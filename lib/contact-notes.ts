import { ghlFetch } from "@/lib/ghl";

/**
 * GHL notes live on the CONTACT, not the opportunity — what intakers see as
 * "the opportunity's notes" in the GHL UI is the contact's note stream. One
 * consequence for serial clients: the notes of every one of their
 * opportunities share this single stream.
 */

export type ContactNote = {
  id: string;
  /** Plain text (GHL stores rich text; HTML is stripped as a fallback). */
  text: string;
  /** ISO timestamp. */
  dateAdded: string | null;
  userId: string | null;
};

type RawNote = {
  id?: string;
  body?: string;
  bodyText?: string;
  dateAdded?: string;
  userId?: string;
};

/**
 * Add a note to a contact's stream. Used to mirror investigation-log entries
 * into GHL while staff still live there (transition-period convenience; the
 * Firestore log is the canonical record).
 */
export async function createContactNote(
  contactId: string,
  text: string,
): Promise<void> {
  await ghlFetch(`/contacts/${contactId}/notes`, {
    method: "POST",
    body: { body: text },
  });
}

/** Notes of a contact, newest first. */
export async function fetchContactNotes(
  contactId: string,
): Promise<ContactNote[]> {
  const res = await ghlFetch<{ notes?: RawNote[] }>(
    `/contacts/${contactId}/notes`,
  );
  return (res.notes ?? [])
    .map((n) => ({
      id: n.id ?? "",
      text: (
        n.bodyText || (n.body ?? "").replace(/<[^>]+>/g, " ")
      )
        .replace(/\s+\n/g, "\n")
        .trim(),
      dateAdded: n.dateAdded ?? null,
      userId: n.userId ?? null,
    }))
    .filter((n) => n.text)
    .sort((a, b) => (b.dateAdded ?? "").localeCompare(a.dateAdded ?? ""));
}
