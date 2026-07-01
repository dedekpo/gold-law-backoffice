// Pure presentation helpers shared across the case UI: label maps, score tones,
// and small formatters for Secretary of State records. No JSX, no state.

import type {
  Band,
  CaseFile,
  DefendantCandidate,
  ScreenId,
  SosEntity,
  Track,
} from "./types";

export const CATEGORY_LABELS: Record<string, string> = {
  prerecorded_voicemail: "Pre-recorded voicemail",
  idnc_failure_to_stop: "Failure to stop (marketing)",
  idnc_debt_collection: "Failure to stop (debt collection)",
  quiet_hours: "Quiet hours (marketing)",
  quiet_hours_debt_collection: "Quiet hours (debt collection)",
  ndnc_federal: "National DNC (federal)",
  ndnc_florida: "Florida DNC",
  none: "No violation detected",
};

export const MESSAGE_TYPE_LABELS: Record<string, string> = {
  marketing: "Marketing",
  debt_collection: "Debt collection",
  informational: "Informational",
  unknown: "Unknown",
};

export const SOLVABILITY_LABELS: Record<
  DefendantCandidate["solvability_tier"],
  string
> = {
  risk: "⚠️ Small (risk)",
  good: "✅ Solid target",
  whale: "💰 Whale",
  unknown: "Unknown size",
};

export type ScoreTone = {
  /** Chip background + text. */
  chip: string;
  /** Focus ring color. */
  ring: string;
  /** Accent used for sidebar markers and dots. */
  dot: string;
  label: string;
};

export function scoreTone(score: number): ScoreTone {
  if (score <= 2)
    return {
      chip: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
      ring: "ring-emerald-500/50",
      dot: "bg-emerald-500",
      label: "Clear",
    };
  if (score <= 5)
    return {
      chip: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
      ring: "ring-amber-500/50",
      dot: "bg-amber-500",
      label: "Possible",
    };
  if (score <= 8)
    return {
      chip: "bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-200",
      ring: "ring-orange-500/50",
      dot: "bg-orange-500",
      label: "Likely",
    };
  return {
    chip: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
    ring: "ring-red-500/50",
    dot: "bg-red-500",
    label: "Violation",
  };
}

// --- TCPA IQ bands, screens, tracks (see docs/scoring-spec.md) ---------------

export const BAND_LABELS: Record<Band, string> = {
  priority: "Priority",
  solid: "Solid",
  marginal: "Marginal",
  pass: "Pass",
};

export const SCREEN_LABELS: Record<ScreenId, string> = {
  prerecorded_voice: "Prerecorded voice",
  failure_to_stop: "Failure to stop (IDNC)",
  quiet_hours: "Quiet hours",
  dnc_registry: "Do-Not-Call registry",
};

export const TRACK_LABELS: Record<Track, string> = {
  tcpa: "TCPA",
  debt_collection: "Debt collection",
};

/**
 * Plain-language explanation of each scorecard factor, keyed by `ScoreFactor.name`
 * (see docs/scoring-spec.md §3). Surfaced as tooltips on the company scorecard.
 */
export const FACTOR_TOOLTIPS: Record<string, string> = {
  "Claim Type":
    "The strongest legal theory in the evidence (prerecorded voice · failure-to-stop · quiet hours · DNC), plus a bonus for stacking multiple theories. Max 24.",
  Collectability:
    "Whether the defendant can actually pay a judgment — based on employee count, revenue, and public-company status. Max 24.",
  Willfulness:
    "Signs the violation was deliberate (ignored a STOP, known repeat offender) — this is what can treble the damages. Max 18.",
  Volume:
    "How many violating contacts are attributed to this company. More contacts = more statutory damages. Max 16.",
  Identifiability:
    "How readily the entity can be sued and served — a Florida nexus scores highest, forum friction lowest. Max 10.",
  Defensibility:
    "How hard the defendant can argue the consumer consented — a clean cold contact scores highest, an established relationship lowest. Max 8.",
};

// Worst → best, for picking a case's headline band across its companies.
const BAND_ORDER: Band[] = ["pass", "marginal", "solid", "priority"];

/** The strongest band among a set (e.g. a case's companies), or null if empty. */
export function bestBand(bands: Band[]): Band | null {
  if (bands.length === 0) return null;
  return bands.reduce((best, b) =>
    BAND_ORDER.indexOf(b) > BAND_ORDER.indexOf(best) ? b : best,
  );
}

/** Tone for a band chip: priority = go (green), down to pass = muted. */
export function bandTone(band: Band): ScoreTone {
  switch (band) {
    case "priority":
      return {
        chip: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
        ring: "ring-emerald-500/50",
        dot: "bg-emerald-500",
        label: "Priority",
      };
    case "solid":
      return {
        chip: "bg-sky-100 text-sky-900 dark:bg-sky-950 dark:text-sky-200",
        ring: "ring-sky-500/50",
        dot: "bg-sky-500",
        label: "Solid",
      };
    case "marginal":
      return {
        chip: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
        ring: "ring-amber-500/50",
        dot: "bg-amber-500",
        label: "Marginal",
      };
    default:
      return {
        chip: "bg-zinc-100 text-zinc-700 dark:bg-zinc-900 dark:text-zinc-300",
        ring: "ring-zinc-400/40",
        dot: "bg-zinc-400 dark:bg-zinc-600",
        label: "Pass",
      };
  }
}

export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

export function messageTypeLabel(messageType: string): string {
  return MESSAGE_TYPE_LABELS[messageType] ?? messageType;
}

export function joinAddress(parts: Array<string | null | undefined>): string | null {
  const cleaned = parts.map((p) => (p ?? "").trim()).filter(Boolean);
  return cleaned.length ? cleaned.join(", ") : null;
}

export function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}

/** True when this record came from the Florida registry. */
export function isFloridaRecord(sos: SosEntity): boolean {
  return (sos.searchState ?? "").toUpperCase() === "FL";
}

/**
 * A short heading for one official record: the home/domestic registration vs. a
 * Florida foreign registration (a company incorporated elsewhere but registered
 * to do business in Florida — the firm's preferred place to serve).
 */
export function recordLabel(sos: SosEntity): string {
  const searchState = (sos.searchState ?? "").toUpperCase();
  if (searchState === "FL") {
    const home = String(sos.jurisdiction ?? "").toUpperCase();
    const foreign = home && home !== "FL" && !home.includes("FLORIDA");
    return foreign ? "Florida registration (foreign)" : "Florida registration";
  }
  return searchState ? `Home registration (${searchState})` : "Home registration";
}

/** The record whose registered agent the firm should serve: Florida first. */
export function preferredServiceRecord(records: SosEntity[]): SosEntity | null {
  return records.find((rec) => isFloridaRecord(rec)) ?? records[0] ?? null;
}

/**
 * The originating evidence to show for one company: the case files the agent
 * attributed to it (matched by filename). When the agent couldn't attribute any
 * file, fall back so proof is never hidden — but only to files no OTHER company
 * claimed, never to evidence that belongs to a sibling. `attributed` tells the
 * caller which case it is so the UI can label the fallback honestly.
 *
 * Two guards keep the fallback honest:
 * - A registry-only `synthesized` company never falls back: it was surfaced from
 *   the Secretary of State record, not from the evidence, so claiming the case's
 *   voicemails/screenshots as its proof would be misleading.
 * - The fallback excludes files attributed to any other candidate in
 *   `allCandidates`, so an unattributed company doesn't appear to own a sibling's
 *   evidence. With no siblings (a single-company case) this is the whole case —
 *   the original "don't hide the proof" intent.
 */
export function candidateEvidence(
  caseFiles: CaseFile[],
  candidate: DefendantCandidate,
  options?: { fallback?: boolean; allCandidates?: DefendantCandidate[] },
): { files: CaseFile[]; attributed: boolean } {
  const names = new Set(candidate.evidence_files ?? []);
  const matched = names.size
    ? caseFiles.filter((file) => names.has(file.name))
    : [];
  if (matched.length > 0) return { files: matched, attributed: true };
  // Callers that file each company's evidence separately (the case bundle) pass
  // `fallback: false`, so unattributed files are routed to their own folder.
  if (options?.fallback === false) return { files: [], attributed: false };
  // A registry-only company has no claim on the evidence — show nothing.
  if (candidate.synthesized) return { files: [], attributed: false };
  // Otherwise fall back only to files no other company attributed.
  const claimedByOthers = new Set(
    (options?.allCandidates ?? [])
      .filter((c) => c !== candidate)
      .flatMap((c) => c.evidence_files ?? []),
  );
  const orphans = caseFiles.filter((file) => !claimedByOthers.has(file.name));
  return { files: orphans, attributed: false };
}

export function formatCaseName(date: Date, suffix?: string): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return suffix ? `Case ${stamp} (${suffix})` : `Case ${stamp}`;
}
