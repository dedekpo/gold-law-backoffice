import { appendFile, mkdir } from "fs/promises";
import path from "path";
import { z } from "zod";
import { createLogger, nextRequestId } from "@/lib/logger";
import { GhlError } from "@/lib/ghl";
import {
  DEFENDANT_NAME_KEY,
  getDefendantRecord,
  linkDefendantToOpportunity,
  updateDefendantRecord,
} from "@/lib/defendant-migration";
import {
  deleteDefendantRecord,
  deleteRelation,
  fetchRelations,
} from "@/lib/defendant-dedupe";

const baseLog = createLogger("defendant-dedupe-execute");

const clusterSchema = z.object({
  survivorId: z.string().min(1),
  duplicateIds: z.array(z.string().min(1)).min(1).max(20),
});

const bodySchema = z.object({
  clusters: z.array(clusterSchema).min(1).max(20),
});

export type DedupeResult = {
  survivorId: string;
  ok: boolean;
  mergedFields: string[];
  relationsMoved: number;
  deletedIds: string[];
  error: string | null;
};

// GHL has no undelete for custom-object records, so every record is written
// to a local tombstone file (full properties + relations) BEFORE deletion. If
// the tombstone cannot be written, the delete is aborted — no recovery data,
// no deletion.
const TOMBSTONE_FILE = path.join(
  process.cwd(),
  "logs",
  "defendant-dedupe-tombstones.jsonl",
);

async function writeTombstone(entry: Record<string, unknown>): Promise<void> {
  await mkdir(path.dirname(TOMBSTONE_FILE), { recursive: true });
  await appendFile(
    TOMBSTONE_FILE,
    JSON.stringify({ deletedAt: new Date().toISOString(), ...entry }) + "\n",
  );
}

function errorMessage(err: unknown): string {
  if (err instanceof GhlError) {
    return `${err.message}: ${JSON.stringify(err.body).slice(0, 300)}`;
  }
  return err instanceof Error ? err.message : String(err);
}

// Merges each approved cluster: fills the survivor's empty fields from the
// duplicates, re-points the duplicates' opportunity links at the survivor,
// then deletes the duplicate records. Destructive — only runs on clusters the
// user explicitly approved in the UI.
export async function POST(request: Request) {
  const log = baseLog.child(nextRequestId());
  const parsed = bodySchema.safeParse(await request.json());
  if (!parsed.success) {
    return Response.json(
      { error: `Invalid request body: ${parsed.error.message}` },
      { status: 400 },
    );
  }

  const results: DedupeResult[] = [];
  for (const { survivorId, duplicateIds } of parsed.data.clusters) {
    try {
      if (duplicateIds.includes(survivorId)) {
        throw new Error("survivorId must not be listed in duplicateIds");
      }
      const survivor = await getDefendantRecord(survivorId);
      const duplicates = [];
      for (const id of duplicateIds) duplicates.push(await getDefendantRecord(id));
      // Oldest duplicate first so, when several disagree, the earliest value
      // fills the gap (same convention as the migration).
      duplicates.sort((a, b) => a.createdAt.localeCompare(b.createdAt));

      // Fill-empty merge into the survivor; its own values always win.
      const updates: Record<string, string> = {};
      for (const dup of duplicates) {
        for (const [key, value] of Object.entries(dup.properties)) {
          if (key === DEFENDANT_NAME_KEY) continue;
          if (!survivor.properties[key]?.trim() && !updates[key]) {
            updates[key] = value;
          }
        }
      }
      if (Object.keys(updates).length) {
        await updateDefendantRecord(survivorId, updates);
      }

      // Re-point opportunity links, then delete the duplicate records.
      const survivorRelations = await fetchRelations(survivorId);
      const alreadyLinked = new Set(
        survivorRelations.map((r) => `${r.associationId}:${r.secondRecordId}`),
      );
      let relationsMoved = 0;
      const deletedIds: string[] = [];
      for (const dup of duplicates) {
        const relations = await fetchRelations(dup.id);
        // Recovery data first — abort this cluster if it cannot be persisted.
        await writeTombstone({ survivorId, record: dup, relations });
        for (const rel of relations) {
          if (rel.firstRecordId !== dup.id) continue; // defendant is 1st side
          const target = `${rel.associationId}:${rel.secondRecordId}`;
          if (!alreadyLinked.has(target)) {
            await linkDefendantToOpportunity(
              survivorId,
              rel.secondRecordId,
              rel.associationId,
            );
            alreadyLinked.add(target);
            relationsMoved++;
          }
          // Remove the old link so the deleted record leaves nothing behind.
          // Non-fatal: deleting the record may cascade anyway.
          try {
            await deleteRelation(rel.id);
          } catch (err) {
            log.warn("relation delete failed (continuing)", {
              relationId: rel.id,
              message: errorMessage(err),
            });
          }
        }
        await deleteDefendantRecord(dup.id);
        deletedIds.push(dup.id);
        log.info("merged duplicate", { survivorId, deleted: dup.id });
      }

      results.push({
        survivorId,
        ok: true,
        mergedFields: Object.keys(updates),
        relationsMoved,
        deletedIds,
        error: null,
      });
    } catch (err) {
      const message = errorMessage(err);
      log.error("cluster merge failed", { survivorId, message });
      results.push({
        survivorId,
        ok: false,
        mergedFields: [],
        relationsMoved: 0,
        deletedIds: [],
        error: message,
      });
    }
  }

  return Response.json({ results });
}
