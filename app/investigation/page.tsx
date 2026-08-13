"use client";

import {
  Suspense,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import type { InvestigationViewResponse } from "@/app/api/investigation/route";
import type {
  QueueEntry,
  QueueResponse,
} from "@/app/api/investigation/queue/route";
import { buildDisplayFiles, caseFromRun, proxied } from "@/lib/case-display";
import type {
  InvestigationDoc,
  InvestigationEvidence,
} from "@/lib/investigation-store";
import { RUN_STATUS } from "@/lib/opportunity-fields";
import type { Case, CaseFile } from "@/lib/types";
import { AiRunSection } from "@/components/investigation/ai-run";
import { CompaniesSection } from "@/components/investigation/companies";
import { ContextRail } from "@/components/investigation/context-rail";
import { ExhibitsSection } from "@/components/investigation/exhibits";
import {
  ExhibitViewer,
  type Exhibit,
} from "@/components/investigation/file-viewer";
import { CaptionHeader } from "@/components/investigation/header";
import { HistorySection } from "@/components/investigation/history";
import { LogSection } from "@/components/investigation/log";
import { SplitSection } from "@/components/investigation/split";
import {
  api,
  Btn,
  ErrorNote,
  fmtDate,
  inputCls,
  Stamp,
  WorkbenchProvider,
  type RunFn,
  type StampTone,
  type Workbench,
} from "@/components/investigation/ui";
import { ViolationsSection } from "@/components/investigation/violations";

/**
 * The investigation file: one page per opportunity holding the WHOLE
 * investigation — exhibits, the AI run, manual findings, companies, the
 * docket, and the split into defendant-centric case opportunities — so nobody
 * clicks around GHL to reconstruct what happened. Reached by deep link:
 * /investigation?opp=<opportunityId>.
 */

const ACTOR_STORAGE_KEY = "investigatorName";

type View = {
  data: InvestigationViewResponse;
  displayCase: Case | null;
  files: CaseFile[];
};

export default function InvestigationPage() {
  return (
    <Suspense
      fallback={
        <main className="flex flex-1 items-center justify-center bg-paper">
          <p className="font-mono text-sm text-soft">Loading…</p>
        </main>
      }
    >
      <InvestigationView />
    </Suspense>
  );
}

function InvestigationView() {
  const router = useRouter();
  const params = useSearchParams();
  const opp = params.get("opp");
  const desk = params.get("desk") === "review" ? "review" : "manual";
  const [loaded, setLoaded] = useState<{ id: string; view: View } | null>(null);
  const [loadError, setLoadError] = useState<{ id: string; message: string } | null>(null);

  const loadToken = useRef(0);
  const objectUrls = useRef<string[]>([]);
  useEffect(() => {
    const urls = objectUrls.current;
    return () => urls.forEach((u) => URL.revokeObjectURL(u));
  }, []);

  const load = useCallback(async (opportunityId: string) => {
    const token = ++loadToken.current;
    try {
      const res = await fetch(
        `/api/investigation?opp=${encodeURIComponent(opportunityId)}`,
      );
      const data = (await res.json().catch(() => null)) as
        | (InvestigationViewResponse & { error?: string })
        | null;
      if (!res.ok || !data) {
        throw new Error(data?.error ?? `Loading failed: ${res.status}`);
      }
      const files = await buildDisplayFiles(data.doc?.run?.files, data.evidence);
      if (token !== loadToken.current) return;
      objectUrls.current.push(
        ...files.map((f) => f.url).filter((u) => u.startsWith("blob:")),
      );
      setLoaded({
        id: opportunityId,
        view: {
          data,
          displayCase: data.doc ? caseFromRun(opportunityId, data.doc, files) : null,
          files,
        },
      });
      setLoadError(null);
    } catch (err) {
      if (token !== loadToken.current) return;
      setLoadError({
        id: opportunityId,
        message:
          err instanceof Error ? err.message : "Could not load the investigation.",
      });
    }
  }, []);

  useEffect(() => {
    // Fetch-on-mount: every setState happens after the awaited response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (opp) void load(opp);
  }, [opp, load]);

  if (!opp) {
    // Default view: a desk's docket — the investigator desk by default, the
    // review desk via ?desk=review. `push`, not `replace`, so the back
    // button returns from a file to the docket.
    return (
      <Docket
        desk={desk}
        onOpen={(id) =>
          router.push(`/investigation?opp=${encodeURIComponent(id)}`)
        }
      />
    );
  }

  const view = loaded && loaded.id === opp ? loaded.view : null;
  const error = loadError && loadError.id === opp ? loadError.message : null;

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-paper font-sans text-ink">
      {error ? (
        <div className="mx-auto max-w-2xl p-8">
          <ErrorNote>{error}</ErrorNote>
        </div>
      ) : !view ? (
        <div className="flex h-full items-center justify-center p-8">
          <p className="font-mono text-sm text-soft">
            Pulling the file — GHL, Firestore, notes…
          </p>
        </div>
      ) : (
        <FileView view={view} onReload={() => load(opp)} />
      )}
    </main>
  );
}

/** Per-desk docket copy: what the queue is and how to work it. */
const DOCKET_COPY = {
  manual: {
    title: "Manual investigation",
    fallbackStage: "🔍 Manual Investigation",
    description:
      "stage, oldest first. Open one to work its file.",
  },
  review: {
    title: "Review & split",
    fallbackStage: "AI Under Investigation",
    description:
      "stage, oldest first — every opportunity the agent has taken on. Open one to review the findings and split it into case opportunities.",
  },
} as const;

/**
 * A desk's docket: every open opportunity in its stage, oldest first — the
 * queue the desk drains ('🔍 Manual Investigation' by default, 'AI Under
 * Investigation' for the review desk). The pull-by-id form on top is the
 * optional side door to any file, in or out of the stage.
 */
function Docket({
  desk,
  onOpen,
}: {
  desk: "manual" | "review";
  onOpen: (id: string) => void;
}) {
  const [data, setData] = useState<QueueResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setData(null);
    setError(null);
    try {
      const res = await fetch(`/api/investigation/queue?desk=${desk}`);
      const body = (await res.json().catch(() => null)) as
        | (QueueResponse & { error?: string })
        | null;
      if (!res.ok || !body) {
        throw new Error(body?.error ?? `Loading failed: ${res.status}`);
      }
      setData(body);
    } catch (err) {
      setError(
        err instanceof Error ? err.message : "Could not load the docket.",
      );
    }
  }, [desk]);

  useEffect(() => {
    // Fetch-on-mount: every setState happens after the awaited response.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void load();
  }, [load]);

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-paper font-sans text-ink">
      <div className="mx-auto flex max-w-4xl gap-5 px-4 py-10 sm:px-6">
        {/* The pleading-paper margin rule. */}
        <div
          aria-hidden
          className="hidden w-[5px] shrink-0 self-stretch border-x border-stamp/35 sm:block"
        />

        <div className="min-w-0 flex-1">
          <header className="border-b-2 border-ink/80 pb-5">
            <div className="flex flex-wrap items-baseline justify-between gap-x-6 gap-y-1">
              <Link
                href="/"
                className="font-mono text-[11px] tracking-[0.22em] text-stamp uppercase hover:underline"
              >
                Gold Law · Lobby
              </Link>
              {data && (
                <p className="font-mono text-[11px] text-faint">
                  {data.entries.length} in queue
                </p>
              )}
            </div>
            <h1 className="mt-2 font-serif text-2xl font-semibold text-ink sm:text-[1.7rem]">
              {DOCKET_COPY[desk].title}
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-soft">
              Opportunities in the{" "}
              {data?.stageName ?? DOCKET_COPY[desk].fallbackStage}{" "}
              {DOCKET_COPY[desk].description}
            </p>
          </header>

          <PullFileForm onOpen={onOpen} />

          {error ? (
            <div className="mt-6 flex flex-col items-start gap-3">
              <ErrorNote>{error}</ErrorNote>
              <Btn onClick={() => void load()}>Try again</Btn>
            </div>
          ) : data === null ? (
            <p className="mt-8 font-mono text-sm text-soft">
              Pulling the docket…
            </p>
          ) : data.entries.length === 0 ? (
            <p className="mt-8 text-sm text-soft">
              The {data.stageName} stage is clear.
            </p>
          ) : (
            <ul className="mt-2">
              {data.entries.map((entry) => (
                <DocketRow key={entry.id} entry={entry} desk={desk} />
              ))}
            </ul>
          )}

          <div className="h-16" />
        </div>
      </div>
    </main>
  );
}

/** The optional side door: open any file by opportunity id or GHL URL. */
function PullFileForm({ onOpen }: { onOpen: (id: string) => void }) {
  const [value, setValue] = useState("");
  const id = value.trim().split("/").filter(Boolean).pop() ?? "";
  return (
    <form
      className="mt-5 flex flex-wrap items-end gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        if (id) onOpen(id);
      }}
    >
      <label className="flex min-w-0 flex-1 flex-col gap-1">
        <span className="font-mono text-[10px] tracking-[0.12em] text-soft uppercase">
          Pull any file · Opportunity id or GHL link
        </span>
        <input
          value={value}
          onChange={(e) => setValue(e.target.value)}
          placeholder="Opportunity id or GHL URL"
          className={`${inputCls} w-full font-mono`}
        />
      </label>
      <Btn variant="primary" type="submit" disabled={!id}>
        Open the file
      </Btn>
    </form>
  );
}

/**
 * The review desk's badge speaks for the AGENT's outcome (the row's reason to
 * exist); a human investigation opened on top of it wins, same as the manual
 * desk. RUN_STATUS values are matched verbatim — an unknown value (a renamed
 * GHL option) falls back to showing the raw text rather than lying.
 */
function runStatusStamp(status: string | null): {
  tone: StampTone;
  label: string;
} {
  switch (status) {
    case RUN_STATUS.found:
      return { tone: "ledger", label: "Companies found" };
    case RUN_STATUS.none:
      return { tone: "neutral", label: "No company found" };
    case RUN_STATUS.timeBarred:
      return { tone: "stamp", label: "Time-barred" };
    case RUN_STATUS.noClaim:
      return { tone: "stamp", label: "No claim" };
    case null:
      return { tone: "pending", label: "Run not finished" };
    default:
      return { tone: "neutral", label: status };
  }
}

function DocketRow({
  entry,
  desk,
}: {
  entry: QueueEntry;
  desk: "manual" | "review";
}) {
  const inv = entry.investigation;
  const run = desk === "review" ? runStatusStamp(entry.aiRunStatus) : null;
  return (
    <li className="border-b border-rule">
      <Link
        href={`/investigation?opp=${encodeURIComponent(entry.id)}`}
        className="group flex items-center justify-between gap-4 py-3.5 transition-colors hover:bg-wash sm:-mx-3 sm:px-3"
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="truncate font-serif text-base font-semibold text-ink underline-offset-4 group-hover:underline">
            {entry.name}
          </span>
          <span className="truncate font-mono text-[11px] text-faint">
            {entry.createdAt ? `Opened ${fmtDate(entry.createdAt)}` : "No date"}
            {entry.contactName && ` · ${entry.contactName}`}
            {inv &&
              ` · ${inv.confirmedCompanies}/${inv.companies} companies · ${inv.evidence} file${inv.evidence === 1 ? "" : "s"}`}
          </span>
        </span>
        <span className="flex shrink-0 items-center gap-1.5">
          {run && <Stamp tone={run.tone}>{run.label}</Stamp>}
          {inv === null ? (
            run === null && <Stamp tone="neutral">Not started</Stamp>
          ) : inv.status === "open" ? (
            <Stamp tone="pending">In progress</Stamp>
          ) : (
            <Stamp tone="pending">Ready for review</Stamp>
          )}
        </span>
      </Link>
    </li>
  );
}

// ---------------------------------------------------------------------------
// Loaded file

function FileView({ view, onReload }: { view: View; onReload: () => Promise<void> }) {
  const { data, displayCase, files } = view;

  const [actorName, setActorName] = useState("");
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActorName(localStorage.getItem(ACTOR_STORAGE_KEY) ?? "");
  }, []);
  const saveActorName = (name: string) => {
    setActorName(name);
    localStorage.setItem(ACTOR_STORAGE_KEY, name);
  };

  const [busy, setBusy] = useState<string | null>(null);
  const [mutError, setMutError] = useState<string | null>(null);
  const [docs, setDocs] = useState<InvestigationDoc[]>(data.investigations);
  // Server refetches win over local snapshots.
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => setDocs(data.investigations), [data.investigations]);

  const run: RunFn = async (key, fn, opts) => {
    setBusy(key);
    setMutError(null);
    try {
      const next = await fn();
      if (next) {
        setDocs((prev) =>
          prev.some((d) => d.id === next.id)
            ? prev.map((d) => (d.id === next.id ? next : d))
            : [next, ...prev],
        );
      }
      if (opts?.reload) await onReload();
      return true;
    } catch (err) {
      setMutError(err instanceof Error ? err.message : "Request failed.");
      return false;
    } finally {
      setBusy(null);
    }
  };

  const activeInv = docs.find((d) => d.status !== "closed") ?? null;
  const closedInvs = docs.filter((d) => d.status === "closed");
  const runDefendants = displayCase?.defendants ?? [];
  const ready = actorName.trim().length > 0 && busy === null;

  const workbench: Workbench | null = activeInv
    ? { doc: activeInv, actorName, ready, busy, run }
    : null;

  // ------------------------------------------------------------------
  // Exhibits: the unified evidence model (investigation entries + run files).

  const exhibits = useMemo(() => {
    const inv = activeInv ?? docs[0] ?? null;
    const byName = new Map(files.map((f) => [f.name, f] as const));
    const list: Exhibit[] = [];
    let index = 1;
    for (const e of inv?.evidence ?? []) {
      const match = byName.get(e.name);
      list.push({
        key: `ev:${e.id}`,
        index: index++,
        name: e.name,
        kind: e.kind,
        url:
          match?.url && match.status === "done"
            ? match.url
            : evidenceUrl(inv!, e),
        role: e.role,
        sourceLabel:
          e.source === "ghl_field"
            ? "Client-sent (GHL)"
            : `Filed by ${e.addedBy.kind === "ai" ? "AI" : e.addedBy.name}`,
        companyIds: e.companyIds,
        text: e.text ?? match?.text ?? null,
        forensics: match?.forensics ?? null,
        evidenceId: inv && inv === activeInv ? e.id : null,
      });
    }
    for (const f of files) {
      if (inv?.evidence.some((e) => e.name === f.name)) continue;
      list.push({
        key: `file:${f.id}`,
        index: index++,
        name: f.name,
        kind: f.kind,
        url: f.url,
        role: null,
        sourceLabel: "AI run",
        companyIds: [],
        text: f.text ?? null,
        forensics: f.forensics ?? null,
        evidenceId: null,
      });
    }
    return list;
  }, [docs, activeInv, files]);

  const [openKey, setOpenKey] = useState<string | null>(null);
  const openExhibit = exhibits.find((e) => e.key === openKey) ?? null;

  const attributionOptions = (activeInv?.companies ?? [])
    .filter((c) => c.status !== "rejected")
    .map((c) => ({
      id: c.id,
      name: c.profile.legal_name || c.profile.company_name,
    }));

  const patchExhibit = (
    exhibit: Exhibit,
    patch: { role?: "raw" | "confirmed"; companyIds?: string[] },
  ) => {
    if (!activeInv || !exhibit.evidenceId) return;
    void run(`evidence:${exhibit.evidenceId}`, async () => {
      const { doc } = await api<{ doc: InvestigationDoc }>(
        "/api/investigation/evidence",
        "PATCH",
        {
          investigationId: activeInv.id,
          actorName: actorName.trim(),
          evidenceId: exhibit.evidenceId,
          ...patch,
        },
      );
      return doc;
    });
  };

  const isChildCase = Boolean(data.spawnedFrom);

  return (
    <div className="mx-auto flex max-w-6xl gap-5 px-4 py-8 sm:px-6">
      {/* The pleading-paper margin rule. */}
      <div
        aria-hidden
        className="hidden w-[5px] shrink-0 self-stretch border-x border-stamp/35 sm:block"
      />

      <div className="min-w-0 flex-1">
        <CaptionHeader
          data={{ ...data, investigations: docs }}
          activeInv={activeInv}
          actorName={actorName}
          onActorName={saveActorName}
          busy={busy}
          error={mutError}
          run={run}
        />

        <Bench workbench={workbench}>
          <div className="mt-7 flex flex-col gap-10 lg:grid lg:grid-cols-[320px_minmax(0,1fr)] lg:items-start lg:gap-x-10">
            <aside className="flex min-w-0 flex-col gap-8">
              <ExhibitsSection
                exhibits={exhibits}
                onOpen={(e) => setOpenKey(e.key)}
                canUpload={Boolean(workbench)}
              />
              <ContextRail data={data} />
            </aside>

            <div className="flex min-w-0 flex-col gap-10">
              {displayCase && <AiRunSection displayCase={displayCase} />}

              {workbench && (
                <>
                  <CompaniesSection data={data} runDefendants={runDefendants} />
                  <ViolationsSection
                    runDefendants={runDefendants}
                    displayCase={displayCase}
                    onOpenEvidence={(id) => setOpenKey(`ev:${id}`)}
                  />
                </>
              )}

              {!isChildCase && (
                <SplitSection
                  data={{ ...data, investigations: docs }}
                  runDefendants={runDefendants}
                  activeInv={activeInv}
                  busy={busy}
                  run={run}
                />
              )}

              {workbench && <LogSection />}

              <HistorySection
                investigations={closedInvs}
                actorName={actorName}
                busy={busy}
                run={run}
              />
            </div>
          </div>
        </Bench>

        <div className="h-16" />
      </div>

      {openExhibit && (
        <ExhibitViewer
          exhibit={openExhibit}
          options={attributionOptions}
          canEdit={Boolean(workbench) && ready && openExhibit.evidenceId !== null}
          busy={busy === `evidence:${openExhibit.evidenceId}`}
          error={mutError}
          onPatch={(patch) => patchExhibit(openExhibit, patch)}
          onClose={() => setOpenKey(null)}
        />
      )}
    </div>
  );
}

/** Wraps children in the workbench context when an investigation is open. */
function Bench({
  workbench,
  children,
}: {
  workbench: Workbench | null;
  children: React.ReactNode;
}) {
  if (!workbench) return <>{children}</>;
  return <WorkbenchProvider value={workbench}>{children}</WorkbenchProvider>;
}

function evidenceUrl(inv: InvestigationDoc, e: InvestigationEvidence): string {
  if (e.ghlUrl) return proxied(e.ghlUrl);
  return `/api/investigation/file?inv=${encodeURIComponent(inv.id)}&ev=${encodeURIComponent(e.id)}`;
}
