"use client";

import { useEffect, useRef, useState } from "react";
import type { DncCheck, FileKind } from "@/lib/types";

/** One piece of evidence ready to enter the pipeline. */
export type NewCaseInput = { blob: Blob; name: string; kind: FileKind };

export type NewCaseMeta = {
  /** Automated DNC lookup of the client's number, run by the import route. */
  dnc?: DncCheck;
  /** Case display name; defaults to the timestamp name when absent. */
  name?: string;
  opportunityId?: string;
};

type ImportResponse = {
  opportunity: { id: string; name: string };
  files: { url: string; name: string; mimetype: string; kind: FileKind }[];
  skipped: number;
  /** Set when the opportunity's "AI Run Status" field shows a previous run. */
  existingRun: { status: string } | null;
  /** Automated DNC registry check of the opportunity contact's number. */
  dnc: DncCheck;
};

/**
 * Case-creation dialog: paste a GHL opportunity URL and the evidence attached
 * to it (plus the contact's automated DNC lookup) enters the pipeline. The old
 * manual file upload and the operator-attested DNC checkboxes are gone — the
 * opportunity is the single source, and the DNC registries are checked through
 * the RealValidation API on the server.
 */
export function NewCaseModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (inputs: NewCaseInput[], meta: NewCaseMeta) => void;
}) {
  const [url, setUrl] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Import held for confirmation because the agent already ran (a report note
  // exists on the opportunity). The user decides whether to run again.
  const [pendingImport, setPendingImport] = useState<ImportResponse | null>(
    null,
  );
  const busyRef = useRef(false);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  /** Download an import's evidence and hand the case off to the pipeline. */
  async function launchImport(data: ImportResponse) {
    const inputs = await Promise.all(
      data.files.map(async (file): Promise<NewCaseInput> => {
        const download = await fetch(
          `/api/opportunity/file?url=${encodeURIComponent(file.url)}`,
        );
        if (!download.ok) {
          throw new Error(`Could not download ${file.name}.`);
        }
        return { blob: await download.blob(), name: file.name, kind: file.kind };
      }),
    );
    onCreate(inputs, {
      dnc: data.dnc,
      name: data.opportunity.name,
      opportunityId: data.opportunity.id,
    });
    onClose();
  }

  async function start() {
    setError(null);
    busyRef.current = true;
    setBusy(true);
    try {
      const res = await fetch("/api/opportunity/import", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ url: url.trim() }),
      });
      const data = (await res.json().catch(() => null)) as
        | (ImportResponse & { error?: string })
        | null;
      if (!res.ok || !data) {
        throw new Error(data?.error ?? `Import failed: ${res.status}`);
      }
      if (data.files.length === 0) {
        throw new Error(
          "This opportunity has no files in Violation Screenshots or Violation Audio Files.",
        );
      }
      if (data.existingRun) {
        // The agent already ran for this opportunity — ask before re-running.
        setPendingImport(data);
        return;
      }
      await launchImport(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the case.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  async function confirmRerun() {
    if (!pendingImport) return;
    setError(null);
    busyRef.current = true;
    setBusy(true);
    try {
      await launchImport(pendingImport);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the case.");
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  }

  const canStart = !busy && url.trim().length > 0;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={() => !busy && onClose()}
    >
      <div
        className="flex w-full max-w-md flex-col gap-5 rounded-xl border border-zinc-200 bg-white p-6 shadow-xl dark:border-zinc-800 dark:bg-zinc-950"
        onClick={(event) => event.stopPropagation()}
      >
        {pendingImport ? (
          <>
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              Run the agent again?
            </h2>
            <p className="text-sm text-zinc-600 dark:text-zinc-300">
              The agent already searched for this opportunity
              {pendingImport.existingRun &&
                ` (${pendingImport.existingRun.status})`}
              , want to run it again? Re-running overwrites the AI Intake fields
              and the saved report PDF.
            </p>
            {error && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-400">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={() => {
                  setPendingImport(null);
                  setError(null);
                }}
                disabled={busy}
                className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-900"
              >
                No
              </button>
              <button
                type="button"
                onClick={() => void confirmRerun()}
                disabled={busy}
                className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
              >
                {busy ? "Fetching evidence…" : "Yes, run again"}
              </button>
            </div>
          </>
        ) : (
          <>
            <h2 className="text-base font-semibold text-zinc-900 dark:text-zinc-100">
              New case
            </h2>

            <div className="flex flex-col gap-1.5">
              <input
                type="url"
                value={url}
                onChange={(event) => {
                  setUrl(event.target.value);
                  setError(null);
                }}
                placeholder="https://login.amicus-pro.com/v2/location/…/opportunities/…"
                className="w-full rounded-lg border border-zinc-300 bg-transparent px-3 py-2 text-sm text-zinc-900 placeholder:text-zinc-400 focus:border-zinc-500 focus:outline-none dark:border-zinc-700 dark:text-zinc-100 dark:placeholder:text-zinc-600"
              />
              <p className="text-xs text-zinc-500 dark:text-zinc-400">
                Evidence is pulled from the opportunity&rsquo;s Violation
                Screenshots and Violation Audio Files fields. The client&rsquo;s
                number is checked against the National and Florida DNC
                registries automatically.
              </p>
            </div>

            {error && (
              <p className="rounded-lg bg-red-50 px-3 py-2 text-sm text-red-700 dark:bg-red-950/40 dark:text-red-400">
                {error}
              </p>
            )}

            <div className="flex justify-end gap-2">
              <button
                type="button"
                onClick={onClose}
                disabled={busy}
                className="rounded-lg px-4 py-2 text-sm font-medium text-zinc-600 transition-colors hover:bg-zinc-100 disabled:opacity-50 dark:text-zinc-300 dark:hover:bg-zinc-900"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void start()}
                disabled={!canStart}
                className="rounded-lg bg-zinc-900 px-4 py-2 text-sm font-medium text-white transition-colors hover:bg-zinc-700 disabled:opacity-50 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300"
              >
                {busy ? "Fetching evidence…" : "Start case"}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  );
}
