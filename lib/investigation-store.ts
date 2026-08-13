import { randomUUID } from "node:crypto";
import { FieldValue } from "firebase-admin/firestore";
import { db } from "@/lib/firebase";
import type { StoredRun, ReviewDecision } from "@/lib/case-store";
import type { DefendantCandidate, FileKind, ScreenId } from "@/lib/types";

/**
 * Firestore persistence for investigations: collection `investigations`, one
 * document per investigation. An investigation is the bridge between the
 * client-centric intake opportunity and the defendant-centric case
 * opportunities spawned from it — everything found while investigating (AI or
 * manual) lives here, and both sides reference it by id.
 *
 * Cardinality: one intake opportunity holds N investigations over time (serial
 * clients reuse their opportunity across evidence batches); each spawned case
 * opportunity points back at exactly one investigation via the
 * `investigationId` GHL custom field.
 *
 * This schema supersedes the legacy `cases/{oppId}` docs (case-store.ts):
 * `run`/`manual`/`review` map to `aiRun`/`log`/`review` here. Legacy docs are
 * read-through until backfilled — see Phase 1 of the migration roadmap.
 */

const COLLECTION = "investigations";

// ---------------------------------------------------------------------------
// Evidence
// ---------------------------------------------------------------------------

/**
 * Lifecycle role of an evidence file. The legacy GHL upload fields conflated
 * these two meanings in a single field; the split is now explicit:
 * - "raw": as received from the client, unvetted.
 * - "confirmed": vetted during investigation and attributed to at least one
 *   company (`companyIds`) as proof for the case against it.
 */
export type EvidenceRole = "raw" | "confirmed";

export type EvidenceSource =
  /** Pulled from a GHL opportunity upload field (legacy path). */
  | "ghl_field"
  /** Uploaded through the app by an investigator/intaker. */
  | "manual_upload";

export type InvestigationEvidence = {
  id: string;
  name: string;
  kind: FileKind;
  mimetype: string;
  size: number | null;
  role: EvidenceRole;
  source: EvidenceSource;
  /** Canonical copy in Firebase Storage; null until mirrored there. */
  storageUrl: string | null;
  /** URL of GHL's stored copy, when the file originated in a GHL field. */
  ghlUrl: string | null;
  /** Short GHL custom-field key it came from, e.g. "violation_screenshots". */
  ghlField: string | null;
  /** Transcription (audio) or description (image), once processed. */
  text: string | null;
  /** Ids of the companies this file is confirmed proof against. */
  companyIds: string[];
  /** ISO timestamp the file entered the investigation. */
  addedAt: string;
  addedBy: Actor;
};

// ---------------------------------------------------------------------------
// Companies & violations — unified across AI and manual investigation
// ---------------------------------------------------------------------------

export type Actor = { kind: "ai" | "human"; name: string };

export type CompanyStatus =
  /** Surfaced by AI or manual research; not yet vetted. */
  | "candidate"
  /** Vetted — will get (or has) a Defendant record and a case opportunity. */
  | "confirmed"
  /** Vetted and ruled out. Kept for the record; never spawns a case. */
  | "rejected";

/**
 * One company under investigation. AI and manual investigation produce this
 * same artifact — `origin` is the only difference — so review renders one list
 * regardless of who found what.
 */
export type InvestigationCompany = {
  id: string;
  origin: Actor;
  status: CompanyStatus;
  /** Full research profile; superset of the GHL Defendant record's fields. */
  profile: DefendantCandidate;
  /** GHL Defendant custom-object record id, once linked (create or reuse). */
  defendantRecordId: string | null;
  /** GHL case opportunity spawned for this company at the split, if any. */
  spawnedOpportunityId: string | null;
  /** ISO timestamp + actor of the confirm/reject decision. */
  decidedAt: string | null;
  decidedBy: Actor | null;
};

export type ViolationStatus = "potential" | "confirmed" | "dismissed";

/** One violation finding, promoted from "potential" by a human reviewer. */
export type ViolationFinding = {
  id: string;
  screen: ScreenId;
  status: ViolationStatus;
  /** Human-readable basis citing the evidence. */
  basis: string;
  /** Company this violation is pinned to; null while unattributed. */
  companyId: string | null;
  /**
   * Ids of the evidence entries proving this violation — the screenshot/audio
   * the finding rests on, so review never hunts through the raw pile.
   * Findings written before this field existed lack it: read as `?? []`.
   */
  evidenceIds?: string[];
  foundBy: Actor;
};

// ---------------------------------------------------------------------------
// Investigation log — replaces GHL Notes as the step-by-step record
// ---------------------------------------------------------------------------

export type LogEntry = {
  id: string;
  /** ISO timestamp. */
  at: string;
  author: Actor;
  text: string;
  /** Evidence attached to this step, if any. */
  evidenceIds: string[];
};

// ---------------------------------------------------------------------------
// Lifecycle
// ---------------------------------------------------------------------------

export type InvestigationStatus =
  /** Being worked — AI run and/or manual investigation in progress. */
  | "open"
  /** Findings complete; awaiting approve/decline review. */
  | "ready_for_review"
  /** Terminal — see `outcome`. */
  | "closed";

export type InvestigationOutcome =
  /** Split executed: case opportunities created for confirmed companies. */
  | "converted"
  | "no_company_found"
  | "no_violation"
  /** "Not a fit" — declined for another reason (e.g. time-barred, no claim). */
  | "declined";

/** A case opportunity created at the split, with its links. */
export type SpawnedCase = {
  opportunityId: string;
  /** e.g. "Prado v. Fashion Nova, LLC". */
  name: string;
  companyId: string;
  defendantRecordId: string;
  /** ISO timestamp of creation. */
  createdAt: string;
};

export type InvestigationDoc = {
  id: string;
  /** The intake opportunity this investigation belongs to. */
  source: {
    opportunityId: string;
    opportunityName: string;
    contactId: string | null;
    pipelineId: string | null;
  };
  status: InvestigationStatus;
  outcome: InvestigationOutcome | null;
  /** ISO timestamps. */
  createdAt: string;
  updatedAt: string;
  evidence: InvestigationEvidence[];
  companies: InvestigationCompany[];
  violations: ViolationFinding[];
  log: LogEntry[];
  /** The finished AI run, verbatim (same shape the legacy `cases` docs store). */
  aiRun: StoredRun | null;
  /** Approve/decline decision + the GHL stage move it caused. */
  review: ReviewDecision | null;
  spawned: SpawnedCase[];
  /**
   * Flat copy of spawned[].opportunityId so a case opportunity can find its
   * investigation with a single array-contains query.
   */
  spawnedOpportunityIds: string[];
};

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

export function newId(): string {
  return randomUUID();
}

export async function createInvestigation(
  source: InvestigationDoc["source"],
): Promise<InvestigationDoc> {
  const now = new Date().toISOString();
  const doc: InvestigationDoc = {
    id: newId(),
    source,
    status: "open",
    outcome: null,
    createdAt: now,
    updatedAt: now,
    evidence: [],
    companies: [],
    violations: [],
    log: [],
    aiRun: null,
    review: null,
    spawned: [],
    spawnedOpportunityIds: [],
  };
  await db().collection(COLLECTION).doc(doc.id).set(doc);
  return doc;
}

export async function getInvestigation(
  id: string,
): Promise<InvestigationDoc | null> {
  const snap = await db().collection(COLLECTION).doc(id).get();
  return snap.exists ? (snap.data() as InvestigationDoc) : null;
}

/**
 * All investigations of one intake opportunity, newest first. Sorted in
 * memory — N per opportunity stays small, and this avoids a composite index.
 */
export async function listInvestigationsForOpportunity(
  opportunityId: string,
): Promise<InvestigationDoc[]> {
  const snap = await db()
    .collection(COLLECTION)
    .where("source.opportunityId", "==", opportunityId)
    .get();
  return snap.docs
    .map((d) => d.data() as InvestigationDoc)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}

/**
 * Every investigation currently in the given status, most recently touched
 * first — feeds the review queue (status "ready_for_review"). Single-field
 * where-clause, so no composite index is needed.
 */
export async function listInvestigationsByStatus(
  status: InvestigationStatus,
): Promise<InvestigationDoc[]> {
  const snap = await db()
    .collection(COLLECTION)
    .where("status", "==", status)
    .get();
  return snap.docs
    .map((d) => d.data() as InvestigationDoc)
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

/**
 * The investigation that spawned the given case opportunity, if any — how a
 * child opportunity's view finds its way back to the parent investigation.
 */
export async function findInvestigationBySpawnedOpportunity(
  opportunityId: string,
): Promise<InvestigationDoc | null> {
  const snap = await db()
    .collection(COLLECTION)
    .where("spawnedOpportunityIds", "array-contains", opportunityId)
    .limit(1)
    .get();
  return snap.empty ? null : (snap.docs[0].data() as InvestigationDoc);
}

/** Shallow field-group update; always bumps `updatedAt`. */
async function patch(
  id: string,
  fields: Partial<
    Pick<
      InvestigationDoc,
      | "status"
      | "outcome"
      | "evidence"
      | "companies"
      | "violations"
      | "aiRun"
      | "review"
      | "spawned"
      | "spawnedOpportunityIds"
    >
  >,
): Promise<void> {
  await db()
    .collection(COLLECTION)
    .doc(id)
    .update({ ...fields, updatedAt: new Date().toISOString() });
}

export const updateInvestigation = patch;

/**
 * Transactional read-modify-write for the capture endpoints (log, companies,
 * violations, evidence): the mutator gets the current doc and edits it (in
 * place or by returning a replacement); concurrent edits retry instead of
 * clobbering each other's array writes. Returns the stored doc.
 */
export async function mutateInvestigation(
  id: string,
  mutator: (doc: InvestigationDoc) => InvestigationDoc | void,
): Promise<InvestigationDoc> {
  const ref = db().collection(COLLECTION).doc(id);
  return db().runTransaction(async (tx) => {
    const snap = await tx.get(ref);
    if (!snap.exists) throw new Error("Investigation not found.");
    const doc = snap.data() as InvestigationDoc;
    const next = mutator(doc) ?? doc;
    next.updatedAt = new Date().toISOString();
    tx.set(ref, next);
    return next;
  });
}

export async function appendLogEntry(
  id: string,
  entry: Omit<LogEntry, "id">,
): Promise<LogEntry> {
  const full: LogEntry = { ...entry, id: newId() };
  await db()
    .collection(COLLECTION)
    .doc(id)
    .update({ log: FieldValue.arrayUnion(full), updatedAt: entry.at });
  return full;
}
