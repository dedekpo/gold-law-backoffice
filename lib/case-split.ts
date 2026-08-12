import { matchKey } from "@/lib/company-names";
import {
  DEFENDANT_NAME_KEY,
  createDefendantRecord,
  fetchOpportunityFieldKeysById,
  findDefendantByName,
  LEGAL_NAME_KEY,
  linkDefendantToOpportunity,
  resolveDefendantAssociationId,
  updateDefendantRecord,
} from "@/lib/defendant-migration";
import { SCREEN_LABELS } from "@/lib/display";
import { downloadEvidenceObject } from "@/lib/evidence-storage";
import { ghlFetch, ghlLocationId, ghlUploadCustomFieldFile } from "@/lib/ghl";
import {
  appendLogEntry,
  createInvestigation,
  getInvestigation,
  listInvestigationsForOpportunity,
  updateInvestigation,
  type Actor,
  type InvestigationCompany,
  type InvestigationDoc,
  type InvestigationEvidence,
  type SpawnedCase,
} from "@/lib/investigation-store";
import { createLogger } from "@/lib/logger";
import {
  INVESTIGATION_URL_FIELD_ID,
  investigationUrlFor,
} from "@/lib/opportunity-fields";
import { splitReadiness, type SplitReadiness } from "@/lib/split-readiness";
import type { DefendantCandidate, ScreenId } from "@/lib/types";

const log = createLogger("case-split");

/**
 * The split: the terminal action of an investigation. For each confirmed
 * company the operator selected, spawn a defendant-centric case opportunity in
 * the signup pipeline ("Client v. Company, LLC"), create-or-reuse its
 * Defendant custom-object record, associate the two, and hand the child a
 * COMPLETE case file: its confirmed evidence copied into its violation upload
 * fields, its confirmed violations + basis text on its custom fields, and its
 * own editable investigation doc for the legal-review stages. The
 * client-centric intake opportunity is ALWAYS retired to the "Converted to
 * Case(s)" stage — never promoted or renamed — so serial clients keep one
 * intake opportunity forever.
 *
 * Stages are matched by normalized name (same convention as review-queue.ts)
 * so cosmetic renames in GHL fail loudly instead of moving cards to the wrong
 * place.
 */

export const INTAKE_PIPELINE_NAME = "01 Intake-Investigation Pipeline";
export const CONVERTED_STAGE_NAME = "⚖️ Converted to Case(s)";
export const CASE_PIPELINE_NAME = "02 New Client Signup Pipeline";
export const CASE_ENTRY_STAGE_NAME = "👩‍⚖️ Legal Approval - Potential Case";

export type SplitStages = {
  intake: { pipelineId: string; converted: { id: string; name: string } };
  case: { pipelineId: string; entry: { id: string; name: string } };
};

const normName = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]/g, "");

type RawPipeline = {
  id: string;
  name?: string;
  stages?: { id: string; name?: string }[];
};

export async function resolveSplitStages(): Promise<SplitStages> {
  const res = await ghlFetch<{ pipelines?: RawPipeline[] }>(
    `/opportunities/pipelines?locationId=${ghlLocationId()}`,
  );
  const pipelines = res.pipelines ?? [];
  const pipeline = (wanted: string) => {
    const match = pipelines.find((p) => normName(p.name ?? "") === normName(wanted));
    if (!match) {
      const names = pipelines.map((p) => p.name).filter(Boolean).join(", ");
      throw new Error(`Pipeline "${wanted}" not found. Available: ${names}`);
    }
    return match;
  };
  const stage = (p: RawPipeline, wanted: string) => {
    const match = (p.stages ?? []).find(
      (s) => normName(s.name ?? "") === normName(wanted),
    );
    if (!match) {
      const names = (p.stages ?? []).map((s) => s.name).filter(Boolean).join(", ");
      throw new Error(
        `Stage "${wanted}" not found in pipeline "${p.name}". Available: ${names}`,
      );
    }
    return { id: match.id, name: match.name ?? wanted };
  };

  const intake = pipeline(INTAKE_PIPELINE_NAME);
  const cases = pipeline(CASE_PIPELINE_NAME);
  return {
    intake: { pipelineId: intake.id, converted: stage(intake, CONVERTED_STAGE_NAME) },
    case: { pipelineId: cases.id, entry: stage(cases, CASE_ENTRY_STAGE_NAME) },
  };
}

// ---------------------------------------------------------------------------
// Naming & mapping

/** "Calzada" + "Fashion Nova, LLC" → "Calzada v. Fashion Nova, LLC". */
export function caseOpportunityName(
  clientLastName: string,
  companyName: string,
): string {
  return `${clientLastName} v. ${companyName}`;
}

/**
 * The client's surname for the case title. Prefers the contact record's
 * lastName; falls back to the last word of the contact's full name, then of
 * the intake opportunity name.
 */
export async function fetchClientLastName(
  contactId: string | null,
  fallbackName: string,
): Promise<string> {
  if (contactId) {
    try {
      const res = await ghlFetch<{
        contact?: { firstName?: string; lastName?: string; name?: string };
      }>(`/contacts/${contactId}`);
      const last = res.contact?.lastName?.trim();
      if (last) return last;
      const full = res.contact?.name?.trim();
      if (full) return full.split(/\s+/).at(-1)!;
    } catch (err) {
      log.warn("contact fetch failed; falling back to opportunity name", {
        contactId,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }
  const words = fallbackName.trim().split(/\s+/);
  return words.at(-1) || fallbackName.trim();
}

/**
 * Project an investigation profile onto the Defendant record's TEXT fields
 * (all 17 are TEXT — verified against the live schema, so freeform values are
 * safe). The full mailing address lands in the street field: the profile
 * carries one string and splitting it heuristically would corrupt data.
 */
export function defendantPropertiesFromProfile(
  name: string,
  profile: DefendantCandidate,
): Record<string, string> {
  const props: Record<string, string> = { [DEFENDANT_NAME_KEY]: name };
  const set = (key: string, value: string | null | undefined) => {
    if (typeof value === "string" && value.trim()) props[key] = value.trim();
  };
  set("defendant_website", profile.website);
  set("defendant_registration_state", profile.state_of_incorporation);
  set("defendant_approximate_revenue_size", profile.revenue_estimate);
  set("defendant_approximate_employee_size", profile.employees_estimate);
  set("defendant_main_office_street", profile.hq_mailing_address);
  set("defendant_registered_agent_name", profile.registered_agent?.name);
  set(
    "defendant_registered_agent_street_address",
    profile.registered_agent?.address,
  );
  set("defendant_registered_agent_state", profile.registered_agent?.state);
  return props;
}

// ---------------------------------------------------------------------------
// Split execution

export type SplitCompanyInput = {
  /** Id of the matching InvestigationCompany, when it already exists. */
  companyId: string | null;
  /** Final defendant name — becomes the record name and the case title. */
  name: string;
  profile: DefendantCandidate;
};

export type SplitCompanyResult = {
  companyId: string;
  name: string;
  defendantRecordId: string | null;
  defendantReused: boolean;
  opportunityId: string | null;
  opportunityName: string | null;
  /** True when a previous run already spawned this company's case. */
  alreadySpawned: boolean;
  error: string | null;
};

export type SplitOutcome = {
  investigationId: string;
  results: SplitCompanyResult[];
  /** True only when every requested company has a spawned case. */
  ok: boolean;
  parentMoved: boolean;
  parentStageName: string;
};

/** The opportunity core needed to run a split. */
async function fetchOpportunityCore(opportunityId: string): Promise<{
  id: string;
  name: string;
  contactId: string | null;
  pipelineId: string | null;
}> {
  const res = await ghlFetch<{
    opportunity?: {
      id: string;
      name?: string;
      contactId?: string;
      pipelineId?: string;
    };
  }>(`/opportunities/${opportunityId}`);
  const opp = res.opportunity;
  if (!opp?.id) throw new Error("GHL returned no opportunity for that id.");
  return {
    id: opp.id,
    name: (opp.name ?? "").trim() || opp.id,
    contactId: opp.contactId ?? null,
    pipelineId: opp.pipelineId ?? null,
  };
}

async function createCaseOpportunity(args: {
  name: string;
  contactId: string | null;
  stages: SplitStages;
}): Promise<string> {
  const res = await ghlFetch<{ opportunity?: { id?: string } }>(
    "/opportunities/",
    {
      method: "POST",
      body: {
        locationId: ghlLocationId(),
        pipelineId: args.stages.case.pipelineId,
        pipelineStageId: args.stages.case.entry.id,
        name: args.name,
        status: "open",
        ...(args.contactId ? { contactId: args.contactId } : {}),
      },
    },
  );
  const id = res.opportunity?.id;
  if (!id) throw new Error("GHL did not return the created opportunity's id.");
  return id;
}

/** Opportunity custom-field ids the split writes on the child, by short key. */
type ChildFieldIds = {
  screenshots: string | null;
  audio: string | null;
  confirmedViolations: string | null;
  facts: string | null;
  legalName: string | null;
};

async function resolveChildFieldIds(): Promise<ChildFieldIds> {
  const byId = await fetchOpportunityFieldKeysById();
  const idByKey = new Map<string, string>();
  for (const [id, key] of byId) if (!idByKey.has(key)) idByKey.set(key, id);
  return {
    screenshots: idByKey.get("violation_screenshots") ?? null,
    audio: idByKey.get("violation_audio_files") ?? null,
    confirmedViolations: idByKey.get("confirmed_tcpa_violations") ?? null,
    facts: idByKey.get("facts_connecting_company_to_callstexts") ?? null,
    legalName: idByKey.get(LEGAL_NAME_KEY) ?? null,
  };
}

/**
 * Screen → the exact option configured on "Confirmed TCPA Violations"
 * (verified against the live field on 2026-08-11; options are rejected unless
 * they match verbatim).
 */
const CONFIRMED_VIOLATION_OPTIONS: Record<ScreenId, string> = {
  prerecorded_voice: "PRV",
  failure_to_stop: "iDNC",
  quiet_hours: "Quiet Hours",
  dnc_registry: "DNC",
};

/** Read one evidence file's bytes: Firebase Storage first, then GHL's copy. */
async function evidenceBytes(
  entry: InvestigationEvidence,
): Promise<{ data: Uint8Array; mimetype: string } | null> {
  if (entry.storageUrl) {
    const buf = await downloadEvidenceObject(entry.storageUrl);
    if (buf) {
      return {
        data: new Uint8Array(buf),
        mimetype: entry.mimetype || "application/octet-stream",
      };
    }
  }
  if (entry.ghlUrl) {
    const res = await fetch(entry.ghlUrl, { cache: "no-store" });
    if (res.ok) {
      return {
        data: new Uint8Array(await res.arrayBuffer()),
        mimetype:
          entry.mimetype ||
          res.headers.get("content-type") ||
          "application/octet-stream",
      };
    }
  }
  return null;
}

/**
 * Build the child's complete case file so the case opportunity is a working
 * file, not an empty card:
 *  1. Copy the company's confirmed evidence into the child's violation upload
 *     fields (each file re-uploaded so the child owns its GHL copy).
 *  2. Write the confirmed violations, the basis text, the legal name, and a
 *     deep link to the CHILD's own investigation view onto its custom fields.
 *  3. Create the child's own investigation doc — editable by the legal
 *     reviewer — seeded with the company, its violations, and its evidence.
 *
 * Per-file copy failures degrade to warnings (the child doc still references
 * the parent-side copies); anything else throws so the caller can report the
 * spawn as incomplete and a retried split heals it.
 */
async function seedChildCaseFile(args: {
  parent: InvestigationDoc;
  company: InvestigationCompany;
  readiness: SplitReadiness;
  childOpportunityId: string;
  childOpportunityName: string;
  contactId: string | null;
  casePipelineId: string;
  fieldIds: ChildFieldIds;
  /** Final defendant name chosen at the split. */
  finalName: string;
  appBase: string;
  actor: Actor;
}): Promise<{ warnings: string[] }> {
  const { parent, company, readiness, fieldIds } = args;
  const warnings: string[] = [];
  const now = new Date().toISOString();

  // 1. Evidence files → the child's upload fields.
  const uploadsByField = new Map<
    string,
    Array<{
      url: string;
      meta: { mimetype: string; name: string; size: number };
      deleted: boolean;
    }>
  >();
  const childEvidence: InvestigationEvidence[] = [];
  for (const entry of readiness.evidence) {
    const fieldId = entry.kind === "image" ? fieldIds.screenshots : fieldIds.audio;
    let copied: { url: string; mimetype: string; size: number } | null = null;
    if (!fieldId) {
      warnings.push(
        `"${entry.name}" not copied — no ${entry.kind} upload field found on the opportunity model.`,
      );
    } else {
      try {
        const bytes = await evidenceBytes(entry);
        if (!bytes) throw new Error("no readable copy in Storage or GHL");
        copied = await ghlUploadCustomFieldFile(
          fieldId,
          new Blob([bytes.data as BlobPart], { type: bytes.mimetype }),
          entry.name,
        );
        const list = uploadsByField.get(fieldId) ?? [];
        list.push({
          url: copied.url,
          meta: { mimetype: copied.mimetype, name: entry.name, size: copied.size },
          deleted: false,
        });
        uploadsByField.set(fieldId, list);
      } catch (err) {
        warnings.push(
          `"${entry.name}" could not be copied to the case opportunity: ${err instanceof Error ? err.message : String(err)}`,
        );
      }
    }
    childEvidence.push({
      ...entry,
      ghlUrl: copied?.url ?? entry.ghlUrl,
      ghlField: copied
        ? entry.kind === "image"
          ? "violation_screenshots"
          : "violation_audio_files"
        : entry.ghlField,
    });
  }

  // 2. Violations → option strings + a written basis the lawyers can read.
  const violationOptions = [
    ...new Set(
      readiness.violations
        .map((v) => CONFIRMED_VIOLATION_OPTIONS[v.screen])
        .filter(Boolean),
    ),
  ];
  const facts = [
    `Confirmed at the intake investigation of "${parent.source.opportunityName}":`,
    ...readiness.violations.map((v) =>
      v.basis.trim()
        ? `• ${SCREEN_LABELS[v.screen]} — ${v.basis.trim()}`
        : `• ${SCREEN_LABELS[v.screen]}`,
    ),
  ]
    .join("\n")
    .slice(0, 12_000);

  // 3. One PUT binds everything, including the deep link to the child's OWN
  // case file (the parent stays reachable through the file's lineage line).
  await ghlFetch(`/opportunities/${args.childOpportunityId}`, {
    method: "PUT",
    body: {
      customFields: [
        {
          id: INVESTIGATION_URL_FIELD_ID,
          field_value: investigationUrlFor(args.appBase, args.childOpportunityId),
        },
        ...(fieldIds.legalName
          ? [{ id: fieldIds.legalName, field_value: args.finalName }]
          : []),
        ...(fieldIds.confirmedViolations && violationOptions.length
          ? [{ id: fieldIds.confirmedViolations, field_value: violationOptions }]
          : []),
        ...(fieldIds.facts ? [{ id: fieldIds.facts, field_value: facts }] : []),
        ...[...uploadsByField.entries()].map(([id, files]) => ({
          id,
          field_value: files,
        })),
      ],
    },
  });

  // 4. The child's own investigation doc: an editable case file for review.
  // Ids are carried verbatim so violation/evidence attributions keep pointing
  // at the company without remapping.
  const childDoc = await createInvestigation({
    opportunityId: args.childOpportunityId,
    opportunityName: args.childOpportunityName,
    contactId: args.contactId,
    pipelineId: args.casePipelineId,
  });
  await updateInvestigation(childDoc.id, {
    companies: [{ ...args.company, spawnedOpportunityId: null }],
    violations: parent.violations
      .filter((v) => v.companyId === company.id && v.status !== "dismissed")
      .map((v) => ({ ...v })),
    evidence: childEvidence,
  });
  await appendLogEntry(childDoc.id, {
    at: now,
    author: args.actor,
    text: [
      `Case file opened from the split of "${parent.source.opportunityName}" (investigation ${parent.id}).`,
      `Carried over: company "${args.finalName}", ${readiness.violations.length} confirmed violation(s), ${childEvidence.length} exhibit(s).`,
      ...(warnings.length ? ["Warnings:", ...warnings.map((w) => `- ${w}`)] : []),
    ].join("\n"),
    evidenceIds: childEvidence.map((e) => e.id),
  });

  return { warnings };
}

/**
 * Find the doc company matching an input — by id first, then by normalized
 * name across the profile's known names.
 */
function matchDocCompany(
  doc: InvestigationDoc,
  input: SplitCompanyInput,
): InvestigationCompany | undefined {
  if (input.companyId) {
    const byId = doc.companies.find((c) => c.id === input.companyId);
    if (byId) return byId;
  }
  const target = matchKey(input.name);
  return doc.companies.find((c) =>
    [c.profile.legal_name, c.profile.company_name].some(
      (n) => n && matchKey(n) === target,
    ),
  );
}

/**
 * Execute the split for the selected companies. Hard-gated: a company spawns
 * only when it passes `splitReadiness` (confirmed, with confirmed violations
 * pinned and confirmed evidence attributed) — the same data the split
 * migrates onto the child's case file. Idempotent per company: a company that
 * already has a spawned opportunity is reported as done and skipped — and if
 * its child never got a case file (partial earlier failure), the file is
 * seeded on the retry. The parent is moved to the terminal stage — and the
 * investigation closed as "converted" — only once EVERY requested company has
 * its case, complete.
 */
export async function executeSplit(args: {
  opportunityId: string;
  /** Target a specific investigation; defaults to latest (or creates one). */
  investigationId: string | null;
  companies: SplitCompanyInput[];
  actor: Actor;
  /** App origin for the children's investigation_url deep link. */
  appBase: string;
}): Promise<SplitOutcome> {
  if (args.companies.length === 0) {
    throw new Error("Select at least one company to spawn.");
  }

  const [opportunity, stages, associationId, fieldIds] = await Promise.all([
    fetchOpportunityCore(args.opportunityId),
    resolveSplitStages(),
    resolveDefendantAssociationId(),
    resolveChildFieldIds(),
  ]);

  // The investigation this split belongs to: explicit id, else the latest for
  // the opportunity, else a fresh doc (manual-era opportunities have none).
  let doc: InvestigationDoc | null = null;
  if (args.investigationId) {
    doc = await getInvestigation(args.investigationId);
    if (!doc) throw new Error("Investigation not found.");
    if (doc.source.opportunityId !== opportunity.id) {
      throw new Error("Investigation belongs to a different opportunity.");
    }
  } else {
    const existing = await listInvestigationsForOpportunity(opportunity.id);
    doc =
      existing[0] ??
      (await createInvestigation({
        opportunityId: opportunity.id,
        opportunityName: opportunity.name,
        contactId: opportunity.contactId,
        pipelineId: opportunity.pipelineId,
      }));
  }

  const clientLastName = await fetchClientLastName(
    opportunity.contactId,
    opportunity.name,
  );
  const now = () => new Date().toISOString();

  const companies = [...doc.companies];
  const spawned = [...doc.spawned];
  const results: SplitCompanyResult[] = [];

  // Sequential on purpose: each company is several dependent GHL writes, and
  // the client-side throttle in ghlFetch already paces the request rate.
  for (const input of args.companies) {
    const company = matchDocCompany(doc, input);

    if (company?.spawnedOpportunityId) {
      const childId = company.spawnedOpportunityId;
      const childName =
        spawned.find((s) => s.opportunityId === childId)?.name ?? null;
      // Heal a partial earlier split: a spawned case whose file was never
      // seeded (e.g. pre-migration splits, or a failure after the spawn)
      // gets its case file now.
      let error: string | null = null;
      try {
        const childDocs = await listInvestigationsForOpportunity(childId);
        if (childDocs.length === 0) {
          await seedChildCaseFile({
            parent: doc,
            company,
            readiness: splitReadiness(doc, company),
            childOpportunityId: childId,
            childOpportunityName: childName ?? input.name,
            contactId: opportunity.contactId,
            casePipelineId: stages.case.pipelineId,
            fieldIds,
            finalName: input.name,
            appBase: args.appBase,
            actor: args.actor,
          });
          log.info("child case file seeded on retry", {
            parent: opportunity.id,
            child: childId,
          });
        }
      } catch (err) {
        error = `The case opportunity exists but its case file could not be completed: ${err instanceof Error ? err.message : String(err)}`;
      }
      results.push({
        companyId: company.id,
        name: input.name,
        defendantRecordId: company.defendantRecordId,
        defendantReused: true,
        opportunityId: childId,
        opportunityName: childName,
        alreadySpawned: true,
        error,
      });
      continue;
    }

    if (!company) {
      results.push({
        companyId: input.companyId ?? input.name,
        name: input.name,
        defendantRecordId: null,
        defendantReused: false,
        opportunityId: null,
        opportunityName: null,
        alreadySpawned: false,
        error:
          "This company is not on the investigation. Add it in the Companies section and confirm it first.",
      });
      continue;
    }

    // The hard gate: everything the child's case file needs must exist
    // before the case is created — never after, when the file is locked.
    const readiness = splitReadiness(doc, company);
    if (!readiness.ready) {
      results.push({
        companyId: company.id,
        name: input.name,
        defendantRecordId: company.defendantRecordId,
        defendantReused: false,
        opportunityId: null,
        opportunityName: null,
        alreadySpawned: false,
        error: `Not ready to spawn: ${readiness.missing.join("; ")}.`,
      });
      continue;
    }

    const oppName = caseOpportunityName(clientLastName, input.name);
    try {
      // Defendant record: reuse an exact name match (fill only its EMPTY
      // fields — same rule as the migration tool), else create. The profile
      // comes from the investigation doc — the vetted copy, not the client's.
      const props = defendantPropertiesFromProfile(input.name, company.profile);
      const existing = await findDefendantByName(input.name);
      let defendantReused = false;
      let defendantRecordId: string;
      if (existing) {
        defendantReused = true;
        defendantRecordId = existing.id;
        const fill: Record<string, string> = {};
        for (const [key, value] of Object.entries(props)) {
          if (key !== DEFENDANT_NAME_KEY && !existing.properties[key]) {
            fill[key] = value;
          }
        }
        if (Object.keys(fill).length) {
          await updateDefendantRecord(existing.id, fill);
        }
      } else {
        defendantRecordId = await createDefendantRecord(props);
      }
      company.defendantRecordId = defendantRecordId;

      const caseOppId = await createCaseOpportunity({
        name: oppName,
        contactId: opportunity.contactId,
        stages,
      });
      company.spawnedOpportunityId = caseOppId;

      await linkDefendantToOpportunity(defendantRecordId, caseOppId, associationId);

      // Record the spawn BEFORE seeding, so a seeding failure leaves a
      // retryable state (the retry path above completes the file).
      spawned.push({
        opportunityId: caseOppId,
        name: oppName,
        companyId: company.id,
        defendantRecordId,
        createdAt: now(),
      } satisfies SpawnedCase);

      const { warnings } = await seedChildCaseFile({
        parent: doc,
        company,
        readiness,
        childOpportunityId: caseOppId,
        childOpportunityName: oppName,
        contactId: opportunity.contactId,
        casePipelineId: stages.case.pipelineId,
        fieldIds,
        finalName: input.name,
        appBase: args.appBase,
        actor: args.actor,
      });
      if (warnings.length) {
        log.warn("child case file seeded with warnings", {
          child: caseOppId,
          warnings,
        });
      }

      results.push({
        companyId: company.id,
        name: input.name,
        defendantRecordId,
        defendantReused,
        opportunityId: caseOppId,
        opportunityName: oppName,
        alreadySpawned: false,
        error: null,
      });
      log.info("case opportunity spawned", {
        parent: opportunity.id,
        child: caseOppId,
        defendant: defendantRecordId,
        reused: defendantReused,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error("spawn failed for company", {
        parent: opportunity.id,
        company: input.name,
        message,
      });
      results.push({
        companyId: company.id,
        name: input.name,
        defendantRecordId: company.defendantRecordId,
        defendantReused: false,
        // The opportunity may exist even when a later step failed — surface
        // it so the operator sees the spawn, while `error` keeps ok=false.
        opportunityId: company.spawnedOpportunityId,
        opportunityName: company.spawnedOpportunityId ? oppName : null,
        alreadySpawned: false,
        error: message,
      });
    }
  }

  // "Complete" means spawned AND its case file seeded — an error on any row
  // (even an already-spawned one) keeps the parent in place for a retry.
  const ok = results.every((r) => r.opportunityId !== null && r.error === null);
  const newlySpawned = results.filter((r) => r.opportunityId && !r.alreadySpawned);

  await updateInvestigation(doc.id, {
    companies,
    spawned,
    spawnedOpportunityIds: spawned.map((s) => s.opportunityId),
    // A completed split IS the approval: the reviewer's terminal action on an
    // investigation is spawning its cases, so record the decision here.
    ...(ok
      ? {
          status: "closed" as const,
          outcome: "converted" as const,
          review: {
            decision: "approved" as const,
            decidedAt: now(),
            movedToStageId: stages.intake.converted.id,
            movedToStageName: stages.intake.converted.name,
          },
        }
      : {}),
  });

  if (newlySpawned.length || results.some((r) => r.error)) {
    const lines = results.map((r) =>
      r.error
        ? `✗ ${r.name}: ${r.error}`
        : `${r.alreadySpawned ? "• (already spawned)" : "✓"} ${r.opportunityName ?? r.name} — opportunity ${r.opportunityId}`,
    );
    await appendLogEntry(doc.id, {
      at: now(),
      author: args.actor,
      text: `Split executed:\n${lines.join("\n")}`,
      evidenceIds: [],
    });
  }

  // Retire the parent only when the split is complete — a partial split keeps
  // it in place so the remaining companies stay visible in the working stages.
  let parentMoved = false;
  if (ok) {
    await ghlFetch(`/opportunities/${opportunity.id}`, {
      method: "PUT",
      body: {
        pipelineId: stages.intake.pipelineId,
        pipelineStageId: stages.intake.converted.id,
      },
    });
    parentMoved = true;
    log.info("parent retired to converted stage", { parent: opportunity.id });
  }

  return {
    investigationId: doc.id,
    results,
    ok,
    parentMoved,
    parentStageName: stages.intake.converted.name,
  };
}
