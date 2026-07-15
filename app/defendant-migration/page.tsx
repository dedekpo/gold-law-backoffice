"use client";

import { useMemo, useRef, useState } from "react";
import type {
  CompanyFlag,
  MigrationPlan,
  PlanAction,
  PlanItem,
} from "@/lib/defendant-migration";
import { DedupeSection } from "./dedupe-section";

/**
 * Dry-run + approve UI for the "Investigation on Company 1" → Defendants
 * custom-object migration. "Build plan" is read-only; nothing changes in GHL
 * until "Approve & execute" is pressed.
 */

type ItemResult = {
  ok: boolean;
  recordId: string | null;
  createdRecord: boolean;
  updatedFields: string[];
  linked: boolean;
  alreadyLinked: boolean;
  error: string | null;
};

const ACTION_LABEL: Record<PlanAction, string> = {
  "create-and-link": "CREATE + LINK",
  "update-and-link": "UPDATE + LINK",
  "link-only": "LINK ONLY",
  "already-linked": "ALREADY LINKED",
  skip: "SKIP",
};

const ACTION_CLASS: Record<PlanAction, string> = {
  "create-and-link": "bg-green-100 text-green-800",
  "update-and-link": "bg-blue-100 text-blue-800",
  "link-only": "bg-indigo-100 text-indigo-800",
  "already-linked": "bg-gray-200 text-gray-600",
  skip: "bg-gray-200 text-gray-600",
};

const FLAG_LABEL: Record<string, string> = {
  "similar-defendant-exists": "similar existing defendant — review",
  "matched-ignoring-punctuation": "matched existing record (punctuation differs)",
  "nonstandard-separator": "title uses a “v”/“vs” variant, not “v.”",
  "uppercase-v-separator": "capital “V.” — could be a middle initial, verify",
  "name-from-title": "name from title (no Legal Name field)",
  "no-company1-fields": "no Company 1 fields",
  "no-defendant-name": "no defendant name",
  "company2-data": "Company 2 data present",
  "company3-data": "Company 3 data present",
  conflicts: "field conflicts",
  "multiple-defendant-matches": "several existing records share this name",
  "linked-to-another-defendant": "already linked to a different defendant",
};

function Badge({ text, className }: { text: string; className: string }) {
  return (
    <span
      className={`inline-block shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold ${className}`}
    >
      {text}
    </span>
  );
}

function ItemRow({
  item,
  selected,
  onToggle,
  result,
  disabled,
}: {
  item: PlanItem;
  selected: boolean;
  onToggle: () => void;
  result: ItemResult | undefined;
  disabled: boolean;
}) {
  const actionable = item.action !== "skip" && item.action !== "already-linked";
  return (
    <details className="border-b border-gray-200 dark:border-zinc-800">
      <summary className="flex cursor-pointer items-center gap-2 px-2 py-1.5 hover:bg-gray-50 dark:hover:bg-zinc-900">
        <input
          type="checkbox"
          checked={selected}
          disabled={!actionable || disabled}
          onChange={onToggle}
          onClick={(e) => e.stopPropagation()}
          className="shrink-0"
        />
        <Badge text={ACTION_LABEL[item.action]} className={ACTION_CLASS[item.action]} />
        <span className="min-w-0 flex-1 truncate">
          <span className="text-gray-500">{item.opportunityName}</span>
          {item.defendantName && (
            <>
              {" → "}
              <span className="font-semibold">{item.defendantName}</span>
            </>
          )}
        </span>
        {Object.keys(item.setFields).length > 0 && (
          <span className="shrink-0 text-gray-400">
            {Object.keys(item.setFields).length} fields
          </span>
        )}
        {item.flags.map((f) => (
          <Badge key={f} text={FLAG_LABEL[f] ?? f} className="bg-amber-100 text-amber-800" />
        ))}
        {result &&
          (result.ok ? (
            <Badge
              text={[
                result.createdRecord ? "created" : null,
                result.updatedFields.length ? `filled ${result.updatedFields.length}` : null,
                result.linked ? "linked" : result.alreadyLinked ? "was linked" : null,
              ]
                .filter(Boolean)
                .join(" · ") || "done"}
              className="bg-green-600 text-white"
            />
          ) : (
            <Badge text="ERROR" className="bg-red-600 text-white" />
          ))}
      </summary>
      <div className="space-y-2 bg-gray-50 px-8 py-3 text-xs dark:bg-zinc-900">
        <div className="text-gray-500">
          Opportunity <code>{item.opportunityId}</code> · status {item.opportunityStatus} ·
          separator “{item.separator}” · name source: {item.nameSource ?? "—"}
          {item.titleName && item.nameSource === "legal-name-field" && (
            <> · title says: “{item.titleName}”</>
          )}
        </div>
        {item.existingRecordId ? (
          <div>
            Reuses existing defendant record{" "}
            <span className="font-semibold">{item.existingRecordName}</span>{" "}
            <code className="text-gray-500">{item.existingRecordId}</code>
            {item.alreadyLinked && " (already linked to this opportunity)"}
          </div>
        ) : (
          item.defendantName && <div>Defendant record will be created.</div>
        )}
        {item.similarExisting.length > 0 && (
          <div className="rounded border border-amber-300 bg-amber-50 p-2 dark:bg-amber-950/30">
            <div className="font-bold text-amber-800 dark:text-amber-300">
              Similar existing defendants (NOT auto-matched — check the row to
              create a new record anyway, or handle in the dedupe tab):
            </div>
            <ul className="mt-1">
              {item.similarExisting.map((s) => (
                <li key={s.id}>
                  <span className="font-semibold">{s.name}</span>{" "}
                  <span className="text-gray-500">— {s.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {Object.keys(item.setFields).length > 0 && (
          <table className="w-full">
            <tbody>
              {Object.entries(item.setFields).map(([key, value]) => (
                <tr key={key} className="align-top">
                  <td className="w-72 pr-2 text-gray-500">{key}</td>
                  <td className="whitespace-pre-wrap break-all">{value}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {item.conflicts.length > 0 && (
          <div className="rounded border border-amber-300 bg-amber-50 p-2 dark:bg-amber-950/30">
            <div className="font-bold text-amber-800 dark:text-amber-300">
              Conflicts — existing values are kept, these are NOT written:
            </div>
            <table className="mt-1 w-full">
              <tbody>
                {item.conflicts.map((c) => (
                  <tr key={c.field} className="align-top">
                    <td className="w-72 pr-2 text-gray-500">{c.field}</td>
                    <td className="whitespace-pre-wrap break-all">
                      keeps: {c.existing}
                      <br />
                      this card had: {c.incoming}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {result?.error && (
          <div className="rounded border border-red-300 bg-red-50 p-2 text-red-800 dark:bg-red-950/30 dark:text-red-300">
            {result.error}
          </div>
        )}
      </div>
    </details>
  );
}

export default function DefendantMigrationPage() {
  const [tab, setTab] = useState<"migration" | "dedupe">("migration");
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [planning, setPlanning] = useState(false);
  const [planError, setPlanError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [executing, setExecuting] = useState(false);
  const [progress, setProgress] = useState({ done: 0, total: 0 });
  const [results, setResults] = useState<Map<string, ItemResult>>(new Map());
  const [executeError, setExecuteError] = useState<string | null>(null);
  const abortRef = useRef(false);

  async function buildPlan() {
    setPlanning(true);
    setPlanError(null);
    setPlan(null);
    setResults(new Map());
    setExecuteError(null);
    try {
      const res = await fetch("/api/defendant-migration/plan");
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `Plan failed (${res.status})`);
      const nextPlan = body as MigrationPlan;
      setPlan(nextPlan);
      setSelected(
        new Set(
          nextPlan.items
            .filter((i) => i.defaultSelected)
            .map((i) => i.opportunityId),
        ),
      );
    } catch (err) {
      setPlanError(err instanceof Error ? err.message : "Plan request failed");
    } finally {
      setPlanning(false);
    }
  }

  const actionable = useMemo(
    () =>
      (plan?.items ?? []).filter(
        (i) => i.action !== "skip" && i.action !== "already-linked",
      ),
    [plan],
  );
  const selectedItems = actionable.filter((i) => selected.has(i.opportunityId));

  function toggle(id: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function execute() {
    if (!plan || selectedItems.length === 0) return;
    const confirmed = window.confirm(
      `Execute ${selectedItems.length} approved changes in GoHighLevel? ` +
        "Defendant records will be created/updated and linked to opportunities.",
    );
    if (!confirmed) return;

    setExecuting(true);
    setExecuteError(null);
    abortRef.current = false;

    // Keep all items of one defendant group in the same request so the server
    // resolves the record once and never creates duplicates.
    const groupOrder: string[] = [];
    const byGroup = new Map<string, PlanItem[]>();
    for (const item of selectedItems) {
      const key = item.groupKey ?? item.opportunityId;
      if (!byGroup.has(key)) {
        byGroup.set(key, []);
        groupOrder.push(key);
      }
      byGroup.get(key)!.push(item);
    }
    const batches: PlanItem[][] = [];
    let batch: PlanItem[] = [];
    for (const key of groupOrder) {
      const group = byGroup.get(key)!;
      if (batch.length > 0 && batch.length + group.length > 20) {
        batches.push(batch);
        batch = [];
      }
      batch.push(...group);
    }
    if (batch.length) batches.push(batch);

    setProgress({ done: 0, total: selectedItems.length });
    let done = 0;
    try {
      for (const chunk of batches) {
        if (abortRef.current) break;
        const res = await fetch("/api/defendant-migration/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            items: chunk.map((i) => ({
              opportunityId: i.opportunityId,
              opportunityName: i.opportunityName,
              defendantName: i.defendantName,
              groupKey: i.groupKey,
              existingRecordId: i.existingRecordId,
              setFields: i.setFields,
            })),
          }),
        });
        const body = await res.json();
        if (!res.ok) throw new Error(body.error ?? `Execute failed (${res.status})`);
        setResults((prev) => {
          const next = new Map(prev);
          for (const r of body.results as ({ opportunityId: string } & ItemResult)[]) {
            next.set(r.opportunityId, r);
          }
          return next;
        });
        done += chunk.length;
        setProgress({ done, total: selectedItems.length });
      }
    } catch (err) {
      setExecuteError(
        err instanceof Error ? err.message : "Execute request failed",
      );
    } finally {
      setExecuting(false);
    }
  }

  const succeeded = [...results.values()].filter((r) => r.ok).length;
  const failed = [...results.values()].filter((r) => !r.ok).length;

  return (
    // The root layout locks <body> to the viewport, so this page scrolls itself.
    <main className="min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto max-w-6xl px-6 py-10 font-mono text-sm">
        <h1 className="text-xl font-bold">
          Defendant migration — Company 1 → Defendants custom object
        </h1>

        <div className="mt-3 flex gap-1 border-b border-gray-200 dark:border-zinc-800">
          {(
            [
              ["migration", "Field migration"],
              ["dedupe", "Existing duplicates"],
            ] as const
          ).map(([key, label]) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`rounded-t px-3 py-1.5 ${
                tab === key
                  ? "border border-b-0 border-gray-200 font-bold dark:border-zinc-800"
                  : "text-gray-500"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {tab === "dedupe" && <DedupeSection />}
        {tab === "migration" && (
          <>
        <p className="mt-1 text-gray-500">
          Scans opportunities titled “… v. …” (also the manual-entry variants
          “v”, “vs”, “vs.”), copies their Company 1 investigation fields into
          the Defendants custom object (fill-empty only, never overwriting)
          and links the defendant to the opportunity. Building the plan is
          read-only; nothing changes until you approve.
        </p>

        <div className="mt-4 flex items-center gap-3">
          <button
            onClick={buildPlan}
            disabled={planning || executing}
            className="rounded bg-gray-900 px-4 py-2 text-white disabled:opacity-40 dark:bg-zinc-100 dark:text-zinc-900"
          >
            {planning ? "Scanning ~5.5k opportunities…" : plan ? "Rebuild plan" : "Build migration plan"}
          </button>
          {plan && !executing && (
            <button
              onClick={execute}
              disabled={selectedItems.length === 0}
              className="rounded bg-green-700 px-4 py-2 font-bold text-white disabled:opacity-40"
            >
              Approve &amp; execute {selectedItems.length} changes
            </button>
          )}
          {executing && (
            <>
              <span>
                Executing… {progress.done}/{progress.total}
              </span>
              <button
                onClick={() => (abortRef.current = true)}
                className="rounded border border-red-600 px-3 py-2 text-red-600"
              >
                Stop after current batch
              </button>
            </>
          )}
        </div>

        {planError && (
          <div className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-red-800 dark:bg-red-950/30 dark:text-red-300">
            {planError}
          </div>
        )}
        {executeError && (
          <div className="mt-4 rounded border border-red-300 bg-red-50 p-3 text-red-800 dark:bg-red-950/30 dark:text-red-300">
            Execution stopped: {executeError} — already-applied changes are
            safe; rebuild the plan and re-run, completed items resolve to
            “already linked”.
          </div>
        )}
        {results.size > 0 && !executing && (
          <div className="mt-4 rounded border border-gray-300 bg-gray-50 p-3 dark:border-zinc-700 dark:bg-zinc-900">
            Done: {succeeded} succeeded, {failed} failed.{" "}
            {failed > 0 && "Failed rows are marked below — expand for the error."}
          </div>
        )}

        {plan && (
          <>
            <div className="mt-6 flex flex-wrap gap-2 text-xs">
              {[
                ["scanned", plan.totals.opportunitiesScanned],
                ["“v./vs” cards in scope", plan.totals.inScope],
                ["create + link", plan.totals.createAndLink],
                ["update + link", plan.totals.updateAndLink],
                ["link only", plan.totals.linkOnly],
                ["already linked", plan.totals.alreadyLinked],
                ["skipped", plan.totals.skipped],
                ["with conflicts", plan.totals.withConflicts],
                ["existing defendant records", plan.totals.existingDefendantRecords],
              ].map(([label, value]) => (
                <span
                  key={label}
                  className="rounded border border-gray-300 px-2 py-1 dark:border-zinc-700"
                >
                  <span className="font-bold">{value}</span> {label}
                </span>
              ))}
            </div>

            {plan.companyFlags.length > 0 && (
              <div className="mt-6 rounded border border-amber-400 bg-amber-50 p-3 dark:bg-amber-950/30">
                <div className="font-bold text-amber-900 dark:text-amber-300">
                  🚩 {plan.companyFlags.length} opportunities have Company 2/3
                  investigation data — NOT migrated, handle separately:
                </div>
                <ul className="mt-2 space-y-1 text-xs">
                  {plan.companyFlags.map((f: CompanyFlag) => (
                    <li key={`${f.opportunityId}-${f.company}`}>
                      <span className="font-semibold">{f.opportunityName}</span>{" "}
                      — Company {f.company} ({Object.keys(f.fields).length}{" "}
                      fields{f.inScope ? "" : ", card not in “v./vs” scope"})
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-6 flex items-center gap-3 text-xs">
              <span className="text-gray-500">
                {selectedItems.length}/{actionable.length} selected
              </span>
              <button
                onClick={() =>
                  setSelected(new Set(actionable.map((i) => i.opportunityId)))
                }
                disabled={executing}
                className="underline"
              >
                select all
              </button>
              <button
                onClick={() => setSelected(new Set())}
                disabled={executing}
                className="underline"
              >
                select none
              </button>
              <button
                onClick={() =>
                  setSelected(
                    new Set(
                      actionable
                        .filter((i) => i.flags.length === 0)
                        .map((i) => i.opportunityId),
                    ),
                  )
                }
                disabled={executing}
                className="underline"
              >
                only unflagged
              </button>
            </div>

            <div className="mt-2 rounded border border-gray-200 dark:border-zinc-800">
              {plan.items.map((item) => (
                <ItemRow
                  key={item.opportunityId}
                  item={item}
                  selected={selected.has(item.opportunityId)}
                  onToggle={() => toggle(item.opportunityId)}
                  result={results.get(item.opportunityId)}
                  disabled={executing}
                />
              ))}
            </div>
          </>
        )}
          </>
        )}
      </div>
    </main>
  );
}
