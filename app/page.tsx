"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { amrToWavBlob, isAmr } from "@/lib/audio";
import { formatCaseName } from "@/lib/display";
import { buildCaseManifest, caseSummaryText } from "@/lib/export";
import { buildAiFieldValues } from "@/lib/opportunity-fields";
import { buildReportPdf } from "@/lib/report-pdf";
import type {
  AudioForensics,
  Case,
  CaseFile,
  DefendantReport,
  EvidenceFacts,
  FileKind,
  IntakeGate,
} from "@/lib/types";
import { CaseSidebar } from "@/components/case-sidebar";
import { CaseDetail } from "@/components/case-detail";
import { FileModal } from "@/components/evidence";
import {
  NewCaseModal,
  type NewCaseInput,
  type NewCaseMeta,
} from "@/components/new-case-modal";

function randomId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random()}`;
}

/**
 * Read a file (from its object URL) back as base64 so it can be sent to a model
 * directly — the original screenshot for the evaluator, or the audio bytes for
 * forensic analysis. Returns null on failure so the caller can fall back.
 */
async function dataFromUrl(
  url: string,
  fallbackType: string,
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
      dataUrl.slice(5, dataUrl.indexOf(";")) || blob.type || fallbackType;
    return data ? { data, mediaType } : null;
  } catch {
    return null;
  }
}

/** Immutably patch a single file inside a case. */
function patchFile(
  cases: Case[],
  caseId: string,
  fileId: string,
  patch: Partial<CaseFile>,
): Case[] {
  return cases.map((entry) =>
    entry.id === caseId
      ? {
          ...entry,
          files: entry.files.map((f) =>
            f.id === fileId ? { ...f, ...patch } : f,
          ),
        }
      : entry,
  );
}

const ENDPOINTS: Record<FileKind, string> = {
  audio: "/api/audio-transcription",
  image: "/api/image-description",
};

// Screening and defendant identification run as background jobs we poll for.
// Polling every few seconds keeps each request short (so a proxy can't time it
// out), and we tolerate a run of failed polls before giving up so a transient
// network/proxy blip doesn't abandon a job that is still running on the server.
const JOB_POLL_INTERVAL_MS = 3000;
const JOB_MAX_POLL_FAILURES = 10;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Poll a background-job endpoint (whose POST returned { jobId }) until the job
// reaches a terminal state, and return the "done" payload. A failed poll
// (dropped connection, a brief 5xx from the proxy) is retried rather than
// treated as failure, so a still-running job is never abandoned; only a 404
// (job expired server-side) or a sustained run of failures gives up.
async function pollJob<TDone>(
  endpoint: string,
  jobId: string,
  messages: {
    expiredMessage: string;
    lostMessage: string;
    failedMessage: string;
  },
): Promise<TDone> {
  let pollFailures = 0;
  while (true) {
    await sleep(JOB_POLL_INTERVAL_MS);

    let pollRes: Response;
    try {
      pollRes = await fetch(`${endpoint}?jobId=${encodeURIComponent(jobId)}`);
    } catch {
      if (++pollFailures > JOB_MAX_POLL_FAILURES) {
        throw new Error(messages.lostMessage);
      }
      continue;
    }

    if (pollRes.status === 404) {
      throw new Error(messages.expiredMessage);
    }
    if (!pollRes.ok) {
      // Transient proxy/server error — retry on the next tick.
      if (++pollFailures > JOB_MAX_POLL_FAILURES) {
        throw new Error(messages.lostMessage);
      }
      continue;
    }

    pollFailures = 0;
    const data = (await pollRes.json().catch(() => null)) as
      | { status: "running" }
      | ({ status: "done" } & TDone)
      | { status: "error"; error?: string }
      | null;

    if (!data || data.status === "running") continue;
    if (data.status === "error") {
      throw new Error(data.error ?? messages.failedMessage);
    }
    return data;
  }
}

// Bound how many transcription/forensics requests are in flight to the server at
// once. Each is a held HTTP request, so a big upload (e.g. 28 files → ~56 calls)
// fired all at once makes later requests sit in the server's rate-limit queue
// long enough for a platform proxy to cut them with a 502. A small client gate
// keeps every request short by never over-queuing the server.
const MAX_CONCURRENT_MEDIA_REQUESTS = 4;

function createLimiter(max: number) {
  let active = 0;
  const waiters: Array<() => void> = [];
  return async function limit<T>(task: () => Promise<T>): Promise<T> {
    if (active >= max) {
      await new Promise<void>((resolve) => waiters.push(resolve));
    }
    active++;
    try {
      return await task();
    } finally {
      active--;
      waiters.shift()?.();
    }
  };
}

const mediaLimiter = createLimiter(MAX_CONCURRENT_MEDIA_REQUESTS);

export default function Home() {
  const [cases, setCases] = useState<Case[]>([]);
  const [selectedCaseId, setSelectedCaseId] = useState<string | null>(null);
  const [openFile, setOpenFile] = useState<CaseFile | null>(null);
  const [showNewCase, setShowNewCase] = useState(false);

  const casesRef = useRef<Case[]>([]);
  const extractedRef = useRef<Set<string>>(new Set());
  const identifiedRef = useRef<Set<string>>(new Set());
  const forensicsRef = useRef<Set<string>>(new Set());
  const reportedRef = useRef<Set<string>>(new Set());

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

  // Extract normalized facts from the evidence, then run the intake gate (SOL +
  // plausible-claim). Replaces the old per-batch 0–10 evaluation. A declined
  // intake is terminal and never reaches defendant identification.
  const extractCase = useCallback(async (caseId: string) => {
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
                screeningStatus: "error",
                screeningError: "No files could be processed.",
                completedAt: Date.now(),
              }
            : entry,
        ),
      );
      return;
    }

    setCases((prev) =>
      prev.map((entry) =>
        entry.id === caseId ? { ...entry, screeningStatus: "evaluating" } : entry,
      ),
    );

    try {
      // Images: attach the original bytes for native vision. Audio: pass the
      // forensic hint when it's already in, so isPrerecorded is grounded.
      const filesPayload = await Promise.all(
        successful.map(async (file) => {
          const base: {
            kind: FileKind;
            name: string;
            text: string;
            image?: { data: string; mediaType: string };
            forensics?: {
              is_likely_prerecorded: boolean;
              automated_likelihood: number;
            };
          } = { kind: file.kind, name: file.name, text: file.text! };
          if (file.kind === "image") {
            const image = await dataFromUrl(file.url, "image/png");
            if (image) base.image = image;
          } else if (file.forensics) {
            base.forensics = {
              is_likely_prerecorded: file.forensics.is_likely_prerecorded,
              automated_likelihood: file.forensics.automated_likelihood,
            };
          }
          return base;
        }),
      );

      // Start the extraction as a background job. The POST returns a job id in
      // well under a second, so a proxy timeout can't cut it — a large batch
      // previously held this request past Railway's 5-minute limit and
      // surfaced as a silent "Screening failed: 502".
      const startRes = await fetch("/api/extract-screen", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ files: filesPayload }),
      });
      if (!startRes.ok) {
        const body = (await startRes.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error ?? `Screening failed: ${startRes.status}`);
      }
      const { jobId } = (await startRes.json()) as { jobId: string };
      const { facts, gate } = await pollJob<{
        facts: EvidenceFacts;
        gate: IntakeGate;
      }>("/api/extract-screen", jobId, {
        expiredMessage: "Screening expired on the server. Please run it again.",
        lostMessage: "Lost connection while screening the evidence.",
        failedMessage: "Screening failed",
      });
      setCases((prev) =>
        prev.map((entry) =>
          entry.id === caseId
            ? {
                ...entry,
                screeningStatus: "done",
                facts,
                gate,
                // Declined at the gate → terminal; no identification will run.
                completedAt: gate.declined ? Date.now() : entry.completedAt,
              }
            : entry,
        ),
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : "Screening failed";
      setCases((prev) =>
        prev.map((entry) =>
          entry.id === caseId
            ? {
                ...entry,
                screeningStatus: "error",
                screeningError: message,
                completedAt: Date.now(),
              }
            : entry,
        ),
      );
    }
  }, []);

  // Trigger extraction + gate once a case has no in-flight files.
  useEffect(() => {
    cases.forEach((c) => {
      if (extractedRef.current.has(c.id)) return;
      if (c.files.length === 0) return;
      const stillProcessing = c.files.some((file) => file.status === "processing");
      if (stillProcessing) return;
      extractedRef.current.add(c.id);
      extractCase(c.id);
    });
  }, [cases, extractCase]);

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
      // Start the investigation as a background job. This POST returns a job id
      // in well under a second, so it can't be cut by a proxy timeout.
      const startRes = await fetch("/api/defendant-identification", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          files: successful.map((file) => ({
            kind: file.kind,
            name: file.name,
            text: file.text!,
            forensics: file.forensics
              ? {
                  is_likely_prerecorded: file.forensics.is_likely_prerecorded,
                  automated_likelihood: file.forensics.automated_likelihood,
                }
              : undefined,
          })),
          // Normalized facts from the extraction pass, used to screen + score
          // each identified company.
          facts: c.facts,
          // Operator-attested DNC registrations from case creation (Screen 04).
          dnc: c.dnc,
        }),
      });
      if (!startRes.ok) {
        const body = (await startRes.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(
          body?.error ?? `Identification failed: ${startRes.status}`,
        );
      }
      const { jobId } = (await startRes.json()) as { jobId: string };
      setCases((prev) =>
        prev.map((entry) =>
          entry.id === caseId ? { ...entry, defendantJobId: jobId } : entry,
        ),
      );

      const { report: finalReport } = await pollJob<{
        report: DefendantReport;
      }>("/api/defendant-identification", jobId, {
        expiredMessage:
          "Investigation expired on the server. Please run it again.",
        lostMessage: "Lost connection while identifying the company.",
        failedMessage: "Identification failed",
      });
      setCases((prev) =>
        prev.map((entry) =>
          entry.id === caseId
            ? {
                ...entry,
                defendantStatus: "done",
                defendants: finalReport.candidates,
                defendantSosError: finalReport.sos_error,
                defendantUnmatchedSos: finalReport.unmatched_sos_records,
                defendantSearchTerms: finalReport.search_terms_used,
                defendantInvestigation: finalReport.investigation_summary,
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

  // Once a case has passed the intake gate, kick off defendant identification.
  // A declined intake (time-barred or no plausible claim) never reaches here.
  useEffect(() => {
    cases.forEach((c) => {
      if (identifiedRef.current.has(c.id)) return;
      if (c.screeningStatus !== "done") return;
      if (!c.gate || c.gate.declined) return;
      identifiedRef.current.add(c.id);
      identifyDefendant(c.id);
    });
  }, [cases, identifyDefendant]);

  // Persist a finished run to the GHL opportunity's "AI Intake" custom fields
  // (aggregated skim values + the full PDF report). GHL is the run database:
  // a non-empty "AI Run Status" field is how a future run — or the coming
  // stage-change automation — knows the opportunity was already processed.
  const saveReport = useCallback(async (caseId: string) => {
    const c = casesRef.current.find((entry) => entry.id === caseId);
    if (!c?.opportunityId) return;
    setCases((prev) =>
      prev.map((entry) =>
        entry.id === caseId ? { ...entry, reportStatus: "saving" } : entry,
      ),
    );
    try {
      const report = caseSummaryText(buildCaseManifest(c));
      const form = new FormData();
      form.append(
        "payload",
        JSON.stringify({
          opportunityId: c.opportunityId,
          values: buildAiFieldValues(c),
        }),
      );
      form.append("report", buildReportPdf(report), "AI Intake Report.pdf");
      const res = await fetch("/api/opportunity/report", {
        method: "POST",
        body: form,
      });
      if (!res.ok) {
        const body = (await res.json().catch(() => null)) as
          | { error?: string }
          | null;
        throw new Error(body?.error ?? `Saving failed: ${res.status}`);
      }
      setCases((prev) =>
        prev.map((entry) =>
          entry.id === caseId ? { ...entry, reportStatus: "done" } : entry,
        ),
      );
    } catch (err) {
      const message =
        err instanceof Error ? err.message : "Could not save the report note.";
      setCases((prev) =>
        prev.map((entry) =>
          entry.id === caseId
            ? { ...entry, reportStatus: "error", reportError: message }
            : entry,
        ),
      );
    }
  }, []);

  // Save the note once a GHL-imported case reaches a successful terminal state:
  // either declined at the intake gate (terminal by design) or identification
  // finished. Failed runs are NOT persisted — a re-run should stay possible
  // without a confirmation prompt.
  useEffect(() => {
    cases.forEach((c) => {
      if (!c.opportunityId) return;
      if (reportedRef.current.has(c.id)) return;
      const declined = c.screeningStatus === "done" && Boolean(c.gate?.declined);
      const identified = c.defendantStatus === "done";
      if (!declined && !identified) return;
      reportedRef.current.add(c.id);
      void saveReport(c.id);
    });
  }, [cases, saveReport]);

  // Forensic automation analysis for each audio recording. Runs off the
  // transcription (independent of evaluation/identification) so the
  // pre-recorded/automated assessment is ready to file as evidence.
  const analyzeForensics = useCallback(
    async (caseId: string, fileId: string) => {
      const c = casesRef.current.find((entry) => entry.id === caseId);
      const file = c?.files.find((f) => f.id === fileId);
      if (!file || file.kind !== "audio" || !file.text) return;

      setCases((prev) =>
        patchFile(prev, caseId, fileId, { forensicsStatus: "processing" }),
      );

      try {
        const audio = await dataFromUrl(file.url, "audio/wav");
        if (!audio) throw new Error("Could not read audio for analysis.");
        const response = await fetch("/api/audio-forensics", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            audio,
            transcription: file.text,
            name: file.name,
          }),
        });
        if (!response.ok) {
          const body = (await response.json().catch(() => null)) as
            | { error?: string }
            | null;
          throw new Error(
            body?.error ?? `Forensic analysis failed: ${response.status}`,
          );
        }
        const forensics = (await response.json()) as AudioForensics;
        setCases((prev) =>
          patchFile(prev, caseId, fileId, {
            forensicsStatus: "done",
            forensics,
          }),
        );
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Forensic analysis failed";
        setCases((prev) =>
          patchFile(prev, caseId, fileId, {
            forensicsStatus: "error",
            forensicsError: message,
          }),
        );
      }
    },
    [],
  );

  // Analyze each audio file once its transcription is in.
  useEffect(() => {
    cases.forEach((c) => {
      c.files.forEach((file) => {
        if (file.kind !== "audio") return;
        if (file.status !== "done" || !file.text) return;
        if (file.forensicsStatus) return;
        const key = `${c.id}:${file.id}`;
        if (forensicsRef.current.has(key)) return;
        forensicsRef.current.add(key);
        void mediaLimiter(() => analyzeForensics(c.id, file.id));
      });
    });
  }, [cases, analyzeForensics]);

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

  async function createCase(inputs: NewCaseInput[], meta: NewCaseMeta) {
    if (inputs.length === 0) return;
    const built = await Promise.all(
      inputs.map((input) => buildCaseFile(input.blob, input.name, input.kind)),
    );
    const caseId = randomId();
    const newCase: Case = {
      id: caseId,
      name: meta.name ?? formatCaseName(new Date()),
      createdAt: Date.now(),
      files: built.map((b) => b.file),
      dnc: meta.dnc,
      opportunityId: meta.opportunityId,
      screeningStatus: "idle",
      defendantStatus: "idle",
    };
    setCases((prev) => [...prev, newCase]);
    setSelectedCaseId(caseId);
    built.forEach(({ file, raw }) => {
      void mediaLimiter(() => processFile(caseId, file, raw));
    });
  }

  const selectedCase = cases.find((c) => c.id === selectedCaseId) ?? null;

  return (
    <main className="flex min-h-0 flex-1">
      <CaseSidebar
        cases={cases}
        selectedCaseId={selectedCaseId}
        onSelect={setSelectedCaseId}
        onNewCase={() => setShowNewCase(true)}
      />

      {selectedCase ? (
        <CaseDetail caseItem={selectedCase} onOpenFile={setOpenFile} />
      ) : (
        <div className="flex flex-1 items-center justify-center p-8 text-center">
          <p className="max-w-sm text-sm text-zinc-500 dark:text-zinc-400">
            Open a case from uploaded audio/image files or from a GHL
            opportunity URL. Each case is evaluated against the TCPA rubric,
            then investigated to identify the company behind it.
          </p>
        </div>
      )}

      {showNewCase && (
        <NewCaseModal
          onClose={() => setShowNewCase(false)}
          onCreate={(inputs, meta) => void createCase(inputs, meta)}
        />
      )}

      {openFile && (
        <FileModal file={openFile} onClose={() => setOpenFile(null)} />
      )}
    </main>
  );
}
