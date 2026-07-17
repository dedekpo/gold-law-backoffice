import { z } from "zod";
import { GhlError, ghlFetch, ghlLocationId } from "@/lib/ghl";
import { detectKind } from "@/lib/file-kind";
import { createLogger, nextRequestId } from "@/lib/logger";
import { fetchContactNotes, findReportNote } from "@/lib/opportunity-note";
import type { FileKind } from "@/lib/types";

const baseLog = createLogger("opportunity-import");

/**
 * Resolve a pasted GHL opportunity URL to the case evidence attached to it.
 * Read-only: fetches the opportunity plus the location's opportunity
 * custom-field definitions, and returns the files held in the evidence
 * FILE_UPLOAD fields. The client downloads each file through
 * /api/opportunity/file and feeds it into the same pipeline as a manual upload.
 */

/** Opportunity custom fields whose uploads count as case evidence. */
const EVIDENCE_FIELD_KEYS = [
  "opportunity.violation_screenshots",
  "opportunity.violation_audio_files",
] as const;

// e.g. https://login.amicus-pro.com/v2/location/{locationId}/opportunities/{id}?tab=…
const URL_RE = /\/location\/([A-Za-z0-9]+)\/opportunities\/([A-Za-z0-9]+)/;

const requestSchema = z.object({
  url: z.string().min(1),
});

type RawFileEntry = {
  url?: unknown;
  deleted?: unknown;
  meta?: { name?: unknown; mimetype?: unknown; size?: unknown };
};

type RawCustomFieldValue = {
  id?: string;
  // The upload array's property name varies by endpoint version; probe them all.
  fieldValue?: unknown;
  fieldValueArray?: unknown;
  value?: unknown;
};

export type ImportedFile = {
  url: string;
  name: string;
  mimetype: string;
  size: number | null;
  kind: FileKind;
  /** Short field key the file came from, e.g. "violation_screenshots". */
  field: string;
};

function fileEntries(raw: RawCustomFieldValue): RawFileEntry[] {
  for (const candidate of [raw.fieldValue, raw.fieldValueArray, raw.value]) {
    if (Array.isArray(candidate)) return candidate as RawFileEntry[];
  }
  return [];
}

export async function POST(request: Request) {
  const log = baseLog.child(nextRequestId());
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request body: expected { url }" },
      { status: 400 },
    );
  }

  const match = URL_RE.exec(parsed.data.url);
  if (!match) {
    return Response.json(
      {
        error:
          "That doesn't look like a GHL opportunity URL. Expected …/location/{locationId}/opportunities/{opportunityId}.",
      },
      { status: 400 },
    );
  }
  const [, urlLocationId, opportunityId] = match;
  if (urlLocationId !== ghlLocationId()) {
    return Response.json(
      {
        error:
          "This opportunity belongs to a different GHL sub-account than the one this tool is connected to.",
      },
      { status: 400 },
    );
  }

  log.info("importing opportunity", { opportunityId });

  try {
    const [oppRes, fieldsRes] = await Promise.all([
      ghlFetch<{
        opportunity?: {
          id?: string;
          name?: string;
          status?: string;
          contactId?: string;
          customFields?: RawCustomFieldValue[];
        };
      }>(`/opportunities/${opportunityId}`),
      ghlFetch<{
        customFields?: { id: string; fieldKey: string; dataType?: string }[];
      }>(`/locations/${ghlLocationId()}/customFields?model=opportunity`),
    ]);

    const opportunity = oppRes.opportunity;
    if (!opportunity?.id) {
      return Response.json(
        { error: "GHL returned no opportunity for that URL." },
        { status: 502 },
      );
    }

    const evidenceIds = new Map<string, string>(); // field id → short key
    for (const def of fieldsRes.customFields ?? []) {
      if ((EVIDENCE_FIELD_KEYS as readonly string[]).includes(def.fieldKey)) {
        evidenceIds.set(def.id, def.fieldKey.replace(/^opportunity\./, ""));
      }
    }

    const files: ImportedFile[] = [];
    let skipped = 0;
    for (const cf of opportunity.customFields ?? []) {
      const field = cf.id ? evidenceIds.get(cf.id) : undefined;
      if (!field) continue;
      for (const entry of fileEntries(cf)) {
        if (entry.deleted === true) continue;
        const url = typeof entry.url === "string" ? entry.url : null;
        if (!url) continue;
        const name =
          typeof entry.meta?.name === "string" && entry.meta.name
            ? entry.meta.name
            : url.split("/").pop() || "evidence";
        const mimetype =
          typeof entry.meta?.mimetype === "string" ? entry.meta.mimetype : "";
        const kind = detectKind(mimetype, name);
        if (!kind) {
          skipped++;
          continue;
        }
        files.push({
          url,
          name,
          mimetype,
          size: typeof entry.meta?.size === "number" ? entry.meta.size : null,
          kind,
          field,
        });
      }
    }

    // A previous agent run leaves a fixed-title note on the opportunity; report
    // it so the UI can ask before running again. Notes live under the contact
    // (with an opportunity relation), so no contact → no note to find.
    let existingReport: { noteId: string; dateAdded: string | null } | null =
      null;
    if (opportunity.contactId) {
      try {
        const note = findReportNote(
          await fetchContactNotes(opportunity.contactId),
          opportunityId,
        );
        if (note) {
          existingReport = { noteId: note.id, dateAdded: note.dateAdded ?? null };
        }
      } catch (err) {
        // Non-fatal: failing to list notes shouldn't block an import.
        log.warn("could not check for an existing report note", {
          message: err instanceof Error ? err.message : String(err),
        });
      }
    }

    log.info("opportunity imported", {
      opportunityId,
      name: opportunity.name,
      files: files.length,
      skipped,
      existingReport: existingReport?.noteId ?? "none",
    });

    return Response.json({
      opportunity: {
        id: opportunity.id,
        name: (opportunity.name ?? "").trim() || opportunity.id,
        status: opportunity.status ?? "unknown",
        contactId: opportunity.contactId ?? null,
      },
      files,
      skipped,
      existingReport,
    });
  } catch (err) {
    if (err instanceof GhlError && err.status === 404) {
      return Response.json(
        { error: "Opportunity not found — check the URL and try again." },
        { status: 404 },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error("import failed", { opportunityId, message });
    return Response.json(
      { error: `Could not fetch the opportunity from GHL: ${message}` },
      { status: 502 },
    );
  }
}
