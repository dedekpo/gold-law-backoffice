"use client";

import { useState } from "react";
import type {
  InvestigationDoc,
  ViolationFinding,
  ViolationStatus,
} from "@/lib/investigation-store";
import { contactMatchesFiles, mergeContacts, runScreens } from "@/lib/screening";
import type { Case, DefendantCandidate, ScreenId } from "@/lib/types";
import {
  api,
  Btn,
  Empty,
  Eyebrow,
  inputCls,
  nameKey,
  SCREEN_LABELS,
  Stamp,
  Tag,
  useWorkbench,
} from "./ui";

/**
 * Violation findings: which of the four screens the evidence supports, pinned
 * to a company where possible. Potential → confirmed / dismissed, same stamp
 * language as companies.
 *
 * The AI run's screen hits arrive as suggestions (same hand-off as company
 * candidates): each carries the screen, the written basis, the company it was
 * screened against, and — the point — the exact evidence files proving it, so
 * accepting one links the proof instead of hunting it through the raw pile.
 */

const STATUS_STAMP: Record<
  ViolationStatus,
  { tone: "ledger" | "stamp" | "pending"; label: string }
> = {
  confirmed: { tone: "ledger", label: "Confirmed" },
  dismissed: { tone: "stamp", label: "Dismissed" },
  potential: { tone: "pending", label: "Potential" },
};

/** One AI screen hit offered for the file, with its proof pre-resolved. */
type ViolationSuggestion = {
  /** Dedup/dismiss key: company + screen. */
  key: string;
  screen: ScreenId;
  basis: string;
  companyId: string;
  companyName: string;
  /** Investigation evidence entries matched to the hit's proof files. */
  evidence: Array<{ id: string; name: string }>;
};

const candidateName = (c: DefendantCandidate) =>
  c.legal_name || c.company_name;

/**
 * Per-screen proof for a candidate on a run stored before screens carried
 * `evidence_files`: re-derive it from the stored facts with the SAME pure
 * screening engine the run used. Deterministic — same contacts, same code,
 * same answer — so the proof is exactly the files behind each hit, never the
 * company's whole attributed pool.
 */
function recomputeScreenProof(
  candidate: DefendantCandidate,
  displayCase: Case,
): Map<ScreenId, string[]> | null {
  const facts = displayCase.facts;
  if (!facts?.contacts?.length) return null;
  const prerecordedFiles = new Set(
    displayCase.files
      .filter((f) => f.forensics?.is_likely_prerecorded)
      .map((f) => f.name),
  );
  const attributed = new Set(candidate.evidence_files ?? []);
  const companyContacts = mergeContacts(facts.contacts, prerecordedFiles).filter(
    (c) => contactMatchesFiles(c, attributed),
  );
  const screens = runScreens(companyContacts, { dnc: displayCase.dnc });
  return new Map(screens.map((s) => [s.screen, s.evidence_files ?? []]));
}

/**
 * AI screen hits projected onto the investigation: only for companies already
 * ON the file (accept the company suggestion first — a violation needs its
 * defendant), skipping screens the file already has a finding for. Proof
 * files come from the screen's own `evidence_files` when the run recorded
 * them; for older runs they are recomputed from the stored facts. Never the
 * company's whole pool — overstated proof is worse than none.
 */
function buildSuggestions(
  doc: InvestigationDoc,
  runDefendants: DefendantCandidate[],
  displayCase: Case | null,
  dismissed: Set<string>,
): ViolationSuggestion[] {
  const evidenceByName = new Map(doc.evidence.map((e) => [e.name, e] as const));
  const out: ViolationSuggestion[] = [];
  const seen = new Set<string>();

  for (const candidate of runDefendants) {
    const cn = candidateName(candidate);
    if (!cn) continue;
    const company = doc.companies.find((c) => {
      const dn = c.profile.legal_name || c.profile.company_name;
      return dn && nameKey(dn) === nameKey(cn);
    });
    if (!company || company.status === "rejected") continue;

    // Lazily recomputed once per candidate, only when a stored screen lacks
    // its own proof list (runs saved before per-screen capture existed).
    let recomputed: Map<ScreenId, string[]> | null | undefined;

    for (const s of candidate.screens ?? []) {
      if (!s.hit) continue;
      const key = `${company.id}:${s.screen}`;
      if (seen.has(key) || dismissed.has(key)) continue;
      // A finding for this screen+company already on the file — added,
      // confirmed or dismissed by a human — retires the suggestion.
      if (
        doc.violations.some(
          (v) => v.screen === s.screen && v.companyId === company.id,
        )
      ) {
        continue;
      }
      seen.add(key);
      let proofNames = s.evidence_files ?? [];
      if (!proofNames.length && displayCase) {
        recomputed ??= recomputeScreenProof(candidate, displayCase);
        proofNames = recomputed?.get(s.screen) ?? [];
      }
      out.push({
        key,
        screen: s.screen,
        basis: s.basis,
        companyId: company.id,
        companyName:
          company.profile.legal_name || company.profile.company_name,
        evidence: proofNames
          .map((name) => evidenceByName.get(name))
          .filter((e): e is NonNullable<typeof e> => Boolean(e))
          .map((e) => ({ id: e.id, name: e.name })),
      });
    }
  }
  return out;
}

export function ViolationsSection({
  runDefendants,
  displayCase,
  onOpenEvidence,
}: {
  /** Companies the AI run identified, with their per-screen results. */
  runDefendants: DefendantCandidate[];
  /** The stored AI run (facts + files + DNC), for re-deriving proof. */
  displayCase: Case | null;
  /** Opens an evidence entry in the exhibit viewer. */
  onOpenEvidence: (evidenceId: string) => void;
}) {
  const { doc, ready, busy, actorName, run } = useWorkbench();
  const [screen, setScreen] = useState<ScreenId>("prerecorded_voice");
  const [basis, setBasis] = useState("");
  const [companyId, setCompanyId] = useState("");
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

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

  const evidenceName = (id: string) =>
    doc.evidence.find((e) => e.id === id)?.name ?? null;

  const suggestions = buildSuggestions(
    doc,
    runDefendants,
    displayCase,
    dismissed,
  );

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

      {suggestions.length > 0 && (
        <div className="mb-3 flex flex-col gap-2">
          {suggestions.map((s) => (
            <SuggestionCard
              key={s.key}
              suggestion={s}
              disabled={!ready}
              busy={busy}
              onOpenEvidence={onOpenEvidence}
              onAdd={() =>
                void save(
                  {
                    screen: s.screen,
                    basis: s.basis,
                    companyId: s.companyId,
                    evidenceIds: s.evidence.map((e) => e.id),
                  },
                  `vsuggest:${s.key}`,
                )
              }
              onDismiss={() =>
                setDismissed((prev) => new Set(prev).add(s.key))
              }
            />
          ))}
        </div>
      )}

      {doc.violations.length === 0 && suggestions.length === 0 && (
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
            evidence={(v.evidenceIds ?? [])
              .map((id) => ({ id, name: evidenceName(id) }))
              .filter((e): e is { id: string; name: string } =>
                Boolean(e.name),
              )}
            ready={ready}
            busy={busy}
            onOpenEvidence={onOpenEvidence}
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

// ---------------------------------------------------------------------------
// Suggestion card — the AI's screen hit, one click from the working list.

function SuggestionCard({
  suggestion: s,
  disabled,
  busy,
  onAdd,
  onDismiss,
  onOpenEvidence,
}: {
  suggestion: ViolationSuggestion;
  disabled: boolean;
  busy: string | null;
  onAdd: () => void;
  onDismiss: () => void;
  onOpenEvidence: (evidenceId: string) => void;
}) {
  const adding = busy === `vsuggest:${s.key}`;
  return (
    <div className="rounded-xs border border-pending/50 bg-pending-soft/50 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="text-sm font-medium text-ink">
              {SCREEN_LABELS[s.screen]}
            </span>
            <Tag>{s.companyName} · AI screening</Tag>
          </p>
          <p className="mt-0.5 text-xs leading-5 break-words text-soft">
            {s.basis}
          </p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Btn variant="primary" small disabled={disabled} onClick={onAdd}>
            {adding ? "Adding…" : "Add to file"}
          </Btn>
          <Btn small disabled={disabled} onClick={onDismiss}>
            Dismiss
          </Btn>
        </div>
      </div>
      {s.evidence.length > 0 && (
        <EvidenceChips
          label={PROOF_LABELS[s.screen]}
          evidence={s.evidence}
          onOpen={onOpenEvidence}
        />
      )}
    </div>
  );
}

/**
 * What the linked files MEAN, per screen. For the DNC screen the registration
 * itself comes from the registry lookup, never from a file — the files are
 * the telemarketing contacts being counted (each call/text to a registered
 * number is a violation instance), so the label says exactly that.
 */
const PROOF_LABELS: Partial<Record<ScreenId, string>> = {
  dnc_registry: "Telemarketing contacts",
};

/**
 * The proof, one chip per file — click to open it in the exhibit viewer.
 * A violation can rest on many files (e.g. every counted telemarketing
 * contact); collapse past a handful to keep the card readable.
 */
const CHIP_LIMIT = 6;

function EvidenceChips({
  label = "Proof",
  evidence,
  onOpen,
}: {
  label?: string;
  evidence: Array<{ id: string; name: string }>;
  onOpen: (evidenceId: string) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const shown = expanded ? evidence : evidence.slice(0, CHIP_LIMIT);
  const hidden = evidence.length - shown.length;
  return (
    <div className="mt-1.5 flex flex-wrap items-baseline gap-1.5">
      <Tag>{label}</Tag>
      {shown.map((e) => (
        <button
          key={e.id}
          type="button"
          onClick={() => onOpen(e.id)}
          title="Open in the exhibit viewer"
          className="max-w-56 truncate rounded-xs bg-wash px-1.5 py-0.5 font-mono text-[11px] text-soft underline decoration-rule underline-offset-2 hover:text-ink hover:decoration-stamp"
        >
          {e.name}
        </button>
      ))}
      {hidden > 0 && (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="rounded-xs px-1 py-0.5 font-mono text-[11px] text-faint hover:text-ink"
        >
          +{hidden} more
        </button>
      )}
      {expanded && evidence.length > CHIP_LIMIT && (
        <button
          type="button"
          onClick={() => setExpanded(false)}
          className="rounded-xs px-1 py-0.5 font-mono text-[11px] text-faint hover:text-ink"
        >
          show fewer
        </button>
      )}
    </div>
  );
}

function ViolationRow({
  violation: v,
  companyName,
  evidence,
  ready,
  busy,
  onStatus,
  onOpenEvidence,
}: {
  violation: ViolationFinding;
  companyName: string | null;
  evidence: Array<{ id: string; name: string }>;
  ready: boolean;
  busy: string | null;
  onStatus: (status: ViolationStatus) => void;
  onOpenEvidence: (evidenceId: string) => void;
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
      {evidence.length > 0 && (
        <EvidenceChips
          label={PROOF_LABELS[v.screen]}
          evidence={evidence}
          onOpen={onOpenEvidence}
        />
      )}
    </div>
  );
}
