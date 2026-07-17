import { z } from "zod";
import { GhlError, ghlFetch } from "@/lib/ghl";
import { createLogger, nextRequestId } from "@/lib/logger";
import {
  createReportNote,
  deleteNote,
  fetchContactNotes,
  isReportNote,
} from "@/lib/opportunity-note";

const baseLog = createLogger("opportunity-report");

/**
 * Persist a finished agent run as the opportunity's "AI Intake Report" note.
 * Upsert semantics: any previous report note for the opportunity is deleted
 * first (delete + recreate rather than PUT, because only POST is verified to
 * accept the opportunity-only `relations`), so one canonical note exists and
 * future runs can detect it.
 */

const requestSchema = z.object({
  opportunityId: z.string().min(1),
  /** The run result as plain text (converted to note HTML server-side). */
  report: z.string().min(1),
});

export async function POST(request: Request) {
  const log = baseLog.child(nextRequestId());
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request body: expected { opportunityId, report }" },
      { status: 400 },
    );
  }
  const { opportunityId, report } = parsed.data;

  try {
    // Re-resolve the contact server-side; our token only reaches this location,
    // so this also guards against a foreign opportunity id.
    const oppRes = await ghlFetch<{ opportunity?: { contactId?: string } }>(
      `/opportunities/${opportunityId}`,
    );
    const contactId = oppRes.opportunity?.contactId;
    if (!contactId) {
      return Response.json(
        { error: "The opportunity has no contact to attach the note under." },
        { status: 422 },
      );
    }

    const previous = (await fetchContactNotes(contactId)).filter((note) =>
      isReportNote(note, opportunityId),
    );
    for (const note of previous) {
      await deleteNote(contactId, note.id);
    }

    const noteId = await createReportNote(contactId, opportunityId, report);
    log.info("report note saved", {
      opportunityId,
      noteId,
      replaced: previous.length,
      chars: report.length,
    });
    return Response.json({ noteId, replaced: previous.length });
  } catch (err) {
    if (err instanceof GhlError && err.status === 404) {
      return Response.json(
        { error: "Opportunity not found in GHL." },
        { status: 404 },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error("saving report note failed", { opportunityId, message });
    return Response.json(
      { error: `Could not save the report note: ${message}` },
      { status: 502 },
    );
  }
}
