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
  declined: "Not a fit",
};

/** Where closing parks the intake opportunity, by outcome — mirrors the
 * server's CLOSE_STAGE_NAMES (app/api/investigation/status). */
const CLOSE_STAGE_LABELS: Record<
  Exclude<InvestigationOutcome, "converted">,
  string
> = {
  no_company_found: "No Company ID – Notify Lead",
  no_violation: "No Case Leads",
  declined: "Not a Fit",
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
      <OpenBench
        inv={activeInv}
        ready={ready}
        needName={needName}
        busy={busy}
        transition={transition}
      />
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

/** The investigator's bench: submit for review, or close a dead-end file. */
function OpenBench({
  inv,
  ready,
  needName,
  busy,
  transition,
}: {
  inv: InvestigationDoc;
  ready: boolean;
  needName: boolean;
  busy: string | null;
  transition: (
    inv: InvestigationDoc,
    body: Record<string, unknown>,
    after?: () => void,
  ) => void;
}) {
  const [closing, setClosing] = useState(false);
  return (
    <div className="mt-4">
      <div className="flex flex-wrap items-center gap-3">
        <Btn
          variant="primary"
          disabled={!ready}
          onClick={() => transition(inv, { action: "submit" })}
        >
          {busy === "status" ? "Submitting…" : "Submit for review"}
        </Btn>
        <span className="flex-1 text-xs text-soft">
          {needName
            ? "Enter your name first — every entry on the file is attributed."
            : "Done digging? This hands the file to the reviewer."}
        </span>
        <Btn
          small
          variant="danger"
          disabled={!ready}
          onClick={() => setClosing(!closing)}
        >
          Close — no case…
        </Btn>
      </div>
      {closing && (
        <ClosePanel
          inv={inv}
          ready={ready}
          transition={transition}
          onDone={() => setClosing(false)}
        />
      )}
    </div>
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
      {mode === "send_back" && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <input
            value={note}
            onChange={(e) => setNote(e.target.value)}
            placeholder="What still needs digging? (required)"
            className={`${inputCls} min-w-64 flex-1`}
          />
          <Btn
            variant="primary"
            disabled={!ready || note.trim().length === 0}
            onClick={() =>
              transition(inv, { action: "send_back", note: note.trim() }, reset)
            }
          >
            Send back
          </Btn>
        </div>
      )}
      {mode === "close" && (
        <ClosePanel inv={inv} ready={ready} transition={transition} onDone={reset} />
      )}
    </div>
  );
}

/**
 * The no-case close: reason first, because the reason decides where the
 * opportunity is parked in GHL — no more dragging cards after the fact.
 */
function ClosePanel({
  inv,
  ready,
  transition,
  onDone,
}: {
  inv: InvestigationDoc;
  ready: boolean;
  transition: (
    inv: InvestigationDoc,
    body: Record<string, unknown>,
    after?: () => void,
  ) => void;
  onDone: () => void;
}) {
  const [note, setNote] = useState("");
  const [outcome, setOutcome] = useState<
    "no_company_found" | "no_violation" | "declined"
  >("no_company_found");

  return (
    <div className="mt-3">
      <div className="flex flex-wrap items-center gap-2">
        <select
          value={outcome}
          onChange={(e) => setOutcome(e.target.value as typeof outcome)}
          className={`${inputCls} py-1 text-xs`}
        >
          <option value="no_company_found">No company found</option>
          <option value="no_violation">No violations found</option>
          <option value="declined">Not a fit</option>
        </select>
        <input
          value={note}
          onChange={(e) => setNote(e.target.value)}
          placeholder="Note for the record (optional)"
          className={`${inputCls} min-w-64 flex-1`}
        />
        <Btn
          variant="danger"
          disabled={!ready}
          onClick={() =>
            transition(
              inv,
              {
                action: "close",
                outcome,
                ...(note.trim() ? { note: note.trim() } : {}),
              },
              onDone,
            )
          }
        >
          Close investigation
        </Btn>
      </div>
      <p className="mt-1.5 font-mono text-[11px] text-soft">
        Closing moves the opportunity to &ldquo;{CLOSE_STAGE_LABELS[outcome]}
        &rdquo; in GHL.
      </p>
    </div>
  );
}
