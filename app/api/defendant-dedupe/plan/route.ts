import { createLogger, nextRequestId } from "@/lib/logger";
import { fetchAllDefendantRecords } from "@/lib/defendant-migration";
import {
  buildDedupeCluster,
  clusterDefendants,
  fetchRelations,
  type DedupePlan,
} from "@/lib/defendant-dedupe";

const baseLog = createLogger("defendant-dedupe-plan");

// Read-only: fetches every Defendant record, clusters similar names, and (for
// clustered records only) fetches their opportunity links so the UI can pick a
// sensible survivor. Nothing in GHL is modified.
export async function GET() {
  const log = baseLog.child(nextRequestId());
  try {
    const done = log.start("build dedupe plan");
    const records = await fetchAllDefendantRecords();
    const rawClusters = clusterDefendants(records);

    // Relations are only needed for records that are in a cluster.
    const linkedByRecord = new Map<string, string[]>();
    for (const cluster of rawClusters) {
      for (const record of cluster.records) {
        const relations = await fetchRelations(record.id);
        linkedByRecord.set(
          record.id,
          relations
            .map((r) =>
              r.firstRecordId === record.id ? r.secondRecordId : r.firstRecordId,
            )
            .filter(Boolean),
        );
      }
    }

    const plan: DedupePlan = {
      generatedAt: new Date().toISOString(),
      totalRecords: records.length,
      clusters: rawClusters.map((c) =>
        buildDedupeCluster(c.tier, c.records, linkedByRecord),
      ),
    };
    done({ records: records.length, clusters: plan.clusters.length });
    return Response.json(plan);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("dedupe plan failed", { message });
    return Response.json({ error: message }, { status: 500 });
  }
}
