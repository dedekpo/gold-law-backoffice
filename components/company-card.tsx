"use client";

import { Fragment, useState } from "react";
import type { Case, CaseFile, DefendantCandidate } from "@/lib/types";
import {
  SOLVABILITY_LABELS,
  candidateEvidence,
  preferredServiceRecord,
  recordLabel,
} from "@/lib/display";
import { buildCompanyZip, companyZipFilename } from "@/lib/export";
import { ChevronIcon } from "./icons";
import { DownloadButton } from "./download-button";
import { FileThumbnail } from "./evidence";
import { SosRecordPanel } from "./sos";

/**
 * A single identified company inside a case. Co-locates everything tied to that
 * company — the agent's enrichment, the authoritative Secretary of State
 * record(s), and the originating evidence (Step 2) — so a reviewer sees proof
 * and defendant together. The Download action exports a self-describing
 * manifest of all of it (the foundation for the Step 3 zip bundle).
 */
export function CompanyCard({
  caseItem,
  candidate,
  onOpenFile,
}: {
  caseItem: Case;
  candidate: DefendantCandidate;
  onOpenFile: (file: CaseFile) => void;
}) {
  const [open, setOpen] = useState(true);
  const c = candidate;
  const records = c.sos_records ?? [];
  const serviceRecord = preferredServiceRecord(records);

  const agent = c.registered_agent;
  const agentDisplay =
    agent && (agent.name || agent.address || agent.state)
      ? [agent.name, agent.address, agent.state].filter(Boolean).join(" · ")
      : null;

  const rows: [string, string | null][] = [
    ["Legal name", c.legal_name],
    ["Website", c.website],
    ["Goods / services", c.goods_services],
    ["State of incorporation", c.state_of_incorporation],
    ["HQ mailing address", c.hq_mailing_address],
    ["Registered agent", agentDisplay],
    ["Employees", c.employees_estimate],
    ["Revenue", c.revenue_estimate],
    ["Solvability", SOLVABILITY_LABELS[c.solvability_tier]],
  ];

  return (
    <article className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center gap-2 p-4">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex flex-1 items-center gap-2.5 text-left"
          aria-expanded={open}
        >
          <ChevronIcon open={open} />
          <span className="flex flex-col gap-1">
            <span className="flex items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {c.company_name}
              {records.length > 0 && (
                <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                  SOS verified
                </span>
              )}
            </span>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              {c.goods_services ?? "—"} · {SOLVABILITY_LABELS[c.solvability_tier]}
            </span>
          </span>
        </button>
        <span className="shrink-0 text-xs text-zinc-400 dark:text-zinc-500">
          {Math.round(c.confidence * 100)}%
        </span>
        <DownloadButton
          title="Download this company's evidence + research as a zip"
          build={async () => ({
            filename: companyZipFilename(candidate),
            blob: await buildCompanyZip(caseItem, candidate),
          })}
        />
      </div>

      {open && (
        <div className="border-t border-zinc-200 bg-zinc-50 px-4 py-4 dark:border-zinc-800 dark:bg-zinc-900">
          <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-sm">
            {rows.map(([label, value]) => (
              <Fragment key={label}>
                <dt className="text-zinc-500 dark:text-zinc-400">{label}</dt>
                <dd className="break-words text-zinc-900 dark:text-zinc-100">
                  {label === "Website" && value ? (
                    <a
                      href={value}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-blue-600 underline dark:text-blue-400"
                    >
                      {value}
                    </a>
                  ) : (
                    value ?? "—"
                  )}
                </dd>
              </Fragment>
            ))}
          </dl>

          {/* Step 2: the proof this company came from, beside the company. */}
          <EvidenceStrip
            caseItem={caseItem}
            candidate={candidate}
            onOpenFile={onOpenFile}
          />

          <div className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
            <p className="mb-2 text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Official records (Secretary of State)
            </p>
            {records.length > 0 ? (
              <div className="flex flex-col gap-3">
                {records.map((rec, i) => (
                  <SosRecordPanel
                    key={`${rec.entityId ?? rec.entityName ?? "rec"}-${rec.searchState ?? ""}-${i}`}
                    sos={rec}
                    label={recordLabel(rec)}
                    preferredAgent={records.length > 1 && rec === serviceRecord}
                  />
                ))}
              </div>
            ) : (
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                No matching Secretary of State record was found for this entity.
              </p>
            )}
            {c.fl_check === "not_found" && (
              <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
                No Florida registration on file — Sunbiz was checked for a Florida
                foreign registration and none was found.
              </p>
            )}
            {c.fl_check === "error" && (
              <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
                Florida check didn&apos;t complete — retry to capture any Florida
                registered agent (preferred for service).
              </p>
            )}
          </div>

          {c.notes && (
            <p className="mt-3 border-t border-zinc-200 pt-3 text-sm text-zinc-700 dark:border-zinc-800 dark:text-zinc-300">
              {c.notes}
            </p>
          )}

          {c.sources.length > 0 && (
            <div className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
              <p className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                Sources
              </p>
              <ul className="mt-1 flex flex-col gap-1">
                {c.sources.map((src) => (
                  <li key={src}>
                    <a
                      href={src}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="break-all text-xs text-blue-600 underline dark:text-blue-400"
                    >
                      {src}
                    </a>
                  </li>
                ))}
              </ul>
            </div>
          )}
        </div>
      )}
    </article>
  );
}

/**
 * The originating evidence for THIS company, rendered on the company card — the
 * specific screenshot(s)/voicemail(s) the agent attributed to it. Falls back to
 * the whole case's files (with a note) when nothing could be attributed, so the
 * proof is never hidden.
 */
function EvidenceStrip({
  caseItem,
  candidate,
  onOpenFile,
}: {
  caseItem: Case;
  candidate: DefendantCandidate;
  onOpenFile: (file: CaseFile) => void;
}) {
  const { files, attributed } = candidateEvidence(caseItem.files, candidate, {
    allCandidates: caseItem.defendants,
  });
  if (files.length === 0) {
    // A registry-only company legitimately has no evidence tied to it — say so
    // plainly rather than hiding the section (which would look like a glitch).
    if (candidate.synthesized) {
      return (
        <div className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
          <p className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Originating evidence
          </p>
          <p className="text-[11px] text-zinc-400 dark:text-zinc-500">
            No specific evidence tied to this company — it was surfaced from the
            Secretary of State record, not from the case files.
          </p>
        </div>
      );
    }
    return null;
  }
  return (
    <div className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
      <p className="mb-2 text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        {attributed
          ? `Originating evidence (${files.length})`
          : `Case evidence (${files.length})`}
      </p>
      <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
        {files.map((file) => (
          <FileThumbnail
            key={file.id}
            file={file}
            onClick={() => onOpenFile(file)}
          />
        ))}
      </div>
      <p className="mt-2 text-[11px] text-zinc-400 dark:text-zinc-500">
        {attributed
          ? "The proof this company was identified from. Open a file to read its transcription / description."
          : "Could not tie specific files to this company — showing all case evidence. Open a file to read its transcription / description."}
      </p>
    </div>
  );
}
