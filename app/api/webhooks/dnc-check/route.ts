import { createLogger, nextRequestId } from "@/lib/logger";
import { GhlError } from "@/lib/ghl";
import { syncContactDnc } from "@/lib/contact-dnc";

const baseLog = createLogger("dnc-check-webhook");

/**
 * GHL-facing webhook: given a contact id and raw phone, runs a RealValidation
 * DNC lookup and mirrors the result into the contact's dropdown custom fields
 * (see lib/contact-dnc.ts) as a reference for intakers.
 *
 * Wire-up (GHL Workflow, "Contact Created" trigger → "Custom Webhook" action):
 *   POST https://<railway-app>/api/webhooks/dnc-check
 *   Header: x-webhook-secret: $GO_HIGH_LEVEL_WEBHOOK_SECRET
 *   Custom data: { "phone-raw": "{{contact.phone}}", "contact-id": "{{contact.id}}" }
 *
 * Idempotent: safe to fire repeatedly; writes only the dropdowns whose value
 * changed. An "unknown" flag (lookup outage, malformed number) leaves the
 * corresponding dropdown untouched rather than erasing a prior result.
 */

/**
 * GHL webhook payloads vary by trigger/config; accept values from the
 * documented custom-data keys plus common fallbacks, top-level or nested
 * under customData.
 */
function extractField(body: unknown, keys: string[]): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const customData = b.customData as Record<string, unknown> | undefined;
  for (const key of keys) {
    for (const candidate of [b[key], customData?.[key]]) {
      if (typeof candidate === "string" && candidate.trim()) {
        return candidate.trim();
      }
    }
  }
  return null;
}

const PHONE_KEYS = ["phone-raw", "phoneRaw", "phone_raw", "phone"];
const CONTACT_KEYS = ["contact-id", "contactId", "contact_id"];

export async function POST(request: Request) {
  const log = baseLog.child(nextRequestId());

  // Fail closed: without a configured secret the endpoint refuses everything.
  const secret = process.env.GO_HIGH_LEVEL_WEBHOOK_SECRET;
  if (!secret) {
    log.error("GO_HIGH_LEVEL_WEBHOOK_SECRET is not set");
    return Response.json(
      { error: "Webhook secret is not configured on the server" },
      { status: 503 }
    );
  }
  if (request.headers.get("x-webhook-secret") !== secret) {
    log.warn("rejected: bad or missing x-webhook-secret");
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const phoneRaw = extractField(body, PHONE_KEYS);
  const contactId = extractField(body, CONTACT_KEYS);
  if (!phoneRaw || !contactId) {
    return Response.json(
      {
        error:
          'Missing phone or contact id — send { "phone-raw": "{{contact.phone}}", "contact-id": "{{contact.id}}" }',
      },
      { status: 400 }
    );
  }

  try {
    const { dnc, changedFields, writeError } = await syncContactDnc(contactId, {
      phoneRaw,
    });
    if (dnc.error) {
      // Nothing verified — nothing was written, so a registry outage can't
      // erase or fabricate a registration status.
      log.warn("dnc lookup unavailable", { contactId, error: dnc.error });
      return Response.json(
        { updated: false, contactId, error: dnc.error },
        { status: 502 }
      );
    }
    if (writeError) {
      return Response.json(
        { updated: false, contactId, error: writeError },
        { status: 500 }
      );
    }
    log.info("dnc check complete", {
      contactId,
      phone: dnc.phone,
      national: dnc.national,
      state: dnc.state,
      changedFields,
    });
    return Response.json({
      updated: true,
      changed: changedFields > 0,
      contactId,
      phone: dnc.phone,
      national: dnc.national,
      state: dnc.state,
    });
  } catch (err) {
    const status = err instanceof GhlError ? err.status : undefined;
    const message = err instanceof Error ? err.message : String(err);
    log.error("contact update failed", { contactId, status, message });
    // 404 from GHL means the id wasn't a contact (or was deleted)
    return Response.json(
      { error: message, contactId },
      { status: status === 404 ? 404 : 500 }
    );
  }
}
