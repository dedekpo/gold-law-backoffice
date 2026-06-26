import type { Case } from "@/lib/types";
import { categoryLabel, messageTypeLabel, scoreTone } from "@/lib/display";

/** Compact score chip shown in the sidebar and detail header. */
export function ScoreBadge({ caseItem }: { caseItem: Case }) {
  const allDone = caseItem.files.every((f) => f.status !== "processing");

  if (!allDone) {
    return (
      <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-[11px] text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
        Waiting…
      </span>
    );
  }

  if (caseItem.evaluationStatus === "evaluating") {
    return (
      <span className="rounded-full bg-zinc-100 px-2.5 py-1 text-[11px] text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
        Evaluating…
      </span>
    );
  }

  if (caseItem.evaluationStatus === "error") {
    return (
      <span
        className="rounded-full bg-red-100 px-2.5 py-1 text-[11px] text-red-700 dark:bg-red-950 dark:text-red-300"
        title={caseItem.evaluationError ?? undefined}
      >
        Eval failed
      </span>
    );
  }

  if (!caseItem.evaluation) return null;

  const tone = scoreTone(caseItem.evaluation.score);

  return (
    <span
      className={`flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-medium ring-1 ${tone.chip} ${tone.ring}`}
    >
      <span className="text-sm font-bold leading-none">
        {caseItem.evaluation.score}
      </span>
      <span className="opacity-70">/ 10</span>
      <span className="hidden text-[10px] uppercase tracking-wide opacity-80 sm:inline">
        {tone.label}
      </span>
    </span>
  );
}

/** Full TCPA evaluation breakdown for the detail panel. */
export function EvaluationPanel({ caseItem }: { caseItem: Case }) {
  if (caseItem.evaluationStatus === "evaluating") {
    return (
      <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
        Evaluating case against the TCPA rubric…
      </div>
    );
  }

  if (caseItem.evaluationStatus === "error") {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
        Evaluation failed: {caseItem.evaluationError ?? "unknown error"}
      </div>
    );
  }

  if (!caseItem.evaluation) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
        Waiting for files to finish processing…
      </div>
    );
  }

  const tone = scoreTone(caseItem.evaluation.score);

  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          TCPA evaluation
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tone.chip}`}
        >
          {tone.label}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-zinc-500 dark:text-zinc-400">Score</dt>
        <dd className="font-semibold text-zinc-900 dark:text-zinc-100">
          {caseItem.evaluation.score} / 10
        </dd>

        <dt className="text-zinc-500 dark:text-zinc-400">Category</dt>
        <dd className="text-zinc-900 dark:text-zinc-100">
          {categoryLabel(caseItem.evaluation.category)}
        </dd>

        <dt className="text-zinc-500 dark:text-zinc-400">Message type</dt>
        <dd className="text-zinc-900 dark:text-zinc-100">
          {messageTypeLabel(caseItem.evaluation.message_type)}
        </dd>

        {caseItem.evaluation.needs_external_check.length > 0 && (
          <>
            <dt className="text-zinc-500 dark:text-zinc-400">Needs check</dt>
            <dd className="flex flex-wrap gap-1">
              {caseItem.evaluation.needs_external_check.map((token) => (
                <span
                  key={token}
                  className="rounded bg-zinc-200 px-1.5 py-0.5 text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                >
                  {token}
                </span>
              ))}
            </dd>
          </>
        )}
      </dl>

      <div className="mt-4 border-t border-zinc-200 pt-3 dark:border-zinc-800">
        <p className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Reasoning
        </p>
        <p className="mt-1 text-sm leading-6 text-zinc-700 dark:text-zinc-200">
          {caseItem.evaluation.reasoning}
        </p>
      </div>
    </div>
  );
}
