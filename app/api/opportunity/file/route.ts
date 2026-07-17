import { ghlLocationId } from "@/lib/ghl";
import { createLogger, nextRequestId } from "@/lib/logger";

const baseLog = createLogger("opportunity-file");

/**
 * Download proxy for evidence files attached to a GHL opportunity. The stored
 * URLs point at GHL's GCS bucket; proxying them keeps the browser independent
 * of that bucket's CORS/visibility policy. Locked to this location's uploads
 * (host allowlist + the location-id path prefix) so it can't be used to fetch
 * arbitrary URLs.
 */

const ALLOWED_HOSTS = new Set([
  "msgsndr-private.storage.googleapis.com",
  "storage.googleapis.com",
]);

function isAllowed(url: URL): boolean {
  if (url.protocol !== "https:") return false;
  if (!ALLOWED_HOSTS.has(url.hostname)) return false;
  return url.pathname.includes(`/location/${ghlLocationId()}/`);
}

export async function GET(request: Request) {
  const log = baseLog.child(nextRequestId());
  const raw = new URL(request.url).searchParams.get("url");
  if (!raw) {
    return Response.json({ error: "Missing url parameter" }, { status: 400 });
  }
  let target: URL;
  try {
    target = new URL(raw);
  } catch {
    return Response.json({ error: "Invalid url parameter" }, { status: 400 });
  }
  if (!isAllowed(target)) {
    return Response.json(
      { error: "URL is not an evidence file for this location" },
      { status: 403 },
    );
  }

  const upstream = await fetch(target, { cache: "no-store" });
  if (!upstream.ok || !upstream.body) {
    log.warn("upstream fetch failed", {
      status: upstream.status,
      path: target.pathname,
    });
    return Response.json(
      { error: `File download failed (${upstream.status})` },
      { status: 502 },
    );
  }

  const headers = new Headers();
  for (const name of ["content-type", "content-length", "content-disposition"]) {
    const value = upstream.headers.get(name);
    if (value) headers.set(name, value);
  }
  return new Response(upstream.body, { status: 200, headers });
}
