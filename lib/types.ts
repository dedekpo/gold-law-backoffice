// Shared domain types for the intake/triage flow. Kept framework-agnostic and
// in one place so the UI, the API routes, and the coming database layer all
// speak the same shapes.

export type FileKind = "audio" | "image";
export type FileStatus = "processing" | "done" | "error";

export type ScreeningStatus = "idle" | "evaluating" | "done" | "error";
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

// ---------------------------------------------------------------------------
// Screening & scoring domain — see docs/screening-spec.md and docs/scoring-spec.md.
// The LLM extraction pass produces `EvidenceFacts`; the deterministic screening
// engine produces `IntakeGate` + `ScreenResult[]` + `KillCheck`; the deterministic
// scoring engine produces `Scorecard`. No score is ever LLM-generated.
// ---------------------------------------------------------------------------

/** Which legal pipeline a violation belongs to. */
export type Track = "tcpa" | "debt_collection";

export type MessageType =
  | "marketing"
  | "debt_collection"
  | "informational"
  | "unknown";
export type ContactChannel = "text" | "call" | "voicemail" | "email" | "unknown";
export type ContactDirection = "from_consumer" | "from_company" | "unknown";
/** Auto-decline signals (scoring-spec §2). Device marketing is NOT true_healthcare. */
export type KillSignal = "job_scam" | "true_healthcare" | "none";
/** Consent posture for Defensibility (scoring-spec §3.6). */
export type ConsentSignal =
  | "cold_contact"
  | "ambiguous"
  | "prior_relationship"
  | "unknown";

/** One normalized message/contact extracted from a single piece of evidence. */
export type ExtractedContact = {
  /** Filename of the evidence this contact came from (matches CaseFile.name). */
  file: string;
  /**
   * 1-based chronological position of this message in the overall conversation
   * timeline (oldest → newest), shared across ALL files: the same message shown
   * in two overlapping screenshots gets ONE sequence. Screening relies on this
   * for message order (e.g. "STOP, then a later contact") so an untimestamped
   * bubble can't scramble the timeline. See screening-spec §4.
   */
  sequence: number;
  direction: ContactDirection;
  channel: ContactChannel;
  /**
   * Timestamp shown in the evidence (ISO 8601), treated as the consumer's LOCAL
   * time per screening-spec §4 (Quiet Hours). Null if none is visible.
   */
  timestamp: string | null;
  /**
   * True when `timestamp` was INFERRED from neighbouring messages (the message
   * had no visible time of its own — e.g. a sent "Stop" bubble) rather than read
   * directly. Screening must not trust an inferred timestamp for time-gap math;
   * it falls back to `sequence` order instead.
   */
  timestampInferred: boolean;
  /**
   * Receipt date (ISO `YYYY-MM-DD`) for the SOL clock — set ONLY when a 4-digit
   * year is explicitly visible in the evidence; null otherwise. We never store a
   * guessed year (see `dateReceivedYearShown`).
   */
  dateReceived: string | null;
  /**
   * Whether a 4-digit year was actually visible for this date. Messaging/email
   * apps show only month/day for recent (current-year) messages and add the year
   * only for OLDER ones — so a date with no visible year is treated as
   * current-year / in-window, and only an explicit-year date can be time-barred.
   * See screening-spec §1.
   */
  dateReceivedYearShown: boolean;
  messageType: MessageType;
  /** The consumer asked to stop ("stop", "unsubscribe", "remove me", …). */
  isStopRequest: boolean;
  /** A single automated "you've been opted out" confirmation (carve-out, not a violation). */
  isOptOutConfirmation: boolean;
  /** Audio only: the voicemail is pre-recorded / artificial (corroborated by forensics). */
  isPrerecorded: boolean;
  consentSignal: ConsentSignal;
  killSignal: KillSignal;
  /** Short factual summary of the message content. */
  contentSummary: string;
};

/** The normalized fact set for a whole intake, produced by the extraction pass. */
export type EvidenceFacts = {
  contacts: ExtractedContact[];
  /** Free-form items the extractor flagged worth confirming at intake. */
  notes?: string[];
};

export type IntakeDeclineReason = "time-barred" | "no-claim-informational";

/** Intake-level gate outcome (screening-spec §1–2), computed before identification. */
export type IntakeGate = {
  /** At least one qualifying message is inside the viable SOL window. */
  solPass: boolean;
  /** SOP: an SOL problem means the lead must be told immediately. */
  notifyLeadImmediately: boolean;
  /** At least one in-window message shows a potential violation. */
  hasPlausibleClaim: boolean;
  /** True when the intake is rejected here (no identification runs). */
  declined: boolean;
  declineReason?: IntakeDeclineReason;
  /** Flagged unknowns surfaced at the gate (e.g. unconfirmed message dates). */
  unknowns?: string[];
};

export type ScreenId =
  | "prerecorded_voice"
  | "failure_to_stop"
  | "quiet_hours"
  | "dnc_registry";

/**
 * Operator-attested DNC registrations, ticked by an intaker AFTER a manual
 * lookup on the registry sites confirmed the client's number. Unchecked means
 * "not confirmed" — either nobody looked or the lookup came back negative —
 * and keeps the screen in its unverified state; it never means a verified
 * non-registration. Interim input until the registry API check lands.
 */
export type DncStatus = {
  /** National DNC registry (federal — Claim Tier 4, needs ≥2 telemarketing contacts). */
  national: boolean;
  /** Florida DNC list (Claim Tier 2, a single telemarketing contact suffices). */
  florida: boolean;
};

/** Result of one of the four screens for one company (screening-spec §4). */
export type ScreenResult = {
  screen: ScreenId;
  hit: boolean;
  /** Which track the hit belongs to; null when the screen did not hit. */
  track: Track | null;
  /** Human-readable basis citing the evidence. */
  basis: string;
  /** Applicable but unconfirmable (e.g. DNC needs the API). MVP: Screen 04. */
  unverified?: boolean;
  /** DNC only: claim tiers unlocked by confirmed registrations (2 = FL, 4 = national). */
  dncTiers?: Array<2 | 4>;
};

export type KillReason = "job_scam" | "true_healthcare";

/** Auto-decline outcome for one company (scoring-spec §2). */
export type KillCheck = {
  declined: boolean;
  reason?: KillReason;
  basis?: string;
};

export type Band = "priority" | "solid" | "marginal" | "pass";

/** One scored factor in the scorecard (scoring-spec §3). */
export type ScoreFactor = {
  name: string;
  points: number;
  max: number;
  /** How the points were arrived at, citing the evidence/enrichment. */
  basis: string;
};

/** The per-company TCPA IQ scorecard (scoring-spec §6). */
export type Scorecard = {
  factors: ScoreFactor[];
  /** Additive sum of the six factors before any cap. */
  raw: number;
  /** True when the shell cap reduced the final score. */
  capApplied: boolean;
  final: number;
  band: Band;
  killCheck: KillCheck;
  /** "Needs intake to confirm" items that could move the score. */
  unknowns: string[];
};

/** Days of filing runway required before the 4-year SOL cutoff; under this → reject. */
export const SOL_BUFFER_DAYS = 30;

/**
 * Optional willfulness bonus for high contact volume (scoring-spec §3.3).
 * Default OFF — a deliberate, documented deviation from "highest single applies".
 */
export const HIGH_VOLUME_WILLFULNESS = {
  enabled: false,
  threshold: 10,
  bonus: 6,
} as const;

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
  // --- Per-company screening + scoring (populated after identification) ---
  /** Which pipeline this company falls into. Debt-collection companies are not TCPA-scored. */
  track?: Track;
  /** The four screens evaluated over this company's attributed evidence. */
  screens?: ScreenResult[];
  /** The TCPA IQ scorecard. Absent for debt-collection-track or declined companies. */
  scorecard?: Scorecard;
};

export type DefendantReport = {
  candidates: DefendantCandidate[];
  search_terms_used: string[];
  sos_records?: SosEntity[];
  unmatched_sos_records?: SosEntity[];
  sos_error?: string;
  /** The agent's written investigation narrative (why it did/didn't find a company). */
  investigation_summary?: string;
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
  /** Operator-attested DNC registrations captured when the case was created. */
  dnc?: DncStatus;
  /** Id of the GHL opportunity this case was imported from, when applicable. */
  opportunityId?: string;
  /** Saving the finished run to the opportunity's "AI Intake Report" note. */
  reportStatus?: "saving" | "done" | "error";
  reportError?: string;
  /** Normalized facts extracted from the evidence; input to screening + scoring. */
  facts?: EvidenceFacts;
  /** Intake-level gate outcome (SOL + plausible-claim). Set by the extraction step. */
  gate?: IntakeGate;
  /** Status of the extraction + intake-gate screening step. */
  screeningStatus: ScreeningStatus;
  /** Error from the screening step, if it failed. */
  screeningError?: string;
  defendantStatus: DefendantStatus;
  /** Id of the background investigation job, set while it is running/polling. */
  defendantJobId?: string;
  defendants?: DefendantCandidate[];
  defendantError?: string;
  defendantSosError?: string;
  defendantUnmatchedSos?: SosEntity[];
  /** The queries the agent investigated (numbers, brands, phrases). */
  defendantSearchTerms?: string[];
  /** The agent's written investigation narrative — shown when no company is identified. */
  defendantInvestigation?: string;
};
