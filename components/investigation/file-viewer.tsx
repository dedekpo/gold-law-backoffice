"use client";

import { useEffect, useState } from "react";
import type { EvidenceRole } from "@/lib/investigation-store";
import type { AudioForensics, FileKind } from "@/lib/types";
import { SpeakerIcon } from "@/components/icons";
import { ErrorNote, Stamp, Tag } from "./ui";

/**
 * Exhibits — the unified evidence model of the investigation view. Every file
 * (client-sent GHL upload, investigator upload, or AI-run leftover) becomes a
 * numbered exhibit; the viewer shows the media with its transcription /
 * description and audio forensics, and — when the exhibit belongs to an open
 * investigation — lets the investigator set its role and company attribution.
 */

export type Exhibit = {
  key: string;
  /** 1-based exhibit number, in record order. */
  index: number;
  name: string;
  kind: FileKind;
  url: string;
  /** null for files that only exist on the AI run, not the investigation. */
  role: EvidenceRole | null;
  sourceLabel: string;
  companyIds: string[];
  text: string | null;
  forensics: AudioForensics | null;
  /** Set when this exhibit is an InvestigationEvidence entry (patchable). */
  evidenceId: string | null;
};

export const exhibitNo = (index: number) =>
  `EX ${String(index).padStart(2, "0")}`;

export function ExhibitTile({
  exhibit,
  onOpen,
}: {
  exhibit: Exhibit;
  onOpen: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onOpen}
      title={exhibit.name}
      className="group flex flex-col gap-1 text-left"
    >
      <div className="relative aspect-square overflow-hidden rounded-xs border border-rule bg-wash transition-colors group-hover:border-rule-strong">
        {exhibit.kind === "image" ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={exhibit.url}
            alt={exhibit.name}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-soft">
            <SpeakerIcon />
          </div>
        )}
        <span className="absolute top-0 left-0 rounded-br-xs bg-ink/80 px-1 py-px font-mono text-[9px] tracking-[0.1em] text-paper">
          {exhibitNo(exhibit.index)}
        </span>
        {exhibit.role === "confirmed" && (
          <span
            title="Confirmed proof"
            className="absolute right-0 bottom-0 rounded-tl-xs bg-ledger px-1 py-px font-mono text-[9px] tracking-[0.1em] text-paper uppercase"
          >
            Proof
          </span>
        )}
      </div>
      <span className="truncate font-mono text-[10px] text-faint">
        {exhibit.name}
      </span>
    </button>
  );
}

/** Company choices for exhibit attribution, provided by the workbench. */
export type AttributionOption = { id: string; name: string };

export function ExhibitViewer({
  exhibit,
  options,
  canEdit,
  busy,
  error,
  onPatch,
  onClose,
}: {
  exhibit: Exhibit;
  options: AttributionOption[];
  /** True when the exhibit is on an open investigation and the actor is set. */
  canEdit: boolean;
  busy: boolean;
  /** Last mutation error, surfaced inside the modal (the header is covered). */
  error: string | null;
  onPatch: (patch: { role?: EvidenceRole; companyIds?: string[] }) => void;
  onClose: () => void;
}) {
  // "Confirmed proof" chosen but no company picked yet — the request only
  // fires once the attribution makes it valid (proof must name a company).
  const [pendingConfirm, setPendingConfirm] = useState(false);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setPendingConfirm(false), [exhibit.key]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const confirmedView = exhibit.role === "confirmed" || pendingConfirm;

  const chooseRole = (role: EvidenceRole) => {
    setPendingConfirm(false);
    if (role === "raw") {
      if (exhibit.role !== "raw") onPatch({ role: "raw" });
      return;
    }
    if (exhibit.companyIds.length > 0) {
      onPatch({ role: "confirmed" });
    } else {
      // Not sendable yet — the API (rightly) rejects unattributed proof.
      setPendingConfirm(true);
    }
  };

  const toggleCompany = (id: string, checked: boolean) => {
    const next = checked
      ? [...exhibit.companyIds, id]
      : exhibit.companyIds.filter((x) => x !== id);
    setPendingConfirm(false);
    if (next.length === 0) {
      // Unattributed proof is not a thing — dropping the last company
      // returns the exhibit to raw.
      onPatch({ role: "raw", companyIds: [] });
    } else {
      onPatch({ role: "confirmed", companyIds: next });
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-ink/60 p-4 backdrop-blur-xs"
      onClick={onClose}
      role="dialog"
      aria-label={`Exhibit ${exhibit.index}: ${exhibit.name}`}
    >
      <div
        className="flex max-h-[92vh] w-full max-w-3xl flex-col overflow-hidden rounded-sm border border-rule-strong bg-card shadow-2xl"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-baseline gap-3 border-b border-rule px-5 py-3">
          <span className="font-mono text-[11px] tracking-[0.14em] text-stamp">
            {exhibitNo(exhibit.index)}
          </span>
          <h3 className="min-w-0 flex-1 truncate text-sm font-semibold text-ink">
            {exhibit.name}
          </h3>
          <Tag>{exhibit.sourceLabel}</Tag>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="rounded-xs px-2 font-mono text-sm text-soft hover:bg-wash"
          >
            ✕
          </button>
        </header>

        <div className="flex min-h-0 flex-col gap-4 overflow-y-auto p-5">
          <div className="flex items-center justify-center rounded-xs bg-wash p-3">
            {exhibit.kind === "image" ? (
              /* eslint-disable-next-line @next/next/no-img-element */
              <img
                src={exhibit.url}
                alt={exhibit.name}
                className="max-h-[52vh] w-auto max-w-full rounded-xs object-contain"
              />
            ) : (
              <audio controls src={exhibit.url} className="w-full" />
            )}
          </div>

          {exhibit.role !== null && (
            <div className="rounded-xs border border-rule px-3 py-2.5">
              <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
                <span className="font-mono text-[10px] tracking-[0.12em] text-soft uppercase">
                  Role
                </span>
                <label className="flex items-center gap-1.5 text-sm text-ink">
                  <input
                    type="radio"
                    name="exhibit-role"
                    checked={!confirmedView}
                    disabled={!canEdit || busy}
                    onChange={() => chooseRole("raw")}
                    className="accent-(--ink)"
                  />
                  Raw (client-sent)
                </label>
                <label
                  className="flex items-center gap-1.5 text-sm text-ink"
                  title={
                    options.length === 0
                      ? "Proof must be attributed — add a company to the file first."
                      : undefined
                  }
                >
                  <input
                    type="radio"
                    name="exhibit-role"
                    checked={confirmedView}
                    disabled={!canEdit || busy || options.length === 0}
                    onChange={() => chooseRole("confirmed")}
                    className="accent-(--ink)"
                  />
                  Confirmed proof
                </label>
                {confirmedView && options.length > 0 && (
                  <>
                    <span className="ml-2 font-mono text-[10px] tracking-[0.12em] text-soft uppercase">
                      Proof against
                    </span>
                    {options.map((c) => (
                      <label
                        key={c.id}
                        className="flex items-center gap-1.5 text-sm text-ink"
                      >
                        <input
                          type="checkbox"
                          checked={exhibit.companyIds.includes(c.id)}
                          disabled={!canEdit || busy}
                          onChange={(e) => toggleCompany(c.id, e.target.checked)}
                          className="accent-(--ink)"
                        />
                        {c.name}
                      </label>
                    ))}
                  </>
                )}
              </div>
              {options.length === 0 && (
                <p className="mt-1.5 text-xs text-soft">
                  Proof must be attributed to a company — add the company to
                  the file first, then mark this exhibit as proof against it.
                </p>
              )}
              {pendingConfirm && (
                <p className="mt-1.5 text-xs text-pending">
                  Pick at least one company — the exhibit becomes confirmed
                  proof once it&rsquo;s attributed.
                </p>
              )}
            </div>
          )}

          {error && <ErrorNote>{error}</ErrorNote>}

          {exhibit.text && (
            <section>
              <p className="mb-1 font-mono text-[10px] tracking-[0.12em] text-soft uppercase">
                {exhibit.kind === "audio" ? "Transcription" : "Description"}
              </p>
              <p className="text-sm leading-6 break-words whitespace-pre-wrap text-ink">
                {exhibit.text}
              </p>
            </section>
          )}

          {exhibit.forensics && <Forensics f={exhibit.forensics} />}
        </div>
      </div>
    </div>
  );
}

function Forensics({ f }: { f: AudioForensics }) {
  return (
    <section className="border-t border-rule pt-3">
      <div className="mb-2 flex items-center gap-2">
        <p className="font-mono text-[10px] tracking-[0.12em] text-soft uppercase">
          Audio forensics
        </p>
        <Stamp tone={f.is_likely_prerecorded ? "stamp" : "ledger"}>
          {f.is_likely_prerecorded ? "Likely automated" : "Likely human"} ·{" "}
          {f.automated_likelihood}/10
        </Stamp>
      </div>
      <ul className="flex flex-col gap-1.5">
        {f.factors.map((factor, i) => (
          <li key={`${factor.name}-${i}`} className="text-sm text-ink">
            <span className="font-medium">{factor.name}:</span>{" "}
            <span className="text-soft">{factor.explanation}</span>
          </li>
        ))}
      </ul>
      {f.personalization_analysis && (
        <p className="mt-2 text-sm leading-6 break-words whitespace-pre-wrap text-soft">
          {f.personalization_analysis}
        </p>
      )}
    </section>
  );
}
