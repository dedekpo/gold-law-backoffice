import { ghlFetch } from "@/lib/ghl";

/**
 * The agent's run report persisted as a GHL note. GHL has no opportunity-notes
 * endpoint: notes in the opportunity's Notes tab are CONTACT notes carrying a
 * `relations` array (undocumented but accepted by POST /contacts/{id}/notes —
 * verified live). Creating a note with ONLY the opportunity relation attaches
 * it to the opportunity and not the client, which is exactly what we want.
 *
 * The fixed title + marker first line identify our note among the humans' so a
 * later run (or the coming stage-change automation) can detect that the agent
 * already processed this opportunity.
 */

export const REPORT_NOTE_TITLE = "AI Intake Report";
/** First line of the note body — the durable marker future runs search for. */
export const REPORT_NOTE_MARKER = "AI INTAKE REPORT — automated agent run";

/** Defensive cap; GHL's note-body limit is undocumented. */
const MAX_REPORT_CHARS = 40_000;

export type GhlNote = {
  id: string;
  title?: string;
  body?: string;
  bodyText?: string;
  dateAdded?: string;
  relations?: { objectKey?: string; recordId?: string }[];
};

export function isReportNote(note: GhlNote, opportunityId: string): boolean {
  const linked = (note.relations ?? []).some(
    (r) => r.objectKey === "opportunity" && r.recordId === opportunityId,
  );
  if (!linked) return false;
  if (note.title === REPORT_NOTE_TITLE) return true;
  const text = note.bodyText ?? note.body ?? "";
  return text.trimStart().startsWith(REPORT_NOTE_MARKER);
}

export async function fetchContactNotes(contactId: string): Promise<GhlNote[]> {
  const res = await ghlFetch<{ notes?: GhlNote[] }>(
    `/contacts/${contactId}/notes`,
  );
  return res.notes ?? [];
}

export function findReportNote(
  notes: GhlNote[],
  opportunityId: string,
): GhlNote | null {
  return notes.find((n) => isReportNote(n, opportunityId)) ?? null;
}

const escapeHtml = (line: string): string =>
  line.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/**
 * Render the plain-text report as the simple paragraph HTML the notes editor
 * uses (one <p> per line, leading spaces preserved as &nbsp;) — raw newlines
 * collapse in the rich-text view.
 */
export function reportToNoteHtml(report: string): string {
  let text = `${REPORT_NOTE_MARKER}\n\n${report.trim()}`;
  if (text.length > MAX_REPORT_CHARS) {
    text = `${text.slice(0, MAX_REPORT_CHARS)}\n\n[truncated — full report in the backoffice export]`;
  }
  return text
    .split("\n")
    .map((line) => {
      if (!line.trim()) return '<p style="margin:0px;"><br></p>';
      const indented = escapeHtml(line).replace(/^ +/, (m) =>
        "&nbsp;".repeat(m.length),
      );
      return `<p style="margin:0px;">${indented}</p>`;
    })
    .join("");
}

/**
 * Create the report note attached to the opportunity only. Any previous report
 * note for this opportunity should be deleted first (see the report route) so
 * exactly one canonical note exists.
 */
export async function createReportNote(
  contactId: string,
  opportunityId: string,
  report: string,
): Promise<string> {
  const res = await ghlFetch<{ note?: { id?: string } }>(
    `/contacts/${contactId}/notes`,
    {
      method: "POST",
      body: {
        title: REPORT_NOTE_TITLE,
        body: reportToNoteHtml(report),
        relations: [{ objectKey: "opportunity", recordId: opportunityId }],
      },
    },
  );
  const id = res.note?.id;
  if (!id) throw new Error("GHL did not return the created note's id");
  return id;
}

export async function deleteNote(
  contactId: string,
  noteId: string,
): Promise<void> {
  await ghlFetch(`/contacts/${contactId}/notes/${noteId}`, {
    method: "DELETE",
  });
}
