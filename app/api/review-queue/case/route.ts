import { z } from "zod";
import {
  getCaseDoc,
  saveManualInvestigation,
  type CaseDoc,
} from "@/lib/case-store";
import { GhlError } from "@/lib/ghl";
import { createLogger, nextRequestId } from "@/lib/logger";
import {
  customFieldString,
  fetchOpportunityWithEvidence,
  type EvidenceFile,
} from "@/lib/opportunity-evidence";
import { AI_FIELD_IDS } from "@/lib/opportunity-fields";

const baseLog = createLogger("review-queue-case");

/**
 * One opportunity of the review queue in full:
 *  - the Firestore case document (structured AI run + manual notes + decision),
 *  - the LIVE evidence files from GHL (URLs in stored runs can go stale;
 *    the opportunity's field values are always current),
 *  - the GHL "AI Intake" text fields as a fallback for opportunities whose
 *    run predates the database.
 *
 * PATCH saves the manual-investigation text.
 */

export type ReviewCaseResponse = {
  doc: CaseDoc | null;
  evidence: EvidenceFile[];
  ghlAiFields: {
    runStatus: string | null;
    topScore: string | null;
    companiesFound: string | null;
    companySummary: string | null;
    investigationNotes: string | null;
  };
};

export async function GET(request: Request) {
  const log = baseLog.child(nextRequestId());
  const id = new URL(request.url).searchParams.get("id");
  if (!id) {
    return Response.json({ error: "Missing id parameter" }, { status: 400 });
  }

  try {
    const [doc, live] = await Promise.all([
      getCaseDoc(id),
      fetchOpportunityWithEvidence(id),
    ]);
    if (!live) {
      return Response.json(
        { error: "GHL returned no opportunity for that id." },
        { status: 502 },
      );
    }
    const cf = live.opportunity.customFields;
    const body: ReviewCaseResponse = {
      doc,
      evidence: live.files,
      ghlAiFields: {
        runStatus: customFieldString(cf, AI_FIELD_IDS.runStatus),
        topScore: customFieldString(cf, AI_FIELD_IDS.topScore),
        companiesFound: customFieldString(cf, AI_FIELD_IDS.companiesFound),
        companySummary: customFieldString(cf, AI_FIELD_IDS.companySummary),
        investigationNotes: customFieldString(
          cf,
          AI_FIELD_IDS.investigationNotes,
        ),
      },
    };
    log.info("case loaded", {
      opportunityId: id,
      hasRun: Boolean(doc?.run),
      evidence: live.files.length,
    });
    return Response.json(body);
  } catch (err) {
    if (err instanceof GhlError && err.status === 404) {
      return Response.json(
        { error: "Opportunity not found in GHL." },
        { status: 404 },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error("case load failed", { opportunityId: id, message });
    return Response.json(
      { error: `Could not load the case: ${message}` },
      { status: 502 },
    );
  }
}

const patchSchema = z.object({
  id: z.string().min(1),
  manualText: z.string(),
});

export async function PATCH(request: Request) {
  const log = baseLog.child(nextRequestId());
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request body: expected { id, manualText }" },
      { status: 400 },
    );
  }
  const { id, manualText } = parsed.data;
  try {
    const manual = {
      text: manualText,
      updatedAt: new Date().toISOString(),
    };
    await saveManualInvestigation(id, manual);
    log.info("manual investigation saved", {
      opportunityId: id,
      chars: manualText.length,
    });
    return Response.json({ ok: true, manual });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("manual save failed", { opportunityId: id, message });
    return Response.json(
      { error: `Could not save the manual investigation: ${message}` },
      { status: 502 },
    );
  }
}
