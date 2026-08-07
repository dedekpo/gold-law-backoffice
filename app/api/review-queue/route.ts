import { getCaseDocs } from "@/lib/case-store";
import { createLogger, nextRequestId } from "@/lib/logger";
import { listReviewQueue, resolveReviewStages } from "@/lib/review-queue";

const baseLog = createLogger("review-queue");

/**
 * The case-review queue: every open opportunity in the '👀 For Chris Review'
 * stage, annotated with whether a structured AI run / manual notes exist in
 * Firestore for it.
 */

export type QueueEntry = {
  id: string;
  name: string;
  createdAt: string | null;
  contactName: string | null;
  hasRun: boolean;
  hasManual: boolean;
};

export async function GET() {
  const log = baseLog.child(nextRequestId());
  try {
    const stages = await resolveReviewStages();
    const opportunities = await listReviewQueue(stages);
    const docs = await getCaseDocs(opportunities.map((o) => o.id));

    const entries: QueueEntry[] = opportunities.map((o) => {
      const doc = docs.get(o.id);
      return {
        id: o.id,
        name: o.name,
        createdAt: o.createdAt,
        contactName: o.contactName,
        hasRun: Boolean(doc?.run),
        hasManual: Boolean(doc?.manual?.text?.trim()),
      };
    });

    log.info("queue listed", {
      pipeline: stages.pipelineName,
      count: entries.length,
      withRun: entries.filter((e) => e.hasRun).length,
    });

    return Response.json({
      pipelineName: stages.pipelineName,
      stageName: stages.review.name,
      approvedStageName: stages.approved.name,
      declinedStageName: stages.declined.name,
      entries,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("queue listing failed", { message });
    return Response.json(
      { error: `Could not load the review queue: ${message}` },
      { status: 502 },
    );
  }
}
