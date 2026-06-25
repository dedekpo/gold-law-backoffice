"use client";

import {
  Fragment,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { amrToWavBlob, isAmr } from "@/lib/audio";

type RecorderStatus = "idle" | "recording";
type FileStatus = "processing" | "done" | "error";
type FileKind = "audio" | "image";
type EvaluationStatus = "idle" | "evaluating" | "done" | "error";
type DefendantStatus = "idle" | "identifying" | "done" | "error";

type CaseFile = {
  id: string;
  name: string;
  kind: FileKind;
  url: string;
  status: FileStatus;
  text?: string;
  error?: string;
};

type Evaluation = {
  score: number;
  category: string;
  message_type: string;
  needs_external_check: string[];
  reasoning: string;
};

// Official Secretary of State record (from OpenSOSData via the agent). Every
// field is optional because coverage varies by state; extra fields a state
// returns are preserved via the index signature and shown under "Additional
// details" so nothing in the enrichment is lost.
type SosEntity = {
  entityName?: string | null;
  entityType?: string | null;
  entityId?: string | null;
  status?: string | null;
  formationDate?: string | null;
  registeredAgentName?: string | null;
  registeredAgentAddress?: string | null;
  registeredAgentCity?: string | null;
  registeredAgentState?: string | null;
  registeredAgentZip?: string | null;
  principalAddress?: string | null;
  principalCity?: string | null;
  principalState?: string | null;
  principalZip?: string | null;
  mailingAddress?: string | null;
  mailingCity?: string | null;
  mailingState?: string | null;
  mailingZip?: string | null;
  officers?:
    | Array<{ name?: string | null; title?: string | null; address?: string | null }>
    | null;
  jurisdiction?: string | null;
  searchState?: string | null;
  feiEinNumber?: string | null;
  sosUrl?: string | null;
  scrapedAt?: string | null;
  [key: string]: unknown;
};

type RegisteredAgent = {
  name: string | null;
  address: string | null;
  state: string | null;
};

// Outcome of the mandatory Florida cross-lookup for a company. See the route.
type FlCheckStatus = "found" | "not_found" | "error" | "not_applicable";

type DefendantCandidate = {
  company_name: string;
  legal_name: string | null;
  website: string | null;
  goods_services: string | null;
  state_of_incorporation: string | null;
  hq_mailing_address: string | null;
  registered_agent: RegisteredAgent | null;
  employees_estimate: string | null;
  revenue_estimate: string | null;
  solvability_tier: "risk" | "good" | "whale" | "unknown";
  confidence: number;
  sources: string[];
  notes: string | null;
  // Every official record matched to this company: the home/domestic
  // registration plus any Florida foreign registration found by the cross-lookup.
  sos_records?: SosEntity[];
  // Outcome of the Florida cross-lookup, so the UI can show FL was checked.
  fl_check?: FlCheckStatus;
};

type DefendantReport = {
  candidates: DefendantCandidate[];
  search_terms_used: string[];
  sos_records?: SosEntity[];
  unmatched_sos_records?: SosEntity[];
  sos_error?: string;
};

type Case = {
  id: string;
  name: string;
  files: CaseFile[];
  evaluationStatus: EvaluationStatus;
  evaluation?: Evaluation;
  evaluationError?: string;
  defendantStatus: DefendantStatus;
  defendants?: DefendantCandidate[];
  defendantError?: string;
  defendantSosError?: string;
  defendantUnmatchedSos?: SosEntity[];
};

const PREFERRED_MIME_TYPES = [
  "audio/webm;codecs=opus",
  "audio/webm",
  "audio/ogg;codecs=opus",
  "audio/mp4",
];

function pickMimeType(): string | undefined {
  if (typeof MediaRecorder === "undefined") return undefined;
  return PREFERRED_MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type));
}

function formatCaseName(date: Date, suffix?: string): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
  return suffix ? `Case ${stamp} (${suffix})` : `Case ${stamp}`;
}

function detectKind(blob: Blob, name: string): FileKind | null {
  if (blob.type.startsWith("image/")) return "image";
  if (blob.type.startsWith("audio/")) return "audio";
  const lower = name.toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|svg|heic|heif|avif)$/.test(lower)) return "image";
  if (/\.(mp3|wav|ogg|m4a|aac|flac|webm|amr|3gp|opus)$/.test(lower)) return "audio";
  return null;
}

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random()}`;
}

/**
 * Read an image (from its object URL) back as base64 so the evaluator can view
 * the original screenshot directly. Returns null on failure so the caller can
 * fall back to the text description.
 */
async function imageDataFromUrl(
  url: string,
): Promise<{ data: string; mediaType: string } | null> {
  try {
    const blob = await fetch(url).then((r) => r.blob());
    const dataUrl = await new Promise<string>((resolve, reject) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result as string);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
    const comma = dataUrl.indexOf(",");
    const data = dataUrl.slice(comma + 1);
    const mediaType =
      dataUrl.slice(5, dataUrl.indexOf(";")) || blob.type || "image/png";
    return data ? { data, mediaType } : null;
  } catch {
    return null;
  }
}

const ENDPOINTS: Record<FileKind, string> = {
  audio: "/api/audio-transcription",
  image: "/api/image-description",
};

const CATEGORY_LABELS: Record<string, string> = {
  prerecorded_voicemail: "Pre-recorded voicemail",
  idnc_failure_to_stop: "Failure to stop (marketing)",
  idnc_debt_collection: "Failure to stop (debt collection)",
  quiet_hours: "Quiet hours (marketing)",
  quiet_hours_debt_collection: "Quiet hours (debt collection)",
  ndnc_federal: "National DNC (federal)",
  ndnc_florida: "Florida DNC",
  none: "No violation detected",
};

const MESSAGE_TYPE_LABELS: Record<string, string> = {
  marketing: "Marketing",
  debt_collection: "Debt collection",
  informational: "Informational",
  unknown: "Unknown",
};

function scoreTone(score: number) {
  if (score <= 2)
    return {
      chip: "bg-emerald-100 text-emerald-900 dark:bg-emerald-950 dark:text-emerald-200",
      ring: "ring-emerald-500/50",
      label: "Clear",
    };
  if (score <= 5)
    return {
      chip: "bg-amber-100 text-amber-900 dark:bg-amber-950 dark:text-amber-200",
      ring: "ring-amber-500/50",
      label: "Possible",
    };
  if (score <= 8)
    return {
      chip: "bg-orange-100 text-orange-900 dark:bg-orange-950 dark:text-orange-200",
      ring: "ring-orange-500/50",
      label: "Likely",
    };
  return {
    chip: "bg-red-100 text-red-900 dark:bg-red-950 dark:text-red-200",
    ring: "ring-red-500/50",
    label: "Violation",
  };
}

export default function Home() {
  const [status, setStatus] = useState<RecorderStatus>("idle");
  const [cases, setCases] = useState<Case[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<CaseFile | null>(null);

  const recorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const casesRef = useRef<Case[]>([]);
  const evaluatedRef = useRef<Set<string>>(new Set());
  const identifiedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    casesRef.current = cases;
  }, [cases]);

  useEffect(() => {
    return () => {
      casesRef.current.forEach((c) =>
        c.files.forEach((file) => URL.revokeObjectURL(file.url)),
      );
    };
  }, []);

  useEffect(() => {
    if (!openFile) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenFile(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [openFile]);

  const evaluateCase = useCallback(async (caseId: string) => {
    const c = casesRef.current.find((entry) => entry.id === caseId);
    if (!c) return;
    const successful = c.files.filter(
      (file) => file.status === "done" && file.text,
    );
    if (successful.length === 0) {
      setCases((prev) =>
        prev.map((entry) =>
          entry.id === caseId
            ? {
                ...entry,
                evaluationStatus: "error",
                evaluationError: "No files could be processed.",
              }
            : entry,
        ),
      );
      return;
    }

    setCases((prev) =>
      prev.map((entry) =>
        entry.id === caseId
          ? { ...entry, evaluationStatus: "evaluating" }
          : entry,
      ),
    );

    try {
      // For image files, attach the original bytes so the evaluator reads the
      // screenshot directly (native vision); audio stays as transcription text.
      const filesPayload = await Promise.all(
        successful.map(async (file) => {
          const base = { kind: file.kind, name: file.name, text: file.text! };
          if (file.kind === "image") {
            const image = await imageDataFromUrl(file.url);
            if (image) return { ...base, image };
          }
          return base;
        }),
      );

      const response = await fetch("/api/tcpa-evaluation", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: filesPayload }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(
          body?.error ?? `Evaluation failed: ${response.status}`,
        );
      }
      const evaluation = (await response.json()) as Evaluation;
      setCases((prev) =>
        prev.map((entry) =>
          entry.id === caseId
            ? { ...entry, evaluationStatus: "done", evaluation }
            : entry,
        ),
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Evaluation failed";
      setCases((prev) =>
        prev.map((entry) =>
          entry.id === caseId
            ? {
                ...entry,
                evaluationStatus: "error",
                evaluationError: message,
              }
            : entry,
        ),
      );
    }
  }, []);

  // Trigger evaluation once a case has no in-flight files.
  useEffect(() => {
    cases.forEach((c) => {
      if (evaluatedRef.current.has(c.id)) return;
      if (c.files.length === 0) return;
      const stillProcessing = c.files.some(
        (file) => file.status === "processing",
      );
      if (stillProcessing) return;
      evaluatedRef.current.add(c.id);
      evaluateCase(c.id);
    });
  }, [cases, evaluateCase]);

  const identifyDefendant = useCallback(async (caseId: string) => {
    const c = casesRef.current.find((entry) => entry.id === caseId);
    if (!c) return;
    const successful = c.files.filter(
      (file) => file.status === "done" && file.text,
    );
    if (successful.length === 0) return;

    setCases((prev) =>
      prev.map((entry) =>
        entry.id === caseId
          ? { ...entry, defendantStatus: "identifying" }
          : entry,
      ),
    );

    try {
      const response = await fetch("/api/defendant-identification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: successful.map((file) => ({
            kind: file.kind,
            name: file.name,
            text: file.text!,
          })),
          evaluation: c.evaluation
            ? {
                category: c.evaluation.category,
                message_type: c.evaluation.message_type,
                reasoning: c.evaluation.reasoning,
              }
            : undefined,
        }),
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(
          body?.error ?? `Identification failed: ${response.status}`,
        );
      }
      const report = (await response.json()) as DefendantReport;
      setCases((prev) =>
        prev.map((entry) =>
          entry.id === caseId
            ? {
                ...entry,
                defendantStatus: "done",
                defendants: report.candidates,
                defendantSosError: report.sos_error,
                defendantUnmatchedSos: report.unmatched_sos_records,
              }
            : entry,
        ),
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Identification failed";
      setCases((prev) =>
        prev.map((entry) =>
          entry.id === caseId
            ? { ...entry, defendantStatus: "error", defendantError: message }
            : entry,
        ),
      );
    }
  }, []);

  // Once a case has been evaluated, kick off defendant identification.
  useEffect(() => {
    cases.forEach((c) => {
      if (identifiedRef.current.has(c.id)) return;
      if (c.evaluationStatus !== "done") return;
      identifiedRef.current.add(c.id);
      identifyDefendant(c.id);
    });
  }, [cases, identifyDefendant]);

  async function processFile(caseId: string, file: CaseFile, raw: Blob) {
    try {
      const response = await fetch(ENDPOINTS[file.kind], {
        method: "POST",
        headers: { "Content-Type": raw.type || "application/octet-stream" },
        body: raw,
      });
      if (!response.ok) {
        const body = (await response.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(
          body?.error ?? `Request failed: ${response.status}`,
        );
      }
      const { text } = (await response.json()) as { text: string };
      setCases((prev) =>
        prev.map((entry) =>
          entry.id === caseId
            ? {
                ...entry,
                files: entry.files.map((f) =>
                  f.id === file.id ? { ...f, status: "done", text } : f,
                ),
              }
            : entry,
        ),
      );
    } catch (err) {
      const message =
        err instanceof Error
          ? err.message
          : file.kind === "audio"
            ? "Transcription failed"
            : "Description failed";
      setCases((prev) =>
        prev.map((entry) =>
          entry.id === caseId
            ? {
                ...entry,
                files: entry.files.map((f) =>
                  f.id === file.id ? { ...f, status: "error", error: message } : f,
                ),
              }
            : entry,
        ),
      );
    }
  }

  async function buildCaseFile(
    raw: Blob,
    name: string,
    kind: FileKind,
  ): Promise<{ file: CaseFile; raw: Blob }> {
    let playable = raw;
    if (kind === "audio" && isAmr(raw, name)) {
      try {
        playable = await amrToWavBlob(raw);
      } catch {
        // Fall back to the raw blob.
      }
    }
    const url = URL.createObjectURL(playable);
    return {
      file: { id: randomId(), name, kind, url, status: "processing" },
      raw,
    };
  }

  async function createCase(
    inputs: { blob: Blob; name: string; kind: FileKind }[],
    suffix?: string,
  ) {
    if (inputs.length === 0) return;
    const built = await Promise.all(
      inputs.map((input) => buildCaseFile(input.blob, input.name, input.kind)),
    );
    const caseId = randomId();
    const newCase: Case = {
      id: caseId,
      name: formatCaseName(new Date(), suffix),
      files: built.map((b) => b.file),
      evaluationStatus: "idle",
      defendantStatus: "idle",
    };
    setCases((prev) => [...prev, newCase]);
    built.forEach(({ file, raw }) => {
      void processFile(caseId, file, raw);
    });
  }

  async function startRecording() {
    setError(null);
    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      const mimeType = pickMimeType();
      const recorder = new MediaRecorder(
        stream,
        mimeType ? { mimeType } : undefined,
      );
      chunksRef.current = [];

      recorder.ondataavailable = (event) => {
        if (event.data.size > 0) chunksRef.current.push(event.data);
      };

      recorder.onstop = async () => {
        stream.getTracks().forEach((track) => track.stop());
        const blobType = recorder.mimeType || mimeType || "audio/webm";
        const blob = new Blob(chunksRef.current, { type: blobType });
        if (blob.size === 0) {
          setError("Recording was empty — try again and speak for at least a second.");
          return;
        }
        const now = new Date();
        const pad = (value: number) => String(value).padStart(2, "0");
        const name = `Recording ${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`;
        await createCase([{ blob, name, kind: "audio" }], "recording");
      };

      recorder.start(250);
      recorderRef.current = recorder;
      setStatus("recording");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not access microphone");
    }
  }

  function stopRecording() {
    recorderRef.current?.stop();
    recorderRef.current = null;
    setStatus("idle");
  }

  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files) return;
    const inputs = Array.from(files)
      .map((file) => {
        const kind = detectKind(file, file.name);
        return kind ? { blob: file, name: file.name, kind } : null;
      })
      .filter((value): value is { blob: File; name: string; kind: FileKind } => value !== null);
    void createCase(inputs);
    event.target.value = "";
  }

  return (
    <main className="flex flex-1 flex-col items-center gap-6 p-8">
      <div className="flex flex-col items-center gap-3">
        <button
          type="button"
          onClick={status === "recording" ? stopRecording : startRecording}
          className="rounded-full bg-black px-8 py-3 text-white transition-colors hover:bg-zinc-800 dark:bg-white dark:text-black dark:hover:bg-zinc-200"
        >
          {status === "recording" ? "Stop" : "Record"}
        </button>

        <label className="cursor-pointer rounded-full border border-zinc-300 px-6 py-2 text-sm transition-colors hover:bg-zinc-100 dark:border-zinc-700 dark:hover:bg-zinc-900">
          Upload audio or image files as a case
          <input
            type="file"
            accept="audio/*,image/*"
            multiple
            onChange={handleFiles}
            className="hidden"
          />
        </label>
      </div>

      {error && <p className="text-sm text-red-600">{error}</p>}

      {cases.length > 0 && <DefendantDropdown cases={cases} />}

      {cases.length > 0 && (
        <div className="flex w-full max-w-3xl flex-col gap-4">
          {cases.map((c) => (
            <CaseCard key={c.id} caseItem={c} onOpenFile={setOpenFile} />
          ))}
        </div>
      )}

      {openFile && (
        <FileModal file={openFile} onClose={() => setOpenFile(null)} />
      )}
    </main>
  );
}

function CaseCard({
  caseItem,
  onOpenFile,
}: {
  caseItem: Case;
  onOpenFile: (file: CaseFile) => void;
}) {
  const [open, setOpen] = useState(true);
  const fileCount = caseItem.files.length;
  const processingCount = caseItem.files.filter(
    (f) => f.status === "processing",
  ).length;
  const errorCount = caseItem.files.filter((f) => f.status === "error").length;

  return (
    <article className="relative overflow-hidden rounded-xl border border-zinc-200 bg-white text-zinc-900 shadow-sm dark:border-zinc-800 dark:bg-zinc-950 dark:text-zinc-100">
      <button
        type="button"
        onClick={() => setOpen((value) => !value)}
        className="flex w-full items-center justify-between gap-3 p-5 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900"
        aria-expanded={open}
      >
        <div className="flex flex-1 items-center gap-3">
          <ChevronIcon open={open} />
          <div className="flex flex-col gap-1">
            <h2 className="text-base font-semibold">{caseItem.name}</h2>
            <p className="text-xs text-zinc-500 dark:text-zinc-400">
              {fileCount} file{fileCount === 1 ? "" : "s"}
              {processingCount > 0 && ` · ${processingCount} processing`}
              {errorCount > 0 && ` · ${errorCount} failed`}
            </p>
          </div>
        </div>
        <ScoreBadge caseItem={caseItem} />
      </button>

      {open && (
        <div className="flex flex-col gap-5 border-t border-zinc-200 p-5 dark:border-zinc-800">
          <EvaluationPanel caseItem={caseItem} />

          <div>
            <p className="mb-2 text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              Files
            </p>
            <div className="grid grid-cols-3 gap-3 sm:grid-cols-4 md:grid-cols-5">
              {caseItem.files.map((file) => (
                <FileThumbnail
                  key={file.id}
                  file={file}
                  onClick={() => onOpenFile(file)}
                />
              ))}
            </div>
          </div>
        </div>
      )}
    </article>
  );
}

function ChevronIcon({ open }: { open: boolean }) {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2"
      strokeLinecap="round"
      strokeLinejoin="round"
      className={`h-4 w-4 shrink-0 text-zinc-500 transition-transform dark:text-zinc-400 ${
        open ? "rotate-90" : "rotate-0"
      }`}
      aria-hidden
    >
      <path d="m9 18 6-6-6-6" />
    </svg>
  );
}

function EvaluationPanel({ caseItem }: { caseItem: Case }) {
  if (caseItem.evaluationStatus === "evaluating") {
    return (
      <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
        Evaluating case against the TCPA rubric…
      </div>
    );
  }

  if (caseItem.evaluationStatus === "error") {
    return (
      <div className="rounded-lg border border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
        Evaluation failed: {caseItem.evaluationError ?? "unknown error"}
      </div>
    );
  }

  if (!caseItem.evaluation) {
    return (
      <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 text-sm text-zinc-600 dark:border-zinc-800 dark:bg-zinc-900 dark:text-zinc-400">
        Waiting for files to finish processing…
      </div>
    );
  }

  const tone = scoreTone(caseItem.evaluation.score);
  const categoryLabel =
    CATEGORY_LABELS[caseItem.evaluation.category] ??
    caseItem.evaluation.category;
  const messageLabel =
    MESSAGE_TYPE_LABELS[caseItem.evaluation.message_type] ??
    caseItem.evaluation.message_type;

  return (
    <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-4 dark:border-zinc-800 dark:bg-zinc-900">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          TCPA evaluation
        </span>
        <span
          className={`rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tone.chip}`}
        >
          {tone.label}
        </span>
      </div>

      <dl className="mt-3 grid grid-cols-[8rem_1fr] gap-x-4 gap-y-2 text-sm">
        <dt className="text-zinc-500 dark:text-zinc-400">Score</dt>
        <dd className="font-semibold text-zinc-900 dark:text-zinc-100">
          {caseItem.evaluation.score} / 10
        </dd>

        <dt className="text-zinc-500 dark:text-zinc-400">Category</dt>
        <dd className="text-zinc-900 dark:text-zinc-100">{categoryLabel}</dd>

        <dt className="text-zinc-500 dark:text-zinc-400">Message type</dt>
        <dd className="text-zinc-900 dark:text-zinc-100">{messageLabel}</dd>

        {caseItem.evaluation.needs_external_check.length > 0 && (
          <>
            <dt className="text-zinc-500 dark:text-zinc-400">Needs check</dt>
            <dd className="flex flex-wrap gap-1">
              {caseItem.evaluation.needs_external_check.map((token) => (
                <span
                  key={token}
                  className="rounded bg-zinc-200 px-1.5 py-0.5 text-[11px] text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
                >
                  {token}
                </span>
              ))}
            </dd>
          </>
        )}
      </dl>

      <div className="mt-4 border-t border-zinc-200 pt-3 dark:border-zinc-800">
        <p className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Reasoning
        </p>
        <p className="mt-1 text-sm leading-6 text-zinc-700 dark:text-zinc-200">
          {caseItem.evaluation.reasoning}
        </p>
      </div>
    </div>
  );
}

function FileThumbnail({
  file,
  onClick,
}: {
  file: CaseFile;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col items-stretch gap-1 text-left"
      title={file.name}
    >
      <div className="relative aspect-square overflow-hidden rounded-lg border border-zinc-200 bg-zinc-100 transition-shadow group-hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900">
        {file.kind === "image" ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={file.url}
            alt={file.name}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-linear-to-br from-blue-50 to-blue-100 text-blue-700 dark:from-blue-950 dark:to-blue-900 dark:text-blue-200">
            <SpeakerIcon />
            <span className="text-[10px] uppercase tracking-wide opacity-70">
              Audio
            </span>
          </div>
        )}

        {file.status === "processing" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/30 text-[10px] font-medium text-white">
            Processing…
          </div>
        )}
        {file.status === "error" && (
          <div className="absolute inset-0 flex items-center justify-center bg-red-500/40 text-[10px] font-medium text-white">
            Failed
          </div>
        )}
      </div>
      <span className="truncate text-[11px] text-zinc-600 dark:text-zinc-400">
        {file.name}
      </span>
    </button>
  );
}

function SpeakerIcon() {
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox="0 0 24 24"
      fill="currentColor"
      className="h-7 w-7"
      aria-hidden
    >
      <path d="M3 10v4a1 1 0 0 0 1 1h3l4 3.5a.5.5 0 0 0 .8-.4V5.9a.5.5 0 0 0-.8-.4L7 9H4a1 1 0 0 0-1 1Z" />
      <path d="M15.5 8.5a4 4 0 0 1 0 7" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
      <path d="M17.7 6a7 7 0 0 1 0 12" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" />
    </svg>
  );
}

function ScoreBadge({ caseItem }: { caseItem: Case }) {
  const allDone = caseItem.files.every((f) => f.status !== "processing");

  if (!allDone) {
    return (
      <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
        Waiting for files…
      </span>
    );
  }

  if (caseItem.evaluationStatus === "evaluating") {
    return (
      <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
        Evaluating…
      </span>
    );
  }

  if (caseItem.evaluationStatus === "error") {
    return (
      <span
        className="rounded-full bg-red-100 px-3 py-1 text-xs text-red-700 dark:bg-red-950 dark:text-red-300"
        title={caseItem.evaluationError ?? undefined}
      >
        Eval failed
      </span>
    );
  }

  if (!caseItem.evaluation) return null;

  const tone = scoreTone(caseItem.evaluation.score);

  return (
    <span
      className={`flex shrink-0 items-center gap-2 rounded-full px-3 py-1 text-xs font-medium ring-1 ${tone.chip} ${tone.ring}`}
    >
      <span className="text-sm font-bold leading-none">
        {caseItem.evaluation.score}
      </span>
      <span className="opacity-70">/ 10</span>
      <span className="hidden text-[10px] uppercase tracking-wide opacity-80 sm:inline">
        {tone.label}
      </span>
    </span>
  );
}

const SOLVABILITY_LABELS: Record<DefendantCandidate["solvability_tier"], string> =
  {
    risk: "⚠️ Small (risk)",
    good: "✅ Solid target",
    whale: "💰 Whale",
    unknown: "Unknown size",
  };

type AggregatedCandidate = {
  caseId: string;
  caseName: string;
  candidate: DefendantCandidate;
};

function DefendantDropdown({ cases }: { cases: Case[] }) {
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);

  const candidates: AggregatedCandidate[] = cases.flatMap((c) =>
    (c.defendants ?? []).map((candidate) => ({
      caseId: c.id,
      caseName: c.name,
      candidate,
    })),
  );

  const identifying = cases.some((c) => c.defendantStatus === "identifying");
  const anyDone = cases.some((c) => c.defendantStatus === "done");
  const errors = cases
    .filter((c) => c.defendantStatus === "error")
    .map((c) => ({ name: c.name, message: c.defendantError ?? "Unknown error" }));
  const sosErrors = cases
    .map((c) => c.defendantSosError)
    .filter((m): m is string => Boolean(m));
  const unmatched = cases.flatMap((c) => c.defendantUnmatchedSos ?? []);

  const selectedEntry =
    candidates.find(
      (entry) => `${entry.caseId}:${entry.candidate.company_name}` === selected,
    ) ?? null;

  return (
    <div className="w-full max-w-3xl">
      <div className="overflow-hidden rounded-xl border border-zinc-200 bg-white shadow-sm dark:border-zinc-800 dark:bg-zinc-950">
        <button
          type="button"
          onClick={() => setOpen((value) => !value)}
          className="flex w-full items-center justify-between gap-3 p-4 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900"
          aria-expanded={open}
        >
          <div className="flex items-center gap-3">
            <ChevronIcon open={open} />
            <div className="flex flex-col">
              <span className="text-sm font-semibold text-zinc-900 dark:text-zinc-100">
                Identified companies
              </span>
              <span className="text-xs text-zinc-500 dark:text-zinc-400">
                {identifying
                  ? "Investigating & checking Secretary of State records…"
                  : candidates.length > 0
                    ? `${candidates.length} candidate${candidates.length === 1 ? "" : "s"} found`
                    : errors.length > 0
                      ? "Identification failed"
                      : anyDone
                        ? "No companies identified"
                        : "Waiting for evaluation…"}
              </span>
            </div>
          </div>
          {identifying && (
            <span className="rounded-full bg-zinc-100 px-3 py-1 text-xs text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400">
              Searching…
            </span>
          )}
        </button>

        {open && (
          <div className="border-t border-zinc-200 dark:border-zinc-800">
            {errors.length > 0 && (
              <div className="border-b border-red-200 bg-red-50 p-4 text-sm text-red-700 dark:border-red-900 dark:bg-red-950 dark:text-red-300">
                {errors.map((e) => (
                  <p key={e.name}>
                    <span className="font-medium">{e.name}:</span> {e.message}
                  </p>
                ))}
              </div>
            )}
            {sosErrors.length > 0 && (
              <div className="border-b border-amber-200 bg-amber-50 p-4 text-sm text-amber-800 dark:border-amber-900 dark:bg-amber-950 dark:text-amber-200">
                Secretary of State lookup did not complete: {sosErrors[0]}
              </div>
            )}
            {candidates.length === 0 ? (
              <p className="p-4 text-sm text-zinc-500 dark:text-zinc-400">
                {identifying
                  ? "The agent is searching the web and the Secretary of State registries for the company behind this case…"
                  : errors.length > 0
                    ? "Identification could not be completed — see the error above."
                    : "No companies have been identified yet."}
              </p>
            ) : (
              <ul className="divide-y divide-zinc-200 dark:divide-zinc-800">
                {candidates.map((entry) => {
                  const key = `${entry.caseId}:${entry.candidate.company_name}`;
                  const isOpen = selected === key;
                  return (
                    <li key={key}>
                      <button
                        type="button"
                        onClick={() => setSelected(isOpen ? null : key)}
                        className="flex w-full items-center justify-between gap-3 px-4 py-3 text-left transition-colors hover:bg-zinc-50 dark:hover:bg-zinc-900"
                      >
                        <div className="flex flex-col">
                          <span className="flex items-center gap-2 text-sm font-medium text-zinc-900 dark:text-zinc-100">
                            {entry.candidate.company_name}
                            {(entry.candidate.sos_records?.length ?? 0) > 0 && (
                              <span className="rounded-full bg-emerald-100 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wide text-emerald-800 dark:bg-emerald-950 dark:text-emerald-200">
                                SOS verified
                              </span>
                            )}
                          </span>
                          <span className="text-xs text-zinc-500 dark:text-zinc-400">
                            {entry.candidate.goods_services ?? "—"} ·{" "}
                            {SOLVABILITY_LABELS[entry.candidate.solvability_tier]}
                          </span>
                        </div>
                        <span className="shrink-0 text-xs text-zinc-400 dark:text-zinc-500">
                          {Math.round(entry.candidate.confidence * 100)}%
                        </span>
                      </button>
                      {isOpen && selectedEntry && (
                        <CandidateDetail entry={selectedEntry} />
                      )}
                    </li>
                  );
                })}
              </ul>
            )}
            {unmatched.length > 0 && (
              <div className="border-t border-zinc-200 p-4 dark:border-zinc-800">
                <p className="mb-2 text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
                  Additional official records found
                </p>
                <div className="flex flex-col gap-3">
                  {unmatched.map((entity, i) => (
                    <SosRecordPanel
                      key={`${entity.entityId ?? entity.entityName ?? "rec"}-${i}`}
                      sos={entity}
                      label={recordLabel(entity)}
                    />
                  ))}
                </div>
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function CandidateDetail({ entry }: { entry: AggregatedCandidate }) {
  const c = entry.candidate;
  const records = c.sos_records ?? [];
  // The record whose registered agent the firm should serve: prefer the Florida
  // agent, otherwise fall back to the (home) state-of-formation record.
  const serviceRecord =
    records.find((rec) => isFloridaRecord(rec)) ?? records[0] ?? null;
  const agent = c.registered_agent;
  const agentDisplay =
    agent && (agent.name || agent.address || agent.state)
      ? [agent.name, agent.address, agent.state].filter(Boolean).join(" · ")
      : null;
  const rows: [string, string | null][] = [
    ["Legal name", c.legal_name],
    ["Website", c.website],
    ["Goods / services", c.goods_services],
    ["State of incorporation", c.state_of_incorporation],
    ["HQ mailing address", c.hq_mailing_address],
    ["Registered agent", agentDisplay],
    ["Employees", c.employees_estimate],
    ["Revenue", c.revenue_estimate],
    ["Solvability", SOLVABILITY_LABELS[c.solvability_tier]],
    ["From case", entry.caseName],
  ];

  return (
    <div className="border-t border-zinc-200 bg-zinc-50 px-4 py-4 dark:border-zinc-800 dark:bg-zinc-900">
      <dl className="grid grid-cols-[10rem_1fr] gap-x-4 gap-y-2 text-sm">
        {rows.map(([label, value]) => (
          <Fragment key={label}>
            <dt className="text-zinc-500 dark:text-zinc-400">{label}</dt>
            <dd className="break-words text-zinc-900 dark:text-zinc-100">
              {label === "Website" && value ? (
                <a
                  href={value}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 underline dark:text-blue-400"
                >
                  {value}
                </a>
              ) : (
                value ?? "—"
              )}
            </dd>
          </Fragment>
        ))}
      </dl>

      <div className="mt-4 border-t border-zinc-200 pt-4 dark:border-zinc-800">
        <p className="mb-2 text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
          Official records (Secretary of State)
        </p>
        {records.length > 0 ? (
          <div className="flex flex-col gap-3">
            {records.map((rec, i) => (
              <SosRecordPanel
                key={`${rec.entityId ?? rec.entityName ?? "rec"}-${rec.searchState ?? ""}-${i}`}
                sos={rec}
                label={recordLabel(rec)}
                // Flag the agent to serve only when there's an actual choice
                // (home vs. Florida) — the firm prefers the Florida agent.
                preferredAgent={records.length > 1 && rec === serviceRecord}
              />
            ))}
          </div>
        ) : (
          <p className="text-sm text-zinc-500 dark:text-zinc-400">
            No matching Secretary of State record was found for this entity.
          </p>
        )}
        {c.fl_check === "not_found" && (
          <p className="mt-2 text-xs text-zinc-500 dark:text-zinc-400">
            No Florida registration on file — Sunbiz was checked for a Florida
            foreign registration and none was found.
          </p>
        )}
        {c.fl_check === "error" && (
          <p className="mt-2 rounded-md bg-amber-50 px-3 py-2 text-xs text-amber-800 dark:bg-amber-950 dark:text-amber-200">
            Florida check didn&apos;t complete — retry to capture any Florida
            registered agent (preferred for service).
          </p>
        )}
      </div>

      {c.notes && (
        <p className="mt-3 border-t border-zinc-200 pt-3 text-sm text-zinc-700 dark:border-zinc-800 dark:text-zinc-300">
          {c.notes}
        </p>
      )}

      {c.sources.length > 0 && (
        <div className="mt-3 border-t border-zinc-200 pt-3 dark:border-zinc-800">
          <p className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
            Sources
          </p>
          <ul className="mt-1 flex flex-col gap-1">
            {c.sources.map((src) => (
              <li key={src}>
                <a
                  href={src}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="break-all text-xs text-blue-600 underline dark:text-blue-400"
                >
                  {src}
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

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

function joinAddress(
  parts: Array<string | null | undefined>,
): string | null {
  const cleaned = parts.map((p) => (p ?? "").trim()).filter(Boolean);
  return cleaned.length ? cleaned.join(", ") : null;
}

function humanizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_-]+/g, " ")
    .replace(/^./, (c) => c.toUpperCase());
}

/** True when this record came from the Florida registry. */
function isFloridaRecord(sos: SosEntity): boolean {
  return (sos.searchState ?? "").toUpperCase() === "FL";
}

/**
 * A short heading for one official record: the home/domestic registration vs. a
 * Florida foreign registration (a company incorporated elsewhere but registered
 * to do business in Florida — the firm's preferred place to serve).
 */
function recordLabel(sos: SosEntity): string {
  const searchState = (sos.searchState ?? "").toUpperCase();
  if (searchState === "FL") {
    const home = String(sos.jurisdiction ?? "").toUpperCase();
    const foreign = home && home !== "FL" && !home.includes("FLORIDA");
    return foreign ? "Florida registration (foreign)" : "Florida registration";
  }
  return searchState
    ? `Home registration (${searchState})`
    : "Home registration";
}

/** Renders an authoritative Secretary of State entity record in full. */
function SosRecordPanel({
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
                {[officer.title, officer.name].filter(Boolean).join(" — ") ||
                  "—"}
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

function FileModal({
  file,
  onClose,
}: {
  file: CaseFile;
  onClose: () => void;
}) {
  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative flex max-h-[90vh] w-full max-w-4xl flex-col gap-4 overflow-hidden rounded-xl bg-white p-5 text-zinc-900 shadow-2xl dark:bg-zinc-950 dark:text-zinc-100"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold break-all">{file.name}</h3>
            <p className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              {file.kind}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-zinc-100 px-3 py-1 text-sm text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-lg bg-zinc-50 p-3 dark:bg-zinc-900">
          {file.kind === "image" ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={file.url}
              alt={file.name}
              className="block h-auto w-auto max-w-full rounded object-contain"
              style={{ maxHeight: "70vh" }}
            />
          ) : (
            <audio controls src={file.url} className="w-full" />
          )}
        </div>

        {file.status === "processing" && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {file.kind === "audio" ? "Transcribing…" : "Describing…"}
          </p>
        )}
        {file.status === "error" && (
          <p className="text-xs text-red-600">{file.error}</p>
        )}
        {file.status === "done" && file.text && (
          <div className="overflow-auto">
            <p className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              {file.kind === "audio" ? "Transcription" : "Description"}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-zinc-800 dark:text-zinc-200">
              {file.text}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
