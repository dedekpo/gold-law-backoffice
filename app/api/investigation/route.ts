import { getCaseDoc, type CaseDoc } from "@/lib/case-store";
import { fetchContactNotes, type ContactNote } from "@/lib/contact-notes";
import { GhlError, ghlLocationId } from "@/lib/ghl";
import {
  findInvestigationBySpawnedOpportunity,
  listInvestigationsForOpportunity,
  type InvestigationDoc,
} from "@/lib/investigation-store";
import { createLogger, nextRequestId } from "@/lib/logger";
import {
  ALL_EVIDENCE_FIELD_KEYS,
  customFieldDisplayValue,
  customFieldFiles,
  customFieldString,
  fetchOpportunityWithEvidence,
  type EvidenceFile,
} from "@/lib/opportunity-evidence";
import { AI_FIELD_IDS } from "@/lib/opportunity-fields";
import { LEGAL_NAME_KEY } from "@/lib/defendant-migration";
import type { DefendantCandidate } from "@/lib/types";

const baseLog = createLogger("investigation");

/**
 * Everything known about one opportunity's investigation, aggregated for the
 * unified read-only view (Phase 1 of the investigation-workbench roadmap):
 * Firestore docs (new `investigations` + legacy `cases`), the LIVE evidence
 * from every upload field, the GHL "AI Intake" fields, the contact's note
 * stream, and the populated legacy Company 1/2/3 investigation fields.
 */

/** One populated legacy investigation field, ready to render. */
export type LegacyField = { group: string; name: string; value: string };

export type InvestigationViewResponse = {
  opportunity: {
    id: string;
    name: string;
    status: string;
    contactId: string | null;
  };
  investigations: InvestigationDoc[];
  /**
   * Set when THIS opportunity is a spawned case: the investigation that
   * created it, for the "back to the parent" banner.
   */
  spawnedFrom: {
    investigationId: string;
    opportunityId: string;
    opportunityName: string;
  } | null;
  /** GHL app origin+location prefix for building deep links client-side. */
  ghlAppBase: string;
  /** Legacy Firestore `cases/{oppId}` doc (AI run + manual notes + review). */
  doc: CaseDoc | null;
  /** Live files from every evidence-bearing upload field. */
  evidence: EvidenceFile[];
  /** The AI Intake Report PDFs attached to the opportunity. */
  reportFiles: Array<{ url: string; name: string }>;
  ghlAiFields: {
    runStatus: string | null;
    topScore: string | null;
    companiesFound: string | null;
    violations: string | null;
    companySummary: string | null;
    investigationNotes: string | null;
  };
  notes: ContactNote[];
  legacyFields: LegacyField[];
  /**
   * Company 1 legacy fields projected onto the investigation profile shape,
   * so manual-era opportunities (no AI run, no investigation doc) can still
   * feed the split panel. Null when the legal-name field is empty.
   */
  legacyCompany: DefendantCandidate | null;
};

/**
 * The human-maintained investigation fields worth surfacing, by short key.
 * Company 2/3 are deprecated slots — shown only when they hold data.
 */
const LEGACY_GROUPS: Array<{ group: string; keys: string[] }> = [
  {
    group: "Investigation",
    keys: [
      "which_company_sent_the_texts_or_voicemails_if_you_know",
      "tcpa_violation_type",
      "potential_tcpa_violations",
      "confirmed_tcpa_violations",
      "investigator_name",
      "intaker_name",
      "google_drive_url_link",
      "cms_url",
      "any_other_relevant_information",
      "info_from_lead",
      "customer_initial_message",
    ],
  },
  {
    group: "Company 1",
    keys: [
      "spammer_company_name",
      "other_names_for_the_company_dba_fka_aka",
      "company_1_website",
      "facts_connecting_company_to_callstexts",
      "registration_state",
      "approximate_revenue_size",
      "approximate_employee_size",
      "company_1_main_office_street",
      "company_1_main_office_city",
      "company_1_main_office_state",
      "company_1_main_office_zip_code",
      "principal_members_address_and_emails",
      "registered_agent_name_and_address",
      "company_1_registered_agent_street_address",
      "company_1_registered_agent_city",
      "company_1_registered_agent_state",
      "company_1_registered_agent_zip_code",
      "is_prior_defendant",
      "tcpa_lawsuit_history",
      "any_online_complaints",
      "any_other_relevant_information_about_investigation",
    ],
  },
  {
    group: "Company 2 (deprecated)",
    keys: [
      "other_relevant_company_name",
      "other_names_for_other_relevant_company_dba_fka_aka",
      "company_2_website",
      "facts_connecting_second_company_to_callstexts",
      "second_company_registration_state",
      "second_company_approximate_revenue_size",
      "second_company_approximate_employee_size",
      "second_company_main_office_address",
      "second_company_principal_members_address_and_emails",
      "second_company_registered_agent_name_and_address",
      "company_2_repeat_defendant",
      "any_prior_tcpa_lawsuits_for_second_company",
      "tcpa_lawsuit_history_for_second_company",
      "any_online_complaints_against_second_company",
      "any_other_relevant_information_about_investigation_on_company_2",
    ],
  },
  {
    group: "Company 3 (deprecated)",
    keys: [
      "third_relevant_company_name",
      "other_names_for_third_company_dba_fka_aka",
      "company_3_website",
      "facts_connecting_third_company_to_callstexts",
      "third_company_registration_state",
      "third_company_approximate_revenue_size",
      "third_company_approximate_employee_size",
      "third_company_main_office_address",
      "third_company_principal_members_address_and_emails",
      "third_company_registered_agent_name_and_address",
      "company_3_repeat_defendant",
      "any_prior_tcpa_lawsuits_for_third_company",
      "tcpa_lawsuit_history_for_third_company",
      "any_online_complaints_against_third_company",
      "any_other_relevant_information_about_investigation_on_company_3",
    ],
  },
];

export async function GET(request: Request) {
  const log = baseLog.child(nextRequestId());
  const id = new URL(request.url).searchParams.get("opp");
  if (!id) {
    return Response.json({ error: "Missing opp parameter" }, { status: 400 });
  }

  try {
    const [live, doc, investigations, parentDoc] = await Promise.all([
      fetchOpportunityWithEvidence(id, ALL_EVIDENCE_FIELD_KEYS),
      getCaseDoc(id),
      listInvestigationsForOpportunity(id),
      findInvestigationBySpawnedOpportunity(id),
    ]);
    if (!live) {
      return Response.json(
        { error: "GHL returned no opportunity for that id." },
        { status: 502 },
      );
    }

    const notes = live.opportunity.contactId
      ? await fetchContactNotes(live.opportunity.contactId).catch((err) => {
          log.warn("notes fetch failed", {
            contactId: live.opportunity.contactId,
            message: err instanceof Error ? err.message : String(err),
          });
          return [] as ContactNote[];
        })
      : [];

    const cf = live.opportunity.customFields;
    const idByShortKey = new Map(
      live.fieldDefs.map((d) => [
        d.fieldKey.replace(/^opportunity\./, ""),
        d,
      ]),
    );
    const legacyFields: LegacyField[] = [];
    for (const { group, keys } of LEGACY_GROUPS) {
      for (const key of keys) {
        const def = idByShortKey.get(key);
        if (!def) continue;
        const value = customFieldDisplayValue(cf, def.id);
        if (value) legacyFields.push({ group, name: def.name, value });
      }
    }

    const legacy = (key: string): string | null => {
      const def = idByShortKey.get(key);
      return def ? customFieldDisplayValue(cf, def.id) : null;
    };
    const joinAddress = (...parts: (string | null)[]) =>
      parts.filter(Boolean).join(", ") || null;
    const legacyCompanyName = legacy(LEGAL_NAME_KEY);
    const legacyCompany: DefendantCandidate | null = legacyCompanyName
      ? {
          company_name: legacyCompanyName,
          legal_name: legacyCompanyName,
          website: legacy("company_1_website"),
          goods_services: null,
          state_of_incorporation: legacy("registration_state"),
          hq_mailing_address: joinAddress(
            legacy("company_1_main_office_street"),
            legacy("company_1_main_office_city"),
            legacy("company_1_main_office_state"),
            legacy("company_1_main_office_zip_code"),
          ),
          registered_agent: {
            name: legacy("registered_agent_name_and_address"),
            address: joinAddress(
              legacy("company_1_registered_agent_street_address"),
              legacy("company_1_registered_agent_city"),
              legacy("company_1_registered_agent_zip_code"),
            ),
            state: legacy("company_1_registered_agent_state"),
          },
          employees_estimate: legacy("approximate_employee_size"),
          revenue_estimate: legacy("approximate_revenue_size"),
          solvability_tier: "unknown",
          confidence: 1,
          sources: [],
          evidence_files: [],
          notes: null,
        }
      : null;

    const body: InvestigationViewResponse = {
      opportunity: {
        id: live.opportunity.id,
        name: live.opportunity.name,
        status: live.opportunity.status,
        contactId: live.opportunity.contactId,
      },
      investigations,
      spawnedFrom: parentDoc
        ? {
            investigationId: parentDoc.id,
            opportunityId: parentDoc.source.opportunityId,
            opportunityName: parentDoc.source.opportunityName,
          }
        : null,
      ghlAppBase: `https://login.amicus-pro.com/v2/location/${ghlLocationId()}`,
      doc,
      evidence: live.files,
      reportFiles: customFieldFiles(cf, AI_FIELD_IDS.reportFiles),
      ghlAiFields: {
        runStatus: customFieldString(cf, AI_FIELD_IDS.runStatus),
        topScore: customFieldString(cf, AI_FIELD_IDS.topScore),
        companiesFound: customFieldString(cf, AI_FIELD_IDS.companiesFound),
        violations: customFieldDisplayValue(cf, AI_FIELD_IDS.violations),
        companySummary: customFieldString(cf, AI_FIELD_IDS.companySummary),
        investigationNotes: customFieldString(
          cf,
          AI_FIELD_IDS.investigationNotes,
        ),
      },
      notes,
      legacyFields,
      legacyCompany,
    };
    log.info("investigation view loaded", {
      opportunityId: id,
      investigations: investigations.length,
      hasLegacyRun: Boolean(doc?.run),
      evidence: live.files.length,
      notes: notes.length,
      legacyFields: legacyFields.length,
    });
    return Response.json(body);
  } catch (err) {
    if (err instanceof GhlError && err.status === 404) {
      return Response.json(
        { error: "Opportunity not found in GHL." },
        { status: 404 },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error("investigation view failed", { opportunityId: id, message });
    return Response.json(
      { error: `Could not load the investigation: ${message}` },
      { status: 502 },
    );
  }
}
