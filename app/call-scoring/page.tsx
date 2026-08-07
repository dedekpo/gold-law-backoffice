"use client";

import { useEffect, useRef, useState } from "react";
import type {
  CallScoringProgress,
  CallScoringResult,
  CriterionId,
  ScoreBand,
  ScoredCall,
} from "@/lib/call-scoring";

/**
 * Call Scoring (Conversation QA) — v1 prototype. "Run scoring" collects the
 * 10 most recent answered, recorded intake calls from GHL, transcribes each
 * recording, and scores the intaker against the v1 rubric. Per-criterion 0–5
 * scores come from the AI; the weighted 0–100 overall is computed
 * deterministically server-side. Read-only — nothing in GHL is modified.
 */

const PHASE_LABEL: Record<CallScoringProgress["phase"], string> = {
  scan: "Finding recorded calls",
  transcribe: "Transcribing recordings",
  score: "Scoring against rubric",
};

const BAND_LABEL: Record<ScoreBand, string> = {
  excellent: "EXCELLENT",
  good: "GOOD",
  "needs-work": "NEEDS WORK",
  poor: "POOR",
};

const BAND_CLASS: Record<ScoreBand, string> = {
  excellent:
    "bg-green-100 text-green-800 dark:bg-green-950/60 dark:text-green-300",
  good: "bg-lime-100 text-lime-800 dark:bg-lime-950/60 dark:text-lime-300",
  "needs-work":
    "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  poor: "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300",
};

const BAND_BAR_CLASS: Record<ScoreBand, string> = {
  excellent: "bg-green-500",
  good: "bg-lime-500",
  "needs-work": "bg-amber-500",
  poor: "bg-red-500",
};

function formatDate(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "—";
  return d.toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatDuration(seconds: number | null): string {
  if (seconds === null) return "—";
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

function Badge({ text, className }: { text: string; className: string }) {
  return (
    <span
      className={`inline-block shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${className}`}
    >
      {text}
    </span>
  );
}

function SummaryTile({
  label,
  value,
  accent,
}: {
  label: string;
  value: string | number;
  accent?: string;
}) {
  return (
    <div className="rounded border border-gray-200 px-3 py-2 dark:border-zinc-800">
      <div className={`text-2xl font-bold tabular-nums ${accent ?? ""}`}>
        {value}
      </div>
      <div className="text-[11px] text-gray-500 dark:text-zinc-500">{label}</div>
    </div>
  );
}

/** One criterion row inside a call's detail: score bar + rationale + quote. */
function CriterionRow({
  label,
  weight,
  score,
  rationale,
  quote,
}: {
  label: string;
  weight: number;
  score: number | null;
  rationale: string;
  quote: string | null;
}) {
  return (
    <div className="space-y-0.5">
      <div className="flex items-center gap-2">
        <span className="w-56 shrink-0 truncate font-medium">
          {label}
          <span className="ml-1 text-gray-400 dark:text-zinc-600">
            ({weight}%)
          </span>
        </span>
        <span className="relative h-3 w-32 shrink-0 overflow-hidden rounded bg-gray-200 dark:bg-zinc-800">
          {score !== null && (
            <span
              className={`absolute inset-y-0 left-0 rounded ${
                score >= 4
                  ? "bg-green-500"
                  : score >= 3
                    ? "bg-lime-500"
                    : score >= 2
                      ? "bg-amber-500"
                      : "bg-red-500"
              }`}
              style={{ width: `${(score / 5) * 100}%` }}
            />
          )}
        </span>
        <span className="w-10 shrink-0 tabular-nums font-semibold">
          {score !== null ? `${score}/5` : "N/A"}
        </span>
        <span className="min-w-0 flex-1 text-gray-600 dark:text-zinc-400">
          {rationale}
        </span>
      </div>
      {quote && (
        <div className="pl-58 text-[11px] italic text-gray-500 dark:text-zinc-500">
          &ldquo;{quote}&rdquo;
        </div>
      )}
    </div>
  );
}

function CallRow({
  item,
  rubric,
}: {
  item: ScoredCall;
  rubric: CallScoringResult["rubric"];
}) {
  return (
    <details className="border-b border-gray-200 dark:border-zinc-800">
      <summary className="flex cursor-pointer items-center gap-2 px-2 py-1.5 hover:bg-gray-50 dark:hover:bg-zinc-900">
        {item.emergency.flagged && (
          <Badge text="🚨 EMERGENCY" className="bg-red-600 text-white" />
        )}
        {item.band ? (
          <Badge text={BAND_LABEL[item.band]} className={BAND_CLASS[item.band]} />
        ) : (
          <Badge
            text="ERROR"
            className="bg-gray-200 text-gray-600 dark:bg-zinc-800 dark:text-zinc-400"
          />
        )}
        <span className="w-10 shrink-0 text-right text-sm font-bold tabular-nums">
          {item.overall !== null ? item.overall : "—"}
        </span>
        <span className="min-w-0 flex-1 truncate">
          <span className="font-semibold">
            {item.contactName ?? "(unknown client)"}
          </span>
          <span className="text-gray-500 dark:text-zinc-500">
            {" · "}
            {item.direction === "inbound" ? "inbound" : "outbound"} call
          </span>
        </span>
        {item.contactUrl && (
          <a
            href={item.contactUrl}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-[11px] text-gray-500 underline hover:text-gray-800 dark:text-zinc-500 dark:hover:text-zinc-200"
            onClick={(e) => e.stopPropagation()}
          >
            contact ↗
          </a>
        )}
        <span className="shrink-0 tabular-nums text-gray-600 dark:text-zinc-400">
          {formatDuration(item.durationSeconds)}
        </span>
        <span className="w-24 shrink-0 text-right text-gray-500 dark:text-zinc-500">
          {formatDate(item.callDate)}
        </span>
        <span className="w-36 shrink-0 truncate text-right text-gray-500 dark:text-zinc-500">
          {item.intakerName}
        </span>
      </summary>
      <div className="space-y-3 bg-gray-50 px-8 py-3 text-xs dark:bg-zinc-900">
        {item.emergency.flagged && item.emergency.reason && (
          <div className="rounded border border-red-300 bg-red-50 p-2 font-medium text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            🚨 {item.emergency.reason}
          </div>
        )}
        {item.error && (
          <div className="text-red-700 dark:text-red-400">{item.error}</div>
        )}
        {item.summary && (
          <div>
            <span className="font-bold">Summary:</span> {item.summary}
          </div>
        )}
        {item.scores && (
          <div className="space-y-1.5">
            {rubric.map((c) => {
              const s = item.scores?.[c.id as CriterionId];
              if (!s) return null;
              return (
                <CriterionRow
                  key={c.id}
                  label={c.label}
                  weight={c.weight}
                  score={s.score}
                  rationale={s.rationale}
                  quote={s.quote}
                />
              );
            })}
          </div>
        )}
        {(item.strengths.length > 0 || item.improvements.length > 0) && (
          <div className="grid gap-3 sm:grid-cols-2">
            {item.strengths.length > 0 && (
              <div>
                <div className="font-bold text-green-700 dark:text-green-400">
                  Strengths
                </div>
                <ul className="list-disc pl-4">
                  {item.strengths.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </div>
            )}
            {item.improvements.length > 0 && (
              <div>
                <div className="font-bold text-amber-700 dark:text-amber-400">
                  Coaching points
                </div>
                <ul className="list-disc pl-4">
                  {item.improvements.map((s) => (
                    <li key={s}>{s}</li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
        {item.transcript && (
          <details>
            <summary className="cursor-pointer font-bold hover:underline">
              Transcript
            </summary>
            <pre className="mt-1 max-h-72 overflow-auto whitespace-pre-wrap rounded border border-gray-200 bg-white p-2 font-mono text-[11px] leading-relaxed dark:border-zinc-800 dark:bg-zinc-950">
              {item.transcript}
            </pre>
          </details>
        )}
      </div>
    </details>
  );
}

export default function CallScoringPage() {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<CallScoringProgress | null>(null);
  const [result, setResult] = useState<CallScoringResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | null>(null);

  useEffect(
    () => () => {
      if (pollRef.current !== null) window.clearTimeout(pollRef.current);
    },
    [],
  );

  async function run() {
    setRunning(true);
    setError(null);
    setResult(null);
    setProgress(null);
    try {
      const res = await fetch("/api/call-scoring", { method: "POST" });
      const body = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok || !body.jobId) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      const jobId = body.jobId;
      const poll = async () => {
        try {
          const pollRes = await fetch(
            `/api/call-scoring?jobId=${encodeURIComponent(jobId)}`,
          );
          const snap = (await pollRes.json()) as {
            status?: string;
            progress?: CallScoringProgress | null;
            result?: CallScoringResult;
            error?: string;
          };
          if (!pollRes.ok) throw new Error(snap.error ?? "Polling failed");
          if (snap.status === "running") {
            if (snap.progress) setProgress(snap.progress);
            pollRef.current = window.setTimeout(poll, 1500);
            return;
          }
          if (snap.status === "done" && snap.result) {
            setResult(snap.result);
            setRunning(false);
            return;
          }
          throw new Error(snap.error ?? "Scoring run failed");
        } catch (err) {
          setError(err instanceof Error ? err.message : String(err));
          setRunning(false);
        }
      };
      pollRef.current = window.setTimeout(poll, 1200);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setRunning(false);
    }
  }

  const progressPct =
    progress && progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : null;

  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold">Call Scoring — Conversation QA</h1>
            <p className="mt-1 max-w-2xl text-sm text-gray-500 dark:text-zinc-500">
              v1 prototype: pulls the 10 most recent answered, recorded intake
              calls, transcribes each recording, and scores the intaker against
              the rubric below. Emergencies that need immediate attention are
              flagged at the top. Read-only — nothing in GHL is modified.
            </p>
          </div>
          <button
            type="button"
            onClick={run}
            disabled={running}
            className="rounded bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {running ? "Running…" : result ? "Run again" : "Run scoring"}
          </button>
        </header>

        {running && (
          <div className="rounded border border-gray-200 p-4 text-sm dark:border-zinc-800">
            <div className="flex items-center justify-between">
              <span>{progress ? PHASE_LABEL[progress.phase] : "Starting…"}</span>
              {progress && progress.total > 0 && (
                <span className="tabular-nums text-gray-500">
                  {progress.done} / {progress.total}
                </span>
              )}
            </div>
            <div className="mt-2 h-1.5 overflow-hidden rounded bg-gray-100 dark:bg-zinc-800">
              <div
                className="h-full rounded bg-zinc-900 transition-all dark:bg-zinc-200"
                style={{ width: `${progressPct ?? 5}%` }}
              />
            </div>
          </div>
        )}

        {error && (
          <div className="rounded border border-red-300 bg-red-50 p-3 text-sm text-red-800 dark:border-red-900 dark:bg-red-950/40 dark:text-red-300">
            {error}
          </div>
        )}

        {result && (
          <>
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <SummaryTile label="Calls analyzed" value={result.totals.calls} />
              <SummaryTile
                label="Average score"
                value={result.totals.averageScore ?? "—"}
                accent={
                  result.totals.averageScore !== null
                    ? result.totals.averageScore >= 75
                      ? "text-green-700 dark:text-green-400"
                      : result.totals.averageScore >= 60
                        ? "text-amber-700 dark:text-amber-400"
                        : "text-red-700 dark:text-red-400"
                    : undefined
                }
              />
              <SummaryTile
                label="Emergencies"
                value={result.totals.emergencies}
                accent={
                  result.totals.emergencies > 0
                    ? "text-red-700 dark:text-red-400"
                    : undefined
                }
              />
              <SummaryTile label="Errors" value={result.totals.errors} />
            </div>

            {result.intakers.length > 1 && (
              <section>
                <h2 className="mb-1 text-sm font-semibold">By intaker</h2>
                <div className="space-y-1 text-xs">
                  {result.intakers.map((s) => {
                    const band =
                      s.averageScore !== null
                        ? s.averageScore >= 90
                          ? "excellent"
                          : s.averageScore >= 75
                            ? "good"
                            : s.averageScore >= 60
                              ? "needs-work"
                              : "poor"
                        : null;
                    return (
                      <div
                        key={s.intakerName}
                        className="flex items-center gap-2"
                      >
                        <span className="w-40 shrink-0 truncate font-medium">
                          {s.intakerName}
                        </span>
                        <span className="relative h-4 w-48 shrink-0 overflow-hidden rounded bg-gray-200 dark:bg-zinc-800">
                          {s.averageScore !== null && band && (
                            <span
                              className={`absolute inset-y-0 left-0 rounded ${BAND_BAR_CLASS[band]}`}
                              style={{ width: `${s.averageScore}%` }}
                            />
                          )}
                        </span>
                        <span className="w-10 shrink-0 tabular-nums font-semibold">
                          {s.averageScore ?? "—"}
                        </span>
                        <span className="text-gray-500 dark:text-zinc-500">
                          {s.calls} call{s.calls === 1 ? "" : "s"}
                          {s.emergencies > 0 && (
                            <span className="ml-1 font-semibold text-red-600 dark:text-red-400">
                              · {s.emergencies} 🚨
                            </span>
                          )}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </section>
            )}

            <details className="rounded border border-gray-200 dark:border-zinc-800">
              <summary className="cursor-pointer px-3 py-2 text-sm font-semibold hover:bg-gray-50 dark:hover:bg-zinc-900">
                Scoring rubric (v1 starter — weights in %)
              </summary>
              <div className="space-y-2 px-4 py-3 text-xs">
                {result.rubric.map((c) => (
                  <div key={c.id}>
                    <span className="font-semibold">
                      {c.label} ({c.weight}%)
                    </span>
                    <span className="text-gray-600 dark:text-zinc-400">
                      {" — "}
                      {c.description}
                    </span>
                  </div>
                ))}
                <p className="pt-1 text-gray-500 dark:text-zinc-500">
                  Each criterion is scored 0–5 by AI with a quoted rationale;
                  criteria that don&rsquo;t apply to a call are excluded and the
                  weights renormalize. The 0–100 overall is computed
                  arithmetically from the weights, not by the model.
                </p>
              </div>
            </details>

            <section className="rounded border border-gray-200 text-xs dark:border-zinc-800">
              <div className="border-b border-gray-200 px-2 py-1.5 text-[11px] font-semibold text-gray-500 dark:border-zinc-800 dark:text-zinc-500">
                Calls (emergencies first, then lowest score) — click a row for
                the full scorecard and transcript
              </div>
              {result.items.map((item) => (
                <CallRow key={item.messageId} item={item} rubric={result.rubric} />
              ))}
            </section>

            <footer className="pb-8 text-xs text-gray-400 dark:text-zinc-600">
              Generated {new Date(result.generatedAt).toLocaleString()} ·
              read-only analysis · rubric is a v1 draft pending team review
            </footer>
          </>
        )}
      </div>
    </main>
  );
}
