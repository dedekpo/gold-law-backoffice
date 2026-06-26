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

/** One company inside the case bundle: its folder, evidence, and research. */
export type CaseCompanyEntry = {
  /** Folder within the zip, e.g. "companies/acme-loans-llc". */
  folder: string;
  /** False when no file could be attributed (this company has no evidence). */
  evidenceAttributed: boolean;
  company: DefendantCandidate;
  /** This company's evidence, at its path inside the zip. */
  evidence: EvidenceEntry[];
};

export type CaseManifest = {
  generatedAt: string;
  case: { id: string; name: string };
  evaluation: Case["evaluation"] | null;
  companies: CaseCompanyEntry[];
  unmatchedSosRecords: SosEntity[];
  /** Evidence not attributed to any identified company. */
  unattributedEvidence: EvidenceEntry[];
};

/** Folder for evidence the agent couldn't tie to any identified company. */
const UNATTRIBUTED_DIR = "Unattributed Evidence";

/** Source pairing used while building a zip: a file and its manifest entry. */
type ResolvedEvidence = { file: CaseFile; entry: EvidenceEntry };

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

/** Give every company a unique folder slug within the bundle. */
function uniqueSlug(used: Set<string>, slug: string): string {
  let candidate = slug;
  let i = 2;
  while (used.has(candidate)) candidate = `${slug}-${i++}`;
  used.add(candidate);
  return candidate;
}

/**
 * Resolve a set of case files to their final zip paths (deduping names), pairing
 * each manifest entry with the source file so the zip writer can fetch its bytes
 * at the exact same path the manifest advertises.
 */
function resolveEvidence(files: CaseFile[], folder: string): ResolvedEvidence[] {
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

/**
 * Assemble the complete record for one company within its case. By default
 * (`fallback` on) the evidence falls back to the whole case when the agent
 * couldn't attribute any file, so a single-company download is never empty. The
 * case bundle passes `fallback: false` so unattributed files go to their own
 * folder instead of being copied into every company.
 */
export function buildCompanyManifest(
  caseItem: Case,
  candidate: DefendantCandidate,
  options?: { fallback?: boolean },
): CompanyManifest {
  const { files, attributed } = candidateEvidence(
    caseItem.files,
    candidate,
    options,
  );
  return {
    generatedAt: new Date().toISOString(),
    case: { id: caseItem.id, name: caseItem.name },
    evaluation: caseItem.evaluation ?? null,
    company: candidate,
    evidenceAttributed: attributed,
    evidence: resolveEvidence(files, "evidence").map((r) => r.entry),
  };
}

/**
 * Lay out the whole case for bundling: each company gets its own folder holding
 * the evidence attributed to it, and any leftover (unattributed) evidence is
 * routed to a single shared folder. Returns the manifest plus the file→path
 * pairings the zip writer needs to add the raw bytes.
 */
function planCase(caseItem: Case): {
  manifest: CaseManifest;
  sources: ResolvedEvidence[];
} {
  const usedDirs = new Set<string>();
  const sources: ResolvedEvidence[] = [];
  const claimed = new Set<string>(); // file ids claimed by ≥1 company

  const companies: CaseCompanyEntry[] = (caseItem.defendants ?? []).map(
    (candidate) => {
      const folder = `companies/${uniqueSlug(
        usedDirs,
        slugify(candidate.legal_name || candidate.company_name),
      )}`;
      // Strict attribution: only this company's files (no whole-case fallback).
      const { files, attributed } = candidateEvidence(caseItem.files, candidate, {
        fallback: false,
      });
      files.forEach((f) => claimed.add(f.id));
      const resolved = resolveEvidence(files, `${folder}/evidence`);
      sources.push(...resolved);
      return {
        folder,
        evidenceAttributed: attributed,
        company: candidate,
        evidence: resolved.map((r) => r.entry),
      };
    },
  );

  const orphans = caseItem.files.filter((f) => !claimed.has(f.id));
  const orphanResolved = resolveEvidence(orphans, UNATTRIBUTED_DIR);
  sources.push(...orphanResolved);

  return {
    manifest: {
      generatedAt: new Date().toISOString(),
      case: { id: caseItem.id, name: caseItem.name },
      evaluation: caseItem.evaluation ?? null,
      companies,
      unmatchedSosRecords: caseItem.defendantUnmatchedSos ?? [],
      unattributedEvidence: orphanResolved.map((r) => r.entry),
    },
    sources,
  };
}

/** Assemble the case-level record: every company plus all of its evidence. */
export function buildCaseManifest(caseItem: Case): CaseManifest {
  return planCase(caseItem).manifest;
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
        .map((entry, i) =>
          [
            `COMPANY ${i + 1}  (folder: ${entry.folder}/)`,
            companyBlock(entry.company),
            "",
            `  EVIDENCE (${entry.evidence.length})`,
            evidenceText(entry.evidence),
          ].join("\n"),
        )
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
    `UNATTRIBUTED EVIDENCE (${manifest.unattributedEvidence.length}) — folder: ${UNATTRIBUTED_DIR}/`,
    evidenceText(manifest.unattributedEvidence),
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

/**
 * Build a single zip for an entire case. Each company gets its own folder
 * containing its manifest, summary, and the evidence attributed to it; evidence
 * tied to no company lands in the "Unattributed Evidence" folder.
 */
export async function buildCaseZip(caseItem: Case): Promise<Blob> {
  const { manifest, sources } = planCase(caseItem);
  const entries: Zippable = {
    "manifest.json": strToU8(JSON.stringify(manifest, null, 2)),
    "summary.txt": strToU8(caseSummaryText(manifest)),
  };
  // Each company folder mirrors a standalone company bundle: its own manifest +
  // summary alongside its evidence. Strict attribution (no whole-case fallback)
  // so files map to exactly one company or to the unattributed folder.
  for (const entry of manifest.companies) {
    const sub = buildCompanyManifest(caseItem, entry.company, { fallback: false });
    entries[`${entry.folder}/manifest.json`] = strToU8(
      JSON.stringify(sub, null, 2),
    );
    entries[`${entry.folder}/summary.txt`] = strToU8(companySummaryText(sub));
  }
  await addEvidence(entries, sources);
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
