import { ghlFetch, ghlLocationId } from "@/lib/ghl";
import {
  coreKey,
  dbaKey,
  lengthsComparable,
  matchKey,
  normalizeName,
  similarity,
} from "@/lib/company-names";

/**
 * Domain logic for migrating "Investigation on Company 1" opportunity custom
 * fields into the "Defendants" custom object, plus linking each opportunity to
 * its defendant record via the "Defendant ↔️ Litigation Matters" association.
 *
 * Scope decisions (confirmed with the user on 2026-07-10):
 * - Opportunities whose title contains a versus separator — " v. " plus the
 *   manual-entry variants " v ", " vs ", " vs. ". A capital " V/V. " is only
 *   a separator when the card has a Company 1 Legal Name; otherwise it is a
 *   person's middle initial ("Jaime V. Pages").
 * - The defendant record name comes from the Company 1 Legal Name field
 *   (opportunity.spammer_company_name); the title-parsed name (text after
 *   " v. ") is used only when that field is empty.
 * - Existing defendant records are matched case/whitespace/punctuation/
 *   accent-insensitively on their name (matchKey) and only have EMPTY fields
 *   filled — never overwritten; would-be overwrites surface as conflicts.
 *   Looser resemblances (d/b/a tails, suffix differences, fuzzy typos) are
 *   never auto-matched — the card is flagged and deselected instead.
 * - The opportunity's old Company 1 fields are left untouched.
 */

export const DEFENDANTS_OBJECT_KEY = "custom_objects.defendants";
/** Required primary display property of the Defendants object. */
export const DEFENDANT_NAME_KEY = "defendant_s";
/** Key of the user-defined "Defendant ↔️ Litigation Matters" association. */
const DEFENDANT_ASSOCIATION_KEY = "defendant__litigation_matters";

/** Company 1 Legal Name — source of the defendant record's name. */
export const LEGAL_NAME_KEY = "spammer_company_name";

/**
 * Opportunity "Company 1" custom field → Defendants custom-object field.
 * registration_state maps to defendant_registration_state (the mapping doc
 * pointed it at defendant_main_office_street — a copy-paste slip; confirmed
 * against the live schema).
 */
export const FIELD_MAP: Record<string, string> = {
  other_names_for_the_company_dba_fka_aka: "defendant_other_names_dba_fka_aka",
  company_1_website: "defendant_website",
  approximate_revenue_size: "defendant_approximate_revenue_size",
  approximate_employee_size: "defendant_approximate_employee_size",
  registration_state: "defendant_registration_state",
  company_1_main_office_street: "defendant_main_office_street",
  company_1_main_office_city: "defendant_main_office_city",
  company_1_main_office_state: "defendant_main_office_state",
  company_1_main_office_zip_code: "defendant_main_office_zip_code",
  principal_members_address_and_emails:
    "defendant_names_address_and_emails_for_principal_membershighlevel_employees",
  registered_agent_name_and_address: "defendant_registered_agent_name",
  company_1_registered_agent_street_address:
    "defendant_registered_agent_street_address",
  company_1_registered_agent_city: "defendant_registered_agent_city",
  company_1_registered_agent_state: "defendant_registered_agent_state",
  company_1_registered_agent_zip_code: "defendant_registered_agent_zip_code",
};

/** Company 2 / Company 3 investigation fields — never migrated, only flagged. */
const COMPANY_2_KEYS = [
  "other_relevant_company_name",
  "other_names_for_other_relevant_company_dba_fka_aka",
  "company_2_website",
  "second_company_approximate_revenue_size",
  "second_company_approximate_employee_size",
  "second_company_registration_state",
  "second_company_main_office_address",
  "second_company_principal_members_address_and_emails",
  "second_company_registered_agent_name_and_address",
];
const COMPANY_3_KEYS = [
  "third_relevant_company_name",
  "other_names_for_third_company_dba_fka_aka",
  "company_3_website",
  "third_company_approximate_revenue_size",
  "third_company_approximate_employee_size",
  "third_company_registration_state",
  "third_company_main_office_address",
  "third_company_principal_members_address_and_emails",
  "third_company_registered_agent_name_and_address",
];

// ---------------------------------------------------------------------------
// Types

export type PlanAction =
  | "create-and-link"
  | "update-and-link"
  | "link-only"
  | "already-linked"
  | "skip";

export type PlanConflict = {
  /** Defendant field key the values disagree on. */
  field: string;
  /** Value already on the defendant record (or set by an earlier card). */
  existing: string;
  /** This opportunity's value — NOT written, surfaced for manual review. */
  incoming: string;
};

export type PlanItem = {
  opportunityId: string;
  opportunityName: string;
  opportunityStatus: string;
  createdAt: string;
  defendantName: string | null;
  nameSource: "legal-name-field" | "title" | null;
  /** Text after the separator in the title, so mismatches are eyeballable. */
  titleName: string | null;
  /** The versus separator as typed in the title ("v.", "vs", "V.", …). */
  separator: string | null;
  /** Normalized defendant name — items sharing it resolve to one record. */
  groupKey: string | null;
  action: PlanAction;
  existingRecordId: string | null;
  existingRecordName: string | null;
  /** Defendant fields this card will set (create: its share of the record). */
  setFields: Record<string, string>;
  /**
   * Existing records that RESEMBLE the defendant name (d/b/a tail, suffix
   * difference, fuzzy typo) but were not auto-matched. Non-empty ⇒ the row is
   * flagged and deselected so a human decides create-vs-reuse.
   */
  similarExisting: { id: string; name: string; reason: string }[];
  conflicts: PlanConflict[];
  flags: string[];
  /** Whether the opportunity already has this defendant linked. */
  alreadyLinked: boolean;
  defaultSelected: boolean;
};

export type CompanyFlag = {
  opportunityId: string;
  opportunityName: string;
  company: 2 | 3;
  inScope: boolean;
  fields: Record<string, string>;
};

export type MigrationPlan = {
  generatedAt: string;
  totals: {
    opportunitiesScanned: number;
    inScope: number;
    createAndLink: number;
    updateAndLink: number;
    linkOnly: number;
    alreadyLinked: number;
    skipped: number;
    withConflicts: number;
    existingDefendantRecords: number;
  };
  items: PlanItem[];
  companyFlags: CompanyFlag[];
};

export type OpportunitySummary = {
  id: string;
  name: string;
  status: string;
  createdAt: string;
  /** Custom field values keyed by short field key (non-empty strings only). */
  fields: Record<string, string>;
  /** Defendant record ids already linked via the association. */
  linkedDefendantIds: string[];
};

export type DefendantRecord = {
  id: string;
  createdAt: string;
  properties: Record<string, string>;
};

// ---------------------------------------------------------------------------
// GHL fetchers

type RawCustomFieldValue = {
  id?: string;
  fieldValueString?: unknown;
  fieldValueLargeText?: unknown;
  fieldValue?: unknown;
};

type RawOpportunity = {
  id: string;
  name?: string;
  status?: string;
  createdAt?: string;
  customFields?: RawCustomFieldValue[];
  relations?: { objectKey?: string; recordId?: string; associationId?: string }[];
};

function textValue(raw: RawCustomFieldValue): string | null {
  for (const v of [raw.fieldValueString, raw.fieldValueLargeText, raw.fieldValue]) {
    if (typeof v === "string" && v.trim()) return v.trim();
    if (typeof v === "number") return String(v);
  }
  return null;
}

/** Map of opportunity custom-field id → short field key (no prefix). */
export async function fetchOpportunityFieldKeysById(): Promise<
  Map<string, string>
> {
  const res = await ghlFetch<{
    customFields?: { id: string; fieldKey: string }[];
  }>(`/locations/${ghlLocationId()}/customFields?model=opportunity`);
  const map = new Map<string, string>();
  for (const f of res.customFields ?? []) {
    map.set(f.id, f.fieldKey.replace(/^opportunity\./, ""));
  }
  return map;
}

export async function resolveDefendantAssociationId(): Promise<string> {
  const res = await ghlFetch<{
    associations?: { id: string; key?: string }[];
  }>(`/associations/?locationId=${ghlLocationId()}&skip=0&limit=100`);
  const match = (res.associations ?? []).find(
    (a) => a.key === DEFENDANT_ASSOCIATION_KEY,
  );
  if (!match) {
    throw new Error(
      `Association "${DEFENDANT_ASSOCIATION_KEY}" not found in this location`,
    );
  }
  return match.id;
}

export async function fetchAllOpportunities(
  fieldKeysById: Map<string, string>,
  associationId: string,
): Promise<OpportunitySummary[]> {
  const locationId = ghlLocationId();
  const pagePath = (page: number) =>
    `/opportunities/search?location_id=${locationId}&limit=100&page=${page}`;

  const first = await ghlFetch<{
    opportunities?: RawOpportunity[];
    meta?: { total?: number };
  }>(pagePath(1));
  const total = first.meta?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / 100));

  const pages: RawOpportunity[][] = [first.opportunities ?? []];
  // Fetch remaining pages with a small pool; the client-side throttle keeps
  // request starts spaced under GHL's burst limit.
  const remaining = Array.from({ length: pageCount - 1 }, (_, i) => i + 2);
  const POOL = 5;
  await Promise.all(
    Array.from({ length: POOL }, async () => {
      for (;;) {
        const page = remaining.shift();
        if (page === undefined) return;
        const res = await ghlFetch<{ opportunities?: RawOpportunity[] }>(
          pagePath(page),
        );
        pages[page - 1] = res.opportunities ?? [];
      }
    }),
  );

  const byId = new Map<string, OpportunitySummary>();
  for (const raw of pages.flat()) {
    if (!raw?.id) continue;
    const fields: Record<string, string> = {};
    for (const cf of raw.customFields ?? []) {
      const key = cf.id ? fieldKeysById.get(cf.id) : undefined;
      if (!key) continue;
      const value = textValue(cf);
      if (value) fields[key] = value;
    }
    const linkedDefendantIds = (raw.relations ?? [])
      .filter(
        (r) =>
          r.associationId === associationId ||
          r.objectKey === DEFENDANTS_OBJECT_KEY,
      )
      .map((r) => r.recordId)
      .filter((id): id is string => typeof id === "string");
    byId.set(raw.id, {
      id: raw.id,
      name: (raw.name ?? "").trim(),
      status: raw.status ?? "unknown",
      createdAt: raw.createdAt ?? "",
      fields,
      linkedDefendantIds,
    });
  }
  return [...byId.values()];
}

type RawRecord = {
  id: string;
  createdAt?: string;
  properties?: Record<string, unknown>;
};

function recordProperties(raw: RawRecord): Record<string, string> {
  const props: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw.properties ?? {})) {
    if (typeof v === "string" && v.trim()) props[k] = v.trim();
    else if (typeof v === "number") props[k] = String(v);
  }
  return props;
}

export async function fetchAllDefendantRecords(): Promise<DefendantRecord[]> {
  const locationId = ghlLocationId();
  const records: DefendantRecord[] = [];
  for (let page = 1; ; page++) {
    const res = await ghlFetch<{ records?: RawRecord[]; total?: number }>(
      `/objects/${DEFENDANTS_OBJECT_KEY}/records/search`,
      {
        method: "POST",
        body: { locationId, page, pageLimit: 100, query: "" },
      },
    );
    const batch = res.records ?? [];
    for (const raw of batch) {
      records.push({
        id: raw.id,
        createdAt: raw.createdAt ?? "",
        properties: recordProperties(raw),
      });
    }
    if (batch.length < 100 || records.length >= (res.total ?? 0)) break;
    if (page > 100) break; // hard stop against a paging bug
  }
  return records;
}

// GHL rejects record-search queries over 75 characters (422). Long names are
// truncated at a word boundary — the search only narrows candidates; the
// exact matchKey filter below decides the actual match.
const MAX_SEARCH_QUERY = 75;

function searchQueryFor(name: string): string {
  if (name.length <= MAX_SEARCH_QUERY) return name;
  const cut = name.slice(0, MAX_SEARCH_QUERY);
  const lastSpace = cut.lastIndexOf(" ");
  return (lastSpace > 40 ? cut.slice(0, lastSpace) : cut).trim();
}

/** Free-text record search, then exact normalized-name filtering. */
export async function findDefendantByName(
  name: string,
): Promise<DefendantRecord | null> {
  const res = await ghlFetch<{ records?: RawRecord[] }>(
    `/objects/${DEFENDANTS_OBJECT_KEY}/records/search`,
    {
      method: "POST",
      body: {
        locationId: ghlLocationId(),
        page: 1,
        pageLimit: 50,
        query: searchQueryFor(name),
      },
    },
  );
  const target = matchKey(name);
  for (const raw of res.records ?? []) {
    const props = recordProperties(raw);
    if (matchKey(props[DEFENDANT_NAME_KEY] ?? "") === target) {
      return { id: raw.id, createdAt: raw.createdAt ?? "", properties: props };
    }
  }
  return null;
}

export async function getDefendantRecord(id: string): Promise<DefendantRecord> {
  const res = await ghlFetch<{ record: RawRecord }>(
    `/objects/${DEFENDANTS_OBJECT_KEY}/records/${id}?locationId=${ghlLocationId()}`,
  );
  return {
    id: res.record.id,
    createdAt: res.record.createdAt ?? "",
    properties: recordProperties(res.record),
  };
}

export async function createDefendantRecord(
  properties: Record<string, string>,
): Promise<string> {
  const res = await ghlFetch<{ record: { id: string } }>(
    `/objects/${DEFENDANTS_OBJECT_KEY}/records`,
    { method: "POST", body: { locationId: ghlLocationId(), properties } },
  );
  return res.record.id;
}

/** Partial update — GHL merges the given properties into the record. */
export async function updateDefendantRecord(
  id: string,
  properties: Record<string, string>,
): Promise<void> {
  // locationId must be in the query string only; the body rejects it.
  await ghlFetch(
    `/objects/${DEFENDANTS_OBJECT_KEY}/records/${id}?locationId=${ghlLocationId()}`,
    { method: "PUT", body: { properties } },
  );
}

/** Opportunity ids already linked to this defendant record. */
export async function fetchLinkedOpportunityIds(
  recordId: string,
  associationId: string,
): Promise<Set<string>> {
  const linked = new Set<string>();
  for (let skip = 0; ; skip += 100) {
    const res = await ghlFetch<{
      relations?: {
        associationId?: string;
        secondObjectKey?: string;
        secondRecordId?: string;
      }[];
      total?: number;
    }>(
      `/associations/relations/${recordId}?locationId=${ghlLocationId()}&skip=${skip}&limit=100`,
    );
    const batch = res.relations ?? [];
    for (const r of batch) {
      if (r.associationId === associationId && r.secondRecordId) {
        linked.add(r.secondRecordId);
      }
    }
    if (batch.length < 100) break;
  }
  return linked;
}

export async function linkDefendantToOpportunity(
  recordId: string,
  opportunityId: string,
  associationId: string,
): Promise<void> {
  // Association direction: firstObjectKey is the Defendants custom object,
  // secondObjectKey is opportunity (verified against a live relation).
  await ghlFetch("/associations/relations", {
    method: "POST",
    body: {
      locationId: ghlLocationId(),
      associationId,
      firstRecordId: recordId,
      secondRecordId: opportunityId,
    },
  });
}

// ---------------------------------------------------------------------------
// Plan building (pure)

// Every versus separator seen in the data (titles are typed by hand):
// " v. " (canonical, ~367), " v " (14), " vs " (12), " vs. " (9), " V./V " (3).
// "versus" never occurs but is accepted for completeness.
const SEPARATOR_RE = /\s+(versus|vs\.|vs|v\.|v)\s+/i;

export type VersusTitle = {
  /** The separator exactly as typed, e.g. "v.", "vs", "V." */
  separator: string;
  /** Text after the separator — the would-be defendant name. */
  titleName: string | null;
  /**
   * A capital "V"/"V." is usually a middle initial ("Jaime V. Pages"), not a
   * lawsuit — callers must require corroboration (a Company 1 Legal Name)
   * before treating the card as in scope.
   */
  middleInitialRisk: boolean;
};

/** Parse an opportunity title against every known versus-separator variant. */
export function parseVersusTitle(title: string): VersusTitle | null {
  const match = SEPARATOR_RE.exec(title);
  if (!match) return null;
  const separator = match[1];
  const titleName = title.slice(match.index + match[0].length).trim() || null;
  return {
    separator,
    titleName,
    middleInitialRisk: separator === "V" || separator === "V.",
  };
}

function companyFields(
  fields: Record<string, string>,
  keys: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of keys) if (fields[key]) out[key] = fields[key];
  return out;
}

export function buildPlan(
  opportunities: OpportunitySummary[],
  defendants: DefendantRecord[],
): MigrationPlan {
  const recordsByName = new Map<string, DefendantRecord[]>();
  // Pre-computed looser keys for the similar-name scan (flag-only tiers).
  const recordKeys: { record: DefendantRecord; name: string; dba: string; core: string }[] =
    [];
  for (const record of defendants) {
    const name = record.properties[DEFENDANT_NAME_KEY] ?? "";
    const key = matchKey(name);
    if (!key) continue;
    const list = recordsByName.get(key);
    if (list) list.push(record);
    else recordsByName.set(key, [record]);
    recordKeys.push({ record, name, dba: dbaKey(name), core: coreKey(name) });
  }

  // Existing records resembling (but not equal to) a defendant name.
  const similarCache = new Map<string, PlanItem["similarExisting"]>();
  const findSimilar = (name: string): PlanItem["similarExisting"] => {
    const key = matchKey(name);
    const cached = similarCache.get(key);
    if (cached) return cached;
    const dba = dbaKey(name);
    const core = coreKey(name);
    const out: PlanItem["similarExisting"] = [];
    for (const rk of recordKeys) {
      if (matchKey(rk.name) === key) continue; // exact tier, handled elsewhere
      let reason: string | null = null;
      if (dba && rk.dba === dba) reason = "same name, d/b/a tail differs";
      else if (core && rk.core === core) reason = "corporate suffix differs";
      else if (
        core.length >= 5 &&
        rk.core.length >= 5 &&
        lengthsComparable(core, rk.core, 0.9) &&
        similarity(core, rk.core) >= 0.9
      )
        reason = "similar spelling (possible typo)";
      if (reason) {
        out.push({ id: rk.record.id, name: rk.name, reason });
        if (out.length >= 3) break;
      }
    }
    similarCache.set(key, out);
    return out;
  };

  // Virtual per-group record state so several cards mapping to one defendant
  // apply fill-empty-only semantics in order (oldest card first).
  const groups = new Map<
    string,
    {
      record: DefendantRecord | null;
      isNew: boolean;
      virtual: Record<string, string>;
      hasCreator: boolean;
    }
  >();

  // In scope = title has a versus separator; a capital "V/V." only counts
  // when a Company 1 Legal Name corroborates it (else it's a middle initial).
  const scopedTitle = (o: OpportunitySummary): VersusTitle | null => {
    const parsed = parseVersusTitle(o.name);
    if (!parsed) return null;
    if (parsed.middleInitialRisk && !o.fields[LEGAL_NAME_KEY]) return null;
    return parsed;
  };

  const inScope = opportunities
    .filter((o) => scopedTitle(o) !== null)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt));

  const items: PlanItem[] = [];
  const companyFlags: CompanyFlag[] = [];

  for (const opp of opportunities) {
    const scoped = scopedTitle(opp) !== null;
    const c2 = companyFields(opp.fields, COMPANY_2_KEYS);
    const c3 = companyFields(opp.fields, COMPANY_3_KEYS);
    if (Object.keys(c2).length) {
      companyFlags.push({
        opportunityId: opp.id,
        opportunityName: opp.name,
        company: 2,
        inScope: scoped,
        fields: c2,
      });
    }
    if (Object.keys(c3).length) {
      companyFlags.push({
        opportunityId: opp.id,
        opportunityName: opp.name,
        company: 3,
        inScope: scoped,
        fields: c3,
      });
    }
  }

  for (const opp of inScope) {
    const flags: string[] = [];
    const parsed = scopedTitle(opp)!;
    const titleName = parsed.titleName;
    if (parsed.middleInitialRisk) flags.push("uppercase-v-separator");
    else if (parsed.separator !== "v.") flags.push("nonstandard-separator");
    const legalName = opp.fields[LEGAL_NAME_KEY] ?? null;
    const defendantName = legalName ?? titleName;
    const nameSource: PlanItem["nameSource"] = legalName
      ? "legal-name-field"
      : titleName
        ? "title"
        : null;
    if (!legalName && titleName) flags.push("name-from-title");

    const mapped: [string, string][] = [];
    for (const [oppKey, defKey] of Object.entries(FIELD_MAP)) {
      const value = opp.fields[oppKey];
      if (value) mapped.push([defKey, value]);
    }
    if (!mapped.length && !legalName) flags.push("no-company1-fields");
    if (Object.keys(companyFields(opp.fields, COMPANY_2_KEYS)).length)
      flags.push("company2-data");
    if (Object.keys(companyFields(opp.fields, COMPANY_3_KEYS)).length)
      flags.push("company3-data");

    if (!defendantName) {
      items.push({
        opportunityId: opp.id,
        opportunityName: opp.name,
        opportunityStatus: opp.status,
        createdAt: opp.createdAt,
        defendantName: null,
        nameSource: null,
        titleName,
        separator: parsed.separator,
        groupKey: null,
        action: "skip",
        existingRecordId: null,
        existingRecordName: null,
        setFields: {},
        similarExisting: [],
        conflicts: [],
        flags: [...flags, "no-defendant-name"],
        alreadyLinked: false,
        defaultSelected: false,
      });
      continue;
    }

    const groupKey = matchKey(defendantName);
    let group = groups.get(groupKey);
    if (!group) {
      const matches = recordsByName.get(groupKey) ?? [];
      const record = matches[0] ?? null;
      group = {
        record,
        isNew: !record,
        virtual: { ...(record?.properties ?? {}) },
        hasCreator: false,
      };
      groups.set(groupKey, group);
    }
    if ((recordsByName.get(groupKey)?.length ?? 0) > 1) {
      flags.push("multiple-defendant-matches");
    }
    if (
      group.record &&
      normalizeName(group.record.properties[DEFENDANT_NAME_KEY] ?? "") !==
        normalizeName(defendantName)
    ) {
      // Auto-matched across punctuation/accents — informational only.
      flags.push("matched-ignoring-punctuation");
    }
    const similarExisting = group.record ? [] : findSimilar(defendantName);
    if (similarExisting.length) flags.push("similar-defendant-exists");

    const setFields: Record<string, string> = {};
    const conflicts: PlanConflict[] = [];
    for (const [defKey, value] of mapped) {
      const current = group.virtual[defKey];
      if (!current) {
        setFields[defKey] = value;
        group.virtual[defKey] = value;
      } else if (normalizeName(current) !== normalizeName(value)) {
        conflicts.push({ field: defKey, existing: current, incoming: value });
      }
    }
    if (conflicts.length) flags.push("conflicts");

    const alreadyLinked =
      group.record !== null && opp.linkedDefendantIds.includes(group.record.id);
    if (!alreadyLinked && opp.linkedDefendantIds.length > 0) {
      flags.push("linked-to-another-defendant");
    }

    let action: PlanAction;
    if (group.isNew && !group.hasCreator) {
      action = "create-and-link";
      group.hasCreator = true;
    } else if (Object.keys(setFields).length) {
      action = "update-and-link";
    } else if (alreadyLinked) {
      action = "already-linked";
    } else {
      action = "link-only";
    }

    items.push({
      opportunityId: opp.id,
      opportunityName: opp.name,
      opportunityStatus: opp.status,
      createdAt: opp.createdAt,
      defendantName,
      nameSource,
      titleName,
      separator: parsed.separator,
      groupKey,
      action,
      existingRecordId: group.record?.id ?? null,
      existingRecordName:
        group.record?.properties[DEFENDANT_NAME_KEY] ?? null,
      setFields,
      similarExisting,
      conflicts,
      flags,
      alreadyLinked,
      defaultSelected:
        action !== "already-linked" &&
        !flags.includes("linked-to-another-defendant") &&
        !flags.includes("similar-defendant-exists"),
    });
  }

  const count = (action: PlanAction) =>
    items.filter((i) => i.action === action).length;

  return {
    generatedAt: new Date().toISOString(),
    totals: {
      opportunitiesScanned: opportunities.length,
      inScope: inScope.length,
      createAndLink: count("create-and-link"),
      updateAndLink: count("update-and-link"),
      linkOnly: count("link-only"),
      alreadyLinked: count("already-linked"),
      skipped: count("skip"),
      withConflicts: items.filter((i) => i.conflicts.length).length,
      existingDefendantRecords: defendants.length,
    },
    items,
    companyFlags,
  };
}
