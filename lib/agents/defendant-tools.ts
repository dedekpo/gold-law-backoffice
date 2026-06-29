import { generateText, tool } from "ai";
import { z } from "zod";
import { createLogger } from "@/lib/logger";
import { MODELS, google } from "@/lib/provider";
import { isRateLimitError } from "@/lib/rate-limit";
import { rateLimitedModel } from "./model";

const log = createLogger("defendant-tools");

const FETCH_TIMEOUT_MS = 15_000;
const MAX_PAGE_CHARS = 8_000;

// A desktop user agent — many sites return a stripped page or block obvious bots.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function sourceUrls(sources: readonly unknown[] | undefined): string[] {
  if (!sources) return [];
  const urls = sources
    .map((s) =>
      s && typeof s === "object" && "url" in s
        ? (s as { url?: unknown }).url
        : undefined,
    )
    .filter((u): u is string => typeof u === "string" && u.length > 0);
  return Array.from(new Set(urls));
}

/** Strip a raw HTML document down to readable visible text. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/**
 * Web search backed by a Gemini model with Google Search grounding. Returns a
 * synthesized answer plus the source URLs it cited, so the agent can follow up
 * with `fetch_page` on the most promising links. We stay on the same Gemini
 * family as the rest of the app so web search is covered by the same gateway
 * tier (perplexity/openai search models are premium-only).
 */
export const webSearchTool = tool({
  description:
    "Search the web for information about a company, phone number, or message. " +
    "Returns a synthesized answer with source URLs. Use targeted queries such as: " +
    "the brand/company name; the phone number both with and without dashes; the exact " +
    "message text in quotes; '<company> LLC OR Inc'; '<company> terms of service'; " +
    "'<company> employees linkedin'; '<company> revenue'.",
  inputSchema: z.object({
    query: z.string().describe("The search query to run."),
  }),
  execute: async ({ query }) => {
    const done = log.start("web_search", { query });
    try {
      const { text, sources } = await generateText({
        model: rateLimitedModel(MODELS.agent),
        maxRetries: 0,
        temperature: 0,
        prompt: query,
        // Search grounding is a provider-defined tool in @ai-sdk/google (the old
        // `providerOptions.useSearchGrounding` flag is gone).
        tools: { google_search: google.tools.googleSearch({}) },
      });
      const urls = sourceUrls(sources);
      done({ answerChars: text.length, sources: urls.length });
      return { answer: text, sources: urls };
    } catch (err) {
      log.error("web_search failed", {
        query,
        message: err instanceof Error ? err.message : String(err),
      });
      // A rate limit (429) is worth failing the whole run for — the user should
      // retry once the window clears rather than receive a half-searched report.
      // Any other failure (a 5xx that exhausted retries, a network blip) is
      // returned like `fetch_page` does, so one bad search can't abort the
      // investigation: the agent can try a different query or finish with what
      // it already has.
      if (isRateLimitError(err)) throw err;
      const message = err instanceof Error ? err.message : "Search failed";
      return { error: message, answer: "", sources: [] as string[] };
    }
  },
});

/**
 * Fetch the visible text of a page. Follows redirects (so it doubles as a
 * short-link unmasker) and returns the final URL after redirects.
 */
export const fetchPageTool = tool({
  description:
    "Fetch the visible text of a web page by URL. Use it to read a company's website " +
    "footer, Terms of Service, or Privacy Policy and find the legal entity name (look for " +
    "'LLC', 'Inc', 'Company', 'governed by'). Follows redirects, so it also resolves " +
    "short links (bit.ly, tinyurl, etc.) — check the returned finalUrl.",
  inputSchema: z.object({
    url: z
      .string()
      .describe("Absolute URL to fetch, including the https:// scheme."),
  }),
  execute: async ({ url }) => {
    const done = log.start("fetch_page", { url });
    try {
      const response = await fetch(url, {
        redirect: "follow",
        headers: { "user-agent": USER_AGENT, accept: "text/html,*/*" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const html = await response.text();
      const text = htmlToText(html).slice(0, MAX_PAGE_CHARS);
      done({
        status: response.status,
        redirected: response.url !== url ? response.url : undefined,
        textChars: text.length,
      });
      return {
        url,
        finalUrl: response.url,
        status: response.status,
        text,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fetch page";
      // A timeout/abort here is the common "stuck on one URL" cause — surface it.
      log.warn("fetch_page failed", { url, message });
      return { url, error: message };
    }
  },
});

// --- OpenSOSData: real-time Secretary of State entity lookups -----------------

const OPEN_SOS_BASE_URL = "https://api.opensosdata.com";
// Live scrapes for slow states (CAPTCHA / multi-step portals like Wyoming) can
// hold the initial request for minutes before returning data or handing back a
// 202 job. Give the lookup up to 5 minutes so we stop aborting results the API
// can actually retrieve. The lightweight status poll keeps a short per-request
// cap since each check returns immediately.
const SOS_LOOKUP_TIMEOUT_MS = 300_000;
const SOS_STATUS_TIMEOUT_MS = 30_000;
// Slow states return 202 + a jobId; we poll the status endpoint until it
// resolves, for up to the same 5-minute budget.
const SOS_POLL_INTERVAL_MS = 3_000;
const SOS_MAX_POLL_MS = 300_000;

/**
 * A Secretary of State entity record. Mirrors OpenSOSData's `EntityData` shape;
 * every field is optional because coverage varies by state. The index signature
 * preserves any extra fields a state returns so nothing is dropped from the
 * enrichment — but `screenshots` (heavy source-verification blobs) is stripped
 * before this reaches the agent or the client.
 */
export interface SosEntity {
  entityName?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  status?: string | null;
  formationDate?: string | null;
  registeredAgentName?: string | null;
  registeredAgentAddress?: string | null;
  registeredAgentCity?: string | null;
  registeredAgentState?: string | null;
  registeredAgentZip?: string | null;
  principalAddress?: string | null;
  principalCity?: string | null;
  principalState?: string | null;
  principalZip?: string | null;
  mailingAddress?: string | null;
  mailingCity?: string | null;
  mailingState?: string | null;
  mailingZip?: string | null;
  officers?: Array<{ name?: string | null; title?: string | null; address?: string | null }> | null;
  jurisdiction?: string | null;
  /** The state we searched; injected by the lookup tool, not the API. */
  searchState?: string | null;
  feiEinNumber?: string | null;
  sosUrl?: string | null;
  scrapedAt?: string | null;
  [key: string]: unknown;
}

/** Result of one `sos_lookup` call, as the agent (and route) see it. */
export type SosLookupResult =
  | { found: true; state: string; queriedName: string; entity: SosEntity }
  | { found: false; state: string; queriedName: string; message: string }
  | { found: false; state: string; queriedName: string; error: string };

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Heavy / noisy fields we never need downstream (source-verification image
// blobs and links, the related-results list, and cache bookkeeping). Dropped so
// they don't bloat the agent's context or the enrichment shown to the user.
const SOS_DROP_FIELDS = [
  "screenshots",
  "searchScreenshotPath",
  "detailScreenshotPath",
  "filingHistoryScreenshotPath",
  "searchResultsScreenshotUrl",
  "detailScreenshotUrl",
  "filingHistoryScreenshotUrl",
  "relatedResults",
  "cached",
  "cacheExpiresAt",
] as const;

/** Pull the entity object out of a 200 body or a completed-job body. */
function extractEntity(payload: unknown, searchState: string): SosEntity | null {
  if (!payload || typeof payload !== "object") return null;
  const p = payload as { data?: unknown; result?: { data?: unknown } };
  const data = p.data ?? p.result?.data;
  if (!data || typeof data !== "object") return null;
  const entity = { ...(data as SosEntity) };
  for (const field of SOS_DROP_FIELDS) delete entity[field];
  // Record which registry confirmed the entity. For a domestic entity the API
  // leaves `jurisdiction` (state of formation) blank, so it defaults to the
  // state we searched; foreign entities keep their real home jurisdiction.
  entity.searchState = searchState;
  return entity;
}

type PollOutcome =
  | { kind: "found"; entity: SosEntity }
  | { kind: "not_found" }
  | { kind: "error"; error: string };

/**
 * Poll an async lookup job until it completes, fails, or we run out of time.
 * Returns a tagged outcome describing how it resolved.
 */
async function pollSosJob(
  jobId: string,
  apiKey: string,
  pollInterval: number,
  searchState: string,
): Promise<PollOutcome> {
  const deadline = Date.now() + SOS_MAX_POLL_MS;
  while (Date.now() < deadline) {
    await sleep(pollInterval);
    const res = await fetch(`${OPEN_SOS_BASE_URL}/v1/lookup/status/${jobId}`, {
      headers: { "x-api-key": apiKey },
      signal: AbortSignal.timeout(SOS_STATUS_TIMEOUT_MS),
    });
    if (res.status === 404) return { kind: "not_found" };
    const json = (await res.json().catch(() => ({}))) as {
      status?: string;
      error?: string;
    };
    if (json.status === "complete") {
      const entity = extractEntity(json, searchState);
      return entity
        ? { kind: "found", entity }
        : { kind: "error", error: "Lookup completed but returned no entity data." };
    }
    if (json.status === "failed") {
      return { kind: "error", error: json.error || "State scraper failed." };
    }
    // pending / processing → keep polling
  }
  return { kind: "error", error: "Secretary of State lookup timed out." };
}

/**
 * Look up a business entity in a state's Secretary of State registry via
 * OpenSOSData. This is the authoritative source for the data the legal team
 * needs to file: the registered legal name, state of formation, principal and
 * mailing addresses, and — critically — the registered agent name and address.
 *
 * Handles the API's async (202 + poll) path transparently, so a single call
 * either returns the entity, a not-found, or an error string. Failures are
 * returned (not thrown) so a bad state guess doesn't abort the whole agent run.
 *
 * Exported as a plain function so callers other than the agent (e.g. the route's
 * deterministic Florida cross-lookup) can run a lookup without going through the
 * tool wrapper.
 */
export async function lookupSosEntity(
  entity_name: string,
  state: string,
): Promise<SosLookupResult> {
  const stateCode = state.toUpperCase();
  const done = log.start("sos_lookup", { entity_name, state: stateCode });
  const apiKey = process.env.OPEN_SOS_DATA_API_KEY;
  if (!apiKey) {
    log.error("sos_lookup misconfigured: OPEN_SOS_DATA_API_KEY is not set");
    return {
      found: false,
      state: stateCode,
      queriedName: entity_name,
      error: "OpenSOSData API key is not configured on the server.",
    };
  }

  try {
    const res = await fetch(`${OPEN_SOS_BASE_URL}/v1/lookup`, {
      method: "POST",
      headers: {
        "x-api-key": apiKey,
        "content-type": "application/json",
      },
      body: JSON.stringify({ entity_name, state: stateCode }),
      signal: AbortSignal.timeout(SOS_LOOKUP_TIMEOUT_MS),
    });

    // Not found — the state's registry has no match. Not billed.
    if (res.status === 404) {
      done({ result: "not_found" });
      return {
        found: false,
        state: stateCode,
        queriedName: entity_name,
        message: `No match for "${entity_name}" in ${stateCode}.`,
      };
    }

    const json = (await res.json().catch(() => ({}))) as {
      success?: boolean;
      async?: boolean;
      jobId?: string;
      pollInterval?: number;
      error?: string;
    };

    if (!res.ok) {
      const message =
        json.error || `Lookup failed (HTTP ${res.status}).`;
      log.warn("sos_lookup error response", { status: res.status, message });
      done({ result: "error", status: res.status });
      return {
        found: false,
        state: stateCode,
        queriedName: entity_name,
        error: message,
      };
    }

    // Async path: poll until the job resolves.
    if (res.status === 202 || (json.async && json.jobId)) {
      if (!json.jobId) {
        done({ result: "error" });
        return {
          found: false,
          state: stateCode,
          queriedName: entity_name,
          error: "Lookup was queued but no job id was returned.",
        };
      }
      log.info("sos_lookup queued, polling", { jobId: json.jobId });
      const polled = await pollSosJob(
        json.jobId,
        apiKey,
        json.pollInterval ?? SOS_POLL_INTERVAL_MS,
        stateCode,
      );
      if (polled.kind === "not_found") {
        done({ result: "not_found_async" });
        return {
          found: false,
          state: stateCode,
          queriedName: entity_name,
          message: `No match for "${entity_name}" in ${stateCode}.`,
        };
      }
      if (polled.kind === "error") {
        done({ result: "error_async" });
        return {
          found: false,
          state: stateCode,
          queriedName: entity_name,
          error: polled.error,
        };
      }
      done({
        result: "found_async",
        entity: polled.entity.entityName ?? undefined,
      });
      return {
        found: true,
        state: stateCode,
        queriedName: entity_name,
        entity: polled.entity,
      };
    }

    // Synchronous success.
    const entity = extractEntity(json, stateCode);
    if (!entity) {
      done({ result: "empty" });
      return {
        found: false,
        state: stateCode,
        queriedName: entity_name,
        message: `No match for "${entity_name}" in ${stateCode}.`,
      };
    }
    done({ result: "found", entity: entity.entityName ?? undefined });
    return { found: true, state: stateCode, queriedName: entity_name, entity };
  } catch (err) {
    const message =
      err instanceof Error ? err.message : "Secretary of State lookup failed.";
    log.warn("sos_lookup failed", { entity_name, state: stateCode, message });
    done({ result: "exception" });
    return {
      found: false,
      state: stateCode,
      queriedName: entity_name,
      error: message,
    };
  }
}

export const sosLookupTool = tool({
  description:
    "Look up a business in a US state's official Secretary of State registry. This is " +
    "the AUTHORITATIVE source for the registered legal name, state of formation, " +
    "principal/mailing addresses, and the registered agent name + address (what the firm " +
    "needs to serve a lawsuit). Search NATIONWIDE: pass the entity's most likely state of " +
    "registration (e.g. the state in its address or named in its Terms, or 'DE' for many " +
    "corporations). If not found, retry with other plausible 2-letter state codes — a " +
    "not-found result is free. Verify a hit matches your other evidence (address, officers) " +
    "before trusting it.",
  inputSchema: z.object({
    entity_name: z
      .string()
      .min(2)
      .max(200)
      .describe("Exact legal/business name to search (e.g. 'Sunshine Marketing LLC')."),
    state: z
      .string()
      .length(2)
      .describe("Two-letter US state code to search (e.g. 'FL', 'CA', 'DE')."),
  }),
  execute: ({ entity_name, state }) => lookupSosEntity(entity_name, state),
});
