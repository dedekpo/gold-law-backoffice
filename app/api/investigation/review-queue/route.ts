import { listInvestigationsByStatus } from "@/lib/investigation-store";
import { createLogger, nextRequestId } from "@/lib/logger";

const baseLog = createLogger("investigation-review-queue");

/**
 * Every investigation awaiting review (status "ready_for_review"), for the
 * converged queue on /case-review. Entries link to the investigation view,
 * where the reviewer approves by executing the split, sends the investigation
 * back, or closes it with a no-case outcome.
 */

export type InvestigationQueueEntry = {
  investigationId: string;
  opportunityId: string;
  opportunityName: string;
  /** Last touch on the doc — effectively when it was submitted. */
  updatedAt: string;
  companies: number;
  confirmedCompanies: number;
  confirmedViolations: number;
  evidence: number;
};

export async function GET() {
  const log = baseLog.child(nextRequestId());
  try {
    const docs = await listInvestigationsByStatus("ready_for_review");
    const entries: InvestigationQueueEntry[] = docs.map((d) => ({
      investigationId: d.id,
      opportunityId: d.source.opportunityId,
      opportunityName: d.source.opportunityName,
      updatedAt: d.updatedAt,
      companies: d.companies.length,
      confirmedCompanies: d.companies.filter((c) => c.status === "confirmed")
        .length,
      confirmedViolations: d.violations.filter((v) => v.status === "confirmed")
        .length,
      evidence: d.evidence.length,
    }));
    log.info("investigation queue listed", { count: entries.length });
    return Response.json({ entries });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("investigation queue failed", { message });
    return Response.json(
      { error: `Could not load the investigation queue: ${message}` },
      { status: 502 },
    );
  }
}
