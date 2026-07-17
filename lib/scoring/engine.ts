// Deterministic TCPA IQ scoring engine — see docs/scoring-spec.md.
//
// This module is PURE: no network, no LLM, no clock. Given the structured facts
// gathered by extraction (claim theories, consent posture), screening (which
// screens hit), and enrichment (collectability, forum), it computes the 0–100
// score with fixed point tables. The same input always yields the same output —
// that is the whole point (the LLM extracts facts; arithmetic does the scoring).

import {
  type Band,
  HIGH_VOLUME_WILLFULNESS,
  type ConsentSignal,
  type KillCheck,
  type ScoreFactor,
  type Scorecard,
  type ScreenId,
} from "@/lib/types";

/** A claim theory present in the case (one distinct screen hit on the TCPA track). */
export type ClaimTheory = {
  screen: ScreenId;
  /** Claim Type tier (scoring-spec §3.1). DNC can be Tier 2 (FL) or Tier 4 (federal). */
  tier: 1 | 2 | 3 | 4;
  /**
   * Whether the theory is confirmed and so counts for points. DNC theories are
   * verified by an operator-attested registry lookup (interim, until the API
   * check lands); unverified ones contribute only a flagged unknown.
   */
  verified: boolean;
};

export type CollectabilityProfile = "50plus" | "11to50" | "under10" | "unknown";
export type ForumStatus =
  | "fl_forum"
  | "out_of_state_reachable"
  | "forum_friction";

export type ScoreInput = {
  /** All claim theories present (verified ones score; unverified ones only flag). */
  theories: ClaimTheory[];
  killCheck: KillCheck;
  collectability: {
    profile: CollectabilityProfile;
    /** Verified $10M+ revenue OR confirmed public company → +6. */
    bigRevenueOrPublic: boolean;
  };
  willfulness: {
    /** Screen 02 hit — kept contacting after a visible STOP. */
    stopIgnored: boolean;
    /** Known repeat offender (prior settlement/judgment). MVP: always false. */
    repeatOffender: boolean;
  };
  /** Count of in-window contacts attributable to this company. */
  volumeCount: number;
  forum: ForumStatus;
  consent: ConsentSignal;
  /** Shell-cap inputs (scoring-spec §4) — all three must hold to cap at 50. */
  shell: {
    employees1to2: boolean;
    noSosRegistration: boolean;
    subOneMillion: boolean;
  };
  /** Extra flagged unknowns to merge into the scorecard. */
  unknowns?: string[];
};

const TIER_BASE: Record<1 | 2 | 3 | 4, number> = { 1: 18, 2: 13, 3: 9, 4: 7 };
const CLAIM_TYPE_MAX = 24;
const COLLECTABILITY_MAX = 24;
const WILLFULNESS_MAX = 18;
const FORUM_POINTS: Record<ForumStatus, number> = {
  fl_forum: 10,
  out_of_state_reachable: 6,
  forum_friction: 3,
};
const CONSENT_POINTS: Record<ConsentSignal, number> = {
  cold_contact: 8,
  ambiguous: 4,
  prior_relationship: 0,
  // No consent evidence found = a cold contact with no plausible consent (the
  // rubric's top row). A standard "confirm consent history" unknown is flagged
  // separately so an established relationship can still be ruled out at intake.
  unknown: 8,
};
const SHELL_CAP = 50;

/** A theory's identity for de-duping distinct theories (scoring-spec §3.1). */
function theoryKey(t: ClaimTheory): string {
  return `${t.screen}:${t.tier}`;
}

function claimTypeFactor(theories: ClaimTheory[]): ScoreFactor {
  const verified = dedupeTheories(theories.filter((t) => t.verified));
  if (verified.length === 0) {
    return {
      name: "Claim Type",
      points: 0,
      max: CLAIM_TYPE_MAX,
      basis: "No verified claim theory.",
    };
  }
  const base = Math.max(...verified.map((t) => TIER_BASE[t.tier]));
  const distinct = verified.length;
  const stacking = distinct >= 3 ? 6 : distinct === 2 ? 3 : 0;
  const points = Math.min(CLAIM_TYPE_MAX, base + stacking);
  const tiers = verified
    .map((t) => `Tier ${t.tier}`)
    .sort()
    .join(", ");
  const stackNote =
    stacking > 0 ? ` + ${stacking} stacking (${distinct} distinct theories)` : "";
  return {
    name: "Claim Type",
    points,
    max: CLAIM_TYPE_MAX,
    basis: `Base ${base} (highest of ${tiers})${stackNote}.`,
  };
}

function dedupeTheories(theories: ClaimTheory[]): ClaimTheory[] {
  const seen = new Set<string>();
  const out: ClaimTheory[] = [];
  for (const t of theories) {
    const key = theoryKey(t);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function collectabilityFactor(c: ScoreInput["collectability"]): ScoreFactor {
  const base =
    c.profile === "50plus"
      ? 18
      : c.profile === "11to50"
        ? 13
        : c.profile === "under10"
          ? 6
          : 0;
  const addon = c.bigRevenueOrPublic ? 6 : 0;
  const points = Math.min(COLLECTABILITY_MAX, base + addon);
  const profileLabel: Record<CollectabilityProfile, string> = {
    "50plus": "50+ employees",
    "11to50": "11–50 employees",
    under10: "<10 employees",
    unknown: "size unknown",
  };
  const addonNote = addon ? " +6 ($10M+ revenue or public company)" : "";
  return {
    name: "Collectability",
    points,
    max: COLLECTABILITY_MAX,
    basis: `${profileLabel[c.profile]} (${base})${addonNote}.`,
  };
}

function willfulnessFactor(
  w: ScoreInput["willfulness"],
  volumeCount: number,
): ScoreFactor {
  // Highest single value applies (not additive).
  let base = 0;
  let label = "None visible";
  if (w.repeatOffender) {
    base = 18;
    label = "Known repeat offender";
  } else if (w.stopIgnored) {
    base = 12;
    label = "Kept contacting after a visible STOP";
  }
  // Optional, config-gated additive bonus for high contact volume (default OFF).
  let value = base;
  let bonusNote = "";
  if (
    HIGH_VOLUME_WILLFULNESS.enabled &&
    volumeCount >= HIGH_VOLUME_WILLFULNESS.threshold
  ) {
    value = Math.min(WILLFULNESS_MAX, base + HIGH_VOLUME_WILLFULNESS.bonus);
    if (value > base) bonusNote = ` +${value - base} high volume`;
  }
  return {
    name: "Willfulness",
    points: value,
    max: WILLFULNESS_MAX,
    basis: `${label} (${base})${bonusNote}.`,
  };
}

function volumeFactor(count: number): ScoreFactor {
  const points = count >= 10 ? 16 : count >= 5 ? 11 : count >= 3 ? 7 : count >= 1 ? 3 : 0;
  return {
    name: "Volume",
    points,
    max: 16,
    basis: `${count} contact${count === 1 ? "" : "s"} attributed to this company.`,
  };
}

function forumFactor(forum: ForumStatus): ScoreFactor {
  const label: Record<ForumStatus, string> = {
    fl_forum: "Identified + suable in Florida forum",
    out_of_state_reachable: "Identified, out-of-state but reachable",
    forum_friction: "Identified but forum friction",
  };
  return {
    name: "Identifiability",
    points: FORUM_POINTS[forum],
    max: 10,
    basis: `${label[forum]}.`,
  };
}

function defensibilityFactor(consent: ConsentSignal): ScoreFactor {
  const label: Record<ConsentSignal, string> = {
    cold_contact: "Clean cold contact, no plausible consent",
    ambiguous: "Ambiguous — some prior contact, consent unclear",
    prior_relationship: "Evidence of prior consent / established relationship",
    unknown: "No consent evidence visible (treated as cold contact)",
  };
  return {
    name: "Defensibility",
    points: CONSENT_POINTS[consent],
    max: 8,
    basis: `${label[consent]}.`,
  };
}

function bandFor(score: number): Band {
  if (score >= 80) return "priority";
  if (score >= 60) return "solid";
  if (score >= 40) return "marginal";
  return "pass";
}

function buildUnknowns(input: ScoreInput): string[] {
  const unknowns = new Set<string>(input.unknowns ?? []);
  // DNC theories present but unverified (MVP) — would raise Claim Type once the API confirms.
  if (input.theories.some((t) => !t.verified && (t.tier === 2 || t.tier === 4))) {
    unknowns.add(
      "DNC status unverified — pending registry check (could raise Claim Type).",
    );
  }
  // Volume is only what the evidence shows; the client may have more.
  unknowns.add(
    "Full volume — the client may have more contacts than the evidence shows (could raise Volume).",
  );
  // Consent: unless an established relationship is already evidenced, flag to confirm.
  if (input.consent !== "prior_relationship") {
    unknowns.add(
      "Consent history — confirm no prior business relationship (could lower Defensibility).",
    );
  }
  return [...unknowns];
}

/**
 * Compute a company's TCPA IQ scorecard from structured inputs (scoring-spec.md).
 * If a kill condition fired, the company is declined and no score is produced.
 */
export function scoreCompany(input: ScoreInput): Scorecard {
  if (input.killCheck.declined) {
    return {
      factors: [],
      raw: 0,
      capApplied: false,
      final: 0,
      band: "pass",
      killCheck: input.killCheck,
      unknowns: [],
    };
  }

  const factors: ScoreFactor[] = [
    claimTypeFactor(input.theories),
    collectabilityFactor(input.collectability),
    willfulnessFactor(input.willfulness, input.volumeCount),
    volumeFactor(input.volumeCount),
    forumFactor(input.forum),
    defensibilityFactor(input.consent),
  ];

  const raw = factors.reduce((sum, f) => sum + f.points, 0);

  const isShell =
    input.shell.employees1to2 &&
    input.shell.noSosRegistration &&
    input.shell.subOneMillion;
  const final = isShell ? Math.min(raw, SHELL_CAP) : raw;
  const capApplied = isShell && raw > SHELL_CAP;

  return {
    factors,
    raw,
    capApplied,
    final,
    band: bandFor(final),
    killCheck: input.killCheck,
    unknowns: buildUnknowns(input),
  };
}
