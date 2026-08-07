import { z } from "zod";
import type { CaseRunSnapshot } from "@/lib/case-snapshot";
import { saveRun, type StoredEvidenceFile } from "@/lib/case-store";
import { GhlError, ghlFetch, ghlUploadCustomFieldFile } from "@/lib/ghl";
import { createLogger, nextRequestId } from "@/lib/logger";
import { fetchOpportunityWithEvidence } from "@/lib/opportunity-evidence";
import { AI_FIELD_IDS, RUN_STATUS } from "@/lib/opportunity-fields";

const baseLog = createLogger("opportunity-report");

/**
 * Persist a finished agent run twice over:
 *  1. To the opportunity's "AI Intake" custom fields — the aggregated
 *     skim-layer values plus the full PDF report in the FILE_UPLOAD field.
 *     A non-empty "AI Run Status" field is what marks an opportunity as
 *     already processed. Re-runs overwrite every field.
 *  2. To Firestore (`cases/{opportunityId}`) — the full structured snapshot,
 *     with each evidence file pinned to GHL's stored copy, so the review
 *     queue can query everything without scraping text fields. Best-effort:
 *     a Firestore failure is reported in the response but never fails the
 *     GHL write.
 *
 * Multipart request: `payload` (JSON string, schema below) + `report` (the PDF).
 */

// The snapshot's nested domain shapes (facts, defendants, forensics, …) are
// produced by our own typed client from lib/types.ts; validate the envelope
// strictly and carry the domain payloads through as-is.
const snapshotSchema = z.object({
  caseName: z.string(),
  createdAt: z.number(),
  completedAt: z.number().nullable(),
  files: z.array(
    z.object({
      name: z.string(),
      kind: z.enum(["audio", "image"]),
      text: z.string().nullable(),
      forensics: z.unknown().nullable(),
    }),
  ),
  dnc: z.unknown().nullable(),
  facts: z.unknown().nullable(),
  gate: z.unknown().nullable(),
  defendants: z.array(z.unknown()),
  defendantSearchTerms: z.array(z.string()),
  defendantInvestigation: z.string().nullable(),
  defendantSosError: z.string().nullable(),
  defendantUnmatchedSos: z.array(z.unknown()),
});

const payloadSchema = z.object({
  opportunityId: z.string().min(1),
  values: z.object({
    // Must be one of the field's configured options, verbatim.
    runStatus: z.enum([
      RUN_STATUS.found,
      RUN_STATUS.none,
      RUN_STATUS.timeBarred,
      RUN_STATUS.noClaim,
    ]),
    topScore: z.string(),
    companiesFound: z.string(),
    violations: z.array(z.string()),
    companySummary: z.string(),
    investigationNotes: z.string(),
  }),
  // Optional so an older client tab that predates the DB layer still saves.
  snapshot: snapshotSchema.optional(),
});

export const maxDuration = 60;

export async function POST(request: Request) {
  const log = baseLog.child(nextRequestId());

  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return Response.json(
      { error: "Expected multipart form data with `payload` and `report`." },
      { status: 400 },
    );
  }
  const rawPayload = form.get("payload");
  const report = form.get("report");
  const parsed = payloadSchema.safeParse(
    typeof rawPayload === "string"
      ? (() => {
          try {
            return JSON.parse(rawPayload);
          } catch {
            return null;
          }
        })()
      : null,
  );
  if (!parsed.success || !(report instanceof Blob)) {
    return Response.json(
      { error: "Invalid payload or missing PDF report." },
      { status: 400 },
    );
  }
  const { opportunityId, values } = parsed.data;
  const snapshot = parsed.data.snapshot as CaseRunSnapshot | undefined;

  try {
    const uploaded = await ghlUploadCustomFieldFile(
      AI_FIELD_IDS.reportFiles,
      report,
      "AI Intake Report.pdf",
    );

    await ghlFetch(`/opportunities/${opportunityId}`, {
      method: "PUT",
      body: {
        customFields: [
          { id: AI_FIELD_IDS.runStatus, field_value: values.runStatus },
          { id: AI_FIELD_IDS.topScore, field_value: values.topScore },
          { id: AI_FIELD_IDS.companiesFound, field_value: values.companiesFound },
          { id: AI_FIELD_IDS.violations, field_value: values.violations },
          { id: AI_FIELD_IDS.companySummary, field_value: values.companySummary },
          {
            id: AI_FIELD_IDS.investigationNotes,
            field_value: values.investigationNotes,
          },
          {
            id: AI_FIELD_IDS.reportFiles,
            field_value: [
              {
                url: uploaded.url,
                meta: {
                  mimetype: uploaded.mimetype,
                  name: "AI Intake Report.pdf",
                  size: uploaded.size,
                },
                deleted: false,
              },
            ],
          },
        ],
      },
    });

    log.info("run persisted to AI Intake fields", {
      opportunityId,
      runStatus: values.runStatus,
      pdfBytes: uploaded.size,
    });

    let dbSaved = false;
    if (snapshot) {
      try {
        await persistRunToFirestore(opportunityId, snapshot, values);
        dbSaved = true;
        log.info("run persisted to Firestore", { opportunityId });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.error("Firestore persist failed", { opportunityId, message });
      }
    }

    return Response.json({ ok: true, dbSaved });
  } catch (err) {
    if (err instanceof GhlError && err.status === 404) {
      return Response.json(
        { error: "Opportunity not found in GHL." },
        { status: 404 },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error("persisting run failed", { opportunityId, message });
    return Response.json(
      { error: `Could not save the run to GHL: ${message}` },
      { status: 502 },
    );
  }
}

/**
 * Store the structured run in Firestore, pinning each snapshot file to the
 * GHL-stored copy of the same evidence (matched by filename) so the review
 * page can render the actual image/audio later.
 */
async function persistRunToFirestore(
  opportunityId: string,
  snapshot: CaseRunSnapshot,
  aiFields: z.infer<typeof payloadSchema>["values"],
): Promise<void> {
  const live = await fetchOpportunityWithEvidence(opportunityId);
  const byName = new Map(
    (live?.files ?? []).map((f) => [f.name, f] as const),
  );

  const files: StoredEvidenceFile[] = snapshot.files.map((f) => {
    const ghl = byName.get(f.name);
    return {
      name: f.name,
      kind: f.kind,
      mimetype: ghl?.mimetype ?? "",
      size: ghl?.size ?? null,
      ghlUrl: ghl?.url ?? null,
      field: ghl?.field ?? null,
      text: f.text,
      forensics: f.forensics ?? null,
    };
  });

  await saveRun(
    {
      id: opportunityId,
      name: live?.opportunity.name ?? snapshot.caseName,
      contactId: live?.opportunity.contactId ?? null,
    },
    {
      ...snapshot,
      savedAt: new Date().toISOString(),
      files,
      aiFields,
    },
  );
}
