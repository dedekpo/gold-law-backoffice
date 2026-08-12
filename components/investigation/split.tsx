"use client";

import { useRef, useState } from "react";
import type { InvestigationViewResponse } from "@/app/api/investigation/route";
import type { SplitOutcome } from "@/lib/case-split";
import type {
  InvestigationDoc,
  SpawnedCase,
} from "@/lib/investigation-store";
import { splitReadiness, type SplitReadiness } from "@/lib/split-readiness";
import type { DefendantCandidate } from "@/lib/types";
import {
  Btn,
  defendantRecordUrl,
  Empty,
  Eyebrow,
  fmtDate,
  nameKey,
  Stamp,
  Tag,
  type RunFn,
} from "./ui";

/**
 * The split — the terminal action of an approved investigation. Pick the
 * confirmed companies, and for each one a defendant-centric case opportunity
 * is created carrying a COMPLETE case file (Defendant record, confirmed
 * evidence copied onto the child, violations + basis written to its fields,
 * its own editable investigation doc) while the intake opportunity retires to
 * "Converted to Case(s)".
 *
 * Hard-gated: only companies on the investigation that pass the readiness
 * checklist (confirmed + pinned violations + attached proof) can spawn —
 * that vetted data is exactly what the child's file is built from. Names the
 * AI run or legacy fields surfaced are pointed at the Companies section to
 * get vetted first.
 */

type Candidate = {
  companyId: string;
  defaultName: string;
  origin: string;
  confidence: number | null;
  profile: DefendantCandidate;
  readiness: SplitReadiness;
};

export function SplitSection({
  data,
  runDefendants,
  activeInv,
  busy,
  run,
}: {
  data: InvestigationViewResponse;
  runDefendants: DefendantCandidate[];
  activeInv: InvestigationDoc | null;
  busy: string | null;
  run: RunFn;
}) {
  const inv = activeInv ?? data.investigations[0] ?? null;
  const spawned: SpawnedCase[] = data.investigations.flatMap((i) => i.spawned);

  const candidates: Candidate[] = [];
  const seen = new Set<string>();
  for (const c of inv?.companies ?? []) {
    const name = c.profile.legal_name || c.profile.company_name;
    if (!name) continue;
    seen.add(nameKey(name));
    if (c.status === "rejected" || c.spawnedOpportunityId) continue;
    candidates.push({
      companyId: c.id,
      defaultName: name,
      origin: c.origin.kind === "ai" ? "AI" : c.origin.name,
      confidence: c.profile.confidence ?? null,
      profile: c.profile,
      readiness: splitReadiness(inv!, c),
    });
  }
  // Names surfaced by the AI run or the legacy Company 1 fields that are not
  // on the investigation yet: the case file is built from the investigation's
  // vetted data, so these must be added and vetted first.
  const unvetted: string[] = [];
  for (const d of runDefendants) {
    const name = d.legal_name || d.company_name;
    if (!name || seen.has(nameKey(name))) continue;
    seen.add(nameKey(name));
    unvetted.push(name);
  }
  if (data.legacyCompany) {
    const name =
      data.legacyCompany.legal_name || data.legacyCompany.company_name;
    if (name && !seen.has(nameKey(name))) unvetted.push(name);
  }

  const [edits, setEdits] = useState<
    Record<string, { checked?: boolean; name?: string }>
  >({});
  const [confirming, setConfirming] = useState(false);
  const [outcome, setOutcome] = useState<SplitOutcome | null>(null);
  const submitting = useRef(false);

  if (candidates.length === 0 && spawned.length === 0 && unvetted.length === 0) {
    return null;
  }

  const rowOf = (c: Candidate) => {
    const edit = edits[c.companyId];
    return {
      checked: (edit?.checked ?? c.readiness.ready) && c.readiness.ready,
      name: edit?.name ?? c.defaultName,
    };
  };
  const patchRow = (c: Candidate, patch: { checked?: boolean; name?: string }) =>
    setEdits((prev) => ({
      ...prev,
      [c.companyId]: { ...prev[c.companyId], ...patch },
    }));

  const picked = candidates
    .map((c) => ({ candidate: c, row: rowOf(c) }))
    .filter(
      (x) =>
        x.candidate.readiness.ready &&
        x.row.checked &&
        x.row.name.trim().length >= 2,
    );

  const splitting = busy === "split";

  const submit = () => {
    if (submitting.current) return;
    submitting.current = true;
    void run(
      "split",
      async () => {
        const res = await fetch("/api/investigation/split", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            opportunityId: data.opportunity.id,
            investigationId: inv?.id ?? null,
            companies: picked.map(({ candidate, row }) => ({
              companyId: candidate.companyId,
              name: row.name.trim(),
              profile: candidate.profile,
            })),
          }),
        });
        const body = (await res.json().catch(() => null)) as
          | (SplitOutcome & { error?: string })
          | null;
        if (!body || (body.error && !body.results)) {
          throw new Error(body?.error ?? `Split failed: ${res.status}`);
        }
        setOutcome(body);
        setConfirming(false);
        return null;
      },
      { reload: true },
    ).finally(() => {
      submitting.current = false;
    });
  };

  return (
    <section id="case-opportunities">
      <Eyebrow
        right={spawned.length > 0 ? <Tag>{spawned.length} spawned</Tag> : undefined}
      >
        Case opportunities
      </Eyebrow>

      {spawned.length > 0 && (
        <ul className="mb-3 flex flex-col gap-1.5">
          {spawned.map((s) => (
            <li
              key={s.opportunityId}
              className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-xs border border-ledger/40 bg-ledger-soft/50 px-3 py-2"
            >
              <Stamp tone="ledger">Case</Stamp>
              <a
                href={`/investigation?opp=${encodeURIComponent(s.opportunityId)}`}
                className="font-serif text-sm font-semibold text-ink underline decoration-rule-strong underline-offset-2 hover:decoration-stamp"
              >
                {s.name}
              </a>
              <Tag>{fmtDate(s.createdAt)}</Tag>
              <span className="flex-1" />
              <a
                href={`${data.ghlAppBase}/opportunities/${s.opportunityId}?tab=Opportunity+details`}
                target="_blank"
                rel="noreferrer"
              >
                <Stamp tone="neutral">GHL ↗</Stamp>
              </a>
              <a
                href={defendantRecordUrl(data.ghlAppBase, s.defendantRecordId)}
                target="_blank"
                rel="noreferrer"
              >
                <Stamp tone="neutral">Defendant ↗</Stamp>
              </a>
            </li>
          ))}
        </ul>
      )}

      {outcome && (
        <div className="mb-3 rounded-xs border border-rule bg-card px-3 py-2.5 text-sm">
          {outcome.results.map((r) => (
            <p key={r.companyId} className={r.error ? "text-stamp" : "text-ledger"}>
              {r.error
                ? `✗ ${r.name}: ${r.error}`
                : `${r.alreadySpawned ? "Already spawned" : "Created"}: ${r.opportunityName ?? r.name}${r.defendantReused ? " — existing Defendant record reused" : ""}`}
            </p>
          ))}
          <p className="mt-1 text-soft">
            {outcome.parentMoved
              ? `Intake opportunity moved to "${outcome.parentStageName}".`
              : "Some companies failed — the intake opportunity was NOT moved. Fix and retry; finished companies are skipped."}
          </p>
        </div>
      )}

      {candidates.length > 0 ? (
        <>
          <div className="flex flex-col gap-1.5">
            {candidates.map((c) => {
              const row = rowOf(c);
              const r = c.readiness;
              const checks: Array<{ ok: boolean; label: string; href: string }> = [
                {
                  ok: r.companyConfirmed,
                  label: "company confirmed",
                  href: "#companies",
                },
                {
                  ok: r.violations.length > 0,
                  label:
                    r.violations.length > 0
                      ? `${r.violations.length} confirmed violation${r.violations.length === 1 ? "" : "s"}`
                      : "no confirmed violation pinned",
                  href: "#violations",
                },
                {
                  ok: r.evidence.length > 0,
                  label:
                    r.evidence.length > 0
                      ? `${r.evidence.length} exhibit${r.evidence.length === 1 ? "" : "s"} attached as proof`
                      : "no confirmed proof attached",
                  href: "#exhibits",
                },
              ];
              return (
                <div
                  key={c.companyId}
                  className={`rounded-xs border px-3 py-2 transition-colors ${
                    row.checked ? "border-rule-strong bg-card" : "border-rule bg-card/50"
                  }`}
                >
                  <div className="flex items-center gap-3">
                    <input
                      type="checkbox"
                      checked={row.checked}
                      disabled={splitting || !r.ready}
                      title={
                        r.ready
                          ? undefined
                          : "Complete the checklist below to include this company"
                      }
                      onChange={(e) => patchRow(c, { checked: e.target.checked })}
                      className="accent-(--ink)"
                    />
                    <input
                      value={row.name}
                      disabled={splitting}
                      onChange={(e) => patchRow(c, { name: e.target.value })}
                      aria-label="Final defendant name"
                      className="flex-1 rounded-xs border border-transparent bg-transparent px-1 py-0.5 font-serif text-sm font-semibold text-ink focus:border-rule-strong focus:outline-none"
                    />
                    <Tag>
                      {c.origin}
                      {c.confidence != null
                        ? ` · ${Math.round(c.confidence * 100)}%`
                        : ""}
                    </Tag>
                  </div>
                  <div className="mt-1.5 flex flex-wrap gap-x-4 gap-y-1 pl-7 font-mono text-[11px]">
                    {checks.map((check) =>
                      check.ok ? (
                        <span key={check.href} className="text-ledger">
                          ✓ {check.label}
                        </span>
                      ) : (
                        <a
                          key={check.href}
                          href={check.href}
                          className="text-stamp underline decoration-stamp/50 underline-offset-2 hover:decoration-stamp"
                        >
                          ✗ {check.label}
                        </a>
                      ),
                    )}
                  </div>
                </div>
              );
            })}
          </div>

          {confirming ? (
            <div className="mt-3 rounded-xs border border-pending/60 bg-pending-soft/60 px-4 py-3 text-sm text-ink">
              <p className="mb-2">
                This creates{" "}
                <span className="font-medium">
                  {picked.length} case opportunit{picked.length === 1 ? "y" : "ies"}
                </span>{" "}
                in &ldquo;👩‍⚖️ Legal Approval - Potential Case&rdquo; (
                {picked.map((p) => p.row.name.trim()).join("; ")}), each with
                its own complete case file: a Defendant record created or
                reused, the confirmed evidence copied onto the case, and the
                confirmed violations written to its fields. This intake
                opportunity then moves to &ldquo;⚖️ Converted to
                Case(s)&rdquo; and this investigation locks as approved.
              </p>
              <div className="flex gap-2">
                <Btn variant="primary" disabled={splitting} onClick={submit}>
                  {splitting ? "Creating…" : "Confirm split"}
                </Btn>
                <Btn disabled={splitting} onClick={() => setConfirming(false)}>
                  Cancel
                </Btn>
              </div>
            </div>
          ) : (
            <div className="mt-3">
              <Btn
                variant="primary"
                disabled={picked.length === 0 || splitting}
                onClick={() => setConfirming(true)}
              >
                {splitting
                  ? "Creating case opportunities…"
                  : picked.length === 0
                    ? "Create case opportunities…"
                    : `Create ${picked.length} case opportunit${picked.length === 1 ? "y" : "ies"}…`}
              </Btn>
            </div>
          )}
        </>
      ) : (
        spawned.length === 0 &&
        unvetted.length === 0 && (
          <Empty>No confirmed companies to spawn cases for yet.</Empty>
        )
      )}

      {unvetted.length > 0 && (
        <p className="mt-3 text-xs leading-5 text-soft">
          Found by the search but not on the investigation yet:{" "}
          <span className="text-ink">{unvetted.join("; ")}</span> —{" "}
          <a
            href="#companies"
            className="underline decoration-rule-strong underline-offset-2 hover:decoration-stamp"
          >
            add {unvetted.length === 1 ? "it" : "them"} in the Companies
            section
          </a>{" "}
          and complete the checklist to include {unvetted.length === 1 ? "it" : "them"}{" "}
          in the split.
        </p>
      )}
    </section>
  );
}
