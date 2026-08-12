"use client";

import type { InvestigationDoc } from "@/lib/investigation-store";
import { statusStamp } from "./header";
import { DocketList } from "./log";
import { api, Btn, Eyebrow, fmtDate, Stamp, Tag, type RunFn } from "./ui";

/**
 * Closed investigations stay on the record: what was decided, by whom, and
 * the full docket — collapsed, since the working surfaces come first. A
 * mistaken no-case close can be reopened; a converted one cannot (its case
 * opportunities already exist).
 */

export function HistorySection({
  investigations,
  actorName,
  busy,
  run,
}: {
  investigations: InvestigationDoc[];
  actorName: string;
  busy: string | null;
  run: RunFn;
}) {
  if (investigations.length === 0) return null;
  return (
    <section>
      <Eyebrow>File history</Eyebrow>
      <div className="flex flex-col gap-2">
        {investigations.map((inv) => (
          <ClosedCard
            key={inv.id}
            inv={inv}
            actorName={actorName}
            busy={busy}
            run={run}
          />
        ))}
      </div>
    </section>
  );
}

function ClosedCard({
  inv,
  actorName,
  busy,
  run,
}: {
  inv: InvestigationDoc;
  actorName: string;
  busy: string | null;
  run: RunFn;
}) {
  const stamp = statusStamp(inv);
  const reopenKey = `reopen:${inv.id}`;
  return (
    <div className="rounded-xs border border-rule bg-card px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Stamp tone={stamp.tone}>{stamp.label}</Stamp>
        <Tag>
          Opened {fmtDate(inv.createdAt)} · last touched {fmtDate(inv.updatedAt)}
        </Tag>
        <span className="flex-1" />
        {inv.outcome && inv.outcome !== "converted" && (
          <Btn
            small
            disabled={busy !== null}
            onClick={() =>
              void run(
                reopenKey,
                async () => {
                  const { doc } = await api<{ doc: InvestigationDoc }>(
                    "/api/investigation/status",
                    "POST",
                    {
                      investigationId: inv.id,
                      actorName: actorName.trim() || "backoffice",
                      action: "reopen",
                    },
                  );
                  return doc;
                },
                { reload: true },
              )
            }
          >
            {busy === reopenKey ? "Reopening…" : "Reopen"}
          </Btn>
        )}
      </div>

      {inv.companies.length > 0 && (
        <ul className="mt-2 flex flex-col gap-1">
          {inv.companies.map((c) => (
            <li key={c.id} className="flex items-center gap-2 text-sm text-ink">
              <Stamp
                tone={
                  c.status === "confirmed"
                    ? "ledger"
                    : c.status === "rejected"
                      ? "stamp"
                      : "pending"
                }
              >
                {c.status}
              </Stamp>
              <span className="font-serif font-semibold">
                {c.profile.legal_name || c.profile.company_name}
              </span>
              <Tag>{c.origin.kind === "ai" ? "AI" : c.origin.name}</Tag>
            </li>
          ))}
        </ul>
      )}

      {inv.log.length > 0 && (
        <details className="group mt-2">
          <summary className="cursor-pointer font-mono text-[10px] tracking-[0.12em] text-faint uppercase select-none hover:text-soft">
            <span className="group-open:hidden">▸</span>
            <span className="hidden group-open:inline">▾</span> Docket (
            {inv.log.length})
          </summary>
          <div className="mt-2">
            <DocketList log={inv.log} />
          </div>
        </details>
      )}
    </div>
  );
}
