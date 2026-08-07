"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { amrToWavBlob, isAmr } from "@/lib/audio";
import type { Case, CaseFile } from "@/lib/types";
import type { CaseDoc } from "@/lib/case-store";
import type { EvidenceFile } from "@/lib/opportunity-evidence";
import type { QueueEntry } from "@/app/api/review-queue/route";
import type { ReviewCaseResponse } from "@/app/api/review-queue/case/route";
import { CaseDetail } from "@/components/case-detail";
import { FileModal, FileThumbnail } from "@/components/evidence";

/**
 * The case-review queue: every opportunity sitting in the '👀 For Chris
 * Review' stage, one screen per case — evidence, the structured AI run,
 * manual investigation notes — and an Approve / Decline decision that moves
 * the opportunity to '✅ Approved for Signup' or 'Needs Work'.
 */

type QueueResponse = {
  pipelineName: string;
  stageName: string;
  approvedStageName: string;
  declinedStageName: string;
  entries: QueueEntry[];
};

type LoadedCase = {
  doc: CaseDoc | null;
  ghlAiFields: ReviewCaseResponse["ghlAiFields"];
  /** Reconstructed display case (only when a structured run is stored). */
  displayCase: Case | null;
  /** Evidence as displayable files, run or no run. */
  files: CaseFile[];
};

const proxied = (url: string) =>
  `/api/opportunity/file?url=${encodeURIComponent(url)}`;

/**
 * Turn the stored run's evidence + the live GHL field values into playable /
 * viewable CaseFiles. Live URLs win (stored ones can go stale); stored text
 * and forensics ride along. Audio is downloaded eagerly because voicemails
 * arrive as AMR more often than not and need decoding before <audio> can
 * play them.
 */
async function buildDisplayFiles(
  stored: NonNullable<CaseDoc["run"]>["files"] | undefined,
  live: EvidenceFile[],
): Promise<CaseFile[]> {
  const liveByName = new Map(live.map((f) => [f.name, f] as const));
  const merged: Array<{
    name: string;
    kind: CaseFile["kind"];
    url: string | null;
    text?: string;
    forensics?: CaseFile["forensics"];
  }> = [];

  const seen = new Set<string>();
  for (const f of stored ?? []) {
    seen.add(f.name);
    merged.push({
      name: f.name,
      kind: f.kind,
      url: liveByName.get(f.name)?.url ?? f.ghlUrl,
      text: f.text ?? undefined,
      forensics: f.forensics ?? undefined,
    });
  }
  for (const f of live) {
    if (seen.has(f.name)) continue;
    merged.push({ name: f.name, kind: f.kind, url: f.url });
  }

  return Promise.all(
    merged.map(async (f, i): Promise<CaseFile> => {
      let url = f.url ? proxied(f.url) : "";
      if (f.url && f.kind === "audio") {
        try {
          const blob = await fetch(url).then((r) => {
            if (!r.ok) throw new Error(`download failed: ${r.status}`);
            return r.blob();
          });
          const playable = isAmr(blob, f.name) ? await amrToWavBlob(blob) : blob;
          url = URL.createObjectURL(playable);
        } catch {
          // Keep the proxy URL; the <audio> element will surface the failure.
        }
      }
      return {
        id: `${i}-${f.name}`,
        name: f.name,
        kind: f.kind,
        url,
        status: f.url ? "done" : "error",
        error: f.url ? undefined : "File no longer attached to the opportunity",
        text: f.text,
        forensics: f.forensics,
        forensicsStatus: f.forensics ? "done" : undefined,
      };
    }),
  );
}

/** Rebuild a renderable Case from the stored structured run. */
function caseFromRun(
  opportunityId: string,
  doc: CaseDoc,
  files: CaseFile[],
): Case | null {
  const run = doc.run;
  if (!run) return null;
  return {
    id: opportunityId,
    name: run.caseName || doc.opportunity.name,
    createdAt: run.createdAt,
    completedAt: run.completedAt ?? undefined,
    files,
    dnc: run.dnc ?? undefined,
    opportunityId,
    facts: run.facts ?? undefined,
    gate: run.gate ?? undefined,
    screeningStatus: "done",
    defendantStatus: run.gate?.declined ? "idle" : "done",
    defendants: run.defendants,
    defendantSosError: run.defendantSosError ?? undefined,
    defendantUnmatchedSos: run.defendantUnmatchedSos,
    defendantSearchTerms: run.defendantSearchTerms,
    defendantInvestigation: run.defendantInvestigation ?? undefined,
  };
}

export default function CaseReviewPage() {
  const [queue, setQueue] = useState<QueueResponse | null>(null);
  const [queueError, setQueueError] = useState<string | null>(null);
  const [index, setIndex] = useState(0);
  // Loaded case + load error are tagged with the opportunity id they belong
  // to; "loading" is derived (current case has neither), so switching cases
  // needs no state resets inside effects.
  const [loaded, setLoaded] = useState<{ id: string; data: LoadedCase } | null>(
    null,
  );
  const [caseError, setCaseError] = useState<{
    id: string;
    message: string;
  } | null>(null);
  const [openFile, setOpenFile] = useState<CaseFile | null>(null);
  const [deciding, setDeciding] = useState<"approved" | "declined" | null>(null);
  const [decisionError, setDecisionError] = useState<string | null>(null);
  const [decidedBanner, setDecidedBanner] = useState<string | null>(null);

  // Guards against a slow response for a case the user already navigated away
  // from clobbering the current one.
  const loadToken = useRef(0);
  const objectUrls = useRef<string[]>([]);

  const entries = queue?.entries ?? [];
  // Clamp at render time so the queue shrinking (after a decision) simply
  // points the same position at the next case.
  const safeIndex =
    entries.length > 0 ? Math.min(Math.max(index, 0), entries.length - 1) : 0;
  const current = entries[safeIndex] ?? null;
  const currentLoaded =
    loaded && current && loaded.id === current.id ? loaded.data : null;
  const currentError =
    caseError && current && caseError.id === current.id
      ? caseError.message
      : null;
  const caseLoading = Boolean(current) && !currentLoaded && !currentError;

  const loadQueue = useCallback(async () => {
    try {
      const res = await fetch("/api/review-queue");
      const data = (await res.json().catch(() => null)) as
        | (QueueResponse & { error?: string })
        | null;
      if (!res.ok || !data) {
        throw new Error(data?.error ?? `Loading the queue failed: ${res.status}`);
      }
      setQueue(data);
      setQueueError(null);
      setIndex(0);
    } catch (err) {
      setQueueError(
        err instanceof Error ? err.message : "Could not load the review queue.",
      );
    }
  }, []);

  useEffect(() => {
    // Fetch-on-mount: every setState in loadQueue happens after the awaited
    // response, never synchronously in the effect body.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadQueue();
  }, [loadQueue]);

  // Revoke decoded-audio object URLs when the page unmounts.
  useEffect(() => {
    const urls = objectUrls.current;
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  const loadCase = useCallback(async (opportunityId: string) => {
    const token = ++loadToken.current;
    try {
      const res = await fetch(
        `/api/review-queue/case?id=${encodeURIComponent(opportunityId)}`,
      );
      const data = (await res.json().catch(() => null)) as
        | (ReviewCaseResponse & { error?: string })
        | null;
      if (!res.ok || !data) {
        throw new Error(data?.error ?? `Loading the case failed: ${res.status}`);
      }
      const files = await buildDisplayFiles(data.doc?.run?.files, data.evidence);
      if (token !== loadToken.current) return;
      objectUrls.current.push(
        ...files.map((f) => f.url).filter((u) => u.startsWith("blob:")),
      );
      setLoaded({
        id: opportunityId,
        data: {
          doc: data.doc,
          ghlAiFields: data.ghlAiFields,
          displayCase: data.doc
            ? caseFromRun(opportunityId, data.doc, files)
            : null,
          files,
        },
      });
      setCaseError(null);
    } catch (err) {
      if (token !== loadToken.current) return;
      setCaseError({
        id: opportunityId,
        message:
          err instanceof Error ? err.message : "Could not load the case.",
      });
    }
  }, []);

  const currentId = current?.id ?? null;
  useEffect(() => {
    // Same fetch-after-await shape as loadQueue above.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (currentId) void loadCase(currentId);
  }, [currentId, loadCase]);

  const decide = useCallback(
    async (decision: "approved" | "declined") => {
      if (!current) return;
      setDeciding(decision);
      setDecisionError(null);
      try {
        const res = await fetch("/api/review-queue/decision", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ id: current.id, decision }),
        });
        const data = (await res.json().catch(() => null)) as
          | { movedTo?: string; error?: string }
          | null;
        if (!res.ok || !data) {
          throw new Error(data?.error ?? `Decision failed: ${res.status}`);
        }
        // The opportunity left the stage — drop it from the queue. The same
        // index now points at the next case.
        setQueue((prev) =>
          prev
            ? {
                ...prev,
                entries: prev.entries.filter((e) => e.id !== current.id),
              }
            : prev,
        );
        setDecidedBanner(
          `${current.name} → ${data.movedTo ?? (decision === "approved" ? "approved" : "needs work")}`,
        );
      } catch (err) {
        setDecisionError(
          err instanceof Error ? err.message : "Could not record the decision.",
        );
      } finally {
        setDeciding(null);
      }
    },
    [current],
  );

  return (
    <main className="flex min-h-0 flex-1">
      {/* Queue sidebar */}
      <aside className="flex w-72 shrink-0 flex-col border-r border-zinc-200 dark:border-zinc-800">
        <div className="border-b border-zinc-200 px-4 py-4 dark:border-zinc-800">
          <h1 className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
            Case review
          </h1>
          <p className="mt-0.5 text-xs text-zinc-500 dark:text-zinc-400">
            {queue
              ? `${entries.length} in ${queue.stageName}`
              : queueError
                ? "Queue unavailable"
                : "Loading queue…"}
          </p>
        </div>
        <div className="min-h-0 flex-1 overflow-y-auto">
          {queueError && (
            <div className="p-4">
              <p className="text-sm text-red-600 dark:text-red-400">
                {queueError}
              </p>
              <button
                type="button"
                onClick={() => {
                  setQueue(null);
                  setQueueError(null);
                  void loadQueue();
                }}
                className="mt-2 rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
              >
                Retry
              </button>
            </div>
          )}
          {queue && entries.length === 0 && (
            <p className="p-4 text-sm text-zinc-500 dark:text-zinc-400">
              Nothing waiting for review. 🎉
            </p>
          )}
          <ul>
            {entries.map((entry, i) => (
              <li key={entry.id}>
                <button
                  type="button"
                  onClick={() => setIndex(i)}
                  className={`flex w-full flex-col gap-0.5 border-b border-zinc-100 px-4 py-3 text-left transition-colors dark:border-zinc-900 ${
                    i === safeIndex
                      ? "bg-zinc-100 dark:bg-zinc-900"
                      : "hover:bg-zinc-50 dark:hover:bg-zinc-900/50"
                  }`}
                >
                  <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
                    {entry.name}
                  </span>
                  <span className="flex items-center gap-2 text-[11px] text-zinc-500 dark:text-zinc-400">
                    {entry.hasRun ? (
                      <span className="text-emerald-600 dark:text-emerald-400">
                        ● AI run stored
                      </span>
                    ) : (
                      <span className="text-amber-600 dark:text-amber-400">
                        ○ no stored run
                      </span>
                    )}
                    {entry.hasManual && <span>✎ manual notes</span>}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      </aside>

      {/* Current case */}
      <div className="flex min-h-0 flex-1 flex-col">
        {/* Queue navigation bar */}
        <div className="flex items-center justify-between gap-3 border-b border-zinc-200 px-6 py-3 dark:border-zinc-800">
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIndex(Math.max(0, safeIndex - 1))}
              disabled={safeIndex <= 0}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              ← Previous
            </button>
            <button
              type="button"
              onClick={() => setIndex(Math.min(entries.length - 1, safeIndex + 1))}
              disabled={safeIndex >= entries.length - 1}
              className="rounded-lg border border-zinc-300 px-3 py-1.5 text-sm text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-40 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900"
            >
              Next →
            </button>
            <span className="text-xs text-zinc-500 dark:text-zinc-400">
              {entries.length > 0 ? `${safeIndex + 1} of ${entries.length}` : "—"}
            </span>
          </div>

          {current && (
            <div className="flex items-center gap-2">
              {decisionError && (
                <span className="text-xs text-red-600 dark:text-red-400">
                  {decisionError}
                </span>
              )}
              <button
                type="button"
                onClick={() => void decide("declined")}
                disabled={deciding !== null}
                className="rounded-lg border border-red-300 px-4 py-1.5 text-sm font-medium text-red-700 transition-colors hover:bg-red-50 disabled:opacity-50 dark:border-red-900 dark:text-red-400 dark:hover:bg-red-950/40"
              >
                {deciding === "declined" ? "Moving…" : "Decline → Needs Work"}
              </button>
              <button
                type="button"
                onClick={() => void decide("approved")}
                disabled={deciding !== null}
                className="rounded-lg bg-emerald-600 px-4 py-1.5 text-sm font-medium text-white transition-colors hover:bg-emerald-500 disabled:opacity-50"
              >
                {deciding === "approved" ? "Moving…" : "Approve for Signup"}
              </button>
            </div>
          )}
        </div>

        {decidedBanner && (
          <p className="border-b border-emerald-200 bg-emerald-50 px-6 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-200">
            Moved: {decidedBanner}
          </p>
        )}

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {!current ? (
            <div className="flex flex-1 items-center justify-center p-8 text-center">
              <p className="max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
                {queue && entries.length === 0
                  ? "The review stage is empty — every case has been decided."
                  : "Select a case from the queue."}
              </p>
            </div>
          ) : caseLoading ? (
            <div className="flex flex-1 items-center justify-center p-8">
              <p className="text-sm text-zinc-500 dark:text-zinc-400">
                Loading {current.name}…
              </p>
            </div>
          ) : currentError ? (
            <div className="p-6">
              <p className="rounded-lg bg-red-50 px-4 py-3 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-400">
                {currentError}
              </p>
            </div>
          ) : currentLoaded ? (
            <>
              {currentLoaded.displayCase ? (
                <CaseDetail
                  caseItem={currentLoaded.displayCase}
                  onOpenFile={setOpenFile}
                />
              ) : (
                <NoStoredRun
                  name={current.name}
                  files={currentLoaded.files}
                  ghlAiFields={currentLoaded.ghlAiFields}
                  onOpenFile={setOpenFile}
                />
              )}
              <ManualInvestigationPanel
                key={current.id}
                opportunityId={current.id}
                initial={currentLoaded.doc?.manual ?? null}
              />
              {currentLoaded.doc?.review && (
                <p className="border-t border-zinc-200 px-6 py-3 text-xs text-zinc-500 dark:border-zinc-800 dark:text-zinc-400">
                  Previously {currentLoaded.doc.review.decision} on{" "}
                  {new Date(
                    currentLoaded.doc.review.decidedAt,
                  ).toLocaleString()}{" "}
                  (moved to {currentLoaded.doc.review.movedToStageName}) — it is
                  back in the review stage.
                </p>
              )}
            </>
          ) : null}
        </div>
      </div>

      {openFile && <FileModal file={openFile} onClose={() => setOpenFile(null)} />}
    </main>
  );
}

/**
 * Fallback for opportunities whose run predates the database: the live
 * evidence plus whatever the GHL "AI Intake" text fields hold.
 */
function NoStoredRun({
  name,
  files,
  ghlAiFields,
  onOpenFile,
}: {
  name: string;
  files: CaseFile[];
  ghlAiFields: ReviewCaseResponse["ghlAiFields"];
  onOpenFile: (file: CaseFile) => void;
}) {
  const rows: [string, string | null][] = [
    ["Run status", ghlAiFields.runStatus],
    ["Top score", ghlAiFields.topScore],
    ["Companies found", ghlAiFields.companiesFound],
  ];
  return (
    <div className="flex flex-col gap-6 p-6">
      <header>
        <h2 className="text-lg font-semibold text-zinc-900 dark:text-zinc-100">
          {name}
        </h2>
        <p className="mt-1 text-xs text-amber-600 dark:text-amber-400">
          No structured AI run in the database for this opportunity — showing
          the live GHL evidence and AI Intake fields instead. Re-run the case
          (or backfill later) to get the full structured view.
        </p>
      </header>

      <section>
        <p className="mb-2 text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Evidence
        </p>
        {files.length > 0 ? (
          <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-6">
            {files.map((file) => (
              <FileThumbnail
                key={file.id}
                file={file}
                onClick={() => onOpenFile(file)}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No evidence files on this opportunity.
          </p>
        )}
      </section>

      <section className="rounded-xl border border-zinc-200 bg-white p-4 dark:border-zinc-800 dark:bg-zinc-950">
        <p className="mb-2 text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          AI Intake fields (from GHL)
        </p>
        {ghlAiFields.runStatus ? (
          <div className="flex flex-col gap-3">
            <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
              {rows.map(
                ([label, value]) =>
                  value && (
                    <div key={label} className="contents">
                      <dt className="text-zinc-500 dark:text-zinc-400">
                        {label}
                      </dt>
                      <dd className="whitespace-pre-wrap text-zinc-800 dark:text-zinc-200">
                        {value}
                      </dd>
                    </div>
                  ),
              )}
            </dl>
            {ghlAiFields.companySummary && (
              <div>
                <p className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  Company summary
                </p>
                <p className="whitespace-pre-wrap text-sm leading-6 text-zinc-700 dark:text-zinc-300">
                  {ghlAiFields.companySummary}
                </p>
              </div>
            )}
            {ghlAiFields.investigationNotes && (
              <div>
                <p className="mb-1 text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  Investigation notes
                </p>
                <p className="whitespace-pre-wrap text-sm leading-6 text-zinc-700 dark:text-zinc-300">
                  {ghlAiFields.investigationNotes}
                </p>
              </div>
            )}
          </div>
        ) : (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            The AI agent has not run for this opportunity.
          </p>
        )}
      </section>
    </div>
  );
}

/** Mike's manual-investigation notes, saved to the Firestore case document. */
function ManualInvestigationPanel({
  opportunityId,
  initial,
}: {
  opportunityId: string;
  initial: { text: string; updatedAt: string } | null;
}) {
  const [text, setText] = useState(initial?.text ?? "");
  const [savedText, setSavedText] = useState(initial?.text ?? "");
  const [updatedAt, setUpdatedAt] = useState(initial?.updatedAt ?? null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const dirty = text !== savedText;

  async function save() {
    setSaving(true);
    setError(null);
    try {
      const res = await fetch("/api/review-queue/case", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ id: opportunityId, manualText: text }),
      });
      const data = (await res.json().catch(() => null)) as
        | { manual?: { updatedAt: string }; error?: string }
        | null;
      if (!res.ok || !data) {
        throw new Error(data?.error ?? `Saving failed: ${res.status}`);
      }
      setSavedText(text);
      if (data.manual?.updatedAt) setUpdatedAt(data.manual.updatedAt);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not save the notes.");
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="border-t border-zinc-200 p-6 dark:border-zinc-800">
      <div className="mb-2 flex items-center justify-between gap-3">
        <p className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Manual investigation
        </p>
        <div className="flex items-center gap-2">
          {updatedAt && !dirty && (
            <span className="text-[11px] text-zinc-400 dark:text-zinc-500">
              Saved {new Date(updatedAt).toLocaleString()}
            </span>
          )}
          {error && (
            <span className="text-xs text-red-600 dark:text-red-400">
              {error}
            </span>
          )}
          <button
            type="button"
            onClick={() => void save()}
            disabled={saving || !dirty}
            className="rounded-lg bg-zinc-900 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {saving ? "Saving…" : dirty ? "Save notes" : "Saved"}
          </button>
        </div>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        rows={5}
        placeholder="Findings from a manual investigation (company details, addresses, sources…) — kept with the case so AI and manual results live in one place."
        className="w-full resize-y rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:text-zinc-100 dark:placeholder:text-zinc-600"
      />
    </section>
  );
}
