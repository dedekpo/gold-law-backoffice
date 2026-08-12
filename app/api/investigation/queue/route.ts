import {
  listQueueOpportunities,
  resolveQueueStage,
  type QueueDesk,
} from "@/lib/investigation-queue";
import {
  listInvestigationsByStatus,
  type InvestigationDoc,
  type InvestigationStatus,
} from "@/lib/investigation-store";
import { createLogger, nextRequestId } from "@/lib/logger";

const baseLog = createLogger("investigation-queue");

/**
 * The work queue of one desk: every open opportunity in its pipeline stage
 * (?desk=ai → '👀 Ready for AI Investigation', ?desk=review → 'AI Under
 * Investigation', ?desk=manual → '🔍 Manual Investigation'), oldest first,
 * each annotated with the state of any investigation already open on it in
 * Firestore, plus the AI Run Status field for the review desk's badges.
 */

export type QueueInvestigationState = {
  status: Extract<InvestigationStatus, "open" | "ready_for_review">;
  companies: number;
  confirmedCompanies: number;
  evidence: number;
};

export type QueueEntry = {
  id: string;
  name: string;
  createdAt: string | null;
  contactName: string | null;
  /** "AI Run Status" field value, verbatim; null when no run finished. */
  aiRunStatus: string | null;
  /** Investigation already underway on this opportunity, if any. */
  investigation: QueueInvestigationState | null;
};

export type QueueResponse = {
  desk: QueueDesk;
  stageName: string;
  entries: QueueEntry[];
};

function summarize(doc: InvestigationDoc): QueueInvestigationState | null {
  if (doc.status !== "open" && doc.status !== "ready_for_review") return null;
  return {
    status: doc.status,
    companies: doc.companies.length,
    confirmedCompanies: doc.companies.filter((c) => c.status === "confirmed")
      .length,
    evidence: doc.evidence.length,
  };
}

export async function GET(request: Request) {
  const log = baseLog.child(nextRequestId());
  const desk = new URL(request.url).searchParams.get("desk");
  if (desk !== "ai" && desk !== "review" && desk !== "manual") {
    return Response.json(
      { error: "Expected ?desk=ai, ?desk=review or ?desk=manual." },
      { status: 400 },
    );
  }

  try {
    const [stage, open, inReview] = await Promise.all([
      resolveQueueStage(desk),
      listInvestigationsByStatus("open"),
      listInvestigationsByStatus("ready_for_review"),
    ]);
    const opportunities = await listQueueOpportunities(stage);

    // Open investigations win over ready-for-review when an opportunity
    // somehow has both; within a status, the store returns newest first.
    const byOpportunity = new Map<string, InvestigationDoc>();
    for (const doc of [...inReview, ...open]) {
      byOpportunity.set(doc.source.opportunityId, doc);
    }

    const entries: QueueEntry[] = opportunities.map((o) => {
      const doc = byOpportunity.get(o.id);
      return {
        id: o.id,
        name: o.name,
        createdAt: o.createdAt,
        contactName: o.contactName,
        aiRunStatus: o.aiRunStatus,
        investigation: doc ? summarize(doc) : null,
      };
    });

    log.info("queue listed", { desk, stage: stage.stageName, count: entries.length });
    return Response.json({
      desk,
      stageName: stage.stageName,
      entries,
    } satisfies QueueResponse);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("queue failed", { desk, message });
    return Response.json(
      { error: `Could not load the ${desk} queue: ${message}` },
      { status: 502 },
    );
  }
}
