import {
  BAND_LABELS,
  SCREEN_LABELS,
  SOLVABILITY_LABELS,
} from "./display";
import type { Case, DefendantCandidate, ScreenId } from "./types";

/**
 * GHL is the persistence layer for agent runs: a finished run is written to the
 * "AI Intake" opportunity custom fields (skim layer) plus a full PDF report in
 * the file field (deep-dive layer). The agent owns ONLY these fields — it never
 * writes to the human-maintained investigation fields.
 *
 * Field ids and option strings mirror the fields created in the location on
 * 2026-07-20; option values must match GHL's configured options VERBATIM
 * (emoji and en-dashes included) or the write is rejected.
 */

export const AI_FIELD_IDS = {
  /** SINGLE_OPTIONS — non-empty means the agent already ran (the marker). */
  runStatus: "UFkcagbreisiH6QfsyRE",
  /** TEXT — best company's score+band, e.g. "73/100 – Solid". */
  topScore: "CwzZVm9u3gG65LsOdenb",
  /** LARGE_TEXT — one line per identified company. */
  companiesFound: "TIjW8o67jYvpegZMs2RT",
  /** MULTIPLE_OPTIONS — screens that hit across companies. */
  violations: "bTbm4Tg4vpMkuyPXVSvO",
  /** LARGE_TEXT — compact per-company digest. */
  companySummary: "k14gqdaKuskhDM4mEhUC",
  /** LARGE_TEXT — agent narrative, search terms, flagged unknowns. */
  investigationNotes: "mEdxBRsMrIQgiqCQGGi2",
  /** FILE_UPLOAD — the full PDF report. */
  reportFiles: "N9Qej6haIjauLXbpUcUL",
} as const;

export const RUN_STATUS = {
  found: "✅ Completed – companies found",
  none: "☑️ Completed – no company identified",
  timeBarred: "⏸️ Declined – time-barred",
  noClaim: "❌ Declined – no plausible claim",
} as const;

/** Screen → the exact option string configured on "AI Violations Detected". */
const VIOLATION_OPTIONS: Record<ScreenId, string> = {
  prerecorded_voice: "Prerecorded Voice",
  failure_to_stop: "Failure to Stop (IDNC)",
  quiet_hours: "Quiet Hours",
  dnc_registry: "DNC Registry",
};

/**
 * LARGE_TEXT limit is undocumented; stay comfortably under it and point the
 * reader at the PDF when a digest gets cut.
 */
const MAX_TEXT_FIELD = 12_000;

const cap = (text: string): string =>
  text.length > MAX_TEXT_FIELD
    ? `${text.slice(0, MAX_TEXT_FIELD)}\n… truncated — full details in the AI Intake Report PDF.`
    : text;

export type AiFieldValues = {
  runStatus: string;
  topScore: string;
  companiesFound: string;
  violations: string[];
  companySummary: string;
  investigationNotes: string;
};

function scoreLabel(candidate: DefendantCandidate): string {
  const sc = candidate.scorecard;
  if (sc?.killCheck.declined) {
    return `Declined (${sc.killCheck.reason === "job_scam" ? "job/employment scam" : "true healthcare"})`;
  }
  if (candidate.track === "debt_collection") {
    return "Debt collection track (not TCPA-scored)";
  }
  if (!sc) return "Not scored";
  return `${sc.final}/100 – ${BAND_LABELS[sc.band]}`;
}

function companyLine(candidate: DefendantCandidate): string {
  const name = candidate.legal_name || candidate.company_name;
  const confidence = `${Math.round(candidate.confidence * 100)}% confidence`;
  return `${name} — ${scoreLabel(candidate)} (${confidence})`;
}

function companyBlock(candidate: DefendantCandidate): string {
  const lines: string[] = [companyLine(candidate)];
  const brand =
    candidate.legal_name &&
    candidate.company_name &&
    candidate.legal_name !== candidate.company_name
      ? ` (brand: ${candidate.company_name})`
      : "";
  if (brand) lines[0] = lines[0].replace(" — ", `${brand} — `);

  const profile = [
    `Solvability: ${SOLVABILITY_LABELS[candidate.solvability_tier]}`,
    candidate.employees_estimate && `Employees: ${candidate.employees_estimate}`,
    candidate.revenue_estimate && `Revenue: ${candidate.revenue_estimate}`,
  ]
    .filter(Boolean)
    .join(" · ");
  if (profile) lines.push(profile);

  const hits = (candidate.screens ?? []).filter((s) => s.hit);
  if (hits.length) {
    for (const s of hits) {
      lines.push(`${SCREEN_LABELS[s.screen]}: ${s.basis}`);
    }
  } else if (candidate.scorecard && !candidate.scorecard.killCheck.declined) {
    lines.push("No screen hit for this company's evidence.");
  }

  const agent = candidate.registered_agent;
  if (agent?.name || agent?.address) {
    lines.push(
      `Serve: ${[agent.name, agent.address, agent.state].filter(Boolean).join(", ")}`,
    );
  }
  const sos = candidate.sos_records ?? [];
  lines.push(
    sos.length
      ? `SOS records: ${sos
          .map((r) =>
            [r.searchState ?? r.jurisdiction, r.status].filter(Boolean).join(" – "),
          )
          .join("; ")}`
      : "SOS records: none found.",
  );
  const unknowns = candidate.scorecard?.unknowns ?? [];
  if (unknowns.length) {
    lines.push(`Needs intake to confirm: ${unknowns.join(" | ")}`);
  }
  return lines.join("\n");
}

/** Aggregate a terminal-state case into the AI Intake field values. */
export function buildAiFieldValues(caseItem: Case): AiFieldValues {
  const gate = caseItem.gate;
  const companies = caseItem.defendants ?? [];

  const runStatus = gate?.declined
    ? gate.declineReason === "time-barred"
      ? RUN_STATUS.timeBarred
      : RUN_STATUS.noClaim
    : companies.length > 0
      ? RUN_STATUS.found
      : RUN_STATUS.none;

  const scored = companies.filter(
    (c) => c.scorecard && !c.scorecard.killCheck.declined,
  );
  const best = scored.reduce<DefendantCandidate | null>(
    (top, c) =>
      !top || (c.scorecard!.final ?? 0) > (top.scorecard!.final ?? 0) ? c : top,
    null,
  );
  const topScore = best
    ? `${best.scorecard!.final}/100 – ${BAND_LABELS[best.scorecard!.band]}`
    : "";

  const violations = [
    ...new Set(
      companies.flatMap((c) =>
        (c.screens ?? [])
          .filter((s) => s.hit)
          .map((s) => VIOLATION_OPTIONS[s.screen]),
      ),
    ),
  ];

  const notes: string[] = [];
  const dnc = caseItem.dnc;
  notes.push(
    dnc?.national || dnc?.florida
      ? `DNC registrations attested by manual lookup: ${[
          dnc.national && "National",
          dnc.florida && "Florida",
        ]
          .filter(Boolean)
          .join(", ")}.`
      : "DNC registrations: not confirmed (no manual lookup attested).",
  );
  if (gate) {
    if (gate.declined) {
      notes.push(
        `Intake gate: DECLINED — ${
          gate.declineReason === "time-barred"
            ? "every dated message is past the 4-year SOL window"
            : "no plausible claim (informational messages only)"
        }.`,
      );
    }
    if (gate.notifyLeadImmediately) {
      notes.push("(!) NOTIFY THE LEAD IMMEDIATELY — statute-of-limitations problem.");
    }
    for (const u of gate.unknowns ?? []) notes.push(`Gate: ${u}`);
  }
  if (caseItem.defendantInvestigation) {
    notes.push("", caseItem.defendantInvestigation.trim());
  }
  if (caseItem.defendantSearchTerms?.length) {
    notes.push("", `Search terms: ${caseItem.defendantSearchTerms.join(" · ")}`);
  }
  if (caseItem.defendantSosError) {
    notes.push(`SOS lookup issue: ${caseItem.defendantSosError}`);
  }
  if (caseItem.defendantUnmatchedSos?.length) {
    notes.push(
      `${caseItem.defendantUnmatchedSos.length} official record(s) found that matched no company — see the PDF.`,
    );
  }

  return {
    runStatus,
    topScore,
    companiesFound: cap(companies.map(companyLine).join("\n")),
    violations,
    companySummary: cap(
      companies.map(companyBlock).join("\n\n" + "-".repeat(40) + "\n\n"),
    ),
    investigationNotes: cap(notes.join("\n").trim()),
  };
}
