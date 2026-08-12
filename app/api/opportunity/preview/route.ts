import { GhlError } from "@/lib/ghl";
import { createLogger, nextRequestId } from "@/lib/logger";
import {
  customFieldString,
  fetchOpportunityWithEvidence,
} from "@/lib/opportunity-evidence";
import { AI_FIELD_IDS } from "@/lib/opportunity-fields";
import type { FileKind } from "@/lib/types";

const baseLog = createLogger("opportunity-preview");

/**
 * Read-only look at an opportunity before a run: its evidence files (the same
 * fields the import reads) and whether the agent already ran. Strictly no
 * side effects — unlike the import, no DNC lookup, no write-backs, no stage
 * move — so the AI desk can preview a docket entry freely.
 */

export type OpportunityPreviewResponse = {
  opportunity: { id: string; name: string };
  files: { url: string; name: string; kind: FileKind }[];
  /** Files in the evidence fields whose type we don't handle. */
  skipped: number;
  /** Set when the opportunity's "AI Run Status" field shows a previous run. */
  existingRun: { status: string } | null;
};

export async function GET(request: Request) {
  const log = baseLog.child(nextRequestId());
  const opportunityId = new URL(request.url).searchParams.get("opp");
  if (!opportunityId) {
    return Response.json({ error: "Expected ?opp=<id>." }, { status: 400 });
  }

  try {
    const result = await fetchOpportunityWithEvidence(opportunityId);
    if (!result) {
      return Response.json(
        { error: "GHL returned no opportunity for that id." },
        { status: 502 },
      );
    }
    const { opportunity, files, skipped } = result;
    const statusValue = customFieldString(
      opportunity.customFields,
      AI_FIELD_IDS.runStatus,
    );

    log.info("opportunity previewed", {
      opportunityId,
      files: files.length,
      skipped,
    });
    return Response.json({
      opportunity: { id: opportunity.id, name: opportunity.name },
      files: files.map((f) => ({ url: f.url, name: f.name, kind: f.kind })),
      skipped,
      existingRun: statusValue ? { status: statusValue } : null,
    } satisfies OpportunityPreviewResponse);
  } catch (err) {
    if (err instanceof GhlError && err.status === 404) {
      return Response.json(
        { error: "Opportunity not found in GHL." },
        { status: 404 },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error("preview failed", { opportunityId, message });
    return Response.json(
      { error: `Could not fetch the opportunity from GHL: ${message}` },
      { status: 502 },
    );
  }
}
