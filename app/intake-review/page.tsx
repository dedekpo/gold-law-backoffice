"use client";

import { useEffect, useRef, useState } from "react";
import type {
  IntakeReviewProgress,
  IntakeReviewResult,
  OwnerStat,
  ReviewCategory,
  ReviewItem,
} from "@/lib/intake-review";

/**
 * Intake response review — read-only performance sweep of the
 * "01 Intake-Investigation Pipeline". "Run review" scans every open card's
 * conversation and flags clients whose last message sat unanswered for 5+
 * business days (AI separates real "still waiting" threads from "ok, thanks"
 * loop-closers). Nothing is written to GHL.
 */

const PHASE_LABEL: Record<IntakeReviewProgress["phase"], string> = {
  pipeline: "Resolving pipeline & users",
  opportunities: "Loading open opportunities",
  conversations: "Scanning conversations",
  triage: "AI triage of stale threads",
};

const CATEGORY_LABEL: Record<ReviewCategory, string> = {
  "needs-response": "NEEDS RESPONSE",
  resolved: "CLIENT CLOSED LOOP",
  responded: "TEAM REPLIED LAST",
  "waiting-recent": "WAITING < 5 BD",
  "no-conversation": "NO CONVERSATION",
  error: "ERROR",
};

const CATEGORY_CLASS: Record<ReviewCategory, string> = {
  "needs-response":
    "bg-red-100 text-red-800 dark:bg-red-950/60 dark:text-red-300",
  resolved:
    "bg-green-100 text-green-800 dark:bg-green-950/60 dark:text-green-300",
  responded: "bg-gray-200 text-gray-600 dark:bg-zinc-800 dark:text-zinc-400",
  "waiting-recent":
    "bg-amber-100 text-amber-800 dark:bg-amber-950/60 dark:text-amber-300",
  "no-conversation":
    "bg-gray-100 text-gray-500 dark:bg-zinc-900 dark:text-zinc-500",
  error: "bg-red-600 text-white",
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
  value: number;
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

/**
 * Horizontal bullet bars: gray track = open opportunities assigned to the
 * owner (scaled to the busiest owner), red fill = cards flagged as needing a
 * response. Values are always direct-labeled, so color never stands alone.
 */
function OwnerChart({
  owners,
  selected,
  onSelect,
}: {
  owners: OwnerStat[];
  selected: string | null;
  onSelect: (ownerName: string | null) => void;
}) {
  const maxTotal = Math.max(1, ...owners.map((o) => o.total));
  return (
    <div className="space-y-1">
      {owners.map((o) => {
        const isSelected = selected === o.ownerName;
        const pct = Math.round(o.pendingRatio * 100);
        return (
          <button
            key={o.ownerId ?? "unassigned"}
            type="button"
            onClick={() => onSelect(isSelected ? null : o.ownerName)}
            title={`${o.ownerName}: ${o.needsResponse} of ${o.total} open cards need a response (${pct}%)`}
            className={`flex w-full items-center gap-2 rounded px-1 py-0.5 text-left text-xs hover:bg-gray-50 dark:hover:bg-zinc-900 ${
              isSelected ? "bg-gray-100 dark:bg-zinc-900" : ""
            }`}
          >
            <span className="w-36 shrink-0 truncate font-medium">
              {o.ownerName}
            </span>
            <span className="relative h-4 min-w-0 flex-1">
              <span
                className="absolute inset-y-0 left-0 rounded-r bg-zinc-200 dark:bg-zinc-800"
                style={{ width: `${(o.total / maxTotal) * 100}%` }}
              />
              <span
                className="absolute inset-y-0 left-0 rounded-r bg-[#dc2626] dark:bg-[#ef4444]"
                style={{ width: `${(o.needsResponse / maxTotal) * 100}%` }}
              />
            </span>
            <span className="w-28 shrink-0 text-right tabular-nums text-gray-600 dark:text-zinc-400">
              {o.needsResponse} / {o.total}
              <span className="ml-1 text-gray-400 dark:text-zinc-600">
                ({pct}%)
              </span>
            </span>
          </button>
        );
      })}
    </div>
  );
}

function ItemRow({ item }: { item: ReviewItem }) {
  const hasDetail =
    item.transcript !== null || item.aiReason !== null || item.note !== null;
  return (
    <details className="border-b border-gray-200 dark:border-zinc-800">
      <summary
        className={`flex items-center gap-2 px-2 py-1.5 ${
          hasDetail
            ? "cursor-pointer hover:bg-gray-50 dark:hover:bg-zinc-900"
            : "[&::-webkit-details-marker]:hidden list-none"
        }`}
      >
        <Badge
          text={CATEGORY_LABEL[item.category]}
          className={CATEGORY_CLASS[item.category]}
        />
        <span className="min-w-0 flex-1 truncate">
          <a
            href={item.opportunityUrl}
            target="_blank"
            rel="noreferrer"
            className="font-semibold hover:underline"
            onClick={(e) => e.stopPropagation()}
          >
            {item.opportunityName}
          </a>
          {item.contactName && (
            <span className="text-gray-500 dark:text-zinc-500">
              {" · "}
              {item.contactName}
            </span>
          )}
        </span>
        <Badge
          text={item.stageName}
          className="max-w-44 truncate bg-indigo-100 text-indigo-800 dark:bg-indigo-950/60 dark:text-indigo-300"
        />
        {item.contactUrl && (
          <a
            href={item.contactUrl}
            target="_blank"
            rel="noreferrer"
            className="shrink-0 text-[11px] text-gray-500 underline hover:text-gray-800 dark:text-zinc-500 dark:hover:text-zinc-200"
            onClick={(e) => e.stopPropagation()}
          >
            chat ↗
          </a>
        )}
        {item.businessDaysWaiting !== null && (
          <span className="shrink-0 tabular-nums text-gray-600 dark:text-zinc-400">
            {item.businessDaysWaiting} bd waiting
          </span>
        )}
        <span className="w-40 shrink-0 truncate text-right text-gray-500 dark:text-zinc-500">
          {item.ownerName}
        </span>
      </summary>
      {hasDetail && (
        <div className="space-y-2 bg-gray-50 px-8 py-3 text-xs dark:bg-zinc-900">
          <div className="text-gray-500 dark:text-zinc-500">
            Stage: {item.stageName} · Last message: {formatDate(item.lastMessageAt)}
            {item.lastMessageType && <> ({item.lastMessageType})</>} ·{" "}
            {item.contactUrl && (
              <a
                href={item.contactUrl}
                target="_blank"
                rel="noreferrer"
                className="underline"
              >
                open conversation
              </a>
            )}
          </div>
          {item.aiReason && (
            <div>
              <span className="font-bold">AI verdict:</span> {item.aiReason}
            </div>
          )}
          {item.lastClientMessage && (
            <div>
              <span className="font-bold">Client&rsquo;s last message:</span>{" "}
              &ldquo;{item.lastClientMessage}&rdquo;
            </div>
          )}
          {item.note && (
            <div className="text-red-700 dark:text-red-400">{item.note}</div>
          )}
          {item.transcript && (
            <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded border border-gray-200 bg-white p-2 font-mono text-[11px] leading-relaxed dark:border-zinc-800 dark:bg-zinc-950">
              {item.transcript.join("\n")}
            </pre>
          )}
        </div>
      )}
    </details>
  );
}

function Section({
  title,
  items,
  open,
}: {
  title: string;
  items: ReviewItem[];
  open?: boolean;
}) {
  if (items.length === 0) return null;
  return (
    <details open={open} className="rounded border border-gray-200 dark:border-zinc-800">
      <summary className="cursor-pointer px-3 py-2 text-sm font-semibold hover:bg-gray-50 dark:hover:bg-zinc-900">
        {title} <span className="text-gray-400">({items.length})</span>
      </summary>
      <div className="text-xs">
        {items.map((item) => (
          <ItemRow key={item.opportunityId} item={item} />
        ))}
      </div>
    </details>
  );
}

export default function IntakeReviewPage() {
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState<IntakeReviewProgress | null>(null);
  const [result, setResult] = useState<IntakeReviewResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedOwner, setSelectedOwner] = useState<string | null>(null);
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
    setSelectedOwner(null);
    try {
      const res = await fetch("/api/intake-review", { method: "POST" });
      const body = (await res.json()) as { jobId?: string; error?: string };
      if (!res.ok || !body.jobId) {
        throw new Error(body.error ?? `Request failed (${res.status})`);
      }
      const jobId = body.jobId;
      const poll = async () => {
        try {
          const pollRes = await fetch(
            `/api/intake-review?jobId=${encodeURIComponent(jobId)}`,
          );
          const snap = (await pollRes.json()) as {
            status?: string;
            progress?: IntakeReviewProgress | null;
            result?: IntakeReviewResult;
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
          throw new Error(snap.error ?? "Review failed");
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

  const visibleItems =
    result?.items.filter(
      (i) => selectedOwner === null || i.ownerName === selectedOwner,
    ) ?? [];
  const byCategory = (c: ReviewCategory) =>
    visibleItems.filter((i) => i.category === c);
  const progressPct =
    progress && progress.total > 0
      ? Math.round((progress.done / progress.total) * 100)
      : null;

  return (
    <main className="h-full overflow-y-auto">
      <div className="mx-auto max-w-5xl space-y-6 px-6 py-8">
        <header className="flex flex-wrap items-start justify-between gap-4">
          <div>
            <h1 className="text-xl font-bold">Intake Response Review</h1>
            <p className="mt-1 max-w-2xl text-sm text-gray-500 dark:text-zinc-500">
              Scans every open card in the{" "}
              <span className="font-medium">
                {result?.pipelineName ?? "01 Intake-Investigation Pipeline"}
              </span>{" "}
              (all stages) and flags clients whose last message has waited 5+
              business days for a reply. AI separates real &ldquo;still
              waiting&rdquo; threads from &ldquo;ok, thank you&rdquo;
              loop-closers. Read-only — nothing in GHL is modified.
            </p>
          </div>
          <button
            type="button"
            onClick={run}
            disabled={running}
            className="rounded bg-zinc-900 px-4 py-2 text-sm font-semibold text-white hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
          >
            {running ? "Running…" : result ? "Run again" : "Run review"}
          </button>
        </header>

        {running && (
          <div className="rounded border border-gray-200 p-4 text-sm dark:border-zinc-800">
            <div className="flex items-center justify-between">
              <span>
                {progress ? PHASE_LABEL[progress.phase] : "Starting…"}
              </span>
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
            <div className="grid grid-cols-3 gap-2 sm:grid-cols-6">
              <SummaryTile
                label="Open opportunities"
                value={result.totals.opportunities}
              />
              <SummaryTile
                label="Need response"
                value={result.totals.needsResponse}
                accent="text-[#dc2626] dark:text-[#ef4444]"
              />
              <SummaryTile
                label="Waiting < 5 bd"
                value={result.totals.waitingRecent}
              />
              <SummaryTile
                label="Team replied last"
                value={result.totals.responded}
              />
              <SummaryTile
                label="Client closed loop"
                value={result.totals.resolved}
              />
              <SummaryTile
                label="No conversation"
                value={result.totals.noConversation}
              />
            </div>

            <section>
              <h2 className="mb-1 text-sm font-semibold">
                Pending responses by owner
              </h2>
              <p className="mb-2 text-xs text-gray-500 dark:text-zinc-500">
                Red = cards needing a response · gray track = all open cards
                assigned to that owner. Click a row to filter the lists below.
              </p>
              <OwnerChart
                owners={result.owners}
                selected={selectedOwner}
                onSelect={setSelectedOwner}
              />
            </section>

            <section className="space-y-3">
              {selectedOwner && (
                <div className="flex items-center gap-2 text-sm">
                  <span>
                    Filtered to <span className="font-semibold">{selectedOwner}</span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setSelectedOwner(null)}
                    className="rounded border border-gray-300 px-2 py-0.5 text-xs hover:bg-gray-50 dark:border-zinc-700 dark:hover:bg-zinc-900"
                  >
                    clear
                  </button>
                </div>
              )}
              {byCategory("needs-response").length === 0 && (
                <div className="rounded border border-green-300 bg-green-50 p-3 text-sm text-green-800 dark:border-green-900 dark:bg-green-950/40 dark:text-green-300">
                  No unanswered clients past 5 business days
                  {selectedOwner ? ` for ${selectedOwner}` : ""}. 🎉
                </div>
              )}
              <Section
                title="🔴 Needs response"
                items={byCategory("needs-response")}
                open
              />
              <Section title="⚠️ Analysis errors" items={byCategory("error")} />
              <Section
                title="🕐 Waiting, under 5 business days"
                items={byCategory("waiting-recent")}
              />
              <Section
                title="💬 No conversation found"
                items={byCategory("no-conversation")}
              />
              <Section
                title="🟢 Client closed the loop (AI-verified)"
                items={byCategory("resolved")}
              />
              <Section
                title="✅ Team replied last"
                items={byCategory("responded")}
              />
            </section>

            <footer className="pb-8 text-xs text-gray-400 dark:text-zinc-600">
              Generated {new Date(result.generatedAt).toLocaleString()} ·
              pipeline {result.pipelineName} · read-only analysis
            </footer>
          </>
        )}
      </div>
    </main>
  );
}
