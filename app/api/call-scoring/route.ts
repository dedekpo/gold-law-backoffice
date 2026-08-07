import { getJob, startJob } from "@/lib/jobs";
import {
  runCallScoring,
  type CallScoringProgress,
  type CallScoringResult,
} from "@/lib/call-scoring";
import { createLogger, nextRequestId } from "@/lib/logger";
import { isRateLimitError } from "@/lib/rate-limit";

const baseLog = createLogger("call-scoring-api");

// Live progress per running job, kept beside (not inside) the generic job
// store. Each entry is a mutable box the running task writes into (the first
// progress callback fires before startJob even returns, so the box — not the
// job id — is what the closure captures). Entries are dropped once a terminal
// status is polled.
const progressByJob = new Map<string, { current: CallScoringProgress | null }>();

/**
 * POST starts a call-scoring run in the background and returns a job id;
 * GET ?jobId=… polls it. The run only ever issues GHL reads.
 */
export async function POST() {
  const log = baseLog.child(nextRequestId());
  const progress: { current: CallScoringProgress | null } = { current: null };
  const jobId = startJob(
    () =>
      runCallScoring((p) => {
        progress.current = p;
      }),
    { isRateLimited: isRateLimitError },
  );
  progressByJob.set(jobId, progress);
  log.info("call scoring queued", { jobId });
  return Response.json({ jobId }, { status: 202 });
}

export async function GET(request: Request) {
  const jobId = new URL(request.url).searchParams.get("jobId");
  if (!jobId) {
    return Response.json({ error: "Missing jobId" }, { status: 400 });
  }
  const job = getJob<CallScoringResult>(jobId);
  if (!job) {
    return Response.json(
      { error: "Unknown or expired run. Please start it again." },
      { status: 404 },
    );
  }
  if (job.status === "running") {
    return Response.json({
      status: "running",
      progress: progressByJob.get(jobId)?.current ?? null,
    });
  }
  progressByJob.delete(jobId);
  if (job.status === "done") {
    return Response.json({ status: "done", result: job.result });
  }
  return Response.json({
    status: "error",
    error: job.rateLimited
      ? "AI provider rate limit exceeded. Please wait a moment and try again."
      : job.error,
    rateLimited: job.rateLimited,
  });
}
