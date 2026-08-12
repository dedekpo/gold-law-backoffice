"use client";

import { createContext, useContext } from "react";
import type { InvestigationDoc } from "@/lib/investigation-store";
import type { ScreenId } from "@/lib/types";

/**
 * Shared primitives of the "pleading file" design system introduced with the
 * /investigation redesign. Three voices: serif for matter/defendant names,
 * sans for prose and controls, mono for the record — ids, dates, labels,
 * stamps. Color is semantic only: stamp brick for decisions against,
 * ledger green for decisions for, pending amber for the undecided.
 */

// ---------------------------------------------------------------------------
// Data plumbing

export async function api<T>(
  url: string,
  method: "POST" | "PATCH",
  body: unknown,
): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as
    | (T & { error?: string })
    | null;
  if (!res.ok || !data) {
    throw new Error(data?.error ?? `Request failed: ${res.status}`);
  }
  return data;
}

/** Run one mutation under a busy key; returns true when it succeeded. */
export type RunFn = (
  key: string,
  fn: () => Promise<InvestigationDoc | null>,
  opts?: { reload?: boolean },
) => Promise<boolean>;

/** Everything the capture sections need about the open investigation. */
export type Workbench = {
  doc: InvestigationDoc;
  actorName: string;
  /** Actor named and no mutation in flight. */
  ready: boolean;
  busy: string | null;
  run: RunFn;
};

const WorkbenchContext = createContext<Workbench | null>(null);
export const WorkbenchProvider = WorkbenchContext.Provider;

export function useWorkbench(): Workbench {
  const ctx = useContext(WorkbenchContext);
  if (!ctx) throw new Error("useWorkbench outside WorkbenchProvider");
  return ctx;
}

export const nameKey = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]/g, "");

export const SCREEN_LABELS: Record<ScreenId, string> = {
  prerecorded_voice: "Pre-recorded voice",
  failure_to_stop: "Failure to honor stop",
  quiet_hours: "Quiet hours",
  dnc_registry: "DNC registry",
};

/**
 * GHL UI deep link to a Defendant custom-object record. The path segment is
 * GHL's, not ours — if HighLevel changes (or we mis-guessed) the objects route,
 * fix it HERE and every Defendant ↗ link follows.
 */
export function defendantRecordUrl(ghlAppBase: string, recordId: string) {
  return `${ghlAppBase}/objects/custom_objects.defendants/records/${recordId}`;
}

// Dates render in en-US regardless of browser locale — the file is a US
// legal record and mixed-locale dates read as glitches.
export function fmtDateTime(iso: string): string {
  const d = new Date(iso);
  return `${d.toLocaleDateString("en-US", { year: "2-digit", month: "2-digit", day: "2-digit" })} ${d.toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit" })}`;
}

export function fmtDate(iso: string): string {
  return new Date(iso).toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

// ---------------------------------------------------------------------------
// Typographic atoms

/** Mono section label with a trailing hairline — the ledger heading. */
export function Eyebrow({
  children,
  right,
}: {
  children: React.ReactNode;
  right?: React.ReactNode;
}) {
  return (
    <div className="mb-3 flex items-center gap-3">
      <span className="shrink-0 font-mono text-[11px] tracking-[0.14em] text-soft uppercase">
        {children}
      </span>
      <span aria-hidden className="h-px flex-1 bg-rule" />
      {right && <span className="shrink-0">{right}</span>}
    </div>
  );
}

export type StampTone = "ledger" | "stamp" | "pending" | "neutral";

const STAMP_TONES: Record<StampTone, string> = {
  ledger: "border-ledger text-ledger bg-ledger-soft",
  stamp: "border-stamp text-stamp bg-stamp-soft",
  pending: "border-pending text-pending bg-pending-soft",
  neutral: "border-rule-strong text-soft bg-transparent",
};

/** Rubber-stamp status: bordered mono caps. The record speaks in stamps. */
export function Stamp({
  tone,
  children,
  title,
}: {
  tone: StampTone;
  children: React.ReactNode;
  title?: string;
}) {
  return (
    <span
      title={title}
      className={`inline-flex items-center gap-1 rounded-xs border px-1.5 py-px font-mono text-[10px] font-medium tracking-[0.12em] uppercase ${STAMP_TONES[tone]}`}
    >
      {children}
    </span>
  );
}

/** Quiet mono tag for metadata (origin, dates, counts). */
export function Tag({ children }: { children: React.ReactNode }) {
  return (
    <span className="font-mono text-[11px] text-faint">{children}</span>
  );
}

// ---------------------------------------------------------------------------
// Controls

type BtnVariant = "primary" | "quiet" | "danger" | "ledger";

const BTN_VARIANTS: Record<BtnVariant, string> = {
  primary:
    "border-ink bg-ink text-paper hover:bg-ink/85 disabled:hover:bg-ink",
  quiet: "border-rule-strong text-ink hover:bg-wash",
  danger: "border-stamp/60 text-stamp hover:bg-stamp-soft",
  ledger: "border-ledger/60 text-ledger hover:bg-ledger-soft",
};

export function Btn({
  variant = "quiet",
  small,
  disabled,
  onClick,
  children,
  title,
  type = "button",
}: {
  variant?: BtnVariant;
  small?: boolean;
  disabled?: boolean;
  onClick?: () => void;
  children: React.ReactNode;
  title?: string;
  type?: "button" | "submit";
}) {
  return (
    <button
      type={type}
      title={title}
      disabled={disabled}
      onClick={onClick}
      className={`rounded-xs border font-medium transition-colors disabled:cursor-not-allowed disabled:opacity-40 ${
        small ? "px-2 py-0.5 text-xs" : "px-3.5 py-1.5 text-sm"
      } ${BTN_VARIANTS[variant]}`}
    >
      {children}
    </button>
  );
}

export const inputCls =
  "rounded-xs border border-rule-strong bg-card px-2.5 py-1.5 text-sm text-ink placeholder:text-faint focus:border-ink focus:outline-none disabled:opacity-50";

export function Field({
  label,
  children,
  span,
}: {
  label: string;
  children: React.ReactNode;
  span?: boolean;
}) {
  return (
    <label className={`flex flex-col gap-1 ${span ? "sm:col-span-2" : ""}`}>
      <span className="font-mono text-[10px] tracking-[0.12em] text-soft uppercase">
        {label}
      </span>
      {children}
    </label>
  );
}

// ---------------------------------------------------------------------------
// States

export function Empty({ children }: { children: React.ReactNode }) {
  return <p className="text-sm text-soft">{children}</p>;
}

export function ErrorNote({ children }: { children: React.ReactNode }) {
  return (
    <p className="rounded-xs border border-stamp/50 bg-stamp-soft px-3 py-2 text-sm text-stamp">
      {children}
    </p>
  );
}
