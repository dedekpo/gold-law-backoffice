import { z } from "zod";
import { createLogger, nextRequestId } from "@/lib/logger";
import { GhlError } from "@/lib/ghl";
import {
  DEFENDANT_NAME_KEY,
  createDefendantRecord,
  fetchLinkedOpportunityIds,
  findDefendantByName,
  getDefendantRecord,
  linkDefendantToOpportunity,
  resolveDefendantAssociationId,
  updateDefendantRecord,
} from "@/lib/defendant-migration";

const baseLog = createLogger("defendant-migration-execute");

const itemSchema = z.object({
  opportunityId: z.string().min(1),
  opportunityName: z.string(),
  defendantName: z.string().min(1),
  groupKey: z.string().min(1),
  existingRecordId: z.string().nullable(),
  setFields: z.record(z.string(), z.string()),
});

// The client sends approved plan items in small batches (grouped so that all
// items targeting one defendant arrive in the same request).
const bodySchema = z.object({ items: z.array(itemSchema).min(1).max(60) });

type Item = z.infer<typeof itemSchema>;

export type ExecuteResult = {
  opportunityId: string;
  ok: boolean;
  recordId: string | null;
  createdRecord: boolean;
  updatedFields: string[];
  linked: boolean;
  alreadyLinked: boolean;
  error: string | null;
};

function errorMessage(err: unknown): string {
  if (err instanceof GhlError) {
    return `${err.message}: ${JSON.stringify(err.body).slice(0, 300)}`;
  }
  return err instanceof Error ? err.message : String(err);
}

export async function POST(request: Request) {
  const log = baseLog.child(nextRequestId());
  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json(
      { error: `Invalid request body: ${parsed.error.message}` },
      { status: 400 },
    );
  }

  try {
    const associationId = await resolveDefendantAssociationId();

    const groups = new Map<string, Item[]>();
    for (const item of parsed.data.items) {
      const list = groups.get(item.groupKey);
      if (list) list.push(item);
      else groups.set(item.groupKey, [item]);
    }
    log.info("executing", {
      items: parsed.data.items.length,
      groups: groups.size,
    });

    const results: ExecuteResult[] = [];
    for (const [groupKey, items] of groups) {
      try {
        // Resolve the defendant record. Re-searching by name (not just
        // trusting the plan) makes re-runs after a partial execution safe:
        // a record created moments ago is found instead of duplicated.
        const knownId = items.find((i) => i.existingRecordId)?.existingRecordId;
        let record: Awaited<ReturnType<typeof getDefendantRecord>> | null;
        if (knownId) {
          record = await getDefendantRecord(knownId);
        } else {
          const found = await findDefendantByName(items[0].defendantName);
          // The search index can lag manual edits by seconds; re-read the
          // record directly so fill-empty decisions never overwrite a value
          // an intaker typed moments ago.
          record = found ? await getDefendantRecord(found.id) : null;
        }

        // Merge every card's fields, first card wins; only fills gaps in an
        // existing record — current values are never overwritten.
        const updates: Record<string, string> = {};
        const current = record?.properties ?? {};
        for (const item of items) {
          for (const [key, value] of Object.entries(item.setFields)) {
            if (!current[key]?.trim() && !updates[key]) updates[key] = value;
          }
        }

        let createdRecord = false;
        let updatedFields: string[] = [];
        if (!record) {
          const recordId = await createDefendantRecord({
            [DEFENDANT_NAME_KEY]: items[0].defendantName,
            ...updates,
          });
          record = {
            id: recordId,
            createdAt: new Date().toISOString(),
            properties: updates,
          };
          createdRecord = true;
          updatedFields = Object.keys(updates);
          log.info("created defendant", { groupKey, recordId });
        } else if (Object.keys(updates).length) {
          await updateDefendantRecord(record.id, updates);
          updatedFields = Object.keys(updates);
          log.info("updated defendant", {
            groupKey,
            recordId: record.id,
            fields: updatedFields.length,
          });
        }

        const linkedOpportunities = createdRecord
          ? new Set<string>()
          : await fetchLinkedOpportunityIds(record.id, associationId);

        for (const item of items) {
          if (linkedOpportunities.has(item.opportunityId)) {
            results.push({
              opportunityId: item.opportunityId,
              ok: true,
              recordId: record.id,
              createdRecord,
              updatedFields,
              linked: false,
              alreadyLinked: true,
              error: null,
            });
            continue;
          }
          try {
            await linkDefendantToOpportunity(
              record.id,
              item.opportunityId,
              associationId,
            );
            results.push({
              opportunityId: item.opportunityId,
              ok: true,
              recordId: record.id,
              createdRecord,
              updatedFields,
              linked: true,
              alreadyLinked: false,
              error: null,
            });
          } catch (err) {
            results.push({
              opportunityId: item.opportunityId,
              ok: false,
              recordId: record.id,
              createdRecord,
              updatedFields,
              linked: false,
              alreadyLinked: false,
              error: `Linking failed: ${errorMessage(err)}`,
            });
          }
        }
      } catch (err) {
        const message = errorMessage(err);
        log.error("group failed", { groupKey, message });
        for (const item of items) {
          results.push({
            opportunityId: item.opportunityId,
            ok: false,
            recordId: null,
            createdRecord: false,
            updatedFields: [],
            linked: false,
            alreadyLinked: false,
            error: message,
          });
        }
      }
    }

    return Response.json({ results });
  } catch (err) {
    const message = errorMessage(err);
    log.error("execute failed", { message });
    return Response.json({ error: message }, { status: 500 });
  }
}
