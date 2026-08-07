import type {
  AudioForensics,
  Case,
  DefendantCandidate,
  DncCheck,
  EvidenceFacts,
  FileKind,
  IntakeGate,
  SosEntity,
} from "@/lib/types";

/**
 * The serializable projection of a finished AI run, sent by the browser
 * alongside the GHL report write and persisted to Firestore. It is the whole
 * `Case` minus browser-only state (object URLs, statuses, job ids) — the
 * structured record the review page later queries instead of scraping GHL
 * text fields.
 */

/** One evidence file as it appears in the stored run (no blob URL). */
export type SnapshotFile = {
  name: string;
  kind: FileKind;
  /** Transcription (audio) or description (image); null if processing failed. */
  text: string | null;
  forensics: AudioForensics | null;
};

export type CaseRunSnapshot = {
  caseName: string;
  /** ms epoch — when the run started / reached its terminal state. */
  createdAt: number;
  completedAt: number | null;
  files: SnapshotFile[];
  dnc: DncCheck | null;
  facts: EvidenceFacts | null;
  gate: IntakeGate | null;
  defendants: DefendantCandidate[];
  defendantSearchTerms: string[];
  defendantInvestigation: string | null;
  defendantSosError: string | null;
  defendantUnmatchedSos: SosEntity[];
};

/** Project a terminal-state case into its storable snapshot. */
export function buildCaseSnapshot(caseItem: Case): CaseRunSnapshot {
  return {
    caseName: caseItem.name,
    createdAt: caseItem.createdAt,
    completedAt: caseItem.completedAt ?? null,
    files: caseItem.files.map((f) => ({
      name: f.name,
      kind: f.kind,
      text: f.text ?? null,
      forensics: f.forensics ?? null,
    })),
    dnc: caseItem.dnc ?? null,
    facts: caseItem.facts ?? null,
    gate: caseItem.gate ?? null,
    defendants: caseItem.defendants ?? [],
    defendantSearchTerms: caseItem.defendantSearchTerms ?? [],
    defendantInvestigation: caseItem.defendantInvestigation ?? null,
    defendantSosError: caseItem.defendantSosError ?? null,
    defendantUnmatchedSos: caseItem.defendantUnmatchedSos ?? [],
  };
}
