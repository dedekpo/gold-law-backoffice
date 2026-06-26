"use client";

import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ChangeEvent,
} from "react";
import { amrToWavBlob, isAmr } from "@/lib/audio";
import { formatCaseName } from "@/lib/display";
import type {
  Case,
  CaseFile,
  DefendantReport,
  Evaluation,
  FileKind,
} from "@/lib/types";
import { CaseSidebar } from "@/components/case-sidebar";
import { CaseDetail } from "@/components/case-detail";
import { FileModal } from "@/components/evidence";

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

export default function Home() {
  const [cases, setCases] = useState<Case[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<CaseFile | null>(null);

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
                completedAt: Date.now(),
              }
            : entry,
        ),
      );
      return;
    }

    setCases((prev) =>
      prev.map((entry) =>
        entry.id === caseId ? { ...entry, evaluationStatus: "evaluating" } : entry,
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
        throw new Error(body?.error ?? `Evaluation failed: ${response.status}`);
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
      const message = err instanceof Error ? err.message : "Evaluation failed";
      setCases((prev) =>
        prev.map((entry) =>
          entry.id === caseId
            ? {
                ...entry,
                evaluationStatus: "error",
                evaluationError: message,
                completedAt: Date.now(),
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
      const stillProcessing = c.files.some((file) => file.status === "processing");
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
        entry.id === caseId ? { ...entry, defendantStatus: "identifying" } : entry,
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
                completedAt: Date.now(),
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
            ? {
                ...entry,
                defendantStatus: "error",
                defendantError: message,
                completedAt: Date.now(),
              }
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
        throw new Error(body?.error ?? `Request failed: ${response.status}`);
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
  ) {
    if (inputs.length === 0) return;
    const built = await Promise.all(
      inputs.map((input) => buildCaseFile(input.blob, input.name, input.kind)),
    );
    const caseId = randomId();
    const newCase: Case = {
      id: caseId,
      name: formatCaseName(new Date()),
      createdAt: Date.now(),
      files: built.map((b) => b.file),
      evaluationStatus: "idle",
      defendantStatus: "idle",
    };
    setCases((prev) => [...prev, newCase]);
    setSelectedCaseId(caseId);
    built.forEach(({ file, raw }) => {
      void processFile(caseId, file, raw);
    });
  }

  function handleFiles(event: ChangeEvent<HTMLInputElement>) {
    const files = event.target.files;
    if (!files) return;
    const inputs = Array.from(files)
      .map((file) => {
        const kind = detectKind(file, file.name);
        return kind ? { blob: file, name: file.name, kind } : null;
      })
      .filter(
        (value): value is { blob: File; name: string; kind: FileKind } =>
          value !== null,
      );
    void createCase(inputs);
    event.target.value = "";
  }

  const selectedCase = cases.find((c) => c.id === selectedCaseId) ?? null;

  return (
    <main className="flex min-h-0 flex-1">
      <CaseSidebar
        cases={cases}
        selectedCaseId={selectedCaseId}
        onSelect={setSelectedCaseId}
        onUpload={handleFiles}
      />

      {selectedCase ? (
        <CaseDetail caseItem={selectedCase} onOpenFile={setOpenFile} />
      ) : (
        <div className="flex flex-1 items-center justify-center p-8 text-center">
          <p className="max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
            Upload audio or image files to open a case. Each case is evaluated
            against the TCPA rubric, then investigated to identify the company
            behind it.
          </p>
        </div>
      )}

      {openFile && (
        <FileModal file={openFile} onClose={() => setOpenFile(null)} />
      )}
    </main>
  );
}
