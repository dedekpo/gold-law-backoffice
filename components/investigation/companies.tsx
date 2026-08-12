"use client";

import { useEffect, useMemo, useState } from "react";
import type { InvestigationViewResponse } from "@/app/api/investigation/route";
import type {
  CompanyStatus,
  InvestigationCompany,
  InvestigationDoc,
} from "@/lib/investigation-store";
import type { DefendantCandidate } from "@/lib/types";
import {
  api,
  Btn,
  defendantRecordUrl,
  Empty,
  Eyebrow,
  Field,
  fmtDate,
  inputCls,
  nameKey,
  Stamp,
  Tag,
  useWorkbench,
} from "./ui";

/**
 * Companies — the working list of the investigation. AI candidates arrive as
 * suggestions to accept or dismiss; manual research is entered through the
 * form. Both become the same artifact (an InvestigationCompany), stamped
 * candidate → confirmed / rejected. As a name is typed or shown, the file
 * checks the Defendants object for an existing record: repeat defendants get
 * flagged, prefilled, and reused at the split instead of duplicated.
 */

// ---------------------------------------------------------------------------
// Defendant-record lookup (module-level cache: one search per distinct name)

export type DefendantMatch = {
  id: string;
  createdAt: string;
  properties: Record<string, string>;
};

const lookupCache = new Map<string, DefendantMatch | null>();
const lookupPending = new Map<string, Promise<DefendantMatch | null>>();

async function lookupDefendant(name: string): Promise<DefendantMatch | null> {
  const key = nameKey(name);
  if (lookupCache.has(key)) return lookupCache.get(key)!;
  const pending = lookupPending.get(key);
  if (pending) return pending;
  const promise = fetch(
    `/api/investigation/defendant?name=${encodeURIComponent(name)}`,
  )
    .then(async (res) => {
      const data = (await res.json().catch(() => null)) as {
        match?: DefendantMatch | null;
      } | null;
      if (!res.ok) throw new Error("lookup failed");
      const match = data?.match ?? null;
      lookupCache.set(key, match);
      return match;
    })
    .finally(() => lookupPending.delete(key));
  lookupPending.set(key, promise);
  return promise;
}

type LookupState =
  | { status: "idle" | "searching" | "error" }
  | { status: "done"; match: DefendantMatch | null };

/** Debounced live lookup for a name being typed or displayed. */
function useDefendantLookup(rawName: string, enabled: boolean): LookupState {
  const name = rawName.trim();
  const [state, setState] = useState<LookupState & { for?: string }>({
    status: "idle",
  });

  useEffect(() => {
    if (!enabled || name.length < 3) {
      setState({ status: "idle" });
      return;
    }
    const key = nameKey(name);
    if (lookupCache.has(key)) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setState({ status: "done", match: lookupCache.get(key)!, for: key });
      return;
    }
    let cancelled = false;
    const timer = setTimeout(() => {
      setState({ status: "searching", for: key });
      lookupDefendant(name)
        .then((match) => {
          if (!cancelled) setState({ status: "done", match, for: key });
        })
        .catch(() => {
          if (!cancelled) setState({ status: "error", for: key });
        });
    }, 450);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [name, enabled]);

  return state;
}

// ---------------------------------------------------------------------------
// Profile form model

type ProfileForm = {
  company_name: string;
  legal_name: string;
  website: string;
  state_of_incorporation: string;
  hq_mailing_address: string;
  agent_name: string;
  agent_address: string;
  agent_state: string;
  revenue_estimate: string;
  employees_estimate: string;
  notes: string;
};

const EMPTY_FORM: ProfileForm = {
  company_name: "",
  legal_name: "",
  website: "",
  state_of_incorporation: "",
  hq_mailing_address: "",
  agent_name: "",
  agent_address: "",
  agent_state: "",
  revenue_estimate: "",
  employees_estimate: "",
  notes: "",
};

const ADVANCED_KEYS = [
  "legal_name",
  "state_of_incorporation",
  "hq_mailing_address",
  "agent_name",
  "agent_address",
  "agent_state",
  "revenue_estimate",
  "employees_estimate",
] as const satisfies readonly (keyof ProfileForm)[];

function formFromCompany(c: InvestigationCompany): ProfileForm {
  const p = c.profile;
  return {
    company_name: p.company_name ?? "",
    legal_name: p.legal_name ?? "",
    website: p.website ?? "",
    state_of_incorporation: p.state_of_incorporation ?? "",
    hq_mailing_address: p.hq_mailing_address ?? "",
    agent_name: p.registered_agent?.name ?? "",
    agent_address: p.registered_agent?.address ?? "",
    agent_state: p.registered_agent?.state ?? "",
    revenue_estimate: p.revenue_estimate ?? "",
    employees_estimate: p.employees_estimate ?? "",
    notes: p.notes ?? "",
  };
}

function profilePayload(form: ProfileForm) {
  const opt = (s: string) => (s.trim() ? s.trim() : null);
  const agent =
    opt(form.agent_name) || opt(form.agent_address) || opt(form.agent_state)
      ? {
          name: opt(form.agent_name),
          address: opt(form.agent_address),
          state: opt(form.agent_state),
        }
      : null;
  return {
    company_name: form.company_name.trim(),
    legal_name: opt(form.legal_name),
    website: opt(form.website),
    state_of_incorporation: opt(form.state_of_incorporation),
    hq_mailing_address: opt(form.hq_mailing_address),
    registered_agent: agent,
    revenue_estimate: opt(form.revenue_estimate),
    employees_estimate: opt(form.employees_estimate),
    notes: opt(form.notes),
  };
}

/** The Defendant record's fields projected back onto the form (for prefill). */
function formFromRecord(props: Record<string, string>): Partial<ProfileForm> {
  const join = (...parts: (string | undefined)[]) =>
    parts.filter((p) => p?.trim()).join(", ");
  return {
    website: props.defendant_website ?? "",
    state_of_incorporation: props.defendant_registration_state ?? "",
    hq_mailing_address: join(
      props.defendant_main_office_street,
      props.defendant_main_office_city,
      props.defendant_main_office_state,
      props.defendant_main_office_zip_code,
    ),
    agent_name: props.defendant_registered_agent_name ?? "",
    agent_address: join(
      props.defendant_registered_agent_street_address,
      props.defendant_registered_agent_city,
      props.defendant_registered_agent_zip_code,
    ),
    agent_state: props.defendant_registered_agent_state ?? "",
    revenue_estimate: props.defendant_approximate_revenue_size ?? "",
    employees_estimate: props.defendant_approximate_employee_size ?? "",
  };
}

/** A DefendantCandidate (AI run / legacy fields) projected onto the payload. */
function payloadFromCandidate(c: DefendantCandidate) {
  return {
    company_name: c.company_name || c.legal_name || "",
    legal_name: c.legal_name,
    website: c.website,
    goods_services: c.goods_services,
    state_of_incorporation: c.state_of_incorporation,
    hq_mailing_address: c.hq_mailing_address,
    registered_agent: c.registered_agent,
    employees_estimate: c.employees_estimate,
    revenue_estimate: c.revenue_estimate,
    notes: c.notes,
    confidence: c.confidence,
    solvability_tier: c.solvability_tier,
    sources: c.sources,
    evidence_files: c.evidence_files,
  };
}

const displayName = (p: { legal_name: string | null; company_name: string }) =>
  p.legal_name || p.company_name;

// ---------------------------------------------------------------------------
// Section

export function CompaniesSection({
  data,
  runDefendants,
}: {
  data: InvestigationViewResponse;
  /** Companies the AI run identified (already display-ready). */
  runDefendants: DefendantCandidate[];
}) {
  const { doc, ready, busy, actorName, run } = useWorkbench();
  const [editing, setEditing] = useState<string | "new" | null>(null);
  const [dismissed, setDismissed] = useState<Set<string>>(new Set());

  const onDocKeys = useMemo(
    () =>
      new Set(
        doc.companies.flatMap((c) =>
          [c.profile.legal_name, c.profile.company_name]
            .filter((n): n is string => Boolean(n))
            .map(nameKey),
        ),
      ),
    [doc.companies],
  );

  const suggestions: Array<{ candidate: DefendantCandidate; origin: string }> =
    [];
  const seen = new Set<string>();
  for (const d of runDefendants) {
    const name = displayName(d);
    if (!name) continue;
    const key = nameKey(name);
    if (onDocKeys.has(key) || dismissed.has(key) || seen.has(key)) continue;
    seen.add(key);
    suggestions.push({ candidate: d, origin: "AI search" });
  }
  if (data.legacyCompany) {
    const name = displayName(data.legacyCompany);
    const key = name ? nameKey(name) : "";
    if (name && !onDocKeys.has(key) && !dismissed.has(key) && !seen.has(key)) {
      suggestions.push({
        candidate: data.legacyCompany,
        origin: "Company 1 fields",
      });
    }
  }

  const save = async (
    companyId: string | null,
    payload: ReturnType<typeof profilePayload>,
  ) => {
    const ok = await run(
      "company",
      async () => {
        const { doc: next } = await api<{ doc: InvestigationDoc }>(
          "/api/investigation/company",
          "POST",
          {
            investigationId: doc.id,
            actorName: actorName.trim(),
            companyId,
            profile: payload,
          },
        );
        return next;
      },
      { reload: true },
    );
    if (ok) setEditing(null);
    return ok;
  };

  const addCandidate = (candidate: DefendantCandidate) =>
    void run(
      `suggest:${nameKey(displayName(candidate) ?? candidate.company_name)}`,
      async () => {
        const { doc: next } = await api<{ doc: InvestigationDoc }>(
          "/api/investigation/company",
          "POST",
          {
            investigationId: doc.id,
            actorName: actorName.trim(),
            companyId: null,
            profile: payloadFromCandidate(candidate),
          },
        );
        return next;
      },
      { reload: true },
    );

  const decide = (companyId: string, decision: CompanyStatus) =>
    void run(
      `decide:${companyId}`,
      async () => {
        const { doc: next } = await api<{ doc: InvestigationDoc }>(
          "/api/investigation/company",
          "POST",
          {
            investigationId: doc.id,
            actorName: actorName.trim(),
            companyId,
            decision,
          },
        );
        return next;
      },
      { reload: true },
    );

  return (
    <section id="companies">
      <Eyebrow
        right={
          doc.companies.length > 0 ? (
            <Tag>
              {doc.companies.filter((c) => c.status === "confirmed").length}{" "}
              confirmed of {doc.companies.length}
            </Tag>
          ) : undefined
        }
      >
        Companies
      </Eyebrow>

      {suggestions.length > 0 && (
        <div className="mb-3 flex flex-col gap-2">
          {suggestions.map(({ candidate, origin }) => (
            <SuggestionCard
              key={nameKey(displayName(candidate) ?? candidate.company_name)}
              candidate={candidate}
              origin={origin}
              disabled={!ready}
              busy={busy}
              onAdd={() => addCandidate(candidate)}
              onDismiss={() =>
                setDismissed((prev) =>
                  new Set(prev).add(
                    nameKey(displayName(candidate) ?? candidate.company_name),
                  ),
                )
              }
            />
          ))}
        </div>
      )}

      {doc.companies.length === 0 && suggestions.length === 0 && editing !== "new" && (
        <Empty>
          No companies on the file yet. Add the one you tied to the spam.
        </Empty>
      )}

      <div className="flex flex-col gap-2">
        {doc.companies.map((c) => (
          <CompanyRow
            key={c.id}
            company={c}
            ghlAppBase={data.ghlAppBase}
            spawnedName={
              doc.spawned.find((s) => s.companyId === c.id)?.name ?? null
            }
            runMatch={runDefendants.find((d) => {
              const n = displayName(d);
              const cn = displayName(c.profile);
              return n && cn && nameKey(n) === nameKey(cn);
            })}
            editing={editing === c.id}
            ready={ready}
            busy={busy}
            onDecide={(decision) => decide(c.id, decision)}
            onEditToggle={() => setEditing(editing === c.id ? null : c.id)}
            onSave={(form) => void save(c.id, profilePayload(form))}
          />
        ))}
      </div>

      {editing === "new" ? (
        <div className="mt-2 rounded-xs border border-rule bg-card px-4 py-3">
          <p className="mb-2 text-sm font-medium text-ink">New company</p>
          <CompanyForm
            initial={EMPTY_FORM}
            ghlAppBase={data.ghlAppBase}
            ready={ready}
            saving={busy === "company"}
            onSave={(form) => void save(null, profilePayload(form))}
            onCancel={() => setEditing(null)}
          />
        </div>
      ) : (
        <div className="mt-2">
          <Btn disabled={busy !== null} onClick={() => setEditing("new")}>
            + Add company
          </Btn>
        </div>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Suggestion card — the AI's hand-off, one click from the working list.

function SuggestionCard({
  candidate,
  origin,
  disabled,
  busy,
  onAdd,
  onDismiss,
}: {
  candidate: DefendantCandidate;
  origin: string;
  disabled: boolean;
  busy: string | null;
  onAdd: () => void;
  onDismiss: () => void;
}) {
  const name = displayName(candidate) ?? candidate.company_name;
  const adding = busy === `suggest:${nameKey(name)}`;
  return (
    <div className="rounded-xs border border-pending/50 bg-pending-soft/50 px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <div className="min-w-0 flex-1">
          <p className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-serif text-[15px] font-semibold text-ink">
              {name}
            </span>
            <Tag>
              {origin}
              {candidate.confidence != null && origin === "AI search"
                ? ` · ${Math.round(candidate.confidence * 100)}% confidence`
                : ""}
              {candidate.solvability_tier &&
              candidate.solvability_tier !== "unknown"
                ? ` · ${candidate.solvability_tier}`
                : ""}
            </Tag>
          </p>
          <p className="mt-0.5 text-xs text-soft">
            {origin === "AI search"
              ? "The AI search surfaced this company."
              : "The earlier investigation recorded this company."}{" "}
            Add it to the file with every field carried over, or dismiss it if
            it&rsquo;s wrong.
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
    </div>
  );
}

// ---------------------------------------------------------------------------
// Company row — one defendant dossier.

const STATUS_STAMP: Record<CompanyStatus, { tone: "ledger" | "stamp" | "pending"; label: string }> = {
  confirmed: { tone: "ledger", label: "Confirmed" },
  rejected: { tone: "stamp", label: "Rejected" },
  candidate: { tone: "pending", label: "Candidate" },
};

function CompanyRow({
  company: c,
  ghlAppBase,
  spawnedName,
  runMatch,
  editing,
  ready,
  busy,
  onDecide,
  onEditToggle,
  onSave,
}: {
  company: InvestigationCompany;
  ghlAppBase: string;
  spawnedName: string | null;
  runMatch: DefendantCandidate | undefined;
  editing: boolean;
  ready: boolean;
  busy: string | null;
  onDecide: (decision: CompanyStatus) => void;
  onEditToggle: () => void;
  onSave: (form: ProfileForm) => void;
}) {
  const name = displayName(c.profile);
  const spawned = Boolean(c.spawnedOpportunityId);
  const stamp = STATUS_STAMP[c.status];
  const deciding = busy === `decide:${c.id}`;

  // Repeat-defendant signal: skip the lookup once the record is linked.
  const lookup = useDefendantLookup(name ?? "", !c.defendantRecordId);
  const matchId =
    c.defendantRecordId ??
    (lookup.status === "done" ? lookup.match?.id ?? null : null);

  return (
    <div className="rounded-xs border border-rule bg-card px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <Stamp tone={stamp.tone}>{deciding ? "…" : stamp.label}</Stamp>
        <span className="font-serif text-[15px] font-semibold text-ink">
          {name}
        </span>
        <Tag>
          {c.origin.kind === "ai" ? "AI" : c.origin.name}
          {c.decidedAt ? ` · decided ${fmtDate(c.decidedAt)}` : ""}
        </Tag>
        {matchId && (
          <a
            href={defendantRecordUrl(ghlAppBase, matchId)}
            target="_blank"
            rel="noreferrer"
            title={
              c.defendantRecordId
                ? "Open the linked Defendant record in GHL"
                : "A Defendant record with this name already exists — it will be reused at the split"
            }
          >
            <Stamp tone="neutral">
              {c.defendantRecordId ? "Defendant ↗" : "Repeat defendant ↗"}
            </Stamp>
          </a>
        )}
        <span className="flex-1" />
        {!spawned && (
          <div className="flex shrink-0 gap-1.5">
            {c.status !== "confirmed" && (
              <Btn variant="ledger" small disabled={!ready} onClick={() => onDecide("confirmed")}>
                Confirm
              </Btn>
            )}
            {c.status !== "rejected" && (
              <Btn variant="danger" small disabled={!ready} onClick={() => onDecide("rejected")}>
                Reject
              </Btn>
            )}
            {c.status !== "candidate" && (
              <Btn small disabled={!ready} onClick={() => onDecide("candidate")}>
                Undo
              </Btn>
            )}
            <Btn small disabled={busy !== null} onClick={onEditToggle}>
              {editing ? "Close" : "Edit"}
            </Btn>
          </div>
        )}
      </div>

      {spawnedName && (
        <p className="mt-1.5 font-mono text-[11px] text-ledger">
          Case spawned — {spawnedName}
        </p>
      )}

      {!editing && <ProfileSummary company={c} runMatch={runMatch} />}

      {editing && (
        <div className="mt-3 border-t border-rule pt-3">
          <CompanyForm
            initial={formFromCompany(c)}
            ghlAppBase={ghlAppBase}
            ready={ready}
            saving={busy === "company"}
            onSave={onSave}
            onCancel={onEditToggle}
          />
        </div>
      )}
    </div>
  );
}

/** Compact read view of the dossier: filled fields only, AI trail expandable. */
function ProfileSummary({
  company: c,
  runMatch,
}: {
  company: InvestigationCompany;
  runMatch: DefendantCandidate | undefined;
}) {
  const p = c.profile;
  const enriched = runMatch ?? p;
  const rows: Array<[string, string | null | undefined]> = [
    ["Brand name", p.legal_name ? p.company_name : null],
    ["Website", p.website],
    ["Incorporated", p.state_of_incorporation],
    ["HQ", p.hq_mailing_address],
    ["Agent", p.registered_agent?.name],
    ["Agent address", p.registered_agent?.address],
    ["Revenue", p.revenue_estimate],
    ["Employees", p.employees_estimate],
  ];
  const filled = rows.filter(([, v]) => v?.trim());
  const screens = enriched.screens?.filter((s) => s.hit) ?? [];
  const hasDetail =
    filled.length > 0 || p.notes || screens.length > 0 || (enriched.sources?.length ?? 0) > 0;
  if (!hasDetail) return null;

  return (
    <details className="group mt-2">
      <summary className="cursor-pointer font-mono text-[10px] tracking-[0.12em] text-faint uppercase select-none hover:text-soft">
        <span className="group-open:hidden">▸ Dossier</span>
        <span className="hidden group-open:inline">▾ Dossier</span>
        {enriched.scorecard
          ? ` · score ${enriched.scorecard.final} (${enriched.scorecard.band})`
          : ""}
        {screens.length > 0 ? ` · ${screens.length} screen hit${screens.length === 1 ? "" : "s"}` : ""}
      </summary>
      <div className="mt-2 flex flex-col gap-2.5">
        {filled.length > 0 && (
          <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
            {filled.map(([label, value]) => (
              <div key={label} className="contents">
                <dt className="font-mono text-xs text-soft">{label}</dt>
                <dd className="break-words text-ink">{value}</dd>
              </div>
            ))}
          </dl>
        )}
        {screens.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {screens.map((s) => (
              <Stamp key={s.screen} tone="pending" title={s.basis}>
                {s.screen.replaceAll("_", " ")}
              </Stamp>
            ))}
          </div>
        )}
        {p.notes && (
          <p className="text-sm leading-6 break-words whitespace-pre-wrap text-soft">
            {p.notes}
          </p>
        )}
        {(enriched.sources?.length ?? 0) > 0 && (
          <ul className="flex flex-col gap-0.5">
            {enriched.sources!.slice(0, 8).map((src) => (
              <li key={src} className="truncate">
                <a
                  href={src}
                  target="_blank"
                  rel="noreferrer"
                  className="font-mono text-[11px] text-soft underline decoration-rule underline-offset-2 hover:decoration-stamp"
                >
                  {src}
                </a>
              </li>
            ))}
          </ul>
        )}
      </div>
    </details>
  );
}

// ---------------------------------------------------------------------------
// Company form — short by default, whole dossier on demand.

function CompanyForm({
  initial,
  ghlAppBase,
  ready,
  saving,
  onSave,
  onCancel,
}: {
  initial: ProfileForm;
  ghlAppBase: string;
  ready: boolean;
  saving: boolean;
  onSave: (form: ProfileForm) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState(initial);
  const [expanded, setExpanded] = useState(() =>
    ADVANCED_KEYS.some((key) => initial[key].trim().length > 0),
  );
  const set = (key: keyof ProfileForm) => (value: string) =>
    setForm((f) => ({ ...f, [key]: value }));

  const lookupName = form.legal_name.trim() || form.company_name.trim();
  const lookup = useDefendantLookup(lookupName, lookupName.length >= 3);

  const prefill = (match: DefendantMatch) => {
    const fromRecord = formFromRecord(match.properties);
    setForm((f) => {
      const next = { ...f };
      for (const [key, value] of Object.entries(fromRecord) as Array<
        [keyof ProfileForm, string]
      >) {
        if (value.trim() && !next[key].trim()) next[key] = value;
      }
      return next;
    });
    setExpanded(true);
  };

  const text = (key: keyof ProfileForm, label: string, span?: boolean) => (
    <Field key={key} label={label} span={span}>
      <input
        value={form[key]}
        onChange={(e) => set(key)(e.target.value)}
        className={inputCls}
      />
    </Field>
  );

  return (
    <div className="flex flex-col gap-3">
      <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
        {text("company_name", "Company name (as it appears in the spam)")}
        {text("website", "Website")}
      </div>

      {lookup.status === "searching" && (
        <p className="font-mono text-[11px] text-faint">
          Checking the Defendants object…
        </p>
      )}
      {lookup.status === "done" && lookup.match && (
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-xs border border-ledger/50 bg-ledger-soft px-3 py-2.5">
          <p className="min-w-0 flex-1 text-sm text-ink">
            <span className="font-medium">Repeat defendant.</span> Matches the
            Defendant record on file since {fmtDate(lookup.match.createdAt)} —
            it will be reused at the split, not duplicated.
          </p>
          <Btn variant="ledger" small onClick={() => prefill(lookup.match!)}>
            Prefill empty fields
          </Btn>
          <a
            href={defendantRecordUrl(ghlAppBase, lookup.match.id)}
            target="_blank"
            rel="noreferrer"
          >
            <Stamp tone="neutral">Defendant ↗</Stamp>
          </a>
        </div>
      )}

      {expanded ? (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          {text("legal_name", "Legal name (with entity suffix)")}
          {text("state_of_incorporation", "State of incorporation")}
          {text("hq_mailing_address", "HQ / mailing address", true)}
          {text("agent_name", "Registered agent")}
          {text("agent_state", "Agent state")}
          {text("agent_address", "Agent address", true)}
          {text("revenue_estimate", "Revenue estimate")}
          {text("employees_estimate", "Employees estimate")}
        </div>
      ) : (
        <button
          type="button"
          onClick={() => setExpanded(true)}
          className="self-start font-mono text-[11px] tracking-[0.12em] text-soft uppercase underline decoration-rule-strong underline-offset-2 hover:text-ink"
        >
          ▸ All fields — legal name, HQ, agent, size
        </button>
      )}

      <Field label="Facts connecting the company to the spam">
        <textarea
          value={form.notes}
          onChange={(e) => set("notes")(e.target.value)}
          rows={2}
          className={inputCls}
        />
      </Field>

      <div className="flex gap-2">
        <Btn
          variant="primary"
          disabled={!ready || form.company_name.trim().length === 0}
          onClick={() => onSave(form)}
        >
          {saving ? "Saving…" : "Save company"}
        </Btn>
        <Btn onClick={onCancel}>Cancel</Btn>
      </div>
    </div>
  );
}
