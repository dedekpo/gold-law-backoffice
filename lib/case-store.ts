import { db } from "@/lib/firebase";
import type { CaseRunSnapshot } from "@/lib/case-snapshot";
import type { AiFieldValues } from "@/lib/opportunity-fields";
import type { FileKind } from "@/lib/types";

/**
 * Firestore persistence for AI runs and case review, one document per GHL
 * opportunity: collection `cases`, document id = opportunity id.
 *
 * Field groups are written independently (set + mergeFields) so a re-run
 * replaces `run` wholly without touching `manual` (Mike's investigation
 * notes) or `review` (Chris's decision).
 */

const COLLECTION = "cases";

/** One evidence file of a stored run, pointing back at GHL's copy. */
export type StoredEvidenceFile = {
  name: string;
  kind: FileKind;
  mimetype: string;
  size: number | null;
  /** URL of GHL's stored copy — downloadable via /api/opportunity/file. */
  ghlUrl: string | null;
  /** Short custom-field key it came from, e.g. "violation_screenshots". */
  field: string | null;
  /** Transcription (audio) or description (image). */
  text: string | null;
  forensics: CaseRunSnapshot["files"][number]["forensics"];
};

/** A finished AI run as stored: the snapshot + storage metadata. */
export type StoredRun = Omit<CaseRunSnapshot, "files"> & {
  /** ISO timestamp of the write. */
  savedAt: string;
  files: StoredEvidenceFile[];
  /** The flattened values also written to the GHL "AI Intake" fields. */
  aiFields: AiFieldValues;
};

export type ManualInvestigation = {
  text: string;
  /** ISO timestamp of the last edit. */
  updatedAt: string;
};

export type ReviewDecision = {
  decision: "approved" | "declined";
  /** ISO timestamp of the decision. */
  decidedAt: string;
  /** The GHL stage the opportunity was moved to. */
  movedToStageId: string;
  movedToStageName: string;
};

export type CaseDoc = {
  opportunity: {
    id: string;
    name: string;
    contactId: string | null;
  };
  run?: StoredRun;
  manual?: ManualInvestigation;
  review?: ReviewDecision;
};

export async function saveRun(
  opportunity: CaseDoc["opportunity"],
  run: StoredRun,
): Promise<void> {
  await db()
    .collection(COLLECTION)
    .doc(opportunity.id)
    .set({ opportunity, run }, { mergeFields: ["opportunity", "run"] });
}

export async function saveManualInvestigation(
  opportunityId: string,
  manual: ManualInvestigation,
): Promise<void> {
  await db()
    .collection(COLLECTION)
    .doc(opportunityId)
    .set({ manual }, { mergeFields: ["manual"] });
}

export async function saveReviewDecision(
  opportunityId: string,
  review: ReviewDecision,
): Promise<void> {
  await db()
    .collection(COLLECTION)
    .doc(opportunityId)
    .set({ review }, { mergeFields: ["review"] });
}

export async function getCaseDoc(
  opportunityId: string,
): Promise<CaseDoc | null> {
  const snap = await db().collection(COLLECTION).doc(opportunityId).get();
  return snap.exists ? (snap.data() as CaseDoc) : null;
}

/** Batch existence/summary lookup for the review queue list. */
export async function getCaseDocs(
  opportunityIds: string[],
): Promise<Map<string, CaseDoc>> {
  const found = new Map<string, CaseDoc>();
  if (opportunityIds.length === 0) return found;
  const refs = opportunityIds.map((id) => db().collection(COLLECTION).doc(id));
  const snaps = await db().getAll(...refs);
  for (const snap of snaps) {
    if (snap.exists) found.set(snap.id, snap.data() as CaseDoc);
  }
  return found;
}
