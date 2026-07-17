// The four screens + kill conditions, run over ONE company's attributed evidence
// — see docs/screening-spec.md §4 and docs/scoring-spec.md §2. Pure functions.

import {
  type DncStatus,
  type ExtractedContact,
  type KillCheck,
  type ScreenResult,
} from "@/lib/types";

const TWENTY_FOUR_HOURS_MS = 24 * 60 * 60 * 1000;

/** A company message that could be a violation (excludes the allowed confirmation). */
function isCompanyViolationContact(c: ExtractedContact): boolean {
  return (
    c.direction !== "from_consumer" &&
    c.messageType !== "informational" &&
    !c.isOptOutConfirmation
  );
}

/** Parse a full timestamp to epoch ms; null if unparseable. */
function epoch(ts: string | null): number | null {
  if (!ts) return null;
  const t = new Date(ts).getTime();
  return Number.isNaN(t) ? null : t;
}

/**
 * Local hour 0–23, read straight from the ISO string so the screenshot timestamp
 * is treated as the consumer's local time (screening-spec §4, no TZ conversion).
 */
function localHour(ts: string | null): number | null {
  if (!ts) return null;
  const m = ts.match(/T(\d{2}):/);
  return m ? Number.parseInt(m[1], 10) : null;
}

const inQuietWindow = (hour: number): boolean => hour < 8 || hour >= 21;

// --- Screen 01 — Prerecorded Voice -----------------------------------------
function screenPrerecorded(contacts: ExtractedContact[]): ScreenResult {
  const hits = contacts.filter(
    (c) =>
      c.isPrerecorded &&
      (c.channel === "voicemail" || c.channel === "call") &&
      c.direction !== "from_consumer",
  );
  if (hits.length === 0) {
    return {
      screen: "prerecorded_voice",
      hit: false,
      track: null,
      basis: "No pre-recorded voicemail detected.",
    };
  }
  const file = hits[0].file;
  return {
    screen: "prerecorded_voice",
    hit: true,
    track: "tcpa",
    basis: `Pre-recorded/artificial voicemail (${file}). A single prerecorded voicemail is the violation.`,
  };
}

// --- Screen 02 — Failure to Stop (IDNC) ------------------------------------
function screenFailureToStop(contacts: ExtractedContact[]): ScreenResult {
  const none: ScreenResult = {
    screen: "failure_to_stop",
    hit: false,
    track: null,
    basis: "No opt-out followed by a later contact.",
  };

  // `contacts` arrives in chronological order (route sorts by `sequence`), so
  // thread position IS the timeline. The FIRST opt-out from the consumer.
  const stopIdx = contacts.findIndex(
    (c) => c.direction === "from_consumer" && c.isStopRequest,
  );
  if (stopIdx === -1) return none;
  const stopContact = contacts[stopIdx];
  const stopTime = epoch(stopContact.timestamp);
  // Only trust the STOP's time for gap math when it was read off the evidence.
  // A green "Stop" bubble usually has no visible time; its timestamp is INFERRED,
  // and trusting it (e.g. if the model placed it after the follow-ups) would
  // silently drop a real failure-to-stop. In that case we rely on ORDER alone.
  const stopTimeReliable = stopTime !== null && !stopContact.timestampInferred;

  // A company message is a follow-up when it comes AFTER the opt-out in thread
  // order. When BOTH sides have reliable, directly-read timestamps we additionally
  // apply the firm's 24h grace buffer (so a same-batch message already in flight
  // when the STOP landed doesn't count); otherwise order alone qualifies.
  const isAfterStop = (c: ExtractedContact, idx: number): boolean => {
    if (idx <= stopIdx) return false;
    const t = epoch(c.timestamp);
    if (stopTimeReliable && t !== null && !c.timestampInferred) {
      return t - stopTime > TWENTY_FOUR_HOURS_MS;
    }
    return true;
  };

  const followups = contacts.filter(
    (c, idx) => isCompanyViolationContact(c) && isAfterStop(c, idx),
  );
  if (followups.length === 0) return none;

  // Whether the 24h buffer could actually be confirmed from reliable timestamps.
  const buffered = stopTimeReliable;

  // Marketing → TCPA (Internal DNC, Tier 1). Debt → debt track, text only (MVP).
  const marketing = followups.find((c) => c.messageType === "marketing");
  if (marketing) {
    return {
      screen: "failure_to_stop",
      hit: true,
      track: "tcpa",
      basis: `Opt-out then a marketing ${marketing.channel} after it${
        buffered ? " (>24h later)" : ""
      } (${marketing.file}). Internal DNC / failure to stop.`,
    };
  }
  const debtText = followups.find(
    (c) => c.messageType === "debt_collection" && c.channel === "text",
  );
  if (debtText) {
    return {
      screen: "failure_to_stop",
      hit: true,
      track: "debt_collection",
      basis: `Opt-out then a debt-collection text after it${
        buffered ? " (>24h later)" : ""
      } (${debtText.file}). Debt collection violation — routed to the FDCPA/Florida track, not TCPA-scored.`,
    };
  }
  return none;
}

// --- Screen 03 — Quiet Hours -----------------------------------------------
function screenQuietHours(contacts: ExtractedContact[]): ScreenResult {
  // MVP: marketing only (debt quiet-hours is out of scope). Timestamp = local.
  const quiet = contacts.filter((c) => {
    if (c.direction === "from_consumer" || c.messageType !== "marketing") {
      return false;
    }
    const h = localHour(c.timestamp);
    return h !== null && inQuietWindow(h);
  });
  if (quiet.length < 2) {
    return {
      screen: "quiet_hours",
      hit: false,
      track: null,
      basis:
        quiet.length === 1
          ? "Only one contact inside quiet hours (need 2+)."
          : "No marketing contacts inside quiet hours (9PM–8AM).",
    };
  }
  return {
    screen: "quiet_hours",
    hit: true,
    track: "tcpa",
    basis: `${quiet.length} marketing contacts between 9PM and 8AM (local time).`,
  };
}

// --- Screen 04 — Do-Not-Call Registry ---------------------------------------
// Registration comes from the operator-attested checkboxes (an intaker's manual
// registry lookup) until the API check lands. Federal NDNC needs ≥2
// telemarketing contacts (Tier 4); Florida DNC hits on a single one (Tier 2).
// No attestation → unverified flag (registration status unknown), as before.
function screenDnc(
  contacts: ExtractedContact[],
  dnc: DncStatus | undefined,
): ScreenResult {
  const telemarketing = contacts.filter(
    (c) => c.direction !== "from_consumer" && c.messageType === "marketing",
  ).length;
  if (telemarketing === 0) {
    return {
      screen: "dnc_registry",
      hit: false,
      track: null,
      basis: "Not telemarketing — DNC registry does not apply.",
    };
  }

  const tiers: Array<2 | 4> = [];
  const parts: string[] = [];
  if (dnc?.florida) {
    tiers.push(2);
    parts.push("Florida DNC registration confirmed by manual lookup");
  }
  if (dnc?.national) {
    if (telemarketing >= 2) {
      tiers.push(4);
      parts.push(
        `National DNC registration confirmed by manual lookup (${telemarketing} telemarketing contacts)`,
      );
    } else {
      parts.push(
        "National DNC registration confirmed, but only 1 telemarketing contact (federal claim needs ≥2)",
      );
    }
  }
  if (tiers.length > 0) {
    return {
      screen: "dnc_registry",
      hit: true,
      track: "tcpa",
      dncTiers: tiers,
      basis: `${parts.join("; ")}.`,
    };
  }
  return {
    screen: "dnc_registry",
    hit: false,
    track: null,
    unverified: true,
    basis:
      parts.length > 0
        ? `Telemarketing present. ${parts.join("; ")}. Florida DNC not confirmed — flagged for a registry check.`
        : "Telemarketing present, but no DNC registration was confirmed (registry not checked, or the client is not registered). Flagged — a confirmed registration would add a Florida/National DNC theory.",
  };
}

/** Run all four screens over one company's attributed evidence. */
export function runScreens(
  contacts: ExtractedContact[],
  intake: { dnc?: DncStatus } = {},
): ScreenResult[] {
  return [
    screenPrerecorded(contacts),
    screenFailureToStop(contacts),
    screenQuietHours(contacts),
    screenDnc(contacts, intake.dnc),
  ];
}

/** Auto-decline check (scoring-spec §2). Device marketing is NOT true_healthcare. */
export function checkKillConditions(contacts: ExtractedContact[]): KillCheck {
  const jobScam = contacts.find((c) => c.killSignal === "job_scam");
  if (jobScam) {
    return {
      declined: true,
      reason: "job_scam",
      // Basis cites only the source file; the reason label is added by the UI.
      basis: `from ${jobScam.file}`,
    };
  }
  const healthcare = contacts.find((c) => c.killSignal === "true_healthcare");
  if (healthcare) {
    return {
      declined: true,
      reason: "true_healthcare",
      basis: `from ${healthcare.file}`,
    };
  }
  return { declined: false };
}

/** Count of in-window violation contacts attributable to a company (Volume factor). */
export function countVolume(contacts: ExtractedContact[]): number {
  return contacts.filter(isCompanyViolationContact).length;
}
