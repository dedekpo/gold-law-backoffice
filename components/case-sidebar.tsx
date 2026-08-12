"use client";

import Link from "next/link";
import type { QueueEntry } from "@/app/api/investigation/queue/route";
import type { Band, Case } from "@/lib/types";
import { bandTone, bestBand } from "@/lib/display";
import { Btn, ErrorNote, fmtDate, Stamp } from "@/components/investigation/ui";

/**
 * The AI desk's left rail: the Ready-for-AI docket (open opportunities in the
 * '👀 Ready for AI Investigation' stage — the default way a run starts) above
 * the runs of this browser session. A docket row opens the opportunity's
 * preview; the run starts there. "New case" (pasted URL / manual upload) is
 * the optional side door.
 */
export function CaseSidebar({
  cases,
  selectedCaseId,
  onSelect,
  onNewCase,
  queue,
  queueError,
  importingId,
  selectedQueueId,
  onSelectQueueEntry,
}: {
  cases: Case[];
  selectedCaseId: string | null;
  onSelect: (id: string) => void;
  onNewCase: () => void;
  /** null while the queue is loading. */
  queue: QueueEntry[] | null;
  queueError: string | null;
  /** Opportunity id whose evidence is being fetched, if any. */
  importingId: string | null;
  /** Opportunity whose preview is open in the main pane. */
  selectedQueueId: string | null;
  onSelectQueueEntry: (entry: QueueEntry) => void;
}) {
  // Runs started this session, by opportunity — a second click on a docket
  // row reopens the run instead of importing again.
  const sessionCaseByOpp = new Map(
    cases
      .filter((c) => c.opportunityId)
      .map((c) => [c.opportunityId!, c.id] as const),
  );

  return (
    <aside className="flex min-h-0 w-80 shrink-0 flex-col border-r border-rule bg-paper font-sans">
      <div className="border-b border-rule px-4 py-4">
        <Link
          href="/"
          className="font-mono text-[10px] tracking-[0.2em] text-stamp uppercase hover:underline"
        >
          Gold Law · Lobby
        </Link>
        <div className="mt-1.5 flex items-center justify-between gap-2">
          <h1 className="font-serif text-lg font-semibold text-ink">
            AI investigation
          </h1>
          <Btn small onClick={onNewCase} title="Paste a GHL URL or upload files">
            New case
          </Btn>
        </div>
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto">
        <section className="border-b border-rule px-4 py-4">
          <p className="font-mono text-[10px] tracking-[0.14em] text-soft uppercase">
            Docket · Ready for AI
            {queue !== null && ` (${queue.length})`}
          </p>
          {queueError ? (
            <div className="mt-2">
              <ErrorNote>{queueError}</ErrorNote>
            </div>
          ) : queue === null ? (
            <p className="mt-3 font-mono text-xs text-soft">Pulling the queue…</p>
          ) : queue.length === 0 ? (
            <p className="mt-3 text-sm text-soft">The queue is clear.</p>
          ) : (
            <ul className="mt-2 flex flex-col">
              {queue.map((entry) => (
                <QueueRow
                  key={entry.id}
                  entry={entry}
                  sessionCaseId={sessionCaseByOpp.get(entry.id) ?? null}
                  importing={importingId === entry.id}
                  selected={selectedQueueId === entry.id && !selectedCaseId}
                  onSelect={onSelect}
                  onOpen={onSelectQueueEntry}
                />
              ))}
            </ul>
          )}
        </section>

        <section className="px-4 py-4">
          <p className="font-mono text-[10px] tracking-[0.14em] text-soft uppercase">
            This session
          </p>
          {cases.length === 0 ? (
            <p className="mt-3 text-sm text-soft">
              No runs yet. Pick an opportunity from the docket above.
            </p>
          ) : (
            <ul className="mt-2 flex flex-col gap-1">
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
        </section>
      </div>
    </aside>
  );
}

function QueueRow({
  entry,
  sessionCaseId,
  importing,
  selected,
  onSelect,
  onOpen,
}: {
  entry: QueueEntry;
  /** Session case already started from this opportunity, if any. */
  sessionCaseId: string | null;
  importing: boolean;
  selected: boolean;
  onSelect: (caseId: string) => void;
  onOpen: (entry: QueueEntry) => void;
}) {
  return (
    <li className="border-b border-rule/70 last:border-b-0">
      <button
        type="button"
        onClick={() =>
          sessionCaseId ? onSelect(sessionCaseId) : onOpen(entry)
        }
        className={`flex w-full flex-col gap-0.5 px-1 py-2.5 text-left transition-colors ${
          selected ? "bg-wash" : "hover:bg-wash/60"
        }`}
      >
        <span className="flex items-center justify-between gap-2">
          <span className="truncate text-sm font-medium text-ink">
            {entry.name}
          </span>
          {sessionCaseId ? (
            <Stamp tone="ledger">In session</Stamp>
          ) : importing ? (
            <Stamp tone="pending">Fetching…</Stamp>
          ) : null}
        </span>
        <span className="truncate font-mono text-[11px] text-faint">
          {entry.createdAt ? fmtDate(entry.createdAt) : "No date"}
          {entry.contactName && ` · ${entry.contactName}`}
        </span>
      </button>
    </li>
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
  const bands = (caseItem.defendants ?? [])
    .map((c) => c.scorecard?.band)
    .filter((b): b is Band => Boolean(b));
  const topBand = bestBand(bands);
  const tone = topBand ? bandTone(topBand) : null;

  return (
    <button
      type="button"
      onClick={onSelect}
      className={`flex w-full items-center gap-3 rounded-xs px-2 py-2.5 text-left transition-colors ${
        selected ? "bg-wash" : "hover:bg-wash/60"
      }`}
    >
      <span
        className={`h-2 w-2 shrink-0 rounded-full ${tone ? tone.dot : "bg-rule-strong"}`}
        aria-hidden
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="truncate text-sm font-medium text-ink">
          {caseItem.name}
        </span>
        <span className="truncate font-mono text-[11px] text-faint">
          {fileCount} file{fileCount === 1 ? "" : "s"}
          {companyCount > 0 &&
            ` · ${companyCount} compan${companyCount === 1 ? "y" : "ies"}`}
        </span>
      </span>
      {tone && (
        <span className="shrink-0 font-mono text-[10px] font-semibold tracking-wide text-faint uppercase">
          {tone.label}
        </span>
      )}
    </button>
  );
}
