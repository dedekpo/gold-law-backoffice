import { createLogger } from "@/lib/logger";

type Task<T> = () => Promise<T>;

const log = createLogger("rate-limit");

// Defaults are sized for a PAID Google tier (billing enabled / Vertex AI),
// whose per-minute quota is far higher than the free tier. Keeping the limiter
// generous lets a batch of files flow through quickly so each request gets a
// slot fast and returns before any platform proxy times it out. All values are
// env-tunable — if you run on the free tier again, drop these back (e.g.
// GATEWAY_MAX_CONCURRENT=3, GATEWAY_RATE_LIMIT=8) to avoid 429/503s.
const MAX_CONCURRENT = Number(process.env.GATEWAY_MAX_CONCURRENT ?? 6);
const RATE_WINDOW_MS = Number(process.env.GATEWAY_RATE_WINDOW_MS ?? 60_000);
const RATE_LIMIT = Number(process.env.GATEWAY_RATE_LIMIT ?? 30);
const MAX_RETRIES = Number(process.env.GATEWAY_MAX_RETRIES ?? 6);
const BASE_BACKOFF_MS = Number(process.env.GATEWAY_BASE_BACKOFF_MS ?? 4000);
const MAX_BACKOFF_MS = Number(process.env.GATEWAY_MAX_BACKOFF_MS ?? 60_000);

let inFlight = 0;
const concurrencyWaiters: Array<() => void> = [];
const recentStarts: number[] = [];

async function acquire(): Promise<void> {
  while (inFlight >= MAX_CONCURRENT) {
    await new Promise<void>((resolve) => concurrencyWaiters.push(resolve));
  }
  inFlight++;

  let throttleNoted = false;
  while (true) {
    const now = Date.now();
    while (recentStarts.length && now - recentStarts[0] > RATE_WINDOW_MS) {
      recentStarts.shift();
    }
    if (recentStarts.length < RATE_LIMIT) {
      recentStarts.push(now);
      return;
    }
    const wait = RATE_WINDOW_MS - (now - recentStarts[0]) + 100;
    // Local throttle (not a server 429): we've hit our own per-window cap.
    // Log once so a deliberate pause isn't mistaken for a hang.
    if (!throttleNoted) {
      log.info("local throttle: window full, waiting for a slot", {
        limit: RATE_LIMIT,
        windowMs: RATE_WINDOW_MS,
        waitMs: wait,
      });
      throttleNoted = true;
    }
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

function release(): void {
  inFlight = Math.max(0, inFlight - 1);
  const next = concurrencyWaiters.shift();
  if (next) next();
}

/**
 * Pull a short, human-readable reason out of a provider error so the cause of a
 * 429 (quota vs. depleted credits vs. per-minute cap) is visible in the logs
 * instead of a bare status code. Checks the raw response body first, since
 * that's where Google puts its actual message.
 */
function errorReason(err: unknown): string | undefined {
  if (!err || typeof err !== "object") return undefined;
  const e = err as { responseBody?: unknown; message?: unknown };
  const raw =
    typeof e.responseBody === "string" && e.responseBody
      ? e.responseBody
      : typeof e.message === "string"
        ? e.message
        : undefined;
  if (!raw) return undefined;
  // Prefer the provider's "message" field if the body is JSON; else use as-is.
  try {
    const parsed = JSON.parse(raw) as { error?: { message?: unknown } };
    const msg = parsed.error?.message;
    if (typeof msg === "string" && msg) return msg.trim().slice(0, 240);
  } catch {
    // not JSON — fall through
  }
  return raw.replace(/\s+/g, " ").trim().slice(0, 240);
}

// Transient server-side failures worth retrying with backoff: request timeout,
// conflict, and the 5xx family Google returns when a model is overloaded
// ("high demand" = 503) or has a brief internal hiccup.
const RETRYABLE_STATUS = new Set([408, 409, 500, 502, 503, 504]);

/** Collect every statusCode hiding on an error or its nested causes. */
function statusCodesOf(err: unknown): number[] {
  if (!err || typeof err !== "object") return [];
  const c = err as {
    statusCode?: number;
    cause?: { statusCode?: number };
    errors?: Array<{ statusCode?: number }>;
    lastError?: { statusCode?: number };
  };
  const codes = [
    c.statusCode,
    c.cause?.statusCode,
    c.lastError?.statusCode,
    ...(Array.isArray(c.errors) ? c.errors.map((e) => e?.statusCode) : []),
  ];
  return codes.filter((n): n is number => typeof n === "number");
}

/** True for a 429 specifically — used by routes to return a 429 response. */
export function isRateLimitError(err: unknown): boolean {
  return statusCodesOf(err).includes(429);
}

/**
 * True for errors the retry loop should back off and retry: rate limits (429)
 * plus transient server errors (overloaded model, 5xx). Also honours the AI
 * SDK's own `isRetryable` flag when present.
 */
function isRetryableError(err: unknown): boolean {
  const codes = statusCodesOf(err);
  if (codes.some((code) => code === 429 || RETRYABLE_STATUS.has(code))) {
    return true;
  }
  return (err as { isRetryable?: boolean })?.isRetryable === true;
}

/** First status code on the error, for logging which kind of failure it was. */
function statusCodeOf(err: unknown): number | undefined {
  return statusCodesOf(err)[0];
}

function pickRetryAfterMs(err: unknown): number | null {
  if (!err || typeof err !== "object") return null;
  const headers = (err as { responseHeaders?: Record<string, string> })
    .responseHeaders;
  const value = headers?.["retry-after"] ?? headers?.["Retry-After"];
  if (!value) return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return Math.min(seconds * 1000, MAX_BACKOFF_MS);
  return null;
}

let globalCooldownUntil = 0;

async function respectGlobalCooldown(): Promise<void> {
  const wait = globalCooldownUntil - Date.now();
  if (wait > 0) {
    await new Promise((resolve) => setTimeout(resolve, wait));
  }
}

export async function runRateLimited<T>(task: Task<T>): Promise<T> {
  let attempt = 0;
  while (true) {
    await respectGlobalCooldown();
    await acquire();
    try {
      const result = await task();
      release();
      return result;
    } catch (err) {
      release();
      if (!isRetryableError(err)) throw err;
      if (attempt >= MAX_RETRIES) {
        log.error("giving up after exhausting retries", {
          attempts: attempt + 1,
          status: statusCodeOf(err),
          reason: errorReason(err),
        });
        throw err;
      }
      const retryAfter = pickRetryAfterMs(err);
      const backoff = Math.round(
        retryAfter ??
          Math.min(
            BASE_BACKOFF_MS * 2 ** attempt + Math.random() * 1000,
            MAX_BACKOFF_MS,
          ),
      );
      // Trip a short global cooldown so other in-flight requests pause too.
      globalCooldownUntil = Math.max(globalCooldownUntil, Date.now() + backoff);
      attempt++;
      log.warn("retryable error from provider, backing off before retry", {
        attempt,
        maxRetries: MAX_RETRIES,
        status: statusCodeOf(err),
        backoffMs: backoff,
        source: retryAfter ? "retry-after header" : "exponential",
        reason: errorReason(err),
      });
      await new Promise((resolve) => setTimeout(resolve, backoff));
    }
  }
}
