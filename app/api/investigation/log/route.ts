import { z } from "zod";
import { createContactNote } from "@/lib/contact-notes";
import {
  appendLogEntry,
  getInvestigation,
} from "@/lib/investigation-store";
import { createLogger, nextRequestId } from "@/lib/logger";

const baseLog = createLogger("investigation-log");

/**
 * Append one entry to an investigation's log — the Phase 3 replacement for
 * "add a GHL note". During the transition each entry is also mirrored to the
 * contact's GHL note stream (best-effort; the Firestore log is canonical), so
 * staff who still live in GHL see the same record.
 */

const bodySchema = z.object({
  investigationId: z.string().min(1),
  actorName: z.string().min(1).max(80),
  text: z.string().min(1).max(10_000),
  /** Ids of evidence files this step refers to. */
  evidenceIds: z.array(z.string().min(1)).max(50).optional(),
  mirrorToGhl: z.boolean().optional(),
});

export async function POST(request: Request) {
  const log = baseLog.child(nextRequestId());
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }
  const { investigationId, actorName, text, evidenceIds, mirrorToGhl } =
    parsed.data;
  const actor = { kind: "human" as const, name: actorName.trim() };

  try {
    const doc = await getInvestigation(investigationId);
    if (!doc) {
      return Response.json(
        { error: "Investigation not found." },
        { status: 404 },
      );
    }

    const entry = await appendLogEntry(investigationId, {
      at: new Date().toISOString(),
      author: actor,
      text: text.trim(),
      evidenceIds: evidenceIds ?? [],
    });

    let mirrored = false;
    if ((mirrorToGhl ?? true) && doc.source.contactId) {
      try {
        await createContactNote(
          doc.source.contactId,
          `🔎 Investigation log — ${actor.name}\n\n${entry.text}`,
        );
        mirrored = true;
      } catch (err) {
        log.warn("GHL note mirror failed", {
          investigationId,
          contactId: doc.source.contactId,
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info("log entry added", { investigationId, mirrored });
    return Response.json({ entry, mirrored });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("log entry failed", { investigationId, message });
    return Response.json(
      { error: `Could not add the log entry: ${message}` },
      { status: 502 },
    );
  }
}
