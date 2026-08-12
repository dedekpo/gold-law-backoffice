import { z } from "zod";
import { createContactNote } from "@/lib/contact-notes";
import {
  appendLogEntry,
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
 * Closing does NOT move the intake opportunity in GHL: there is no terminal
 * "declined" stage in pipeline 01, and inventing stage moves is not this
 * route's call. Every transition writes a log entry, mirrored to the
 * contact's GHL notes by default.
 */

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
  declined: "declined",
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
          logLine = `Closed — ${OUTCOME_LABELS[outcome!]}.${trimmed ? `\n${trimmed}` : ""}`;
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

    log.info("status transition", { investigationId, action, outcome, mirrored });
    return Response.json({ doc, mirrored });
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
