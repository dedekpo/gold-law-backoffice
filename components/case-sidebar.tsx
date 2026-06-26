"use client";

import type { ChangeEvent } from "react";
import type { Case } from "@/lib/types";
import { scoreTone } from "@/lib/display";
import { UploadIcon } from "./icons";

export function CaseSidebar({
  cases,
  selectedCaseId,
  onSelect,
  onUpload,
}: {
  cases: Case[];
  selectedCaseId: string | null;
  onSelect: (id: string) => void;
  onUpload: (event: ChangeEvent<HTMLInputElement>) => void;
}) {
  return (
    <aside className="flex min-h-0 w-72 shrink-0 flex-col border-r border-zinc-200 bg-zinc-50/60 dark:border-zinc-800 dark:bg-zinc-950/40">
      <div className="flex flex-col gap-2 border-b border-zinc-200 p-4 dark:border-zinc-800">
        <h1 className="px-1 pb-1 text-sm font-semibold tracking-tight text-zinc-900 dark:text-zinc-100">
          Intake cases
        </h1>
        <label className="flex cursor-pointer items-center justify-center gap-2 rounded-lg border border-zinc-300 px-4 py-2.5 text-sm font-medium text-zinc-700 transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900">
          <UploadIcon />
          Upload files
          <input
            type="file"
            accept="audio/*,image/*"
            multiple
            onChange={onUpload}
            className="hidden"
          />
        </label>
      </div>

      <nav className="flex-1 overflow-y-auto p-2">
        {cases.length === 0 ? (
          <p className="px-3 py-6 text-center text-xs text-zinc-500 dark:text-zinc-400">
            No cases yet. Upload files to start one.
          </p>
        ) : (
          <ul className="flex flex-col gap-1">
            {cases.map((c) => (
              <li key={c.id}>
                <CaseRow
                  caseItem={c}
                  selected={c.id === selectedCaseId}
                  onSelect={() => onSelect(c.id)}
                />
              </li>
            ))}
          </ul>
        )}
      </nav>
    </aside>
  );
}

function CaseRow({
  caseItem,
  selected,
  onSelect,
}: {
  caseItem: Case;
  selected: boolean;
  onSelect: () => void;
}) {
  const fileCount = caseItem.files.length;
  const companyCount = caseItem.defendants?.length ?? 0;
  const tone =
    caseItem.evaluation != null ? scoreTone(caseItem.evaluation.score) : null;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-left transition-colors ${
        selected
          ? "bg-zinc-200/70 dark:bg-zinc-800"
          : "hover:bg-zinc-100 dark:hover:bg-zinc-900"
      }`}
    >
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${tone ? tone.dot : "bg-zinc-300 dark:bg-zinc-700"}`}
        aria-hidden
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-zinc-900 dark:text-zinc-100">
          {caseItem.name}
        </span>
        <span className="truncate text-[11px] text-zinc-500 dark:text-zinc-400">
          {fileCount} file{fileCount === 1 ? "" : "s"}
          {companyCount > 0 &&
            ` · ${companyCount} compan${companyCount === 1 ? "y" : "ies"}`}
        </span>
      </span>
      {caseItem.evaluation != null && (
        <span className="shrink-0 text-xs font-semibold text-zinc-400 dark:text-zinc-500">
          {caseItem.evaluation.score}
        </span>
      )}
    </button>
  );
}
