import type { Band, Case } from "@/lib/types";
import { bandTone, bestBand } from "@/lib/display";

const neutralChip =
  "rounded-full bg-zinc-100 px-2.5 py-1 text-[11px] text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400";

/** Compact status/band chip for the sidebar and detail header. */
export function CaseStatusBadge({ caseItem }: { caseItem: Case }) {
  const allDone = caseItem.files.every((f) => f.status !== "processing");
  if (!allDone) return <span className={neutralChip}>Waiting…</span>;

  if (caseItem.screeningStatus === "evaluating") {
    return <span className={neutralChip}>Screening…</span>;
  }
  if (caseItem.screeningStatus === "error") {
    return (
      <span
        className="rounded-full bg-red-100 px-2.5 py-1 text-[11px] text-red-700 dark:bg-red-950 dark:text-red-300"
        title={caseItem.screeningError ?? undefined}
      >
        Screening failed
      </span>
    );
  }

  if (caseItem.gate?.declined) {
    const timeBarred = caseItem.gate.declineReason === "time-barred";
    return (
      <span
        className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
          timeBarred
            ? "bg-red-100 text-red-700 dark:bg-red-950 dark:text-red-300"
            : "bg-zinc-200 text-zinc-700 dark:bg-zinc-800 dark:text-zinc-300"
        }`}
      >
        {timeBarred ? "Time-barred" : "Declined"}
      </span>
    );
  }

  // Companies scored → show the strongest band.
  const bands = (caseItem.defendants ?? [])
    .map((c) => c.scorecard?.band)
    .filter((b): b is Band => Boolean(b));
  const top = bestBand(bands);
  if (top) {
    const tone = bandTone(top);
    const count = bands.length;
    return (
      <span
        className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ${tone.chip} ${tone.ring}`}
        title={`${count} compan${count === 1 ? "y" : "ies"} scored`}
      >
        <span className="text-[10px] uppercase tracking-wide">{tone.label}</span>
        {count > 1 && <span className="opacity-70">+{count - 1}</span>}
      </span>
    );
  }

  if (caseItem.defendantStatus === "identifying") {
    return <span className={neutralChip}>Investigating…</span>;
  }
  if (caseItem.defendantStatus === "error") {
    return (
      <span
        className="rounded-full bg-red-100 px-2.5 py-1 text-[11px] text-red-700 dark:bg-red-950 dark:text-red-300"
        title={caseItem.defendantError ?? undefined}
      >
        ID failed
      </span>
    );
  }
  if (caseItem.defendantStatus === "done") {
    return <span className={neutralChip}>No companies</span>;
  }
  return null;
}

/** Intake gate banner: SOL + plausible-claim outcome (see screening-spec §1–2). */
export function GateBanner({ caseItem }: { caseItem: Case }) {
  if (caseItem.screeningStatus === "evaluating") {
    return (
      <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
        Screening the evidence against the intake rules…
      </div>
    );
  }
  if (caseItem.screeningStatus === "error") {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
        {caseItem.screeningError ?? "Screening failed: unknown error"}
      </div>
    );
  }

  const gate = caseItem.gate;
  if (!gate) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
        Waiting for files to finish processing…
      </div>
    );
  }

  if (gate.declined && gate.declineReason === "time-barred") {
    return (
      <div className="rounded-lg border border-red-300 bg-red-50 p-4 dark:border-red-800 dark:bg-red-950">
        <p className="text-sm font-semibold text-red-800 dark:text-red-200">
          ⚠ Time-barred — declined at the 4-year SOL gate
        </p>
        <p className="mt-1 text-sm text-red-700 dark:text-red-300">
          No qualifying message falls inside the viable filing window (4 years
          minus a 30-day buffer). Identification was not run.
        </p>
        {gate.notifyLeadImmediately && (
          <p className="mt-2 rounded-md bg-red-100 px-3 py-2 text-sm font-medium text-red-900 dark:bg-red-900/60 dark:text-red-100">
            Notify the lead immediately so they can seek other counsel while they
            still can.
          </p>
        )}
      </div>
    );
  }

  if (gate.declined) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
        <p className="text-sm font-semibold text-zinc-800 dark:text-zinc-200">
          Declined — no plausible claim
        </p>
        <p className="mt-1 text-sm text-zinc-600 dark:text-zinc-400">
          The evidence reads as informational only (no telemarketing or
          debt-collection violation). Identification was not run.
        </p>
      </div>
    );
  }

  // Passed the gate.
  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50 p-4 dark:border-emerald-900 dark:bg-emerald-950">
      <p className="text-sm font-medium text-emerald-800 dark:text-emerald-200">
        Passed intake screening — within the 4-year window with a plausible claim.
      </p>
      {gate.unknowns && gate.unknowns.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {gate.unknowns.map((u) => (
            <li
              key={u}
              className="text-xs text-emerald-700 dark:text-emerald-300"
            >
              • {u}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
