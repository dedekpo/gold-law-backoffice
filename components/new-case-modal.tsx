"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { detectKind } from "@/lib/file-kind";
import type { DncStatus, FileKind } from "@/lib/types";

/** One piece of evidence ready to enter the pipeline (either source). */
export type NewCaseInput = { blob: Blob; name: string; kind: FileKind };

export type NewCaseMeta = {
  dnc: DncStatus;
  /** Case display name; defaults to the timestamp name when absent. */
  name?: string;
  opportunityId?: string;
};

type Source = "upload" | "ghl";

type ImportResponse = {
  opportunity: { id: string; name: string };
  files: { url: string; name: string; mimetype: string; kind: FileKind }[];
  skipped: number;
  /** A previous agent run's report note, when one exists on the opportunity. */
  existingReport: { noteId: string; dateAdded: string | null } | null;
};

/**
 * Case-creation dialog: evidence comes from a manual file upload or from the
 * files attached to a pasted GHL opportunity URL, plus the intaker's manual
 * DNC-lookup attestations. Produces the same inputs either way, so the
 * downstream pipeline doesn't know or care where the evidence came from.
 */
export function NewCaseModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (inputs: NewCaseInput[], meta: NewCaseMeta) => void;
}) {
  const [source, setSource] = useState<Source>("upload");
  const [files, setFiles] = useState<File[]>([]);
  const [url, setUrl] = useState("");
  const [dncNational, setDncNational] = useState(false);
  const [dncFlorida, setDncFlorida] = useState(false);
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

  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    setError(null);
    setFiles(Array.from(event.target.files ?? []));
  }

  const dnc: DncStatus = { national: dncNational, florida: dncFlorida };

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
      dnc,
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
      if (source === "upload") {
        const inputs = files
          .map((file) => {
            const kind = detectKind(file.type, file.name);
            return kind ? { blob: file as Blob, name: file.name, kind } : null;
          })
          .filter((input): input is NewCaseInput => input !== null);
        if (inputs.length === 0) {
          throw new Error("None of the selected files are audio or images.");
        }
        onCreate(inputs, { dnc });
        onClose();
      } else {
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
        if (data.existingReport) {
          // The agent already ran for this opportunity — ask before re-running.
          setPendingImport(data);
          return;
        }
        await launchImport(data);
      }
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

  const canStart =
    !busy && (source === "upload" ? files.length > 0 : url.trim().length > 0);

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
              {pendingImport.existingReport?.dateAdded &&
                ` (report saved ${new Date(
                  pendingImport.existingReport.dateAdded,
                ).toLocaleDateString()})`}
              , want to run it again? Re-running replaces the saved &ldquo;AI
              Intake Report&rdquo; note.
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

        <div className="grid grid-cols-2 gap-2">
          {(
            [
              ["upload", "Upload files"],
              ["ghl", "GHL opportunity"],
            ] as const
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => {
                setSource(value);
                setError(null);
              }}
              className={`rounded-lg border px-3 py-2 text-sm font-medium transition-colors ${
                source === value
                  ? "border-zinc-900 bg-zinc-900 text-white dark:border-zinc-100 dark:bg-zinc-100 dark:text-zinc-900"
                  : "border-zinc-300 text-zinc-700 hover:bg-zinc-100 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
              }`}
            >
              {label}
            </button>
          ))}
        </div>

        {source === "upload" ? (
          <label className="flex cursor-pointer flex-col items-center gap-1 rounded-lg border border-dashed border-zinc-300 px-4 py-6 text-center text-sm text-zinc-600 transition-colors hover:bg-zinc-50 dark:border-zinc-700 dark:text-zinc-300 dark:hover:bg-zinc-900">
            {files.length > 0
              ? `${files.length} file${files.length === 1 ? "" : "s"} selected`
              : "Choose audio or image files"}
            <span className="text-xs text-zinc-400 dark:text-zinc-500">
              Voicemails and screenshots of the violations
            </span>
            <input
              type="file"
              accept="audio/*,image/*"
              multiple
              onChange={handleFiles}
              className="hidden"
            />
          </label>
        ) : (
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
              Screenshots and Violation Audio Files fields.
            </p>
          </div>
        )}

        <fieldset className="flex flex-col gap-2 rounded-lg border border-zinc-200 p-3 dark:border-zinc-800">
          <legend className="px-1 text-xs font-medium text-zinc-500 dark:text-zinc-400">
            DNC registry — manual lookup
          </legend>
          <label className="flex items-start gap-2 text-sm text-zinc-700 dark:text-zinc-200">
            <input
              type="checkbox"
              checked={dncNational}
              onChange={(event) => setDncNational(event.target.checked)}
              className="mt-0.5"
            />
            Client is registered on the National DNC
          </label>
          <label className="flex items-start gap-2 text-sm text-zinc-700 dark:text-zinc-200">
            <input
              type="checkbox"
              checked={dncFlorida}
              onChange={(event) => setDncFlorida(event.target.checked)}
              className="mt-0.5"
            />
            Client is registered on the Florida DNC
          </label>
          <p className="text-xs text-zinc-400 dark:text-zinc-500">
            Tick only after checking the registry. Left unchecked, DNC status is
            treated as unverified.
          </p>
        </fieldset>

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
