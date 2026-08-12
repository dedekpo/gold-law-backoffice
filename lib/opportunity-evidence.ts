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

/**
 * Every upload field that can hold investigation-relevant files — the AI's
 * evidence fields plus prequalified evidence and the per-company consumer
 * complaint screenshots. Used by the unified investigation view; the AI agent
 * keeps reading only EVIDENCE_FIELD_KEYS.
 */
export const ALL_EVIDENCE_FIELD_KEYS = [
  ...EVIDENCE_FIELD_KEYS,
  "opportunity.prequalified_screenshots",
  "opportunity.if_yes_attach_screen_shots_of_complaints",
  "opportunity.if_yes_attach_screen_shots_of_complaints_for_second_company",
  "opportunity.if_yes_attach_screen_shots_of_complaints_for_third_company",
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

/** One opportunity custom-field definition (id ↔ key ↔ display name). */
export type CustomFieldDef = {
  id: string;
  /** Full key, e.g. "opportunity.violation_screenshots". */
  fieldKey: string;
  name: string;
  dataType: string | null;
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
  /** Every opportunity custom-field definition of the location. */
  fieldDefs: CustomFieldDef[];
};

function fileEntries(raw: RawCustomFieldValue): RawFileEntry[] {
  for (const candidate of [raw.fieldValue, raw.fieldValueArray, raw.value]) {
    if (Array.isArray(candidate)) return candidate as RawFileEntry[];
  }
  return [];
}

/**
 * Human-readable value of any non-file custom field: strings verbatim,
 * option arrays joined. File arrays and structured values (TEXTBOX_LIST)
 * return null — they are not display text.
 */
export function customFieldDisplayValue(
  customFields: RawCustomFieldValue[],
  fieldId: string,
): string | null {
  const cf = customFields.find((entry) => entry.id === fieldId);
  if (!cf) return null;
  for (const v of [cf.fieldValueString, cf.fieldValue, cf.fieldValueArray, cf.value]) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
    if (Array.isArray(v) && v.every((item) => typeof item === "string")) {
      const joined = (v as string[]).filter((s) => s.trim()).join(", ");
      if (joined) return joined;
    }
  }
  return null;
}

/** Raw file entries (url + metadata) of a FILE_UPLOAD custom field. */
export function customFieldFiles(
  customFields: RawCustomFieldValue[],
  fieldId: string,
): Array<{ url: string; name: string }> {
  const cf = customFields.find((entry) => entry.id === fieldId);
  if (!cf) return [];
  return fileEntries(cf)
    .filter((entry) => entry.deleted !== true && typeof entry.url === "string")
    .map((entry) => ({
      url: entry.url as string,
      name:
        typeof entry.meta?.name === "string" && entry.meta.name
          ? entry.meta.name
          : (entry.url as string).split("/").pop() || "file",
    }));
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
  evidenceKeys: readonly string[] = EVIDENCE_FIELD_KEYS,
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
      customFields?: { id: string; fieldKey: string; name?: string; dataType?: string }[];
    }>(`/locations/${ghlLocationId()}/customFields?model=opportunity`),
  ]);

  const opportunity = oppRes.opportunity;
  if (!opportunity?.id) return null;

  const fieldDefs: CustomFieldDef[] = (fieldsRes.customFields ?? []).map(
    (def) => ({
      id: def.id,
      fieldKey: def.fieldKey,
      name: def.name ?? def.fieldKey,
      dataType: def.dataType ?? null,
    }),
  );

  const evidenceIds = new Map<string, string>(); // field id → short key
  for (const def of fieldDefs) {
    if (evidenceKeys.includes(def.fieldKey)) {
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
    fieldDefs,
  };
}
