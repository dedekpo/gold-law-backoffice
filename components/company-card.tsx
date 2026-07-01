"use client";

import { Fragment, useState } from "react";
import type {
  Case,
  CaseFile,
  DefendantCandidate,
  KillReason,
  ScreenResult,
} from "@/lib/types";
import {
  FACTOR_TOOLTIPS,
  SCREEN_LABELS,
  SOLVABILITY_LABELS,
  TRACK_LABELS,
  bandTone,
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
            <span className="flex flex-wrap items-center gap-2 text-sm font-semibold text-zinc-900 dark:text-zinc-100">
              {c.company_name}
              <ScoreBandChip candidate={c} />
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
          <ScorecardPanel candidate={c} />
          <ScreensPanel screens={c.screens ?? []} />

          <dl className="mt-4 grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-sm">
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

const KILL_REASON_LABELS: Record<KillReason, string> = {
  job_scam: "Job / employment scam",
  true_healthcare: "True healthcare services",
};

/** Small score/band chip shown beside the company name. */
function ScoreBandChip({ candidate }: { candidate: DefendantCandidate }) {
  if (candidate.track === "debt_collection" && !candidate.scorecard) {
    return (
      <span className="rounded-full bg-purple-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-purple-800 dark:bg-purple-950 dark:text-purple-200">
        Debt collection
      </span>
    );
  }
  const sc = candidate.scorecard;
  if (!sc) return null;
  if (sc.killCheck.declined) {
    return (
      <span className="rounded-full bg-red-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-red-800 dark:bg-red-950 dark:text-red-200">
        Declined
      </span>
    );
  }
  const tone = bandTone(sc.band);
  return (
    <span
      className={`rounded-full px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide ${tone.chip}`}
    >
      {sc.final}/100 · {tone.label}
    </span>
  );
}

/** An info icon that reveals an explanatory tooltip on hover/focus. */
function InfoTooltip({ text }: { text: string }) {
  return (
    <span className="group relative ml-1 inline-flex align-middle">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={1.7}
        aria-hidden
        tabIndex={0}
        className="h-3.5 w-3.5 cursor-help text-zinc-400 outline-none dark:text-zinc-500"
      >
        <path
          strokeLinecap="round"
          strokeLinejoin="round"
          d="M11.25 11.25h.75v3.75h.75M12 8.25h.008M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"
        />
      </svg>
      <span
        role="tooltip"
        className="pointer-events-none absolute left-0 top-full z-30 mt-1.5 w-60 rounded-md bg-zinc-900 px-2.5 py-1.5 text-[11px] font-normal leading-snug text-zinc-50 opacity-0 shadow-lg transition-opacity duration-100 group-hover:opacity-100 group-focus-within:opacity-100 dark:bg-zinc-700 dark:text-zinc-100"
      >
        {text}
      </span>
    </span>
  );
}

/** Full TCPA IQ scorecard for the company (scoring-spec §6). */
function ScorecardPanel({ candidate }: { candidate: DefendantCandidate }) {
  if (candidate.track === "debt_collection" && !candidate.scorecard) {
    return (
      <div className="rounded-lg border border-purple-200 bg-purple-50 p-3 dark:border-purple-900 dark:bg-purple-950">
        <p className="text-sm font-semibold text-purple-800 dark:text-purple-200">
          Debt collection — separate track
        </p>
        <p className="mt-1 text-xs text-purple-700 dark:text-purple-300">
          A STOP request was followed by another debt-collection text. Routed to
          the FDCPA / Florida pipeline — not scored by the TCPA IQ engine.
        </p>
      </div>
    );
  }
  const sc = candidate.scorecard;
  if (!sc) return null;

  if (sc.killCheck.declined) {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-3 dark:border-red-900 dark:bg-red-950">
        <p className="text-sm font-semibold text-red-800 dark:text-red-200">
          DECLINE — auto-kill condition
        </p>
        <p className="mt-1 text-xs text-red-700 dark:text-red-300">
          {(sc.killCheck.reason
            ? KILL_REASON_LABELS[sc.killCheck.reason]
            : "Kill condition") +
            (sc.killCheck.basis ? ` — ${sc.killCheck.basis}` : "")}
          . No score produced.
        </p>
      </div>
    );
  }

  const tone = bandTone(sc.band);
  return (
    <div className="rounded-lg border border-zinc-200 bg-white p-3 dark:border-zinc-800 dark:bg-zinc-950">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          TCPA IQ score
        </span>
        <span
          className={`flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-semibold ${tone.chip}`}
        >
          <span className="text-sm font-bold leading-none">{sc.final}</span>
          <span className="opacity-70">/ 100</span>
          <span className="uppercase tracking-wide">{tone.label}</span>
        </span>
      </div>

      {sc.capApplied && (
        <p className="mt-2 rounded-md bg-amber-50 px-2 py-1 text-[11px] text-amber-800 dark:bg-amber-950 dark:text-amber-200">
          Shell cap applied — capped at 50 (raw score was {sc.raw}).
        </p>
      )}

      <dl className="mt-3 flex flex-col gap-1.5 text-sm">
        {sc.factors.map((f) => (
          <div
            key={f.name}
            className="grid grid-cols-[8.5rem_2.75rem_1fr] items-baseline gap-2"
          >
            <dt className="text-zinc-500 dark:text-zinc-400">
              {f.name}
              {FACTOR_TOOLTIPS[f.name] && (
                <InfoTooltip text={FACTOR_TOOLTIPS[f.name]} />
              )}
            </dt>
            <dd className="font-semibold tabular-nums text-zinc-900 dark:text-zinc-100">
              {f.points}/{f.max}
            </dd>
            <dd className="text-xs text-zinc-500 dark:text-zinc-400">
              {f.basis}
            </dd>
          </div>
        ))}
      </dl>

      {sc.unknowns.length > 0 && (
        <div className="mt-3 border-t border-zinc-200 pt-2 dark:border-zinc-800">
          <p className="text-[10px] uppercase tracking-wide text-amber-600 dark:text-amber-400">
            ⚠ Needs intake to confirm (could move the score)
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {sc.unknowns.map((u) => (
              <li key={u} className="text-xs text-zinc-600 dark:text-zinc-400">
                • {u}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** The four screens for this company (screening-spec §4). */
function ScreensPanel({ screens }: { screens: ScreenResult[] }) {
  if (screens.length === 0) return null;
  return (
    <div className="mt-3">
      <p className="mb-1.5 text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Four screens
      </p>
      <ul className="flex flex-col gap-1">
        {screens.map((s) => {
          const mark = s.hit ? "✓" : s.unverified ? "?" : "✕";
          const markClass = s.hit
            ? "text-emerald-600 dark:text-emerald-400"
            : s.unverified
              ? "text-amber-600 dark:text-amber-400"
              : "text-zinc-400 dark:text-zinc-600";
          return (
            <li key={s.screen} className="flex flex-wrap items-baseline gap-2 text-xs">
              <span className={`font-bold ${markClass}`}>{mark}</span>
              <span className="font-medium text-zinc-700 dark:text-zinc-300">
                {SCREEN_LABELS[s.screen]}
              </span>
              {s.hit && s.track && (
                <span className="rounded bg-zinc-200 px-1 py-0.5 text-[9px] font-semibold uppercase text-zinc-600 dark:bg-zinc-800 dark:text-zinc-300">
                  {TRACK_LABELS[s.track]}
                </span>
              )}
              <span className="text-zinc-500 dark:text-zinc-400">{s.basis}</span>
            </li>
          );
        })}
      </ul>
    </div>
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
