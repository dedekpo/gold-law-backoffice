import type { Case, CaseFile } from "@/lib/types";
import { recordLabel } from "@/lib/display";
import { buildCaseZip, caseZipFilename } from "@/lib/export";
import { CaseStatusBadge, GateBanner } from "./screening";
import { ElapsedTimer } from "./elapsed-timer";
import { DownloadButton } from "./download-button";
import { FileThumbnail } from "./evidence";
import { CompanyCard } from "./company-card";
import { SosRecordPanel } from "./sos";

/** The selected case in full: intake gate, evidence, and scored companies. */
export function CaseDetail({
  caseItem,
  onOpenFile,
}: {
  caseItem: Case;
  onOpenFile: (file: CaseFile) => void;
}) {
  const fileCount = caseItem.files.length;
  const processingCount = caseItem.files.filter(
    (f) => f.status === "processing",
  ).length;
  const errorCount = caseItem.files.filter((f) => f.status === "error").length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <header className="flex items-start justify-between gap-3 border-b border-zinc-200 px-6 py-5 dark:border-zinc-800">
        <div className="flex flex-col gap-1">
          <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
            {caseItem.name}
          </h2>
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {fileCount} file{fileCount === 1 ? "" : "s"}
            {processingCount > 0 && ` · ${processingCount} processing`}
            {errorCount > 0 && ` · ${errorCount} failed`}
          </p>
          {(caseItem.dnc?.national || caseItem.dnc?.florida) && (
            <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
              DNC confirmed by manual lookup:
              {caseItem.dnc.national && " National"}
              {caseItem.dnc.national && caseItem.dnc.florida && " ·"}
              {caseItem.dnc.florida && " Florida"}
            </p>
          )}
          {caseItem.reportStatus === "saving" && (
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              Saving the report to the GHL opportunity…
            </p>
          )}
          {caseItem.reportStatus === "done" && (
            <p className="text-xs font-medium text-emerald-600 dark:text-emerald-400">
              Results saved to the opportunity&rsquo;s AI Intake fields
            </p>
          )}
          {caseItem.reportStatus === "error" && (
            <p className="text-xs font-medium text-red-600 dark:text-red-400">
              Report note failed: {caseItem.reportError}
            </p>
          )}
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1.5">
          <CaseStatusBadge caseItem={caseItem} />
          <ElapsedTimer caseItem={caseItem} />
          {fileCount > 0 && (
            <DownloadButton
              label="Download all"
              title="Download the whole case (every company + all evidence) as a zip"
              build={async () => ({
                filename: caseZipFilename(caseItem),
                blob: await buildCaseZip(caseItem),
              })}
            />
          )}
        </div>
      </header>

      <div className="flex min-h-0 flex-1 flex-col gap-6 overflow-y-auto p-6">
        <GateBanner caseItem={caseItem} />

        <section>
          <p className="mb-2 text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Evidence
          </p>
          {fileCount > 0 ? (
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
              {caseItem.files.map((file) => (
                <FileThumbnail
                  key={file.id}
                  file={file}
                  onClick={() => onOpenFile(file)}
                />
              ))}
            </div>
          ) : (
            <p className="text-sm text-zinc-500 dark:text-zinc-400">
              No files in this case.
            </p>
          )}
        </section>

        <CompaniesSection caseItem={caseItem} onOpenFile={onOpenFile} />
      </div>
    </div>
  );
}

function CompaniesSection({
  caseItem,
  onOpenFile,
}: {
  caseItem: Case;
  onOpenFile: (file: CaseFile) => void;
}) {
  const companies = caseItem.defendants ?? [];
  const unmatched = caseItem.defendantUnmatchedSos ?? [];

  return (
    <section>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Identified companies
        </p>
        {caseItem.defendantStatus === "identifying" && (
          <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
            Investigating & checking Secretary of State…
          </span>
        )}
      </div>

      {caseItem.defendantStatus === "error" && (
        <div className="mb-3 rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
          Identification failed: {caseItem.defendantError ?? "unknown error"}
        </div>
      )}

      {caseItem.defendantSosError && (
        <div className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
          Secretary of State lookup did not complete: {caseItem.defendantSosError}
        </div>
      )}

      {companies.length > 0 ? (
        <>
          <div className="flex flex-col gap-3">
            {companies.map((candidate, i) => (
              <CompanyCard
                key={`${candidate.company_name}-${i}`}
                caseItem={caseItem}
                candidate={candidate}
                onOpenFile={onOpenFile}
              />
            ))}
          </div>
          <InvestigationDetails caseItem={caseItem} />
        </>
      ) : caseItem.defendantStatus === "done" ? (
        <NoCompanyPanel caseItem={caseItem} />
      ) : (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          {caseItem.defendantStatus === "identifying"
            ? "The agent is searching the web and the Secretary of State registries…"
            : caseItem.defendantStatus === "error"
              ? "Identification could not be completed — see the error above."
              : "Waiting for screening…"}
        </p>
      )}

      {unmatched.length > 0 && (
        <div className="mt-4 rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
          <p className="mb-2 text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Additional official records found
          </p>
          <div className="flex flex-col gap-3">
            {unmatched.map((entity, i) => (
              <SosRecordPanel
                key={`${entity.entityId ?? entity.entityName ?? "rec"}-${i}`}
                sos={entity}
                label={recordLabel(entity)}
              />
            ))}
          </div>
        </div>
      )}
    </section>
  );
}

/** Search terms + the agent's written narrative of what it found and rejected. */
function InvestigationBody({ caseItem }: { caseItem: Case }) {
  const summary = caseItem.defendantInvestigation?.trim();
  const terms = caseItem.defendantSearchTerms ?? [];
  return (
    <div className="flex flex-col gap-3">
      {terms.length > 0 && (
        <div>
          <p className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Searched
          </p>
          <div className="flex flex-wrap gap-1">
            {terms.map((t) => (
              <span
                key={t}
                className="rounded bg-zinc-200 px-1.5 py-0.5 text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
              >
                {t}
              </span>
            ))}
          </div>
        </div>
      )}
      {summary ? (
        <p className="whitespace-pre-wrap text-sm leading-6 text-zinc-700 dark:text-zinc-300">
          {summary}
        </p>
      ) : (
        <p className="text-sm text-zinc-500 dark:text-zinc-400">
          The agent did not record a written summary of its search.
        </p>
      )}
    </div>
  );
}

/** Shown when identification finished but produced no company — explains why. */
function NoCompanyPanel({ caseItem }: { caseItem: Case }) {
  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <p className="mb-2 text-sm font-semibold text-zinc-800 dark:text-zinc-200">
        No company could be identified — here&apos;s what the agent tried
      </p>
      <InvestigationBody caseItem={caseItem} />
    </div>
  );
}

/** Collapsible investigation trail shown alongside identified companies. */
function InvestigationDetails({ caseItem }: { caseItem: Case }) {
  const hasContent =
    Boolean(caseItem.defendantInvestigation?.trim()) ||
    (caseItem.defendantSearchTerms?.length ?? 0) > 0;
  if (!hasContent) return null;
  return (
    <details className="mt-4 rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <summary className="cursor-pointer text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
        Investigation notes
      </summary>
      <div className="mt-3">
        <InvestigationBody caseItem={caseItem} />
      </div>
    </details>
  );
}
