// Export helpers for the intake handoff. A "found company" (or a whole case) is
// packaged into a single .zip the intakers can file: the raw audio/image
// evidence, their transcriptions, the TCPA evaluation, the company enrichment,
// and the authoritative Secretary of State record(s). Each zip carries both a
// machine-readable `manifest.json` (shaped to map cleanly onto the coming
// database record) and a human-readable `summary.txt`.

import { strToU8, zipSync, type Zippable } from "fflate";
import {
  SOLVABILITY_LABELS,
  candidateEvidence,
  categoryLabel,
  joinAddress,
  messageTypeLabel,
  recordLabel,
} from "./display";
import type { Case, CaseFile, DefendantCandidate, SosEntity } from "./types";

/** One evidence file as it appears in a manifest (and at this path in the zip). */
export type EvidenceEntry = {
  name: string;
  kind: string;
  /** Transcription (audio) or description (image). */
  text: string | null;
  /** Path the raw file lives at inside the zip (e.g. "evidence/voicemail.mp3"). */
  file: string;
};

export type CompanyManifest = {
  generatedAt: string;
  case: { id: string; name: string };
  evaluation: Case["evaluation"] | null;
  company: DefendantCandidate;
  /**
   * Whether `evidence` is the file(s) attributed to this specific company
   * (true) or a fallback to the whole case because none could be attributed.
   */
  evidenceAttributed: boolean;
  evidence: EvidenceEntry[];
};

export type CaseManifest = {
  generatedAt: string;
  case: { id: string; name: string };
  evaluation: Case["evaluation"] | null;
  companies: DefendantCandidate[];
  unmatchedSosRecords: SosEntity[];
  evidence: EvidenceEntry[];
};

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 60) || "untitled"
  );
}

/** Give every file a unique, filesystem-safe name within one zip folder. */
function uniqueName(used: Set<string>, name: string): string {
  const safe = name.replace(/[/\\]/g, "_") || "file";
  if (!used.has(safe)) {
    used.add(safe);
    return safe;
  }
  const dot = safe.lastIndexOf(".");
  const stem = dot > 0 ? safe.slice(0, dot) : safe;
  const ext = dot > 0 ? safe.slice(dot) : "";
  let i = 2;
  let candidate = `${stem} (${i})${ext}`;
  while (used.has(candidate)) candidate = `${stem} (${++i})${ext}`;
  used.add(candidate);
  return candidate;
}

/**
 * Resolve a set of case files to their final zip paths (deduping names), pairing
 * each manifest entry with the source file so the zip writer can fetch its bytes
 * at the exact same path the manifest advertises.
 */
function resolveEvidence(
  files: CaseFile[],
  folder: string,
): Array<{ file: CaseFile; entry: EvidenceEntry }> {
  const used = new Set<string>();
  return files.map((file) => {
    const zipName = uniqueName(used, file.name);
    return {
      file,
      entry: {
        name: file.name,
        kind: file.kind,
        text: file.text ?? null,
        file: `${folder}/${zipName}`,
      },
    };
  });
}

/** Assemble the complete record for one company within its case. */
export function buildCompanyManifest(
  caseItem: Case,
  candidate: DefendantCandidate,
): CompanyManifest {
  // Only the evidence tied to this company (falls back to the whole case when
  // the agent couldn't attribute), so each company's bundle is self-contained.
  const { files, attributed } = candidateEvidence(caseItem.files, candidate);
  return {
    generatedAt: new Date().toISOString(),
    case: { id: caseItem.id, name: caseItem.name },
    evaluation: caseItem.evaluation ?? null,
    company: candidate,
    evidenceAttributed: attributed,
    evidence: resolveEvidence(files, "evidence").map((r) => r.entry),
  };
}

/** Assemble the case-level record: every company plus all of its evidence. */
export function buildCaseManifest(caseItem: Case): CaseManifest {
  return {
    generatedAt: new Date().toISOString(),
    case: { id: caseItem.id, name: caseItem.name },
    evaluation: caseItem.evaluation ?? null,
    companies: caseItem.defendants ?? [],
    unmatchedSosRecords: caseItem.defendantUnmatchedSos ?? [],
    evidence: resolveEvidence(caseItem.files, "evidence").map((r) => r.entry),
  };
}

// --- Readable summaries -------------------------------------------------------

const DIV = "=".repeat(60);
const dash = (label: string, value: string | null | undefined) =>
  `  ${label}: ${value && String(value).trim() ? value : "—"}`;

function sosRecordText(sos: SosEntity): string {
  const lines = [
    `  [${recordLabel(sos)}]`,
    dash("    Legal name", sos.entityName),
    dash("    Status", sos.status),
    dash("    Entity type", sos.entityType),
    dash("    State of formation", sos.jurisdiction),
    dash("    Formation date", sos.formationDate),
    dash("    Entity ID", sos.entityId),
    dash("    FEI / EIN", sos.feiEinNumber),
    dash(
      "    Principal address",
      joinAddress([
        sos.principalAddress,
        sos.principalCity,
        sos.principalState,
        sos.principalZip,
      ]),
    ),
    dash(
      "    Mailing address",
      joinAddress([
        sos.mailingAddress,
        sos.mailingCity,
        sos.mailingState,
        sos.mailingZip,
      ]),
    ),
    dash("    Registered agent", sos.registeredAgentName),
    dash(
      "    Agent address",
      joinAddress([
        sos.registeredAgentAddress,
        sos.registeredAgentCity,
        sos.registeredAgentState,
        sos.registeredAgentZip,
      ]),
    ),
    dash("    Filing URL", sos.sosUrl),
  ];
  const officers = (sos.officers ?? [])
    .map((o) => [o.title, o.name, o.address].filter(Boolean).join(" · "))
    .filter(Boolean);
  if (officers.length) {
    lines.push("    Officers / directors:");
    for (const o of officers) lines.push(`      - ${o}`);
  }
  return lines.join("\n");
}

function evaluationText(evaluation: Case["evaluation"] | null): string {
  if (!evaluation) return "  (not evaluated)";
  return [
    dash("  Score", `${evaluation.score}/10`),
    dash("  Category", categoryLabel(evaluation.category)),
    dash("  Message type", messageTypeLabel(evaluation.message_type)),
    `  Reasoning:\n    ${evaluation.reasoning.replace(/\n/g, "\n    ")}`,
  ].join("\n");
}

function evidenceText(evidence: EvidenceEntry[]): string {
  if (evidence.length === 0) return "  (no evidence files)";
  return evidence
    .map((e) => {
      const head = `  - ${e.name} [${e.kind}] → ${e.file}`;
      if (!e.text) return head;
      const label = e.kind === "audio" ? "Transcription" : "Description";
      return `${head}\n    ${label}:\n    ${e.text.replace(/\n/g, "\n    ")}`;
    })
    .join("\n\n");
}

function companyBlock(candidate: DefendantCandidate): string {
  const agent = candidate.registered_agent;
  const records = candidate.sos_records ?? [];
  const out = [
    dash("  Brand name", candidate.company_name),
    dash("  Legal name", candidate.legal_name),
    dash("  Confidence", `${Math.round(candidate.confidence * 100)}%`),
    dash("  Goods / services", candidate.goods_services),
    dash("  Solvability", SOLVABILITY_LABELS[candidate.solvability_tier]),
    dash("  Website", candidate.website),
    dash("  State of incorporation", candidate.state_of_incorporation),
    dash("  HQ / mailing address", candidate.hq_mailing_address),
    dash("  Employees", candidate.employees_estimate),
    dash("  Revenue", candidate.revenue_estimate),
    "",
    "  WHO TO SERVE (registered agent):",
    dash("    Name", agent?.name),
    dash("    Address", agent?.address),
    dash("    State", agent?.state),
  ];
  if (records.length) {
    out.push("", "  OFFICIAL RECORDS (Secretary of State):");
    for (const rec of records) out.push(sosRecordText(rec));
  } else {
    out.push("", "  OFFICIAL RECORDS: none found.");
  }
  if (candidate.notes) out.push("", `  Notes: ${candidate.notes}`);
  if (candidate.sources.length) {
    out.push("", "  Sources:");
    for (const s of candidate.sources) out.push(`    - ${s}`);
  }
  return out.join("\n");
}

/** Human-readable handoff for a single company. */
export function companySummaryText(manifest: CompanyManifest): string {
  return [
    DIV,
    "GOLD LAW — COMPANY HANDOFF",
    DIV,
    `Generated: ${manifest.generatedAt}`,
    `Case: ${manifest.case.name} (${manifest.case.id})`,
    "",
    "COMPANY",
    companyBlock(manifest.company),
    "",
    "TCPA EVALUATION",
    evaluationText(manifest.evaluation),
    "",
    `EVIDENCE (${manifest.evidence.length})${
      manifest.evidenceAttributed
        ? ""
        : " — could not tie specific files to this company; all case evidence included"
    }`,
    evidenceText(manifest.evidence),
    "",
  ].join("\n");
}

/** Human-readable handoff for an entire case. */
export function caseSummaryText(manifest: CaseManifest): string {
  const companies = manifest.companies.length
    ? manifest.companies
        .map((c, i) => `COMPANY ${i + 1}\n${companyBlock(c)}`)
        .join(`\n\n${"-".repeat(60)}\n\n`)
    : "(no companies identified)";
  const unmatched = manifest.unmatchedSosRecords.length
    ? [
        "",
        "ADDITIONAL OFFICIAL RECORDS (not tied to a company)",
        ...manifest.unmatchedSosRecords.map(sosRecordText),
      ].join("\n")
    : "";
  return [
    DIV,
    "GOLD LAW — CASE HANDOFF",
    DIV,
    `Generated: ${manifest.generatedAt}`,
    `Case: ${manifest.case.name} (${manifest.case.id})`,
    "",
    "TCPA EVALUATION",
    evaluationText(manifest.evaluation),
    "",
    `IDENTIFIED COMPANIES (${manifest.companies.length})`,
    companies,
    unmatched,
    "",
    `EVIDENCE (${manifest.evidence.length})`,
    evidenceText(manifest.evidence),
    "",
  ].join("\n");
}

// --- Zip building -------------------------------------------------------------

async function fileBytes(file: CaseFile): Promise<Uint8Array> {
  const res = await fetch(file.url);
  if (!res.ok) throw new Error(`Could not read "${file.name}" (${res.status}).`);
  return new Uint8Array(await res.arrayBuffer());
}

/** Fetch the raw bytes for resolved evidence and add them to a zip payload. */
async function addEvidence(
  entries: Zippable,
  resolved: Array<{ file: CaseFile; entry: EvidenceEntry }>,
): Promise<void> {
  const bytes = await Promise.all(resolved.map((r) => fileBytes(r.file)));
  resolved.forEach((r, i) => {
    entries[r.entry.file] = bytes[i];
  });
}

/** Build a self-contained zip for one identified company. */
export async function buildCompanyZip(
  caseItem: Case,
  candidate: DefendantCandidate,
): Promise<Blob> {
  const manifest = buildCompanyManifest(caseItem, candidate);
  const { files } = candidateEvidence(caseItem.files, candidate);
  const entries: Zippable = {
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
    "summary.txt": strToU8(companySummaryText(manifest)),
  };
  await addEvidence(entries, resolveEvidence(files, "evidence"));
  return new Blob([zipSync(entries, { level: 0 })], { type: "application/zip" });
}

/** Build a single zip for an entire case (all companies + all evidence). */
export async function buildCaseZip(caseItem: Case): Promise<Blob> {
  const manifest = buildCaseManifest(caseItem);
  const entries: Zippable = {
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
    "summary.txt": strToU8(caseSummaryText(manifest)),
  };
  // Per-company sub-manifests/summaries so each defendant is filed on its own.
  for (const candidate of manifest.companies) {
    const sub = buildCompanyManifest(caseItem, candidate);
    const dir = `companies/${slugify(candidate.legal_name || candidate.company_name)}`;
    entries[`${dir}/manifest.json`] = strToU8(JSON.stringify(sub, null, 2));
    entries[`${dir}/summary.txt`] = strToU8(companySummaryText(sub));
  }
  await addEvidence(entries, resolveEvidence(caseItem.files, "evidence"));
  return new Blob([zipSync(entries, { level: 0 })], { type: "application/zip" });
}

export function companyZipFilename(candidate: DefendantCandidate): string {
  return `${slugify(candidate.legal_name || candidate.company_name)}.zip`;
}

export function caseZipFilename(caseItem: Case): string {
  return `${slugify(caseItem.name)}.zip`;
}

/** Trigger a client-side download of a Blob. */
export function downloadBlob(filename: string, blob: Blob): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);
}
