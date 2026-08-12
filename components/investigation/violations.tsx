"use client";

import { useState } from "react";
import type {
  InvestigationDoc,
  ViolationFinding,
  ViolationStatus,
} from "@/lib/investigation-store";
import type { ScreenId } from "@/lib/types";
import {
  api,
  Btn,
  Empty,
  Eyebrow,
  inputCls,
  SCREEN_LABELS,
  Stamp,
  Tag,
  useWorkbench,
} from "./ui";

/**
 * Violation findings: which of the four screens the evidence supports, pinned
 * to a company where possible. Potential → confirmed / dismissed, same stamp
 * language as companies.
 */

const STATUS_STAMP: Record<
  ViolationStatus,
  { tone: "ledger" | "stamp" | "pending"; label: string }
> = {
  confirmed: { tone: "ledger", label: "Confirmed" },
  dismissed: { tone: "stamp", label: "Dismissed" },
  potential: { tone: "pending", label: "Potential" },
};

export function ViolationsSection() {
  const { doc, ready, busy, actorName, run } = useWorkbench();
  const [screen, setScreen] = useState<ScreenId>("prerecorded_voice");
  const [basis, setBasis] = useState("");
  const [companyId, setCompanyId] = useState("");

  const save = (body: Record<string, unknown>, key: string) =>
    run(key, async () => {
      const { doc: next } = await api<{ doc: InvestigationDoc }>(
        "/api/investigation/violation",
        "POST",
        { investigationId: doc.id, actorName: actorName.trim(), ...body },
      );
      return next;
    });

  const companyName = (id: string | null) => {
    if (!id) return null;
    const c = doc.companies.find((x) => x.id === id);
    return c ? c.profile.legal_name || c.profile.company_name : null;
  };

  return (
    <section id="violations">
      <Eyebrow
        right={
          doc.violations.length > 0 ? (
            <Tag>
              {doc.violations.filter((v) => v.status === "confirmed").length}{" "}
              confirmed of {doc.violations.length}
            </Tag>
          ) : undefined
        }
      >
        Violations
      </Eyebrow>

      {doc.violations.length === 0 && (
        <Empty>
          No violation findings yet. Record which screens the exhibits support.
        </Empty>
      )}

      <div className="flex flex-col gap-2">
        {doc.violations.map((v) => (
          <ViolationRow
            key={v.id}
            violation={v}
            companyName={companyName(v.companyId)}
            ready={ready}
            busy={busy}
            onStatus={(status) =>
              void save({ violationId: v.id, status }, `violation:${v.id}`)
            }
          />
        ))}
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-2">
        <select
          value={screen}
          onChange={(e) => setScreen(e.target.value as ScreenId)}
          className={`${inputCls} py-1 text-xs`}
        >
          {(Object.keys(SCREEN_LABELS) as ScreenId[]).map((id) => (
            <option key={id} value={id}>
              {SCREEN_LABELS[id]}
            </option>
          ))}
        </select>
        <select
          value={companyId}
          onChange={(e) => setCompanyId(e.target.value)}
          className={`${inputCls} py-1 text-xs`}
        >
          <option value="">Unattributed</option>
          {doc.companies.map((c) => (
            <option key={c.id} value={c.id}>
              {c.profile.legal_name || c.profile.company_name}
            </option>
          ))}
        </select>
        <input
          value={basis}
          onChange={(e) => setBasis(e.target.value)}
          placeholder="Extra info (optional)"
          className={`${inputCls} min-w-56 flex-1`}
        />
        <Btn
          variant="primary"
          disabled={!ready}
          onClick={() =>
            void save(
              { screen, basis: basis.trim(), companyId: companyId || null },
              "violation:new",
            ).then((ok) => {
              if (ok) setBasis("");
            })
          }
        >
          {busy === "violation:new" ? "Adding…" : "Add finding"}
        </Btn>
      </div>
    </section>
  );
}

function ViolationRow({
  violation: v,
  companyName,
  ready,
  busy,
  onStatus,
}: {
  violation: ViolationFinding;
  companyName: string | null;
  ready: boolean;
  busy: string | null;
  onStatus: (status: ViolationStatus) => void;
}) {
  const stamp = STATUS_STAMP[v.status];
  const changing = busy === `violation:${v.id}`;
  return (
    <div className="rounded-xs border border-rule bg-card px-4 py-2.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <Stamp tone={stamp.tone}>{changing ? "…" : stamp.label}</Stamp>
        <span className="text-sm font-medium text-ink">
          {SCREEN_LABELS[v.screen]}
        </span>
        <Tag>
          {companyName ?? "Unattributed"} ·{" "}
          {v.foundBy.kind === "ai" ? "AI" : v.foundBy.name}
        </Tag>
        <span className="flex-1" />
        <div className="flex shrink-0 gap-1.5">
          {v.status !== "confirmed" && (
            <Btn variant="ledger" small disabled={!ready} onClick={() => onStatus("confirmed")}>
              Confirm
            </Btn>
          )}
          {v.status !== "dismissed" && (
            <Btn variant="danger" small disabled={!ready} onClick={() => onStatus("dismissed")}>
              Dismiss
            </Btn>
          )}
          {v.status !== "potential" && (
            <Btn small disabled={!ready} onClick={() => onStatus("potential")}>
              Undo
            </Btn>
          )}
        </div>
      </div>
      {v.basis && (
        <p className="mt-1 text-sm leading-5 break-words whitespace-pre-wrap text-soft">
          {v.basis}
        </p>
      )}
    </div>
  );
}
