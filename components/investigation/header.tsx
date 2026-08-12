"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import type { InvestigationViewResponse } from "@/app/api/investigation/route";
import type {
  InvestigationDoc,
  InvestigationOutcome,
} from "@/lib/investigation-store";
import {
  api,
  Btn,
  ErrorNote,
  fmtDate,
  inputCls,
  Stamp,
  type RunFn,
  type StampTone,
} from "./ui";

/**
 * The caption header — this page's thesis. Styled after a court filing's
 * caption block: the matter in serif, the docket line in mono, and beneath it
 * the lineage chain (intake → investigation → cases) that the whole workflow
 * pivots on. Lifecycle actions (start / submit / review / reopen) live here,
 * always in the same place regardless of state.
 */

const OUTCOME_LABELS: Record<InvestigationOutcome, string> = {
  converted: "Converted to case(s)",
  no_company_found: "No company found",
  no_violation: "No violation",
  declined: "Declined",
};

export function statusStamp(inv: InvestigationDoc): {
  tone: StampTone;
  label: string;
} {
  if (inv.status === "open") return { tone: "pending", label: "Open" };
  if (inv.status === "ready_for_review")
    return { tone: "pending", label: "Ready for review" };
  const outcome = inv.outcome ? OUTCOME_LABELS[inv.outcome] : "Closed";
  return {
    tone: inv.outcome === "converted" ? "ledger" : "stamp",
    label: outcome,
  };
}

export function CaptionHeader({
  data,
  activeInv,
  actorName,
  onActorName,
  busy,
  error,
  run,
}: {
  data: InvestigationViewResponse;
  /** The open / in-review investigation, when there is one. */
  activeInv: InvestigationDoc | null;
  actorName: string;
  onActorName: (name: string) => void;
  busy: string | null;
  error: string | null;
  run: RunFn;
}) {
  const latest = data.investigations[0] ?? null;
  const spawnedCount = data.investigations.reduce(
    (n, inv) => n + inv.spawned.length,
    0,
  );

  return (
    <header className="border-b-2 border-ink/80 pb-5">
      <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
        <Link
          href="/investigation"
          title="Back to the docket"
          className="font-mono text-[11px] tracking-[0.22em] text-stamp uppercase hover:underline"
        >
          Gold Law · Investigation file
        </Link>
        <p className="font-mono text-[11px] text-faint">
          No. {data.opportunity.id}
        </p>
      </div>

      <div className="mt-2 flex flex-wrap items-center justify-between gap-x-6 gap-y-3">
        <h1 className="font-serif text-2xl font-semibold text-ink sm:text-[1.7rem]">
          {data.opportunity.name}
        </h1>
        <div className="flex items-center gap-2">
          <label className="font-mono text-[10px] tracking-[0.12em] text-faint uppercase">
            Working as
          </label>
          <input
            value={actorName}
            onChange={(e) => onActorName(e.target.value)}
            placeholder="Your name"
            className={`${inputCls} w-36 py-1 text-xs`}
          />
        </div>
      </div>

      <Lineage
        data={data}
        latest={latest}
        spawnedCount={spawnedCount}
      />

      {error && (
        <div className="mt-3">
          <ErrorNote>{error}</ErrorNote>
        </div>
      )}

      <Actions
        data={data}
        activeInv={activeInv}
        latest={latest}
        actorName={actorName}
        busy={busy}
        run={run}
      />
    </header>
  );
}

/** The chain: where this file sits between client intake and defendant cases. */
function Lineage({
  data,
  latest,
  spawnedCount,
}: {
  data: InvestigationViewResponse;
  latest: InvestigationDoc | null;
  spawnedCount: number;
}) {
  if (data.spawnedFrom) {
    return (
      <p className="mt-3 font-mono text-[11px] text-soft">
        <span className="tracking-[0.12em] uppercase">Case file</span>
        {" — spawned from the investigation of "}
        <a
          href={`/investigation?opp=${encodeURIComponent(data.spawnedFrom.opportunityId)}`}
          className="text-ink underline decoration-rule-strong underline-offset-2 hover:decoration-stamp"
        >
          {data.spawnedFrom.opportunityName}
        </a>
      </p>
    );
  }

  const stamp = latest ? statusStamp(latest) : null;
  return (
    <div className="mt-3 flex flex-wrap items-center gap-x-2 gap-y-1 font-mono text-[11px] text-soft">
      <span className="tracking-[0.12em] uppercase">
        Intake · {data.opportunity.status}
      </span>
      <Arrow />
      {latest ? (
        <span className="flex items-center gap-1.5 tracking-[0.12em] uppercase">
          Investigation · opened {fmtDate(latest.createdAt)}
          {stamp && <Stamp tone={stamp.tone}>{stamp.label}</Stamp>}
        </span>
      ) : (
        <span className="tracking-[0.12em] uppercase">
          Investigation · not started
        </span>
      )}
      <Arrow />
      {spawnedCount > 0 ? (
        <a
          href="#case-opportunities"
          className="tracking-[0.12em] text-ink uppercase underline decoration-rule-strong underline-offset-2 hover:decoration-stamp"
        >
          {spawnedCount} case{spawnedCount === 1 ? "" : "s"} spawned
        </a>
      ) : (
        <span className="tracking-[0.12em] uppercase">Cases · none yet</span>
      )}
    </div>
  );
}

function Arrow() {
  return (
    <span aria-hidden className="text-faint">
      →
    </span>
  );
}

// ---------------------------------------------------------------------------
// Lifecycle actions

function Actions({
  data,
  activeInv,
  latest,
  actorName,
  busy,
  run,
}: {
  data: InvestigationViewResponse;
  activeInv: InvestigationDoc | null;
  latest: InvestigationDoc | null;
  actorName: string;
  busy: string | null;
  run: RunFn;
}) {
  const ready = actorName.trim().length > 0 && busy === null;
  const needName = actorName.trim().length === 0;

  const transition = (
    inv: InvestigationDoc,
    body: Record<string, unknown>,
    after?: () => void,
  ) =>
    void run(
      "status",
      async () => {
        const { doc } = await api<{ doc: InvestigationDoc }>(
          "/api/investigation/status",
          "POST",
          { investigationId: inv.id, actorName: actorName.trim(), ...body },
        );
        after?.();
        return doc;
      },
      { reload: true },
    );

  if (data.spawnedFrom) return null;

  // Nothing open: offer to start (serial clients reuse their intake card).
  if (!activeInv) {
    return (
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <StartButton
          opportunityId={data.opportunity.id}
          actorName={actorName}
          ready={ready}
          run={run}
        />
        <span className="text-xs text-soft">
          {needName
            ? "Enter your name first — every entry on the file is attributed."
            : latest
              ? "Opens a fresh investigation on this intake; the previous ones stay on the record below."
              : "Opens the workbench and pulls the client-sent files in as raw exhibits."}
        </span>
      </div>
    );
  }

  if (activeInv.status === "open") {
    return (
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Btn
          variant="primary"
          disabled={!ready}
          onClick={() => transition(activeInv, { action: "submit" })}
        >
          {busy === "status" ? "Submitting…" : "Submit for review"}
        </Btn>
        <span className="text-xs text-soft">
          {needName
            ? "Enter your name first — every entry on the file is attributed."
            : "Done digging? This hands the file to the reviewer."}
        </span>
      </div>
    );
  }

  // ready_for_review — the reviewer's bench.
  return <ReviewBench inv={activeInv} ready={ready} transition={transition} />;
}

function StartButton({
  opportunityId,
  actorName,
  ready,
  run,
}: {
  opportunityId: string;
  actorName: string;
  ready: boolean;
  run: RunFn;
}) {
  const submitting = useRef(false);
  return (
    <Btn
      variant="primary"
      disabled={!ready}
      onClick={() => {
        if (submitting.current) return;
        submitting.current = true;
        void run(
          "start",
          async () => {
            await api("/api/investigation/create", "POST", {
              opportunityId,
              actorName: actorName.trim(),
            });
            return null;
          },
          { reload: true },
        ).finally(() => {
          submitting.current = false;
        });
      }}
    >
      Start investigation
    </Btn>
  );
}

function ReviewBench({
  inv,
  ready,
  transition,
}: {
  inv: InvestigationDoc;
  ready: boolean;
  transition: (
    inv: InvestigationDoc,
    body: Record<string, unknown>,
    after?: () => void,
  ) => void;
}) {
  const [mode, setMode] = useState<"idle" | "send_back" | "close">("idle");
  const [note, setNote] = useState("");
  const [outcome, setOutcome] = useState<
    "no_company_found" | "no_violation" | "declined"
  >("no_company_found");
  const reset = () => {
    setMode("idle");
    setNote("");
  };

  return (
    <div className="mt-4 rounded-xs border border-pending/60 bg-pending-soft/60 px-4 py-3">
      <div className="flex flex-wrap items-center gap-3">
        <p className="flex-1 text-sm text-ink">
          <span className="font-medium">Under review.</span> Approve by
          creating the case opportunities, or return the file.
        </p>
        <a href="#case-opportunities">
          <Btn variant="ledger" small>
            Go to case opportunities ↓
          </Btn>
        </a>
        <Btn
          small
          disabled={!ready}
          onClick={() => setMode(mode === "send_back" ? "idle" : "send_back")}
        >
          Send back…
        </Btn>
        <Btn
          small
          variant="danger"
          disabled={!ready}
          onClick={() => setMode(mode === "close" ? "idle" : "close")}
        >
          Close — no case…
        </Btn>
      </div>
      {mode !== "idle" && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          {mode === "close" && (
            <select
              value={outcome}
              onChange={(e) => setOutcome(e.target.value as typeof outcome)}
              className={`${inputCls} py-1 text-xs`}
            >
              <option value="no_company_found">No company found</option>
              <option value="no_violation">No violation</option>
              <option value="declined">Declined — other reason</option>
            </select>
          )}
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder={
              mode === "send_back"
                ? "What still needs digging? (required)"
                : "Note for the record (optional)"
            }
            className={`${inputCls} min-w-64 flex-1`}
          />
          <Btn
            variant={mode === "close" ? "danger" : "primary"}
            disabled={!ready || (mode === "send_back" && note.trim().length === 0)}
            onClick={() =>
              transition(
                inv,
                mode === "send_back"
                  ? { action: "send_back", note: note.trim() }
                  : {
                      action: "close",
                      outcome,
                      ...(note.trim() ? { note: note.trim() } : {}),
                    },
                reset,
              )
            }
          >
            {mode === "send_back" ? "Send back" : "Close investigation"}
          </Btn>
        </div>
      )}
    </div>
  );
}
