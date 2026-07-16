import { createLogger, nextRequestId } from "@/lib/logger";
import { GhlError, ghlFetch } from "@/lib/ghl";
import {
  DEFENDANT_NAME_KEY,
  LEGAL_NAME_KEY,
  fetchOpportunityFieldKeysById,
  getDefendantRecord,
  resolveDefendantAssociationId,
} from "@/lib/defendant-migration";
import { fetchRelations } from "@/lib/defendant-dedupe";

const baseLog = createLogger("defendant-sync-webhook");

/**
 * GHL-facing webhook: given an opportunity id, copies the linked Defendant
 * record's name into the opportunity's "Company 1 Legal Name" custom field
 * (opportunity.spammer_company_name) so opportunity-level merge fields and
 * workflows can use it — GHL cannot reach into associated custom objects.
 *
 * Wire-up (GHL Workflow → "Custom Webhook" action):
 *   POST https://<railway-app>/api/webhooks/defendant-sync
 *   Header: x-webhook-secret: $GO_HIGH_LEVEL_WEBHOOK_SECRET
 *   Custom data: { "opportunityId": "{{opportunity.id}}" }
 *
 * Idempotent: safe to fire repeatedly; writes only when the value changed.
 * Business rule: an opportunity has at most one defendant — if several are
 * found, the first is used and a warning is returned.
 */

// The association id and the target field id are stable per location — cache
// the lookups across invocations (reset on failure so a bad fetch can retry).
let associationIdPromise: Promise<string> | null = null;
function associationId(): Promise<string> {
  associationIdPromise ??= resolveDefendantAssociationId().catch((err) => {
    associationIdPromise = null;
    throw err;
  });
  return associationIdPromise;
}

let legalNameFieldIdPromise: Promise<string> | null = null;
function legalNameFieldId(): Promise<string> {
  legalNameFieldIdPromise ??= fetchOpportunityFieldKeysById()
    .then((byId) => {
      for (const [id, key] of byId) if (key === LEGAL_NAME_KEY) return id;
      throw new Error(
        `Opportunity custom field "${LEGAL_NAME_KEY}" not found in this location`,
      );
    })
    .catch((err) => {
      legalNameFieldIdPromise = null;
      throw err;
    });
  return legalNameFieldIdPromise;
}

/**
 * GHL webhook payloads vary by trigger/config; accept the opportunity id from
 * the documented custom-data spot plus common fallbacks.
 */
function extractOpportunityId(body: unknown): string | null {
  if (!body || typeof body !== "object") return null;
  const b = body as Record<string, unknown>;
  const customData = b.customData as Record<string, unknown> | undefined;
  const opportunity = b.opportunity as Record<string, unknown> | undefined;
  for (const candidate of [
    b.opportunityId,
    b.opportunity_id,
    customData?.opportunityId,
    customData?.opportunity_id,
    opportunity?.id,
  ]) {
    if (typeof candidate === "string" && candidate.trim()) {
      return candidate.trim();
    }
  }
  return null;
}

type OpportunityResponse = {
  opportunity?: {
    customFields?: { id?: string; fieldValue?: unknown }[];
  };
};

export async function POST(request: Request) {
  const log = baseLog.child(nextRequestId());

  // Fail closed: without a configured secret the endpoint refuses everything.
  const secret = process.env.GO_HIGH_LEVEL_WEBHOOK_SECRET;
  if (!secret) {
    log.error("GO_HIGH_LEVEL_WEBHOOK_SECRET is not set");
    return Response.json(
      { error: "Webhook secret is not configured on the server" },
      { status: 503 },
    );
  }
  if (request.headers.get("x-webhook-secret") !== secret) {
    log.warn("rejected: bad or missing x-webhook-secret");
    return Response.json({ error: "Unauthorized" }, { status: 401 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json({ error: "Body must be JSON" }, { status: 400 });
  }
  const opportunityId = extractOpportunityId(body);
  if (!opportunityId) {
    return Response.json(
      {
        error:
          'Missing opportunity id — send { "opportunityId": "{{opportunity.id}}" }',
      },
      { status: 400 },
    );
  }

  try {
    const [assocId, relations] = await Promise.all([
      associationId(),
      fetchRelations(opportunityId),
    ]);
    const defendantRelations = relations.filter(
      (r) => r.associationId === assocId,
    );
    if (defendantRelations.length === 0) {
      log.info("no defendant linked", { opportunityId });
      return Response.json({
        synced: false,
        opportunityId,
        reason: "no defendant linked to this opportunity",
      });
    }
    const warning =
      defendantRelations.length > 1
        ? `expected 1 defendant, found ${defendantRelations.length} — used the first`
        : undefined;
    if (warning) log.warn(warning, { opportunityId });

    const rel = defendantRelations[0];
    const defendantId =
      rel.firstRecordId === opportunityId ? rel.secondRecordId : rel.firstRecordId;
    const defendant = await getDefendantRecord(defendantId);
    const name = defendant.properties[DEFENDANT_NAME_KEY]?.trim();
    if (!name) {
      return Response.json({
        synced: false,
        opportunityId,
        defendantId,
        reason: "linked defendant record has no name",
      });
    }

    // Idempotency: skip the write when the field already holds the name.
    const fieldId = await legalNameFieldId();
    const opp = await ghlFetch<OpportunityResponse>(
      `/opportunities/${opportunityId}`,
    );
    const currentValue = opp.opportunity?.customFields?.find(
      (f) => f.id === fieldId,
    )?.fieldValue;
    if (typeof currentValue === "string" && currentValue.trim() === name) {
      log.info("already in sync", { opportunityId, defendantId });
      return Response.json({
        synced: true,
        changed: false,
        opportunityId,
        defendantId,
        defendantName: name,
        warning,
      });
    }

    await ghlFetch(`/opportunities/${opportunityId}`, {
      method: "PUT",
      body: { customFields: [{ id: fieldId, field_value: name }] },
    });
    log.info("synced defendant name", { opportunityId, defendantId });
    return Response.json({
      synced: true,
      changed: true,
      opportunityId,
      defendantId,
      defendantName: name,
      warning,
    });
  } catch (err) {
    const status = err instanceof GhlError ? err.status : undefined;
    const message = err instanceof Error ? err.message : String(err);
    log.error("sync failed", { opportunityId, status, message });
    // 404 from GHL means the id wasn't an opportunity (or was deleted).
    return Response.json(
      { error: message, opportunityId },
      { status: status === 404 ? 404 : 500 },
    );
  }
}
