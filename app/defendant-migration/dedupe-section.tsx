"use client";

import { useMemo, useState } from "react";
import type { DedupeCluster, DedupePlan, DedupeTier } from "@/lib/defendant-dedupe";

/**
 * "Existing duplicates" tab: clusters of Defendant records with similar names.
 * The user picks a survivor per cluster and approves; merging fills the
 * survivor's empty fields, re-points opportunity links, and DELETES the
 * duplicate records.
 */

const TIER_LABEL: Record<DedupeTier, string> = {
  punctuation: "PUNCTUATION ONLY",
  dba: "D/B/A VARIANT",
  suffix: "SUFFIX DIFFERS",
  fuzzy: "POSSIBLE TYPO",
};

const TIER_CLASS: Record<DedupeTier, string> = {
  punctuation: "bg-green-100 text-green-800",
  dba: "bg-blue-100 text-blue-800",
  suffix: "bg-amber-100 text-amber-800",
  fuzzy: "bg-red-100 text-red-800",
};

type ClusterResult = {
  ok: boolean;
  mergedFields: string[];
  relationsMoved: number;
  deletedIds: string[];
  error: string | null;
};

export function DedupeSection() {
  const [plan, setPlan] = useState<DedupePlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [survivors, setSurvivors] = useState<Map<string, string>>(new Map());
  const [executing, setExecuting] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState<Map<string, ClusterResult>>(new Map());
  const [executeError, setExecuteError] = useState<string | null>(null);

  async function buildPlan() {
    setPlanning(true);
    setPlanError(null);
    setPlan(null);
    setResults(new Map());
    try {
      const res = await fetch("/api/defendant-dedupe/plan");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Plan failed (${res.status})`);
      const nextPlan = body as DedupePlan;
      setPlan(nextPlan);
      setSelected(
        new Set(
          nextPlan.clusters.filter((c) => c.defaultSelected).map((c) => c.key),
        ),
      );
      setSurvivors(
        new Map(nextPlan.clusters.map((c) => [c.key, c.suggestedSurvivorId])),
      );
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : "Plan request failed");
    } finally {
      setPlanning(false);
    }
  }

  const selectedClusters = useMemo(
    () =>
      (plan?.clusters ?? []).filter(
        (c) => selected.has(c.key) && !results.get(c.key)?.ok,
      ),
    [plan, selected, results],
  );
  const deleteCount = selectedClusters.reduce(
    (n, c) => n + c.records.length - 1,
    0,
  );

  async function execute() {
    if (!plan || selectedClusters.length === 0) return;
    const confirmed = window.confirm(
      `Merge ${selectedClusters.length} duplicate groups? This DELETES ` +
        `${deleteCount} defendant records after moving their data and links ` +
        "to the chosen survivor. This cannot be undone.",
    );
    if (!confirmed) return;

    setExecuting(true);
    setExecuteError(null);
    setProgress({ done: 0, total: selectedClusters.length });
    let done = 0;
    try {
      // Small batches so progress is visible and one failure can't stall all.
      for (let i = 0; i < selectedClusters.length; i += 5) {
        const chunk = selectedClusters.slice(i, i + 5);
        const res = await fetch("/api/defendant-dedupe/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            clusters: chunk.map((c) => {
              const survivorId = survivors.get(c.key) ?? c.suggestedSurvivorId;
              return {
                survivorId,
                duplicateIds: c.records
                  .map((r) => r.id)
                  .filter((id) => id !== survivorId),
              };
            }),
          }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `Execute failed (${res.status})`);
        setResults((prev) => {
          const next = new Map(prev);
          for (let j = 0; j < chunk.length; j++) {
            next.set(chunk[j].key, body.results[j] as ClusterResult);
          }
          return next;
        });
        done += chunk.length;
        setProgress({ done, total: selectedClusters.length });
      }
    } catch (err) {
      setExecuteError(
        err instanceof Error ? err.message : "Execute request failed",
      );
    } finally {
      setExecuting(false);
    }
  }

  const tierCounts = useMemo(() => {
    const counts = new Map<DedupeTier, number>();
    for (const c of plan?.clusters ?? []) {
      counts.set(c.tier, (counts.get(c.tier) ?? 0) + 1);
    }
    return counts;
  }, [plan]);

  return (
    <div>
      <p className="mt-1 text-gray-500">
        Finds Defendant records whose names are duplicates or near-duplicates.
        Merging keeps the survivor you pick, fills its empty fields from the
        duplicates, moves their opportunity links over, and deletes the
        duplicates. Only exact (punctuation-level) groups are pre-selected —
        suffix and typo groups need your judgment. After merging, rebuild the
        migration plan.
      </p>

      <div className="mt-4 flex items-center gap-3">
        <button
          onClick={buildPlan}
          disabled={planning || executing}
          className="rounded bg-gray-900 px-4 py-2 text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
        >
          {planning
            ? "Scanning 1k+ defendant records…"
            : plan
              ? "Rebuild dedupe plan"
              : "Build dedupe plan"}
        </button>
        {plan && !executing && (
          <button
            onClick={execute}
            disabled={selectedClusters.length === 0}
            className="rounded bg-red-700 px-4 py-2 font-bold text-white disabled:opacity-40"
          >
            Approve &amp; merge {selectedClusters.length} groups (deletes{" "}
            {deleteCount} records)
          </button>
        )}
        {executing && (
          <span>
            Merging… {progress.done}/{progress.total}
          </span>
        )}
      </div>

      {planError && (
        <div className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-red-800 dark:bg-red-950/30 dark:text-red-300">
          {planError}
        </div>
      )}
      {executeError && (
        <div className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-red-800 dark:bg-red-950/30 dark:text-red-300">
          Merge stopped: {executeError} — completed groups are already merged;
          rebuild the plan to see the current state.
        </div>
      )}

      {plan && (
        <>
          <div className="mt-6 flex flex-wrap gap-2 text-xs">
            <span className="rounded border border-gray-300 px-2 py-1 dark:border-zinc-700">
              <span className="font-bold">{plan.totalRecords}</span> records
              scanned
            </span>
            <span className="rounded border border-gray-300 px-2 py-1 dark:border-zinc-700">
              <span className="font-bold">{plan.clusters.length}</span>{" "}
              duplicate groups
            </span>
            {(Object.keys(TIER_LABEL) as DedupeTier[]).map((tier) => (
              <span
                key={tier}
                className="rounded border border-gray-300 px-2 py-1 dark:border-zinc-700"
              >
                <span className="font-bold">{tierCounts.get(tier) ?? 0}</span>{" "}
                {TIER_LABEL[tier].toLowerCase()}
              </span>
            ))}
          </div>

          <div className="mt-4 space-y-3">
            {plan.clusters.map((cluster) => (
              <ClusterCard
                key={cluster.key}
                cluster={cluster}
                selected={selected.has(cluster.key)}
                onToggle={() =>
                  setSelected((prev) => {
                    const next = new Set(prev);
                    if (next.has(cluster.key)) next.delete(cluster.key);
                    else next.add(cluster.key);
                    return next;
                  })
                }
                survivorId={
                  survivors.get(cluster.key) ?? cluster.suggestedSurvivorId
                }
                onPickSurvivor={(id) =>
                  setSurvivors((prev) => new Map(prev).set(cluster.key, id))
                }
                result={results.get(cluster.key)}
                disabled={executing}
              />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

function ClusterCard({
  cluster,
  selected,
  onToggle,
  survivorId,
  onPickSurvivor,
  result,
  disabled,
}: {
  cluster: DedupeCluster;
  selected: boolean;
  onToggle: () => void;
  survivorId: string;
  onPickSurvivor: (id: string) => void;
  result: ClusterResult | undefined;
  disabled: boolean;
}) {
  const merged = result?.ok === true;
  return (
    <div
      className={`rounded border p-3 ${
        merged
          ? "border-green-300 bg-green-50 dark:bg-green-950/20"
          : "border-gray-200 dark:border-zinc-800"
      }`}
    >
      <div className="flex items-center gap-2">
        <input
          type="checkbox"
          checked={selected && !merged}
          disabled={disabled || merged}
          onChange={onToggle}
        />
        <span
          className={`inline-block rounded px-1.5 py-0.5 text-[10px] font-bold ${TIER_CLASS[cluster.tier]}`}
        >
          {TIER_LABEL[cluster.tier]}
        </span>
        <span className="text-gray-500">
          {cluster.records.length} records
        </span>
        {merged && (
          <span className="rounded bg-green-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
            merged · {result!.deletedIds.length} deleted ·{" "}
            {result!.relationsMoved} links moved
          </span>
        )}
        {result && !result.ok && (
          <span className="rounded bg-red-600 px-1.5 py-0.5 text-[10px] font-bold text-white">
            ERROR
          </span>
        )}
      </div>

      <div className="mt-2 space-y-1">
        {cluster.records.map((record) => (
          <label
            key={record.id}
            className="flex cursor-pointer items-center gap-2 text-xs"
          >
            <input
              type="radio"
              name={`survivor-${cluster.key}`}
              checked={survivorId === record.id}
              disabled={disabled || merged}
              onChange={() => onPickSurvivor(record.id)}
            />
            <span
              className={
                survivorId === record.id ? "font-bold" : "text-gray-500"
              }
            >
              {record.name}
            </span>
            <span className="text-gray-400">
              {record.filledFields} fields · {record.linkedOpportunityIds.length}{" "}
              linked opps
              {survivorId === record.id ? " · SURVIVOR" : " · will be deleted"}
            </span>
          </label>
        ))}
      </div>

      {cluster.conflicts.length > 0 && (
        <div className="mt-2 rounded border border-amber-300 bg-amber-50 p-2 text-xs dark:bg-amber-950/30">
          <div className="font-bold text-amber-800 dark:text-amber-300">
            Conflicting field values — the survivor’s value wins, others are
            lost with the deleted record:
          </div>
          {cluster.conflicts.map((c) => (
            <div key={c.field} className="mt-1">
              <span className="text-gray-500">{c.field}:</span>{" "}
              {c.values.map((v) => `${v.name}: “${v.value}”`).join(" · ")}
            </div>
          ))}
        </div>
      )}
      {result?.error && (
        <div className="mt-2 rounded border border-red-300 bg-red-50 p-2 text-xs text-red-800 dark:bg-red-950/30 dark:text-red-300">
          {result.error}
        </div>
      )}
    </div>
  );
}
