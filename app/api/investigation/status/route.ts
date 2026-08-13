import { z } from "zod";
import { createContactNote } from "@/lib/contact-notes";
import { ghlFetch } from "@/lib/ghl";
import {
  moveOpportunityToStage,
  resolveIntakeStage,
  type QueueStage,
} from "@/lib/investigation-queue";
import {
  appendLogEntry,
  getInvestigation,
  mutateInvestigation,
  type InvestigationOutcome,
} from "@/lib/investigation-store";
import { createLogger, nextRequestId } from "@/lib/logger";

const baseLog = createLogger("investigation-status");

/**
 * Phase 4 lifecycle transitions of an investigation:
 * - submit:    open → ready_for_review (Mike hands it to the reviewer)
 * - send_back: ready_for_review → open (reviewer wants more digging; note required)
 * - close:     open|ready_for_review → closed with a no-case outcome (note optional)
 * - reopen:    closed → open (undo a mistaken close; converted stays closed)
 *
 * Approval has no action here on purpose — approving an investigation IS
 * executing the split (POST /api/investigation/split), which records the
 * review decision and closes the doc as "converted".
 *
 * Closing DOES retire the intake opportunity in GHL: each no-case outcome has
 * a terminal stage in pipeline 01 (see CLOSE_STAGE_NAMES), mirroring how the
 * split retires a converted parent to "Converted to Case(s)". The move runs
 * BEFORE the doc is closed so a GHL failure leaves everything retryable, and
 * is skipped (never forced) when the opportunity has already left the intake
 * pipeline. Reopening does not move the opportunity back — undoing a drag is
 * a human call. Every transition writes a log entry, mirrored to the
 * contact's GHL notes by default.
 */

/** Where a closed intake opportunity is parked, by outcome. Matched by
 * normalized name, so the emoji/dash cosmetics in GHL don't matter. */
const CLOSE_STAGE_NAMES: Record<
  Exclude<InvestigationOutcome, "converted">,
  string
> = {
  no_company_found: "No Company ID – Notify Lead",
  no_violation: "☹️ No Case Leads",
  declined: "⛔ Not a Fit",
};

const bodySchema = z.object({
  investigationId: z.string().min(1),
  actorName: z.string().min(1).max(80),
  action: z.enum(["submit", "send_back", "close", "reopen"]),
  note: z.string().max(5000).optional(),
  /** close only. "converted" is reserved for the split. */
  outcome: z.enum(["no_company_found", "no_violation", "declined"]).optional(),
  mirrorToGhl: z.boolean().optional(),
});

const OUTCOME_LABELS: Record<InvestigationOutcome, string> = {
  converted: "converted to case(s)",
  no_company_found: "no company found",
  no_violation: "no violation",
  declined: "not a fit",
};

export async function POST(request: Request) {
  const log = baseLog.child(nextRequestId());
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }
  const { investigationId, actorName, action, note, outcome, mirrorToGhl } =
    parsed.data;
  if (action === "close" && !outcome) {
    return Response.json(
      { error: "Closing needs an outcome." },
      { status: 400 },
    );
  }
  if (action === "send_back" && !note?.trim()) {
    return Response.json(
      { error: "Sending back needs a note telling the investigator why." },
      { status: 400 },
    );
  }
  const actor = { kind: "human" as const, name: actorName.trim() };
  const now = new Date().toISOString();

  try {
    // Closing retires the intake opportunity to the outcome's terminal stage.
    // Resolve + move BEFORE closing the doc: the PUT is idempotent, so a
    // failure anywhere leaves the investigation open and the close retryable.
    let closedStage: QueueStage | null = null;
    let moveSkipped: string | null = null;
    if (action === "close") {
      const current = await getInvestigation(investigationId);
      if (!current) {
        return Response.json(
          { error: "Investigation not found." },
          { status: 409 },
        );
      }
      if (current.status === "closed") {
        return Response.json(
          { error: "This investigation is already closed." },
          { status: 409 },
        );
      }
      const stage = await resolveIntakeStage(CLOSE_STAGE_NAMES[outcome!]);
      // Guard: only move an opportunity that still lives in the intake
      // pipeline — a PUT would otherwise drag it out of another pipeline.
      const live = await ghlFetch<{
        opportunity?: { pipelineId?: string };
      }>(`/opportunities/${current.source.opportunityId}`);
      if (live.opportunity?.pipelineId === stage.pipelineId) {
        await moveOpportunityToStage(current.source.opportunityId, stage);
        closedStage = stage;
      } else {
        moveSkipped =
          "the opportunity is no longer in the intake pipeline, so it was not moved";
      }
    }

    let logLine = "";
    const doc = await mutateInvestigation(investigationId, (d) => {
      const expect = (allowed: string[]) => {
        if (!allowed.includes(d.status)) {
          throw new Error(
            `This investigation is ${d.status.replaceAll("_", " ")} — the action no longer applies.`,
          );
        }
      };
      const trimmed = note?.trim();
      switch (action) {
        case "submit":
          expect(["open"]);
          d.status = "ready_for_review";
          logLine = `Submitted for review.${trimmed ? `\n${trimmed}` : ""}`;
          break;
        case "send_back":
          expect(["ready_for_review"]);
          d.status = "open";
          logLine = `Sent back to investigation:\n${trimmed}`;
          break;
        case "close":
          expect(["open", "ready_for_review"]);
          d.status = "closed";
          d.outcome = outcome!;
          if (closedStage) {
            // A no-case close is the reviewer's terminal decision — record it
            // with the stage move, same shape the split writes for approvals.
            d.review = {
              decision: "declined",
              decidedAt: now,
              movedToStageId: closedStage.stageId,
              movedToStageName: closedStage.stageName,
            };
          }
          logLine = `Closed — ${OUTCOME_LABELS[outcome!]}.${
            closedStage
              ? ` Moved the opportunity to "${closedStage.stageName}".`
              : moveSkipped
                ? ` (${moveSkipped}.)`
                : ""
          }${trimmed ? `\n${trimmed}` : ""}`;
          break;
        case "reopen":
          expect(["closed"]);
          if (d.outcome === "converted") {
            throw new Error(
              "A converted investigation cannot be reopened — its case opportunities already exist.",
            );
          }
          d.status = "open";
          d.outcome = null;
          logLine = `Reopened.${trimmed ? `\n${trimmed}` : ""}`;
          break;
      }
    });

    doc.log.push(
      await appendLogEntry(investigationId, {
        at: now,
        author: actor,
        text: logLine,
        evidenceIds: [],
      }),
    );

    let mirrored = false;
    if ((mirrorToGhl ?? true) && doc.source.contactId) {
      try {
        await createContactNote(
          doc.source.contactId,
          `🔎 Investigation log — ${actor.name}\n\n${logLine}`,
        );
        mirrored = true;
      } catch (err) {
        log.warn("GHL note mirror failed", {
          investigationId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info("status transition", {
      investigationId,
      action,
      outcome,
      mirrored,
      movedToStage: closedStage?.stageName ?? null,
    });
    return Response.json({
      doc,
      mirrored,
      movedToStage: closedStage
        ? { id: closedStage.stageId, name: closedStage.stageName }
        : null,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const known =
      message.includes("not found") ||
      message.includes("no longer applies") ||
      message.includes("cannot be reopened");
    log.error("status transition failed", { investigationId, action, message });
    return Response.json(
      { error: known ? message : `Could not update the status: ${message}` },
      { status: known ? 409 : 502 },
    );
  }
}
