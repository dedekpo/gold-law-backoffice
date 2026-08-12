"use client";

import type { Case } from "@/lib/types";
import { Eyebrow, Stamp, Tag } from "./ui";

/**
 * What the AI agent concluded, compressed: the intake gate, the DNC lookup,
 * and the search trail. The companies it identified are not repeated here —
 * they surface as suggestions (or members) of the Companies list.
 */

export function AiRunSection({ displayCase }: { displayCase: Case }) {
  const gate = displayCase.gate;
  const dnc = displayCase.dnc;
  const terms = displayCase.defendantSearchTerms ?? [];
  const narrative = displayCase.defendantInvestigation?.trim();

  return (
    <section>
      <Eyebrow>AI investigation</Eyebrow>
      <div className="flex flex-col gap-2.5 rounded-xs border border-rule bg-card px-4 py-3">
        {gate && (
          <div className="flex flex-wrap items-center gap-2">
            {gate.declined ? (
              <Stamp tone="stamp">
                Declined at intake · {gate.declineReason ?? "no claim"}
              </Stamp>
            ) : (
              <>
                <Stamp tone={gate.solPass ? "ledger" : "stamp"}>
                  SOL {gate.solPass ? "pass" : "fail"}
                </Stamp>
                <Stamp tone={gate.hasPlausibleClaim ? "ledger" : "stamp"}>
                  {gate.hasPlausibleClaim ? "Plausible claim" : "No plausible claim"}
                </Stamp>
              </>
            )}
            {gate.notifyLeadImmediately && (
              <Stamp tone="pending">Notify lead — SOL risk</Stamp>
            )}
          </div>
        )}

        {dnc &&
          (dnc.error ? (
            <p className="text-xs text-pending">
              DNC lookup unavailable: {dnc.error}
            </p>
          ) : (
            <p className="font-mono text-[11px] text-soft">
              DNC ({dnc.phone || "no number"}): national {dnc.national} ·
              state/FL {dnc.state}
              {dnc.litigator === "yes" ? " · ⚠ known litigator" : ""}
            </p>
          ))}

        {gate?.unknowns && gate.unknowns.length > 0 && (
          <ul className="flex flex-col gap-0.5">
            {gate.unknowns.map((u) => (
              <li key={u} className="text-xs text-pending">
                Needs intake to confirm: {u}
              </li>
            ))}
          </ul>
        )}

        {terms.length > 0 && (
          <div className="flex flex-wrap items-baseline gap-1.5">
            <Tag>Searched</Tag>
            {terms.map((t) => (
              <span
                key={t}
                className="rounded-xs bg-wash px-1.5 py-0.5 font-mono text-[11px] text-soft"
              >
                {t}
              </span>
            ))}
          </div>
        )}

        {narrative && (
          <details className="group">
            <summary className="cursor-pointer font-mono text-[10px] tracking-[0.12em] text-faint uppercase select-none hover:text-soft">
              <span className="group-open:hidden">▸</span>
              <span className="hidden group-open:inline">▾</span> Search
              narrative
            </summary>
            <p className="mt-2 text-sm leading-6 break-words whitespace-pre-wrap text-soft">
              {narrative}
            </p>
          </details>
        )}
      </div>
    </section>
  );
}
