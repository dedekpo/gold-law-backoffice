import { getJob, startJob } from "@/lib/jobs";
import {
  runIntakeReview,
  type IntakeReviewProgress,
  type IntakeReviewResult,
} from "@/lib/intake-review";
import { createLogger, nextRequestId } from "@/lib/logger";
import { isRateLimitError } from "@/lib/rate-limit";

const baseLog = createLogger("intake-review-api");

// Live progress per running job, kept beside (not inside) the generic job
// store. Each entry is a mutable box the running task writes into (the first
// progress callback fires before startJob even returns, so the box — not the
// job id — is what the closure captures). Entries are dropped once a terminal
// status is polled.
const progressByJob = new Map<string, { current: IntakeReviewProgress | null }>();

/**
 * POST starts a read-only review of the intake pipeline in the background and
 * returns a job id; GET ?jobId=… polls it. The run only ever issues GHL reads.
 */
export async function POST() {
  const log = baseLog.child(nextRequestId());
  const progress: { current: IntakeReviewProgress | null } = { current: null };
  const jobId = startJob(
    () =>
      runIntakeReview((p) => {
        progress.current = p;
      }),
    { isRateLimited: isRateLimitError },
  );
  progressByJob.set(jobId, progress);
  log.info("intake review queued", { jobId });
  return Response.json({ jobId }, { status: 202 });
}

export async function GET(request: Request) {
  const jobId = new URL(request.url).searchParams.get("jobId");
  if (!jobId) {
    return Response.json({ error: "Missing jobId" }, { status: 400 });
  }
  const job = getJob<IntakeReviewResult>(jobId);
  if (!job) {
    return Response.json(
      { error: "Unknown or expired review. Please run it again." },
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
