"use client";

import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { detectKind } from "@/lib/file-kind";
import {
  downloadImportFiles,
  importMeta,
  importOpportunity,
  type ImportResponse,
  type NewCaseInput,
  type NewCaseMeta,
} from "@/lib/opportunity-import-client";
import { Btn, ErrorNote, inputCls } from "@/components/investigation/ui";

type Source = "ghl" | "upload";

/**
 * The optional intake paths of the AI desk: a pasted GHL opportunity URL, or
 * a manual file upload for evidence that isn't on an opportunity — those
 * cases have no contact number, so their DNC status stays unverified (Screen
 * 04 handles that) and no report is written back to GHL. The default path —
 * the Ready-for-AI queue — doesn't come through here.
 */

function ModalShell({
  onDismiss,
  children,
}: {
  /** Called on overlay click / Escape; a no-op while a mutation runs. */
  onDismiss: () => void;
  children: React.ReactNode;
}) {
  const dismissRef = useRef(onDismiss);
  useEffect(() => {
    dismissRef.current = onDismiss;
  }, [onDismiss]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") dismissRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm"
      onClick={onDismiss}
    >
      <div
        className="flex w-full max-w-md flex-col gap-5 rounded-xs border border-rule-strong bg-card p-6 font-sans shadow-xl"
        onClick={(event) => event.stopPropagation()}
      >
        {children}
      </div>
    </div>
  );
}

/**
 * Confirmation before re-running the agent on an opportunity whose "AI Run
 * Status" field shows a previous run. Shared by the modal and the queue.
 */
export function RerunDialog({
  status,
  busy,
  error,
  onCancel,
  onConfirm,
}: {
  status: string | null;
  busy: boolean;
  error: string | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  return (
    <ModalShell onDismiss={() => !busy && onCancel()}>
      <h2 className="font-serif text-lg font-semibold text-ink">
        Run the agent again?
      </h2>
      <p className="text-sm leading-6 text-soft">
        The agent already searched for this opportunity
        {status ? ` (${status})` : ""}. Re-running overwrites the AI Intake
        fields and the saved report PDF.
      </p>
      {error && <ErrorNote>{error}</ErrorNote>}
      <div className="flex justify-end gap-2">
        <Btn onClick={onCancel} disabled={busy}>
          No, keep the run
        </Btn>
        <Btn variant="primary" onClick={onConfirm} disabled={busy}>
          {busy ? "Fetching evidence…" : "Yes, run again"}
        </Btn>
      </div>
    </ModalShell>
  );
}

export function NewCaseModal({
  onClose,
  onCreate,
}: {
  onClose: () => void;
  onCreate: (inputs: NewCaseInput[], meta: NewCaseMeta) => void;
}) {
  const [source, setSource] = useState<Source>("ghl");
  const [url, setUrl] = useState("");
  const [files, setFiles] = useState<File[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // Import held for confirmation because the agent already ran (a report note
  // exists on the opportunity). The user decides whether to run again.
  const [pendingImport, setPendingImport] = useState<ImportResponse | null>(
    null,
  );

  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    setError(null);
    setFiles(Array.from(event.target.files ?? []));
  }

  /** Download an import's evidence and hand the case off to the pipeline. */
  async function launchImport(data: ImportResponse) {
    const inputs = await downloadImportFiles(data);
    onCreate(inputs, importMeta(data));
    onClose();
  }

  async function start() {
    setError(null);
    setBusy(true);
    try {
      if (source === "upload") {
        // Manual evidence: no opportunity, so no automated DNC lookup — the
        // case runs with DNC unverified and nothing is written back to GHL.
        const inputs = files
          .map((file) => {
            const kind = detectKind(file.type, file.name);
            return kind ? { blob: file as Blob, name: file.name, kind } : null;
          })
          .filter((input): input is NewCaseInput => input !== null);
        if (inputs.length === 0) {
          throw new Error("None of the selected files are audio or images.");
        }
        onCreate(inputs, {});
        onClose();
        return;
      }
      const data = await importOpportunity({ url: url.trim() });
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
      setBusy(false);
    }
  }

  async function confirmRerun() {
    if (!pendingImport) return;
    setError(null);
    setBusy(true);
    try {
      await launchImport(pendingImport);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not start the case.");
    } finally {
      setBusy(false);
    }
  }

  if (pendingImport) {
    return (
      <RerunDialog
        status={pendingImport.existingRun?.status ?? null}
        busy={busy}
        error={error}
        onCancel={() => {
          setPendingImport(null);
          setError(null);
        }}
        onConfirm={() => void confirmRerun()}
      />
    );
  }

  const canStart =
    !busy && (source === "upload" ? files.length > 0 : url.trim().length > 0);

  return (
    <ModalShell onDismiss={() => !busy && onClose()}>
      <div className="flex flex-col gap-1">
        <p className="font-mono text-[10px] tracking-[0.18em] text-stamp uppercase">
          AI desk · Outside the queue
        </p>
        <h2 className="font-serif text-lg font-semibold text-ink">New case</h2>
      </div>

      <div className="grid grid-cols-2 gap-2">
        {(
          [
            ["ghl", "GHL opportunity"],
            ["upload", "Upload files"],
          ] as const
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => {
              setSource(value);
              setError(null);
            }}
            className={`rounded-xs border px-3 py-2 text-sm font-medium transition-colors ${
              source === value
                ? "border-ink bg-ink text-paper"
                : "border-rule-strong text-soft hover:bg-wash"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {source === "ghl" ? (
        <div className="flex flex-col gap-1.5">
          <input
            type="url"
            value={url}
            onChange={(event) => {
              setUrl(event.target.value);
              setError(null);
            }}
            placeholder="https://login.amicus-pro.com/v2/location/…/opportunities/…"
            className={`${inputCls} w-full font-mono`}
          />
          <p className="text-xs leading-5 text-soft">
            Evidence is pulled from the opportunity&rsquo;s Violation
            Screenshots and Violation Audio Files fields. The client&rsquo;s
            number is checked against the National and Florida DNC registries
            automatically.
          </p>
        </div>
      ) : (
        <div className="flex flex-col gap-1.5">
          <label className="flex cursor-pointer flex-col items-center gap-1 rounded-xs border border-dashed border-rule-strong px-4 py-6 text-center text-sm text-ink transition-colors hover:bg-wash">
            {files.length > 0
              ? `${files.length} file${files.length === 1 ? "" : "s"} selected`
              : "Choose audio or image files"}
            <span className="text-xs text-faint">
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
          <p className="text-xs leading-5 text-soft">
            Without an opportunity there is no contact number to look up, so
            DNC status stays unverified and no report is saved back to GHL.
          </p>
        </div>
      )}

      {error && <ErrorNote>{error}</ErrorNote>}

      <div className="flex justify-end gap-2">
        <Btn onClick={onClose} disabled={busy}>
          Cancel
        </Btn>
        <Btn variant="primary" onClick={() => void start()} disabled={!canStart}>
          {busy ? "Fetching evidence…" : "Start case"}
        </Btn>
      </div>
    </ModalShell>
  );
}
