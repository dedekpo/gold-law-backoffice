/**
 * Tiny structured logger for server-side (Node console) visibility.
 *
 * Goals: make it possible to follow a single request end-to-end on the local
 * server console — which step is running, how long each took, and exactly where
 * it stopped or errored. Logs are intentionally sparse: one line per meaningful
 * boundary (request in/out, each tool call, each rate-limit backoff), never per
 * token or per byte.
 *
 * Usage:
 *   const log = createLogger("defendant-id");
 *   log.info("request received", { files: 3 });
 *   const done = log.start("agent.generate");
 *   ...
 *   done({ candidates: 2 }); // logs "agent.generate ok (1234ms)"
 */

type Level = "info" | "warn" | "error";
type Fields = Record<string, unknown>;

function format(value: unknown): string {
  if (value === null) return "null";
  if (value === undefined) return "undefined";
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

function fieldsToString(fields?: Fields): string {
  if (!fields) return "";
  const parts = Object.entries(fields)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${format(v)}`);
  return parts.length ? ` ${parts.join(" ")}` : "";
}

function emit(level: Level, scope: string, message: string, fields?: Fields) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [${scope}] ${message}${fieldsToString(fields)}`;
  (level === "info" ? console.log : console[level])(line);
}

export interface Logger {
  info(message: string, fields?: Fields): void;
  warn(message: string, fields?: Fields): void;
  error(message: string, fields?: Fields): void;
  /**
   * Mark the start of an operation; returns a function to call when it finishes.
   * The returned function logs the operation name plus its elapsed time, so a
   * stalled step is visible by the *absence* of its completion line.
   */
  start(operation: string, fields?: Fields): (doneFields?: Fields) => void;
  /** Derive a logger that tags every line with a short id (e.g. per request). */
  child(suffix: string): Logger;
}

export function createLogger(scope: string): Logger {
  return {
    info: (message, fields) => emit("info", scope, message, fields),
    warn: (message, fields) => emit("warn", scope, message, fields),
    error: (message, fields) => emit("error", scope, message, fields),
    start(operation, fields) {
      const startedAt = Date.now();
      emit("info", scope, `${operation} …`, fields);
      return (doneFields) =>
        emit("info", scope, `${operation} ok`, {
          ms: Date.now() - startedAt,
          ...doneFields,
        });
    },
    child(suffix) {
      return createLogger(`${scope}#${suffix}`);
    },
  };
}

let requestCounter = 0;

/** Short, monotonically-increasing id to correlate one request's log lines. */
export function nextRequestId(): string {
  requestCounter = (requestCounter + 1) % 1_000_000;
  return requestCounter.toString(36).padStart(3, "0");
}
