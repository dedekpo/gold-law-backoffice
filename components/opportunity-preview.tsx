"use client";

import Link from "next/link";
import type { OpportunityPreviewResponse } from "@/app/api/opportunity/preview/route";
import type { QueueEntry } from "@/app/api/investigation/queue/route";
import { proxied } from "@/lib/case-display";
import {
  Btn,
  ErrorNote,
  fmtDate,
  Stamp,
} from "@/components/investigation/ui";

/**
 * The AI desk's docket preview: what's on file for a Ready-for-AI opportunity
 * before committing to a run — the evidence the agent would read, and whether
 * it already ran. The run starts from here, never from the docket row itself.
 */
export function OpportunityPreviewPane({
  entry,
  preview,
  importing,
  actionError,
  onRun,
}: {
  entry: QueueEntry;
  /** null while loading. */
  preview: { data: OpportunityPreviewResponse | null; error: string | null } | null;
  importing: boolean;
  /** Error from the last run attempt. */
  actionError: string | null;
  onRun: () => void;
}) {
  const data = preview?.data ?? null;
  const files = data?.files ?? [];

  return (
    <div className="min-h-0 flex-1 overflow-y-auto font-sans">
      <div className="mx-auto max-w-2xl px-6 py-10">
        <header className="border-b-2 border-ink/80 pb-5">
          <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
            <p className="font-mono text-[11px] tracking-[0.22em] text-stamp uppercase">
              Gold Law · AI desk
            </p>
            <p className="font-mono text-[11px] text-faint">No. {entry.id}</p>
          </div>
          <h2 className="mt-2 font-serif text-2xl font-semibold text-ink">
            {entry.name}
          </h2>
          <p className="mt-1 font-mono text-[11px] text-faint">
            {entry.createdAt ? `Opened ${fmtDate(entry.createdAt)}` : "No date"}
            {entry.contactName && ` · ${entry.contactName}`}
          </p>

          {data?.existingRun && (
            <div className="mt-3">
              <Stamp tone="pending" title="Re-running overwrites the AI Intake fields and the saved report PDF.">
                Already ran · {data.existingRun.status}
              </Stamp>
            </div>
          )}

          {actionError && (
            <div className="mt-3">
              <ErrorNote>{actionError}</ErrorNote>
            </div>
          )}

          <div className="mt-4 flex flex-wrap items-center gap-2">
            <Btn
              variant="primary"
              disabled={importing || files.length === 0}
              onClick={onRun}
            >
              {importing
                ? "Fetching evidence…"
                : data?.existingRun
                  ? "Run the agent again"
                  : "Run the agent"}
            </Btn>
            <Link
              href={`/investigation?opp=${encodeURIComponent(entry.id)}`}
              className="rounded-xs border border-rule-strong px-3.5 py-1.5 text-sm font-medium text-ink transition-colors hover:bg-wash"
            >
              Open the investigation file
            </Link>
          </div>
          <p className="mt-3 text-xs leading-5 text-soft">
            The run screens the evidence, checks the client&rsquo;s number
            against the DNC registries, and identifies the company — then
            files the findings back onto the opportunity.
          </p>
        </header>

        <section className="mt-6">
          <div className="mb-3 flex items-center gap-3">
            <span className="shrink-0 font-mono text-[11px] tracking-[0.14em] text-soft uppercase">
              Evidence on file
            </span>
            <span aria-hidden className="h-px flex-1 bg-rule" />
            {data && (
              <span className="shrink-0 font-mono text-[11px] text-faint">
                {files.length} file{files.length === 1 ? "" : "s"}
              </span>
            )}
          </div>

          {preview === null ? (
            <p className="font-mono text-sm text-soft">Pulling the file…</p>
          ) : preview.error ? (
            <ErrorNote>{preview.error}</ErrorNote>
          ) : files.length === 0 ? (
            <p className="text-sm leading-6 text-soft">
              Nothing in the Violation Screenshots or Violation Audio Files
              fields — there is no evidence for the agent to read. Follow up
              with the client, or add files on the opportunity first.
            </p>
          ) : (
            <ul className="grid grid-cols-2 gap-3 sm:grid-cols-3">
              {files.map((file, i) => (
                <li key={`${file.url}-${i}`} className="min-w-0">
                  <div className="relative border border-rule bg-paper">
                    <span className="absolute top-1 left-1 border border-rule-strong bg-card px-1 font-mono text-[9px] tracking-[0.12em] text-soft uppercase">
                      Ex {String(i + 1).padStart(2, "0")}
                    </span>
                    {file.kind === "image" ? (
                      // eslint-disable-next-line @next/next/no-img-element
                      <img
                        src={proxied(file.url)}
                        alt={file.name}
                        loading="lazy"
                        className="h-32 w-full object-cover object-top"
                      />
                    ) : (
                      <div className="flex h-32 w-full items-center justify-center">
                        <span className="font-mono text-[10px] tracking-[0.14em] text-faint uppercase">
                          Audio
                        </span>
                      </div>
                    )}
                  </div>
                  <p className="mt-1 truncate font-mono text-[10px] text-faint">
                    {file.name}
                  </p>
                </li>
              ))}
            </ul>
          )}

          {data !== null && data.skipped > 0 && (
            <p className="mt-3 text-xs text-soft">
              {data.skipped} file{data.skipped === 1 ? "" : "s"} in the
              evidence fields skipped — not audio or images.
            </p>
          )}
        </section>
      </div>
    </div>
  );
}
