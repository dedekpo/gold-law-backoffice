import { createLogger } from "@/lib/logger";

/**
 * Minimal server-side GoHighLevel API v2 client. Auth is a Private Integration
 * token (Bearer) plus the mandatory Version header — requests without it are
 * rejected. Docs: https://marketplace.gohighlevel.com/docs/
 */

const log = createLogger("ghl");

const GHL_BASE_URL = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";

// Private-integration tokens are limited to a 100-requests-per-10s burst;
// spacing request *starts* keeps a long migration comfortably under it while
// still allowing overlap.
const MIN_REQUEST_GAP_MS = 120;
const MAX_RETRIES = 4;

export class GhlError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(message);
    this.name = "GhlError";
  }
}

export function ghlLocationId(): string {
  const id = process.env.GO_HIGH_LEVEL_LOCATION_ID;
  if (!id) {
    throw new Error(
      "GO_HIGH_LEVEL_LOCATION_ID is not set. Add it to .env and restart the dev server.",
    );
  }
  return id;
}

function ghlToken(): string {
  const token = process.env.GO_HIGH_LEVEL_TOKEN;
  if (!token) {
    throw new Error(
      "GO_HIGH_LEVEL_TOKEN is not set. Add it to .env and restart the dev server.",
    );
  }
  return token;
}

let lastRequestAt = 0;
let spacing: Promise<void> = Promise.resolve();

/** Serialize request *starts* MIN_REQUEST_GAP_MS apart; bodies may overlap. */
async function throttle(): Promise<void> {
  const prev = spacing;
  let release!: () => void;
  spacing = new Promise((resolve) => (release = resolve));
  await prev;
  const wait = lastRequestAt + MIN_REQUEST_GAP_MS - Date.now();
  if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
  lastRequestAt = Date.now();
  release();
}

/**
 * Upload a file into a custom field's storage bucket (multipart). Returns the
 * stored file's URL + metadata; binding it to a record is a separate PUT on
 * that record's custom field value. Accepted formats are limited server-side
 * (images/audio/pdf/csv/docx — zip and plain text are rejected with a 415).
 */
export async function ghlUploadCustomFieldFile(
  fieldId: string,
  file: Blob,
  filename: string,
): Promise<{ url: string; mimetype: string; size: number }> {
  await throttle();
  const form = new FormData();
  form.append("id", fieldId);
  form.append("maxFiles", "10");
  form.append("file", file, filename);
  const res = await fetch(`${GHL_BASE_URL}/locations/${ghlLocationId()}/customFields/upload`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${ghlToken()}`,
      Version: GHL_API_VERSION,
      Accept: "application/json",
    },
    body: form,
    cache: "no-store",
  });
  const text = await res.text();
  let parsed: unknown;
  try {
    parsed = text ? JSON.parse(text) : undefined;
  } catch {
    parsed = text;
  }
  if (!res.ok) {
    throw new GhlError(
      `GHL upload to field ${fieldId} failed with ${res.status}`,
      res.status,
      parsed,
    );
  }
  const meta = (
    parsed as { meta?: { url?: string; mimetype?: string; size?: number }[] }
  ).meta?.[0];
  if (!meta?.url) {
    throw new Error("GHL upload returned no file URL");
  }
  return {
    url: meta.url,
    mimetype: meta.mimetype ?? file.type,
    size: meta.size ?? file.size,
  };
}

export async function ghlFetch<T = unknown>(
  path: string,
  init: {
    method?: "GET" | "POST" | "PUT" | "DELETE";
    body?: unknown;
  } = {},
): Promise<T> {
  const { method = "GET", body } = init;
  for (let attempt = 0; ; attempt++) {
    await throttle();
    const res = await fetch(`${GHL_BASE_URL}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${ghlToken()}`,
        Version: GHL_API_VERSION,
        Accept: "application/json",
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
      cache: "no-store",
    });
    const text = await res.text();
    let parsed: unknown;
    try {
      parsed = text ? JSON.parse(text) : undefined;
    } catch {
      parsed = text;
    }
    if (res.ok) return parsed as T;
    if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
      const backoffMs = 1_000 * 2 ** attempt;
      log.warn("retryable GHL error, backing off", {
        method,
        path,
        status: res.status,
        attempt: attempt + 1,
        backoffMs,
      });
      await new Promise((resolve) => setTimeout(resolve, backoffMs));
      continue;
    }
    throw new GhlError(
      `GHL ${method} ${path} failed with ${res.status}`,
      res.status,
      parsed,
    );
  }
}
