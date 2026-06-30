// Shared domain types for the intake/triage flow. Kept framework-agnostic and
// in one place so the UI, the API routes, and the coming database layer all
// speak the same shapes.

export type FileKind = "audio" | "image";
export type FileStatus = "processing" | "done" | "error";

export type EvaluationStatus = "idle" | "evaluating" | "done" | "error";
export type DefendantStatus = "idle" | "identifying" | "done" | "error";

/** One factor supporting the forensic automation assessment. */
export type ForensicFactor = {
  /** Short technical label, e.g. "Uniform cadence" or "Ambient silence". */
  name: string;
  /** Why this audio cue suggests automation or human origin. */
  explanation: string;
};

/**
 * Audio forensic analysis of a recorded voicemail — whether it is an automated /
 * pre-recorded drop vs. a live human recording. Written to be filed as evidence.
 */
export type AudioForensics = {
  /** 0 (clearly human) to 10 (clearly automated/pre-recorded). */
  automated_likelihood: number;
  /** Headline conclusion: is this likely a pre-recorded/automated message. */
  is_likely_prerecorded: boolean;
  /** The acoustic/technical cues behind the assessment. */
  factors: ForensicFactor[];
  /** Dynamic insertion ("Hi Courtney") vs. AI voice cloning vs. none. */
  personalization_analysis: string;
};

/** One piece of originating evidence in a case (a voicemail or a screenshot). */
export type CaseFile = {
  id: string;
  name: string;
  kind: FileKind;
  /** Object URL for in-browser playback/preview (session-only until the DB lands). */
  url: string;
  status: FileStatus;
  /** Transcription (audio) or description (image), once processed. */
  text?: string;
  error?: string;
  /** Audio-only: forensic automation analysis, run after transcription. */
  forensicsStatus?: FileStatus;
  forensics?: AudioForensics;
  forensicsError?: string;
};

/** The TCPA rubric evaluation for a case. */
export type Evaluation = {
  score: number;
  category: string;
  message_type: string;
  needs_external_check: string[];
  reasoning: string;
};

export type RegisteredAgent = {
  name: string | null;
  address: string | null;
  state: string | null;
};

/**
 * Official Secretary of State record (from OpenSOSData via the agent). Every
 * field is optional because coverage varies by state; extra fields a state
 * returns are preserved via the index signature so nothing in the enrichment is
 * lost.
 */
export type SosEntity = {
  entityName?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  status?: string | null;
  formationDate?: string | null;
  registeredAgentName?: string | null;
  registeredAgentAddress?: string | null;
  registeredAgentCity?: string | null;
  registeredAgentState?: string | null;
  registeredAgentZip?: string | null;
  principalAddress?: string | null;
  principalCity?: string | null;
  principalState?: string | null;
  principalZip?: string | null;
  mailingAddress?: string | null;
  mailingCity?: string | null;
  mailingState?: string | null;
  mailingZip?: string | null;
  officers?:
    | Array<{ name?: string | null; title?: string | null; address?: string | null }>
    | null;
  jurisdiction?: string | null;
  searchState?: string | null;
  feiEinNumber?: string | null;
  sosUrl?: string | null;
  scrapedAt?: string | null;
  [key: string]: unknown;
};

/** Outcome of the mandatory Florida cross-lookup for a company. */
export type FlCheckStatus = "found" | "not_found" | "error" | "not_applicable";

/** A company the agent identified behind a case's evidence. */
export type DefendantCandidate = {
  company_name: string;
  legal_name: string | null;
  website: string | null;
  goods_services: string | null;
  state_of_incorporation: string | null;
  hq_mailing_address: string | null;
  registered_agent: RegisteredAgent | null;
  employees_estimate: string | null;
  revenue_estimate: string | null;
  solvability_tier: "risk" | "good" | "whale" | "unknown";
  confidence: number;
  sources: string[];
  // Exact filenames of the originating evidence (audio/image) this company was
  // identified from, so proof and defendant stay linked. Matched against
  // CaseFile.name. Empty when no specific file could be attributed.
  evidence_files: string[];
  notes: string | null;
  // Every official record matched to this company: the home/domestic
  // registration plus any Florida foreign registration from the cross-lookup.
  sos_records?: SosEntity[];
  // Outcome of the Florida cross-lookup, so the UI can show FL was checked.
  fl_check?: FlCheckStatus;
  // True when this company was surfaced purely from a Secretary of State record
  // (the investigator never tied it to the evidence). Such a company must NOT
  // claim the case's evidence as its proof — it came from the registry, not the
  // files. See candidateEvidence.
  synthesized?: boolean;
};

export type DefendantReport = {
  candidates: DefendantCandidate[];
  search_terms_used: string[];
  sos_records?: SosEntity[];
  unmatched_sos_records?: SosEntity[];
  sos_error?: string;
};

/** A case: the evidence sent in, plus everything derived from it. */
export type Case = {
  id: string;
  name: string;
  /** When the case was created (ms epoch) — start of the processing clock. */
  createdAt: number;
  /** When processing reached a terminal state (ms epoch); freezes the clock. */
  completedAt?: number;
  files: CaseFile[];
  evaluationStatus: EvaluationStatus;
  evaluation?: Evaluation;
  evaluationError?: string;
  defendantStatus: DefendantStatus;
  /** Id of the background investigation job, set while it is running/polling. */
  defendantJobId?: string;
  defendants?: DefendantCandidate[];
  defendantError?: string;
  defendantSosError?: string;
  defendantUnmatchedSos?: SosEntity[];
};
