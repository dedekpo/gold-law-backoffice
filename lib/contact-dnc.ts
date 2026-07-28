import { dncUnavailable, lookupDnc } from "@/lib/dnc";
import { GhlError, ghlFetch, ghlLocationId } from "@/lib/ghl";
import { createLogger } from "@/lib/logger";
import type { DncCheck } from "@/lib/types";

/**
 * Fresh DNC lookup mirrored onto the GHL contact record.
 *
 * The location has two contact dropdown (SINGLE_OPTIONS) custom fields —
 * "National DNC Registered?" and "State DNC Registered?" — each with the
 * options Undefined / Yes / No. They are a reference display for intakers,
 * not a cache: every automated check (contact-created webhook, case import)
 * runs the RealValidation lookup itself and overwrites the dropdowns with
 * the fresh answer, so a stale value never outlives the next check.
 *
 * "Undefined" is never written — it is the human-facing "not yet checked"
 * state, and an unknown flag (registry outage, malformed number) leaves the
 * dropdown untouched rather than erasing the last real answer.
 */

const log = createLogger("contact-dnc");

export const NATIONAL_DNC_KEY = "contact.national_dnc_registered";
export const STATE_DNC_KEY = "contact.state_dnc_registered";

/** Dropdown option written for each settled flag; "Undefined" is read-only. */
const OPTION_BY_FLAG: Record<"yes" | "no", string> = { yes: "Yes", no: "No" };

// Field ids are stable per location — cache the lookup across invocations
// (reset on failure so a bad fetch can retry).
let fieldIdsPromise: Promise<{ national: string; state: string }> | null = null;
function contactDncFieldIds(): Promise<{ national: string; state: string }> {
  fieldIdsPromise ??= ghlFetch<{
    customFields?: { id?: string; fieldKey?: string }[];
  }>(`/locations/${ghlLocationId()}/customFields?model=contact`)
    .then((res) => {
      const byKey = new Map<string, string>();
      for (const f of res.customFields ?? []) {
        if (f.fieldKey && f.id) byKey.set(f.fieldKey, f.id);
      }
      const national = byKey.get(NATIONAL_DNC_KEY);
      const state = byKey.get(STATE_DNC_KEY);
      if (!national || !state) {
        throw new Error(
          `Contact custom field "${!national ? NATIONAL_DNC_KEY : STATE_DNC_KEY}" not found in this location`,
        );
      }
      return { national, state };
    })
    .catch((err) => {
      fieldIdsPromise = null;
      throw err;
    });
  return fieldIdsPromise;
}

export type ContactDncResult = {
  dnc: DncCheck;
  /** Dropdowns written to the contact this call (0 = already up to date). */
  changedFields: number;
  /** Set when the write-back failed; `dnc` is still valid and usable. */
  writeError?: string;
};

/**
 * Run a fresh DNC lookup for a contact and mirror the result onto its
 * dropdown custom fields. Throws GhlError only when the contact itself
 * cannot be fetched; registry failures come back as `dnc.error` (lookupDnc's
 * contract) and write-back failures as `writeError`, so callers with good
 * data in hand never lose it to a flaky side effect.
 *
 * `phoneRaw` overrides the contact record's phone as the number to check
 * (the contact-created webhook receives it in the payload).
 */
export async function syncContactDnc(
  contactId: string,
  opts: { phoneRaw?: string } = {},
): Promise<ContactDncResult> {
  // Missing dropdown fields degrade to lookup-only — a deleted custom field
  // must not take DNC screening down with it.
  const [ids, contactRes] = await Promise.all([
    contactDncFieldIds().catch((err) => {
      log.warn("field resolution failed — lookup only, no write-back", {
        message: err instanceof Error ? err.message : String(err),
      });
      return null;
    }),
    ghlFetch<{
      contact?: {
        phone?: unknown;
        customFields?: { id?: string; value?: unknown; fieldValue?: unknown }[];
      };
    }>(`/contacts/${contactId}`),
  ]);

  const contactPhone =
    typeof contactRes.contact?.phone === "string"
      ? contactRes.contact.phone.trim()
      : "";
  const phoneRaw = opts.phoneRaw?.trim() || contactPhone;
  if (!phoneRaw) {
    return {
      dnc: dncUnavailable("The contact has no phone number on file."),
      changedFields: 0,
    };
  }

  const dnc = await lookupDnc(phoneRaw);
  if (!ids || dnc.error) return { dnc, changedFields: 0 };

  // Idempotency: skip dropdowns that already show the fresh answer, so
  // repeated checks don't re-trigger any field-changed automations.
  const current = new Map<string, unknown>();
  for (const f of contactRes.contact?.customFields ?? []) {
    if (f.id) current.set(f.id, f.value ?? f.fieldValue);
  }
  const updates: { id: string; field_value: string }[] = [];
  for (const [fieldId, flag] of [
    [ids.national, dnc.national],
    [ids.state, dnc.state],
  ] as const) {
    if (flag === "unknown") continue;
    const desired = OPTION_BY_FLAG[flag];
    if (current.get(fieldId) !== desired) {
      updates.push({ id: fieldId, field_value: desired });
    }
  }

  if (updates.length === 0) return { dnc, changedFields: 0 };
  try {
    await ghlFetch(`/contacts/${contactId}`, {
      method: "PUT",
      body: { customFields: updates },
    });
    return { dnc, changedFields: updates.length };
  } catch (err) {
    const writeError =
      err instanceof GhlError
        ? `GHL rejected the contact update (${err.status})`
        : err instanceof Error
          ? err.message
          : String(err);
    log.error("write-back failed", { contactId, writeError });
    return { dnc, changedFields: 0, writeError };
  }
}
