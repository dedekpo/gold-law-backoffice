import { z } from "zod";
import { saveReviewDecision, type ReviewDecision } from "@/lib/case-store";
import { GhlError } from "@/lib/ghl";
import { createLogger, nextRequestId } from "@/lib/logger";
import { moveToStage, resolveReviewStages } from "@/lib/review-queue";

const baseLog = createLogger("review-queue-decision");

/**
 * Record a review decision: move the opportunity to '✅ Approved for Signup'
 * (approve) or 'Needs Work' (decline), then remember the decision on the
 * Firestore case document. The stage move is the source of truth — if it
 * fails nothing is recorded; if only the Firestore write fails the response
 * still reports success (the opportunity HAS moved) with dbSaved: false.
 */

const requestSchema = z.object({
  id: z.string().min(1),
  decision: z.enum(["approved", "declined"]),
});

export async function POST(request: Request) {
  const log = baseLog.child(nextRequestId());
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request body: expected { id, decision }" },
      { status: 400 },
    );
  }
  const { id, decision } = parsed.data;

  try {
    const stages = await resolveReviewStages();
    const target = decision === "approved" ? stages.approved : stages.declined;
    await moveToStage(id, stages, target.id);

    const review: ReviewDecision = {
      decision,
      decidedAt: new Date().toISOString(),
      movedToStageId: target.id,
      movedToStageName: target.name,
    };
    let dbSaved = true;
    try {
      await saveReviewDecision(id, review);
    } catch (err) {
      dbSaved = false;
      log.error("decision Firestore write failed", {
        opportunityId: id,
        message: err instanceof Error ? err.message : String(err),
      });
    }

    log.info("decision recorded", {
      opportunityId: id,
      decision,
      movedTo: target.name,
      dbSaved,
    });
    return Response.json({ ok: true, movedTo: target.name, review, dbSaved });
  } catch (err) {
    if (err instanceof GhlError && err.status === 404) {
      return Response.json(
        { error: "Opportunity not found in GHL." },
        { status: 404 },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error("decision failed", { opportunityId: id, decision, message });
    return Response.json(
      { error: `Could not move the opportunity: ${message}` },
      { status: 502 },
    );
  }
}
