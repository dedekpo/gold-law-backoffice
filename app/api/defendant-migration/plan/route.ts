import { createLogger, nextRequestId } from "@/lib/logger";
import {
  buildPlan,
  fetchAllDefendantRecords,
  fetchAllOpportunities,
  fetchOpportunityFieldKeysById,
  resolveDefendantAssociationId,
} from "@/lib/defendant-migration";

const baseLog = createLogger("defendant-migration-plan");

// Read-only dry run: scans every opportunity and every Defendant record, then
// returns the full list of changes the migration WOULD make. Nothing in GHL is
// touched. Scanning ~5.5k opportunities takes on the order of 15–30s.
export async function GET() {
  const log = baseLog.child(nextRequestId());
  try {
    const done = log.start("build plan");
    const [fieldKeysById, associationId] = await Promise.all([
      fetchOpportunityFieldKeysById(),
      resolveDefendantAssociationId(),
    ]);
    const [opportunities, defendants] = await Promise.all([
      fetchAllOpportunities(fieldKeysById, associationId),
      fetchAllDefendantRecords(),
    ]);
    const plan = buildPlan(opportunities, defendants);
    done({
      opportunities: opportunities.length,
      defendants: defendants.length,
      inScope: plan.totals.inScope,
    });
    return Response.json(plan);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("plan failed", { message });
    return Response.json({ error: message }, { status: 500 });
  }
}
