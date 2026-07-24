import { createLogger } from "@/lib/logger";
import type { DncCheck, DncFlag, DncLineType } from "@/lib/types";

/**
 * RealPhoneValidation DNC Lookup API client.
 * Docs: https://realphonevalidation.com/api-documentation/dnc-lookup-api-doc/
 *
 * The API takes ONLY a phone number and the account token — there is no state
 * input parameter. `state_dnc` reports the registry of the number's own state
 * (for the firm's Florida clients, the Florida DNC). Responses use Y / N / "?"
 * flags; "?" and any failure map to "unknown" so screening treats them as
 * unverified rather than a verified non-registration.
 */

const log = createLogger("dnc");

const DNC_API_URL =
  "https://api.realvalidation.com/rpvWebService/DNCLookup.php";
const DNC_TIMEOUT_MS = 15_000;

/** Normalize a phone to the 10 digits the API expects; null if not a US number. */
export function normalizeUsPhone(raw: string): string | null {
  const digits = raw.replace(/\D/g, "");
  const ten =
    digits.length === 11 && digits.startsWith("1") ? digits.slice(1) : digits;
  return ten.length === 10 ? ten : null;
}

const flag = (value: unknown): DncFlag =>
  value === "Y" ? "yes" : value === "N" ? "no" : "unknown";

const lineType = (value: unknown): DncLineType =>
  value === "Y"
    ? "cell"
    : value === "N"
      ? "landline"
      : value === "V"
        ? "voip"
        : "unknown";

/** A DncCheck that never reached the registry — every flag stays "unknown". */
export function dncUnavailable(error: string, phone = ""): DncCheck {
  return {
    phone,
    national: "unknown",
    state: "unknown",
    dma: "unknown",
    litigator: "unknown",
    lineType: "unknown",
    checkedAt: new Date().toISOString(),
    error,
  };
}

type DncApiResponse = {
  RESPONSECODE?: unknown;
  RESPONSEMSG?: unknown;
  national_dnc?: unknown;
  state_dnc?: unknown;
  dma?: unknown;
  litigator?: unknown;
  iscell?: unknown;
};

/**
 * Check a US phone number against the National and state DNC registries.
 * Never throws: failures come back as a DncCheck with `error` set and every
 * flag "unknown", so a registry outage can't abort a case run.
 */
export async function lookupDnc(rawPhone: string): Promise<DncCheck> {
  const token = process.env.REAL_VALIDATION_PHONE_TOKEN;
  if (!token) {
    log.error("misconfigured: REAL_VALIDATION_PHONE_TOKEN is not set");
    return dncUnavailable(
      "RealValidation token is not configured on the server.",
    );
  }
  const phone = normalizeUsPhone(rawPhone);
  if (!phone) {
    return dncUnavailable(
      `"${rawPhone}" is not a 10-digit US phone number.`,
      rawPhone,
    );
  }

  const done = log.start("dnc_lookup", { phone });
  try {
    const params = new URLSearchParams({ phone, token, output: "json" });
    const res = await fetch(`${DNC_API_URL}?${params}`, {
      signal: AbortSignal.timeout(DNC_TIMEOUT_MS),
      cache: "no-store",
    });
    if (!res.ok) {
      done({ result: "http_error", status: res.status });
      return dncUnavailable(
        res.status === 403
          ? "DNC lookup was throttled (rate limit) — try again shortly."
          : `DNC lookup failed (HTTP ${res.status}).`,
        phone,
      );
    }
    const body = (await res.json().catch(() => null)) as DncApiResponse | null;
    if (!body) {
      done({ result: "bad_body" });
      return dncUnavailable("DNC lookup returned an unreadable response.", phone);
    }
    const code = typeof body.RESPONSECODE === "string" ? body.RESPONSECODE : "";
    if (code !== "OK") {
      const msg =
        typeof body.RESPONSEMSG === "string" && body.RESPONSEMSG.trim()
          ? body.RESPONSEMSG.trim()
          : code || "unknown error";
      done({ result: "api_error", code });
      return dncUnavailable(`DNC lookup rejected the request: ${msg}.`, phone);
    }
    const check: DncCheck = {
      phone,
      national: flag(body.national_dnc),
      state: flag(body.state_dnc),
      dma: flag(body.dma),
      litigator: flag(body.litigator),
      lineType: lineType(body.iscell),
      checkedAt: new Date().toISOString(),
    };
    done({
      national: check.national,
      state: check.state,
      litigator: check.litigator,
      lineType: check.lineType,
    });
    return check;
  } catch (err) {
    const message = err instanceof Error ? err.message : "DNC lookup failed.";
    log.warn("dnc_lookup failed", { phone, message });
    done({ result: "exception" });
    return dncUnavailable(`DNC lookup failed: ${message}`, phone);
  }
}
