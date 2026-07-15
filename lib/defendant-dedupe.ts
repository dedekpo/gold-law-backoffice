import { ghlFetch, ghlLocationId } from "@/lib/ghl";
import {
  coreKey,
  dbaKey,
  lengthsComparable,
  matchKey,
  normalizeName,
  similarity,
} from "@/lib/company-names";
import {
  DEFENDANTS_OBJECT_KEY,
  DEFENDANT_NAME_KEY,
  type DefendantRecord,
} from "@/lib/defendant-migration";

/**
 * Duplicate detection + merge planning for records already inside the
 * Defendants custom object. Tiers (tightest first):
 *  - "punctuation": names equal ignoring case/punctuation/accents — certain.
 *  - "dba":         equal once the d/b/a tail is cut — very likely.
 *  - "suffix":      equal once corporate suffixes are stripped — needs eyes
 *                   (LLC vs Corp can be different legal entities).
 *  - "fuzzy":       ≥0.9 edit similarity on the core name — possible typo.
 * Only "punctuation" clusters without field conflicts start selected.
 */

export type DedupeTier = "punctuation" | "dba" | "suffix" | "fuzzy";

export type DedupeRecordInfo = {
  id: string;
  name: string;
  createdAt: string;
  /** Count of non-empty properties besides the name. */
  filledFields: number;
  /** Opportunities linked via any association. */
  linkedOpportunityIds: string[];
};

export type DedupeCluster = {
  /** Stable key for UI state — the sorted record ids joined. */
  key: string;
  tier: DedupeTier;
  records: DedupeRecordInfo[];
  suggestedSurvivorId: string;
  /** Fields where member records disagree — survivor's value would win. */
  conflicts: { field: string; values: { name: string; value: string }[] }[];
  defaultSelected: boolean;
};

export type DedupePlan = {
  generatedAt: string;
  totalRecords: number;
  clusters: DedupeCluster[];
};

// ---------------------------------------------------------------------------
// Clustering (pure)

class UnionFind {
  private parent = new Map<string, string>();
  find(x: string): string {
    let root = this.parent.get(x) ?? x;
    if (root !== x) {
      root = this.find(root);
      this.parent.set(x, root);
    }
    return root;
  }
  union(a: string, b: string): void {
    const ra = this.find(a);
    const rb = this.find(b);
    if (ra !== rb) this.parent.set(ra, rb);
  }
}

export function clusterDefendants(
  records: DefendantRecord[],
): { tier: DedupeTier; records: DefendantRecord[] }[] {
  const named = records.filter(
    (r) => (r.properties[DEFENDANT_NAME_KEY] ?? "").trim().length > 0,
  );
  const nameOf = (r: DefendantRecord) => r.properties[DEFENDANT_NAME_KEY]!;

  const uf = new UnionFind();
  const byKey = (fn: (s: string) => string) => {
    const buckets = new Map<string, DefendantRecord[]>();
    for (const r of named) {
      const k = fn(nameOf(r));
      if (!k) continue;
      const list = buckets.get(k);
      if (list) list.push(r);
      else buckets.set(k, [r]);
    }
    for (const list of buckets.values()) {
      for (let i = 1; i < list.length; i++) uf.union(list[0].id, list[i].id);
    }
  };
  byKey(matchKey);
  byKey(dbaKey);
  byKey(coreKey);

  // Fuzzy tier: pairwise over unique core keys (with cheap prefilters).
  const coreOf = named.map((r) => ({ r, core: coreKey(nameOf(r)) }));
  for (let i = 0; i < coreOf.length; i++) {
    const a = coreOf[i];
    if (a.core.length < 5) continue;
    for (let j = i + 1; j < coreOf.length; j++) {
      const b = coreOf[j];
      if (b.core.length < 5) continue;
      if (a.core === b.core) continue; // already unioned by coreKey
      if (!lengthsComparable(a.core, b.core, 0.9)) continue;
      if (similarity(a.core, b.core) >= 0.9) uf.union(a.r.id, b.r.id);
    }
  }

  const clusters = new Map<string, DefendantRecord[]>();
  for (const r of named) {
    const root = uf.find(r.id);
    const list = clusters.get(root);
    if (list) list.push(r);
    else clusters.set(root, [r]);
  }

  const out: { tier: DedupeTier; records: DefendantRecord[] }[] = [];
  for (const members of clusters.values()) {
    if (members.length < 2) continue;
    // Skip clusters where every member is literally the same string — those
    // are distinct records sharing one name, which the MIGRATION flags as
    // "multiple-defendant-matches"; merging identical names is still valid,
    // so keep them (they land in the "punctuation" tier).
    const names = members.map(nameOf);
    const tier: DedupeTier = names.every(
      (n) => matchKey(n) === matchKey(names[0]),
    )
      ? "punctuation"
      : names.every((n) => dbaKey(n) === dbaKey(names[0]))
        ? "dba"
        : names.every((n) => coreKey(n) === coreKey(names[0]))
          ? "suffix"
          : "fuzzy";
    out.push({ tier, records: members });
  }
  const order: DedupeTier[] = ["punctuation", "dba", "suffix", "fuzzy"];
  out.sort(
    (a, b) =>
      order.indexOf(a.tier) - order.indexOf(b.tier) ||
      a.records[0].properties[DEFENDANT_NAME_KEY]!.localeCompare(
        b.records[0].properties[DEFENDANT_NAME_KEY]!,
      ),
  );
  return out;
}

export function buildDedupeCluster(
  tier: DedupeTier,
  records: DefendantRecord[],
  linkedByRecord: Map<string, string[]>,
): DedupeCluster {
  const infos: DedupeRecordInfo[] = records.map((r) => ({
    id: r.id,
    name: r.properties[DEFENDANT_NAME_KEY] ?? "",
    createdAt: r.createdAt,
    filledFields: Object.keys(r.properties).filter(
      (k) => k !== DEFENDANT_NAME_KEY,
    ).length,
    linkedOpportunityIds: linkedByRecord.get(r.id) ?? [],
  }));

  // Suggested survivor: most linked opportunities, then most data, then oldest.
  const survivor = [...infos].sort(
    (a, b) =>
      b.linkedOpportunityIds.length - a.linkedOpportunityIds.length ||
      b.filledFields - a.filledFields ||
      a.createdAt.localeCompare(b.createdAt),
  )[0];

  const conflicts: DedupeCluster["conflicts"] = [];
  const fields = new Set<string>();
  for (const r of records) {
    for (const k of Object.keys(r.properties)) {
      if (k !== DEFENDANT_NAME_KEY) fields.add(k);
    }
  }
  for (const field of fields) {
    const values = records
      .filter((r) => r.properties[field]?.trim())
      .map((r) => ({
        name: r.properties[DEFENDANT_NAME_KEY] ?? r.id,
        value: r.properties[field],
      }));
    const distinct = new Set(values.map((v) => normalizeName(v.value)));
    if (distinct.size > 1) conflicts.push({ field, values });
  }

  return {
    key: records
      .map((r) => r.id)
      .sort()
      .join("+"),
    tier,
    records: infos,
    suggestedSurvivorId: survivor.id,
    conflicts,
    defaultSelected: tier === "punctuation" && conflicts.length === 0,
  };
}

// ---------------------------------------------------------------------------
// GHL relation helpers (dedupe-specific)

export type Relation = {
  id: string;
  associationId: string;
  firstRecordId: string;
  secondRecordId: string;
};

/** Every relation where the given record is either side. */
export async function fetchRelations(recordId: string): Promise<Relation[]> {
  const out: Relation[] = [];
  for (let skip = 0; ; skip += 100) {
    const res = await ghlFetch<{ relations?: Relation[] }>(
      `/associations/relations/${recordId}?locationId=${ghlLocationId()}&skip=${skip}&limit=100`,
    );
    const batch = res.relations ?? [];
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
}

export async function deleteRelation(relationId: string): Promise<void> {
  // The records DELETE endpoint rejects a locationId query param; try the
  // documented form first and fall back to the bare path on a 422.
  try {
    await ghlFetch(
      `/associations/relations/${relationId}?locationId=${ghlLocationId()}`,
      { method: "DELETE" },
    );
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status !== 422) throw err;
    await ghlFetch(`/associations/relations/${relationId}`, {
      method: "DELETE",
    });
  }
}

export async function deleteDefendantRecord(id: string): Promise<void> {
  // Verified: this endpoint rejects a locationId query param.
  await ghlFetch(`/objects/${DEFENDANTS_OBJECT_KEY}/records/${id}`, {
    method: "DELETE",
  });
}
