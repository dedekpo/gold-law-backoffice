import { ghlFetch, ghlLocationId } from "@/lib/ghl";
import { detectKind } from "@/lib/file-kind";
import type { FileKind } from "@/lib/types";

/**
 * Shared read of a GHL opportunity plus the evidence files attached to it —
 * used by the New Case import, by run persistence (to pin GHL URLs onto the
 * stored evidence), and by the Chris-review queue page.
 */

/** Opportunity custom fields whose uploads count as case evidence. */
export const EVIDENCE_FIELD_KEYS = [
  "opportunity.violation_screenshots",
  "opportunity.violation_audio_files",
] as const;

type RawFileEntry = {
  url?: unknown;
  deleted?: unknown;
  meta?: { name?: unknown; mimetype?: unknown; size?: unknown };
};

export type RawCustomFieldValue = {
  id?: string;
  // The value property name varies by endpoint version; probe them all.
  fieldValue?: unknown;
  fieldValueArray?: unknown;
  fieldValueString?: unknown;
  value?: unknown;
};

export type EvidenceFile = {
  url: string;
  name: string;
  mimetype: string;
  size: number | null;
  kind: FileKind;
  /** Short field key the file came from, e.g. "violation_screenshots". */
  field: string;
};

export type OpportunityWithEvidence = {
  opportunity: {
    id: string;
    name: string;
    status: string;
    contactId: string | null;
    pipelineId: string | null;
    pipelineStageId: string | null;
    customFields: RawCustomFieldValue[];
  };
  files: EvidenceFile[];
  /** Files in the evidence fields whose type we don't handle (not audio/image). */
  skipped: number;
};

function fileEntries(raw: RawCustomFieldValue): RawFileEntry[] {
  for (const candidate of [raw.fieldValue, raw.fieldValueArray, raw.value]) {
    if (Array.isArray(candidate)) return candidate as RawFileEntry[];
  }
  return [];
}

/** First non-empty string value of an opportunity custom field, if any. */
export function customFieldString(
  customFields: RawCustomFieldValue[],
  fieldId: string,
): string | null {
  const cf = customFields.find((entry) => entry.id === fieldId);
  if (!cf) return null;
  const value = [cf.fieldValueString, cf.fieldValue, cf.value].find(
    (v) => typeof v === "string" && v.trim(),
  );
  return typeof value === "string" ? value.trim() : null;
}

/**
 * Fetch an opportunity and resolve the files held in its evidence FILE_UPLOAD
 * fields. Throws GhlError on API failures (a 404 means the opportunity does
 * not exist); returns null only when GHL answers without an opportunity body.
 */
export async function fetchOpportunityWithEvidence(
  opportunityId: string,
): Promise<OpportunityWithEvidence | null> {
  const [oppRes, fieldsRes] = await Promise.all([
    ghlFetch<{
      opportunity?: {
        id?: string;
        name?: string;
        status?: string;
        contactId?: string;
        pipelineId?: string;
        pipelineStageId?: string;
        customFields?: RawCustomFieldValue[];
      };
    }>(`/opportunities/${opportunityId}`),
    ghlFetch<{
      customFields?: { id: string; fieldKey: string; dataType?: string }[];
    }>(`/locations/${ghlLocationId()}/customFields?model=opportunity`),
  ]);

  const opportunity = oppRes.opportunity;
  if (!opportunity?.id) return null;

  const evidenceIds = new Map<string, string>(); // field id → short key
  for (const def of fieldsRes.customFields ?? []) {
    if ((EVIDENCE_FIELD_KEYS as readonly string[]).includes(def.fieldKey)) {
      evidenceIds.set(def.id, def.fieldKey.replace(/^opportunity\./, ""));
    }
  }

  const customFields = opportunity.customFields ?? [];
  const files: EvidenceFile[] = [];
  let skipped = 0;
  for (const cf of customFields) {
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

  return {
    opportunity: {
      id: opportunity.id,
      name: (opportunity.name ?? "").trim() || opportunity.id,
      status: opportunity.status ?? "unknown",
      contactId: opportunity.contactId ?? null,
      pipelineId: opportunity.pipelineId ?? null,
      pipelineStageId: opportunity.pipelineStageId ?? null,
      customFields,
    },
    files,
    skipped,
  };
}
