import { z } from "zod";
import { GhlError } from "@/lib/ghl";
import {
  appendLogEntry,
  createInvestigation,
  updateInvestigation,
  newId,
  type InvestigationEvidence,
} from "@/lib/investigation-store";
import { createLogger, nextRequestId } from "@/lib/logger";
import {
  ALL_EVIDENCE_FIELD_KEYS,
  fetchOpportunityWithEvidence,
} from "@/lib/opportunity-evidence";

const baseLog = createLogger("investigation-create");

/**
 * Open a manual investigation on an intake opportunity (Phase 3): create the
 * Firestore doc (status "open") and import the opportunity's current GHL
 * evidence-field files as role "raw" — the client-sent batch the investigator
 * will vet. Multiple investigations per opportunity are by design (serial
 * clients reuse their intake opportunity), so this always creates a new doc.
 */

const bodySchema = z.object({
  opportunityId: z.string().min(1),
  actorName: z.string().min(1).max(80),
});

export async function POST(request: Request) {
  const log = baseLog.child(nextRequestId());
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }
  const { opportunityId, actorName } = parsed.data;
  const actor = { kind: "human" as const, name: actorName.trim() };

  try {
    const live = await fetchOpportunityWithEvidence(
      opportunityId,
      ALL_EVIDENCE_FIELD_KEYS,
    );
    if (!live) {
      return Response.json(
        { error: "GHL returned no opportunity for that id." },
        { status: 502 },
      );
    }

    const doc = await createInvestigation({
      opportunityId: live.opportunity.id,
      opportunityName: live.opportunity.name,
      contactId: live.opportunity.contactId,
      pipelineId: live.opportunity.pipelineId,
    });

    const now = new Date().toISOString();
    const evidence: InvestigationEvidence[] = live.files.map((f) => ({
      id: newId(),
      name: f.name,
      kind: f.kind,
      mimetype: f.mimetype,
      size: f.size,
      role: "raw",
      source: "ghl_field",
      storageUrl: null,
      ghlUrl: f.url,
      ghlField: f.field,
      text: null,
      companyIds: [],
      addedAt: now,
      addedBy: actor,
    }));
    if (evidence.length) await updateInvestigation(doc.id, { evidence });

    const updated = await appendLogEntry(doc.id, {
      at: now,
      author: actor,
      text: evidence.length
        ? `Investigation opened. Imported ${evidence.length} client-sent file(s) from GHL as raw evidence.`
        : "Investigation opened.",
      evidenceIds: [],
    });

    log.info("investigation opened", {
      opportunityId,
      investigationId: doc.id,
      importedEvidence: evidence.length,
    });
    return Response.json({
      doc: { ...doc, evidence, log: [updated] },
    });
  } catch (err) {
    if (err instanceof GhlError && err.status === 404) {
      return Response.json(
        { error: "Opportunity not found in GHL." },
        { status: 404 },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error("open investigation failed", { opportunityId, message });
    return Response.json(
      { error: `Could not open the investigation: ${message}` },
      { status: 502 },
    );
  }
}
