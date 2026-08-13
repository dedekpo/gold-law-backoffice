// Shared plumbing for working with extracted contacts — used by the
// identification route when a run is scored AND by the UI when it re-derives
// per-screen proof from a stored run's facts. Pure functions, no I/O, so both
// sides are guaranteed to agree.

import type { ExtractedContact } from "@/lib/types";

/**
 * Every file this contact appears in. Newer extractions list the screenshot
 * AND its audio twin in `files`; older ones only carry the single `file`.
 */
export function contactFiles(
  c: Pick<ExtractedContact, "file" | "files">,
): string[] {
  const files = c.files?.length ? c.files : [c.file];
  return [...new Set(files.filter(Boolean))];
}

/** Whether any of the contact's files is in the attributed set. */
export function contactMatchesFiles(
  c: Pick<ExtractedContact, "file" | "files">,
  fileNames: ReadonlySet<string>,
): boolean {
  return contactFiles(c).some((name) => fileNames.has(name));
}

/**
 * A contact as it may arrive from an older extraction payload: `sequence` and
 * `timestampInferred` were added later, so they can be absent — `mergeContacts`
 * fills them in.
 */
type RawExtractedContact = Omit<
  ExtractedContact,
  "sequence" | "timestampInferred"
> & {
  sequence?: number;
  timestampInferred?: boolean;
};

/**
 * Normalize raw extracted contacts and put them in one chronological order
 * (by `sequence`, with extraction order as a stable fallback) so per-company
 * screens see the thread timeline — Screen 02 depends on "STOP then a later
 * contact" being ordered. Also merges the audio forensics hint into
 * `isPrerecorded` (matched against ANY of the contact's files) so Screen 01
 * is grounded in the acoustic analysis.
 */
export function mergeContacts(
  raw: RawExtractedContact[],
  prerecordedFiles: ReadonlySet<string>,
): ExtractedContact[] {
  return raw
    .map((c, i) => ({
      ...c,
      sequence: c.sequence ?? i,
      timestampInferred: c.timestampInferred ?? c.timestamp === null,
      isPrerecorded: contactMatchesFiles(c, prerecordedFiles)
        ? true
        : c.isPrerecorded,
    }))
    .sort((a, b) => a.sequence - b.sequence);
}
