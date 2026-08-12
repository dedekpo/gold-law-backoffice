"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { QueueResponse } from "@/app/api/investigation/queue/route";
import type { QueueDesk } from "@/lib/investigation-queue";

/**
 * The lobby: the firm's investigation work happens at three desks, and this
 * page routes to the right one. The AI desk runs the agent's first pass; the
 * review desk works the agent's results (split what it found, route what it
 * didn't); the investigator desk digs into the files the agent couldn't
 * crack. Each desk shows how much work is waiting in its GHL stage.
 */

type Tally = { count: number | null; failed: boolean };

const LOADING: Tally = { count: null, failed: false };

export default function LobbyPage() {
  const [tallies, setTallies] = useState<Record<QueueDesk, Tally>>({
    ai: LOADING,
    review: LOADING,
    manual: LOADING,
  });

  useEffect(() => {
    (["ai", "review", "manual"] as const).forEach((desk) => {
      void (async () => {
        let tally: Tally;
        try {
          const res = await fetch(`/api/investigation/queue?desk=${desk}`);
          const data = (await res.json().catch(() => null)) as
            | QueueResponse
            | null;
          tally =
            res.ok && data
              ? { count: data.entries.length, failed: false }
              : { count: null, failed: true };
        } catch {
          tally = { count: null, failed: true };
        }
        setTallies((prev) => ({ ...prev, [desk]: tally }));
      })();
    });
  }, []);

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-paper font-sans text-ink">
      <div className="mx-auto flex max-w-3xl gap-5 px-4 py-12 sm:px-6 sm:py-16">
        {/* The pleading-paper margin rule. */}
        <div
          aria-hidden
          className="hidden w-[5px] shrink-0 self-stretch border-x border-stamp/35 sm:block"
        />

        <div className="min-w-0 flex-1">
          <header className="border-b-2 border-ink/80 pb-5">
            <p className="font-mono text-[11px] tracking-[0.22em] text-stamp uppercase">
              Gold Law · Backoffice
            </p>
            <h1 className="mt-2 font-serif text-3xl font-semibold text-ink">
              Investigation
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-soft">
              Every intake flows down this page: the agent takes the first
              pass, its results get reviewed and split into cases, and what
              it can&rsquo;t crack goes to an investigator. Open a desk to
              work its queue.
            </p>
          </header>

          <DeskRow
            href="/ai-investigation"
            eyebrow="First pass · Automated"
            title="AI investigation"
            description="The agent screens the evidence against the TCPA rubric, checks the client's number against the DNC registries, and identifies the company behind the violation."
            stageName="👀 Ready for AI Investigation"
            tally={tallies.ai}
          />
          <DeskRow
            href="/investigation?desk=review"
            eyebrow="Agent results · Intaker"
            title="Review & split"
            description="Every opportunity the agent has taken on — review what it found, complete the checklist, and split the file into case opportunities. Runs that found nothing move to the investigators automatically."
            stageName="AI Under Investigation"
            tally={tallies.review}
          />
          <DeskRow
            href="/investigation"
            eyebrow="Deep dig · Investigator"
            title="Manual investigation"
            description="The investigation file for opportunities the agent couldn't crack — capture companies and evidence, keep the log, and split the file into case opportunities."
            stageName="🔍 Manual Investigation"
            tally={tallies.manual}
          />

        </div>
      </div>
    </main>
  );
}

function DeskRow({
  href,
  eyebrow,
  title,
  description,
  stageName,
  tally,
}: {
  href: string;
  eyebrow: string;
  title: string;
  description: string;
  /** The GHL pipeline stage this desk drains. */
  stageName: string;
  tally: Tally;
}) {
  return (
    <Link
      href={href}
      className="group flex items-start justify-between gap-6 border-b border-rule py-6 transition-colors hover:bg-wash sm:px-3 sm:-mx-3"
    >
      <div className="min-w-0">
        <p className="font-mono text-[10px] tracking-[0.18em] text-stamp uppercase">
          {eyebrow}
        </p>
        <h2 className="mt-1 font-serif text-xl font-semibold text-ink underline-offset-4 group-hover:underline">
          {title}
        </h2>
        <p className="mt-1.5 max-w-lg text-sm leading-6 text-soft">
          {description}
        </p>
        <p className="mt-2 font-mono text-[11px] text-faint">
          Queue: {stageName}
        </p>
      </div>
      <div className="flex shrink-0 flex-col items-end pt-1">
        <span className="font-mono text-3xl font-medium text-ink tabular-nums">
          {tally.failed ? "—" : (tally.count ?? "·")}
        </span>
        <span className="font-mono text-[10px] tracking-[0.14em] text-faint uppercase">
          {tally.failed ? "Unavailable" : "Waiting"}
        </span>
      </div>
    </Link>
  );
}
