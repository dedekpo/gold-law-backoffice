import { bucket } from "@/lib/firebase";

/**
 * Firebase Storage persistence for investigation evidence — the canonical copy
 * of every file an investigator uploads through the app (GHL keeps its own
 * copy of legacy field uploads; those are referenced by `ghlUrl` and mirrored
 * here lazily, if ever).
 *
 * `InvestigationEvidence.storageUrl` holds the OBJECT PATH within the default
 * bucket (not a signed URL — those expire). Files are served to the UI by
 * GET /api/investigation/file, which streams the object through the app.
 */

/** Object path for one evidence file, namespaced by investigation. */
export function evidenceObjectPath(
  investigationId: string,
  evidenceId: string,
  filename: string,
): string {
  // Strip path separators; the object path's structure is ours, not the file's.
  const safeName = filename.replace(/[/\\]/g, "_");
  return `investigations/${investigationId}/evidence/${evidenceId}/${safeName}`;
}

export async function uploadEvidenceObject(
  path: string,
  data: Buffer,
  contentType: string,
): Promise<void> {
  await bucket()
    .file(path)
    .save(data, { contentType, resumable: false });
}

export async function downloadEvidenceObject(
  path: string,
): Promise<Buffer | null> {
  const file = bucket().file(path);
  const [exists] = await file.exists();
  if (!exists) return null;
  const [data] = await file.download();
  return data;
}
