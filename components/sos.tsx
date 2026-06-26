import { Fragment } from "react";
import type { SosEntity } from "@/lib/types";
import { humanizeKey, joinAddress } from "@/lib/display";

// Fields rendered explicitly (or composed into an address) below — excluded
// from the generic "Additional details" dump so they aren't shown twice.
const SOS_CURATED_KEYS = new Set([
  "entityName",
  "status",
  "entityType",
  "formationDate",
  "jurisdiction",
  "searchState",
  "registeredAgentName",
  "registeredAgentAddress",
  "registeredAgentCity",
  "registeredAgentState",
  "registeredAgentZip",
  "registeredAgentMailingAddress",
  "principalAddress",
  "principalCity",
  "principalState",
  "principalZip",
  "mailingAddress",
  "mailingCity",
  "mailingState",
  "mailingZip",
  "officers",
  "sosUrl",
  "feiEinNumber",
  "scrapedAt",
  "screenshots",
]);

/** Renders an authoritative Secretary of State entity record in full. */
export function SosRecordPanel({
  sos,
  label,
  preferredAgent = false,
}: {
  sos: SosEntity;
  label?: string;
  preferredAgent?: boolean;
}) {
  const principal = joinAddress([
    sos.principalAddress,
    sos.principalCity,
    sos.principalState,
    sos.principalZip,
  ]);
  const mailing = joinAddress([
    sos.mailingAddress,
    sos.mailingCity,
    sos.mailingState,
    sos.mailingZip,
  ]);
  const agentAddress = joinAddress([
    sos.registeredAgentAddress,
    sos.registeredAgentCity,
    sos.registeredAgentState,
    sos.registeredAgentZip,
  ]);

  const rows: [string, string | null | undefined][] = [
    ["Legal name", sos.entityName],
    ["Status", sos.status],
    ["Entity type", sos.entityType],
    ["State of formation", sos.jurisdiction ?? sos.searchState],
    ["Registry searched", sos.searchState],
    ["Formation date", sos.formationDate],
    ["FEI / EIN", sos.feiEinNumber],
    ["Principal address", principal],
    ["Mailing address", mailing],
    ["Registered agent", sos.registeredAgentName],
    ["Agent address", agentAddress],
  ];

  // Any remaining scalar fields the state returned, so nothing is lost.
  const extras = Object.entries(sos).filter(
    ([key, value]) =>
      !SOS_CURATED_KEYS.has(key) &&
      (typeof value === "string" || typeof value === "number") &&
      String(value).trim() !== "",
  );

  return (
    <div className="rounded-lg border border-emerald-200 bg-emerald-50/60 p-4 dark:border-emerald-900/60 dark:bg-emerald-950/30">
      {(label || preferredAgent) && (
        <div className="mb-3 flex flex-wrap items-center gap-2 border-b border-emerald-200 pb-2 dark:border-emerald-900/60">
          {label && (
            <span className="text-[11px] font-semibold uppercase tracking-wide text-emerald-800 dark:text-emerald-200">
              {label}
            </span>
          )}
          {preferredAgent && (
            <span className="rounded-full bg-emerald-600 px-2 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-white">
              ★ Preferred agent to serve
            </span>
          )}
        </div>
      )}
      <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-sm">
        {rows.map(([label, value]) => (
          <Fragment key={label}>
            <dt className="text-zinc-500 dark:text-zinc-400">{label}</dt>
            <dd className="break-words text-zinc-900 dark:text-zinc-100">
              {value ?? "—"}
            </dd>
          </Fragment>
        ))}
      </dl>

      {sos.officers && sos.officers.length > 0 && (
        <div className="mt-3 border-t border-emerald-200 pt-3 dark:border-emerald-900/60">
          <p className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Officers / Directors
          </p>
          <ul className="mt-1 flex flex-col gap-1 text-sm text-zinc-800 dark:text-zinc-200">
            {sos.officers.map((officer, i) => (
              <li key={`${officer.name ?? "officer"}-${i}`}>
                {[officer.title, officer.name].filter(Boolean).join(" — ") || "—"}
                {officer.address ? (
                  <span className="text-zinc-500 dark:text-zinc-400">
                    {" "}
                    · {officer.address}
                  </span>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      )}

      {extras.length > 0 && (
        <div className="mt-3 border-t border-emerald-200 pt-3 dark:border-emerald-900/60">
          <p className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Additional details
          </p>
          <dl className="mt-1 grid grid-cols-[10rem_1fr] gap-x-4 gap-y-1 text-sm">
            {extras.map(([key, value]) => (
              <Fragment key={key}>
                <dt className="text-zinc-500 dark:text-zinc-400">
                  {humanizeKey(key)}
                </dt>
                <dd className="break-words text-zinc-800 dark:text-zinc-200">
                  {String(value)}
                </dd>
              </Fragment>
            ))}
          </dl>
        </div>
      )}

      {sos.sosUrl && (
        <div className="mt-3 border-t border-emerald-200 pt-3 dark:border-emerald-900/60">
          <a
            href={sos.sosUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="break-all text-xs text-blue-600 underline dark:text-blue-400"
          >
            View official filing ↗
          </a>
        </div>
      )}
    </div>
  );
}
