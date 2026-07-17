// Bridge between the investigation's company data and the deterministic engines.
// Given one company plus the evidence contacts attributed to it, run the four
// screens, the kill check, and produce its track + TCPA IQ scorecard.
// Pure (no network); the LLM-derived facts come in as arguments.

import {
  checkKillConditions,
  countVolume,
  runScreens,
} from "@/lib/screening";
import type {
  ConsentSignal,
  DncStatus,
  ExtractedContact,
  ScreenResult,
  Scorecard,
  Track,
} from "@/lib/types";
import {
  type ClaimTheory,
  type CollectabilityProfile,
  type ForumStatus,
  type ScoreInput,
  scoreCompany,
} from "./engine";

/**
 * The subset of a company's fields the scorer needs. Kept structural (rather than
 * importing SosEntity/RegisteredAgent) so it accepts the route's candidate shape
 * regardless of which SosEntity definition that side uses.
 */
export type ScorableCompany = {
  solvability_tier: "risk" | "good" | "whale" | "unknown";
  employees_estimate: string | null;
  revenue_estimate: string | null;
  registered_agent: { state: string | null } | null;
  sos_records?: ReadonlyArray<{
    searchState?: string | null;
    jurisdiction?: string | null;
  }>;
  fl_check?: string;
};

export type CompanyAssessment = {
  track: Track;
  screens: ScreenResult[];
  /** Absent for debt-collection-track or kill-declined-via-track companies. */
  scorecard?: Scorecard;
};

// --- small parsers -----------------------------------------------------------

/** Parse a free-text dollar amount ("$1.2B", "10 million", "$500K") to a number. */
export function parseUsdAmount(text: string | null): number | null {
  if (!text) return null;
  const m = text
    .replace(/,/g, "")
    .match(/\$?\s*(\d+(?:\.\d+)?)\s*(b(?:illion)?|m(?:illion)?|k|thousand)?/i);
  if (!m) return null;
  const value = Number.parseFloat(m[1]);
  if (Number.isNaN(value)) return null;
  const unit = (m[2] ?? "").toLowerCase();
  if (unit.startsWith("b")) return value * 1e9;
  if (unit.startsWith("m")) return value * 1e6;
  if (unit.startsWith("k") || unit.startsWith("thousand")) return value * 1e3;
  return value;
}

/** First integer in an employee estimate ("~120", "11-50", "50+") → number. */
export function parseEmployeeCount(text: string | null): number | null {
  if (!text) return null;
  const m = text.replace(/,/g, "").match(/\d+/);
  return m ? Number.parseInt(m[0], 10) : null;
}

const looksPublic = (company: ScorableCompany): boolean =>
  /\b(public|nyse|nasdaq|publicly traded|ticker)\b/i.test(
    `${company.revenue_estimate ?? ""}`,
  );

function collectabilityProfile(
  company: ScorableCompany,
): CollectabilityProfile {
  switch (company.solvability_tier) {
    case "whale":
      return "50plus";
    case "good":
      return "11to50";
    case "risk":
      return "under10";
    default: {
      const n = parseEmployeeCount(company.employees_estimate);
      if (n === null) return "unknown";
      return n >= 50 ? "50plus" : n >= 11 ? "11to50" : "under10";
    }
  }
}

function hasFloridaNexus(company: ScorableCompany): boolean {
  if (company.fl_check === "found") return true;
  if ((company.registered_agent?.state ?? "").toUpperCase() === "FL") return true;
  return (company.sos_records ?? []).some((r) => {
    const s = `${r.searchState ?? ""} ${r.jurisdiction ?? ""}`.toUpperCase();
    return s.includes("FL") || s.includes("FLORIDA");
  });
}

function forumStatus(company: ScorableCompany): ForumStatus {
  if (hasFloridaNexus(company)) return "fl_forum";
  if ((company.sos_records ?? []).length > 0) return "out_of_state_reachable";
  return "forum_friction";
}

/** Strongest consent signal across the company's contacts (worst for plaintiff wins). */
function consentPosture(contacts: ExtractedContact[]): ConsentSignal {
  if (contacts.some((c) => c.consentSignal === "prior_relationship")) {
    return "prior_relationship";
  }
  if (contacts.some((c) => c.consentSignal === "ambiguous")) return "ambiguous";
  if (contacts.some((c) => c.consentSignal === "cold_contact")) {
    return "cold_contact";
  }
  return "unknown";
}

function theoriesFromScreens(screens: ScreenResult[]): ClaimTheory[] {
  const theories: ClaimTheory[] = [];
  for (const s of screens) {
    if (s.screen === "prerecorded_voice" && s.hit) {
      theories.push({ screen: s.screen, tier: 1, verified: true });
    } else if (s.screen === "failure_to_stop" && s.hit && s.track === "tcpa") {
      theories.push({ screen: s.screen, tier: 1, verified: true });
    } else if (s.screen === "quiet_hours" && s.hit) {
      theories.push({ screen: s.screen, tier: 3, verified: true });
    } else if (s.screen === "dnc_registry" && s.hit) {
      // Operator-confirmed registration(s): Tier 2 (FL) and/or Tier 4 (national).
      for (const tier of s.dncTiers ?? []) {
        theories.push({ screen: s.screen, tier, verified: true });
      }
    } else if (s.screen === "dnc_registry" && s.unverified) {
      // Unconfirmed — contributes no points, only a flagged unknown.
      theories.push({ screen: s.screen, tier: 4, verified: false });
    }
  }
  return theories;
}

/**
 * Assess one company against its attributed evidence: screens, kill check, track,
 * and (for the TCPA track) the deterministic scorecard. `intake.dnc` carries the
 * operator-attested DNC registrations (case-level, applies to every company).
 */
export function assessCompany(
  company: ScorableCompany,
  contacts: ExtractedContact[],
  intake: { dnc?: DncStatus } = {},
): CompanyAssessment {
  const screens = runScreens(contacts, intake);
  const killCheck = checkKillConditions(contacts);

  const hasTcpaHit = screens.some((s) => s.hit && s.track === "tcpa");
  const hasDebtHit = screens.some((s) => s.hit && s.track === "debt_collection");
  // TCPA wins when present; a pure debt-collection company is parked (no score).
  // Default to the TCPA track when nothing hit so an identified entity still
  // gets a (low) scorecard rather than vanishing.
  const track: Track = hasTcpaHit ? "tcpa" : hasDebtHit ? "debt_collection" : "tcpa";

  // A kill condition declines regardless of track (scoreCompany short-circuits).
  if (track === "debt_collection" && !killCheck.declined) {
    return { track, screens };
  }

  const volumeCount = countVolume(contacts);
  const revenue = parseUsdAmount(company.revenue_estimate);
  const employees = parseEmployeeCount(company.employees_estimate);

  const input: ScoreInput = {
    theories: theoriesFromScreens(screens),
    killCheck,
    collectability: {
      profile: collectabilityProfile(company),
      bigRevenueOrPublic: (revenue !== null && revenue >= 1e7) || looksPublic(company),
    },
    willfulness: {
      stopIgnored: screens.some(
        (s) => s.screen === "failure_to_stop" && s.hit && s.track === "tcpa",
      ),
      repeatOffender: false, // MVP: no firm list yet.
    },
    volumeCount,
    forum: forumStatus(company),
    consent: consentPosture(contacts),
    shell: {
      employees1to2: employees !== null && employees <= 2,
      noSosRegistration: (company.sos_records ?? []).length === 0,
      subOneMillion: revenue !== null && revenue < 1e6,
    },
  };

  return { track, screens, scorecard: scoreCompany(input) };
}
