import { z } from "zod";
import { GhlError, ghlFetch, ghlUploadCustomFieldFile } from "@/lib/ghl";
import { createLogger, nextRequestId } from "@/lib/logger";
import { AI_FIELD_IDS, RUN_STATUS } from "@/lib/opportunity-fields";

const baseLog = createLogger("opportunity-report");

/**
 * Persist a finished agent run to the opportunity's "AI Intake" custom fields:
 * the aggregated skim-layer values plus the full PDF report in the FILE_UPLOAD
 * field. GHL is the database — a non-empty "AI Run Status" field is what marks
 * an opportunity as already processed. Re-runs overwrite every field (the PDF
 * entry is replaced, not appended).
 *
 * Multipart request: `payload` (JSON string, schema below) + `report` (the PDF).
 */

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
    return Response.json({ ok: true });
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
