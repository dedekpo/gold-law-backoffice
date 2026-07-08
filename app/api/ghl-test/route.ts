import { z } from "zod";
import { createLogger, nextRequestId } from "@/lib/logger";

const baseLog = createLogger("ghl-test");

// GoHighLevel API v2. Auth is a Private Integration token (Bearer) plus the
// mandatory Version header — requests without it are rejected.
// Docs: https://marketplace.gohighlevel.com/docs/
const GHL_BASE_URL = "https://services.leadconnectorhq.com";
const GHL_API_VERSION = "2021-07-28";

const requestSchema = z.object({
  // Path + query relative to the GHL base URL, e.g. "/contacts/?locationId=abc".
  // "{locationId}" placeholders (in the path AND the JSON body) are replaced
  // with GO_HIGH_LEVEL_LOCATION_ID.
  path: z.string().startsWith("/"),
  method: z.enum(["GET", "POST", "PUT", "DELETE"]).default("GET"),
  // JSON payload forwarded to GHL for POST/PUT requests.
  body: z.unknown().optional(),
});

// Server-side proxy so the token never reaches the browser. The GHL response is
// passed through verbatim (status + body) for inspection on the test page.
export async function POST(request: Request) {
  const log = baseLog.child(nextRequestId());
  const parsed = requestSchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json(
      {
        error:
          'Invalid request body: expected { path: "/...", method?, body? }',
      },
      { status: 400 },
    );
  }

  const token = process.env.GO_HIGH_LEVEL_TOKEN;
  if (!token) {
    return Response.json(
      {
        error:
          "GO_HIGH_LEVEL_TOKEN is not set. Add it to .env and restart the dev server.",
      },
      { status: 500 },
    );
  }

  const { method, body } = parsed.data;
  // The body is forwarded as JSON, with the same {locationId} substitution as
  // the path (applied to the serialized form so it works at any depth).
  const rawBody = body === undefined ? undefined : JSON.stringify(body);

  const locationId = process.env.GO_HIGH_LEVEL_LOCATION_ID;
  const needsLocation =
    parsed.data.path.includes("{locationId}") ||
    (rawBody?.includes("{locationId}") ?? false);
  if (needsLocation && !locationId) {
    return Response.json(
      {
        error:
          "GO_HIGH_LEVEL_LOCATION_ID is not set. Add it to .env and restart the dev server.",
      },
      { status: 500 },
    );
  }

  const path = parsed.data.path.replaceAll(
    "{locationId}",
    encodeURIComponent(locationId ?? ""),
  );
  const url = `${GHL_BASE_URL}${path}`;
  log.info("proxying", { method, path });

  try {
    const res = await fetch(url, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Version: GHL_API_VERSION,
        Accept: "application/json",
        ...(rawBody !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body: rawBody?.replaceAll("{locationId}", locationId ?? ""),
      cache: "no-store",
    });
    const text = await res.text();
    let body: unknown;
    try {
      body = JSON.parse(text);
    } catch {
      body = text;
    }
    log.info("response", { status: res.status });
    return Response.json({ status: res.status, ok: res.ok, url, body });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("fetch failed", { message });
    return Response.json(
      { error: `Request to GHL failed: ${message}`, url },
      { status: 502 },
    );
  }
}
