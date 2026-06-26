// Pure presentation helpers shared across the case UI: label maps, score tones,
// and small formatters for Secretary of State records. No JSX, no state.

import type { CaseFile, DefendantCandidate, SosEntity } from "./types";

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
 * file (older data, or a single obvious file), fall back to all of the case's
 * files so proof is never hidden — `attributed` tells the caller which case it is
 * so the UI can label the fallback honestly.
 */
export function candidateEvidence(
  caseFiles: CaseFile[],
  candidate: DefendantCandidate,
): { files: CaseFile[]; attributed: boolean } {
  const names = new Set(candidate.evidence_files ?? []);
  const matched = names.size
    ? caseFiles.filter((file) => names.has(file.name))
    : [];
  if (matched.length > 0) return { files: matched, attributed: true };
  return { files: caseFiles, attributed: false };
}

export function formatCaseName(date: Date, suffix?: string): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return suffix ? `Case ${stamp} (${suffix})` : `Case ${stamp}`;
}
