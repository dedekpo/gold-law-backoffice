import { createLogger } from "@/lib/logger";

const log = createLogger("jobs");

export type JobStatus = "running" | "done" | "error";

type JobRecord<T> = {
  id: string;
  status: JobStatus;
  result?: T;
  error?: string;
  /** True when the failure was a provider rate limit (429), so the UI can advise retrying later. */
  rateLimited?: boolean;
  createdAt: number;
  updatedAt: number;
};

export type JobSnapshot<T> =
  | { status: "running" }
  | { status: "done"; result: T }
  | { status: "error"; error: string; rateLimited: boolean };

// In-memory job store. This is the right fit for a single long-lived Node
// process (one Railway service replica): the background task and the polling
// reads share the same process memory, so a slow job no longer rides on a
// single held HTTP connection that a platform proxy can cut with a 502.
//
// Caveats to be aware of before scaling:
//   - Jobs are lost on restart/redeploy (acceptable: the client just re-runs).
//   - This does NOT work across multiple replicas (a poll could hit a replica
//     that never ran the job) or on serverless (the process is frozen after the
//     response). Move job state to Redis/Postgres before turning either on.
const jobs = new Map<string, JobRecord<unknown>>();

// Keep terminal jobs around long enough for the client to collect the result,
// then drop them so the map can't grow without bound.
const TERMINAL_TTL_MS = 60 * 60 * 1000; // 1 hour

function sweep(): void {
  const now = Date.now();
  for (const [id, job] of jobs) {
    if (job.status !== "running" && now - job.updatedAt > TERMINAL_TTL_MS) {
      jobs.delete(id);
    }
  }
}

function newId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Run `task` in the background and return a job id immediately. The HTTP handler
 * returns right away; the client polls `getJob(id)` for the result. A rejected
 * task is recorded as an error job rather than surfacing as an unhandled
 * rejection, so one failed run can't take down the server process.
 */
export function startJob<T>(
  task: () => Promise<T>,
  options: { isRateLimited?: (err: unknown) => boolean } = {},
): string {
  sweep();
  const id = newId();
  const record: JobRecord<T> = {
    id,
    status: "running",
    createdAt: Date.now(),
    updatedAt: Date.now(),
  };
  jobs.set(id, record as JobRecord<unknown>);

  void (async () => {
    try {
      record.result = await task();
      record.status = "done";
    } catch (err) {
      record.status = "error";
      record.error = err instanceof Error ? err.message : "Job failed";
      record.rateLimited = options.isRateLimited?.(err) ?? false;
      log.error("job failed", { id, message: record.error });
    } finally {
      record.updatedAt = Date.now();
    }
  })();

  return id;
}

/** Snapshot the current state of a job, or undefined if it is unknown/expired. */
export function getJob<T>(id: string): JobSnapshot<T> | undefined {
  const job = jobs.get(id) as JobRecord<T> | undefined;
  if (!job) return undefined;
  if (job.status === "running") return { status: "running" };
  if (job.status === "done") return { status: "done", result: job.result as T };
  return {
    status: "error",
    error: job.error ?? "Job failed",
    rateLimited: job.rateLimited ?? false,
  };
}
