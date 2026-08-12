import { z } from "zod";
import {
  appendLogEntry,
  mutateInvestigation,
  newId,
  type CompanyStatus,
  type InvestigationCompany,
} from "@/lib/investigation-store";
import { createLogger, nextRequestId } from "@/lib/logger";
import type { DefendantCandidate } from "@/lib/types";

const baseLog = createLogger("investigation-company");

/**
 * Add or update one company on an investigation (Phase 3 manual capture).
 * Manual research produces the SAME artifact as the AI agent — an
 * `InvestigationCompany` with a DefendantCandidate profile — so review and
 * the split panel render one list regardless of who found what.
 *
 * A `decision` moves the company through candidate → confirmed/rejected;
 * confirmed companies are what the split spawns cases for.
 */

const profileSchema = z.object({
  company_name: z.string().min(1).max(200),
  legal_name: z.string().max(200).nullable().optional(),
  website: z.string().max(500).nullable().optional(),
  goods_services: z.string().max(1000).nullable().optional(),
  state_of_incorporation: z.string().max(100).nullable().optional(),
  hq_mailing_address: z.string().max(500).nullable().optional(),
  registered_agent: z
    .object({
      name: z.string().max(200).nullable(),
      address: z.string().max(500).nullable(),
      state: z.string().max(100).nullable(),
    })
    .nullable()
    .optional(),
  employees_estimate: z.string().max(100).nullable().optional(),
  revenue_estimate: z.string().max(100).nullable().optional(),
  notes: z.string().max(5000).nullable().optional(),
  // AI-run provenance, sent when a suggestion is added to the investigation so
  // the candidate's enrichment survives the copy.
  confidence: z.number().min(0).max(1).optional(),
  solvability_tier: z.enum(["risk", "good", "whale", "unknown"]).optional(),
  sources: z.array(z.string().max(2000)).max(50).optional(),
  evidence_files: z.array(z.string().max(500)).max(100).optional(),
});

const bodySchema = z.object({
  investigationId: z.string().min(1),
  actorName: z.string().min(1).max(80),
  /** Existing company id to update; omit to add a new one. */
  companyId: z.string().min(1).nullable().optional(),
  profile: profileSchema.optional(),
  decision: z.enum(["candidate", "confirmed", "rejected"]).optional(),
});

/** Fold the edited form fields into an existing (possibly AI-built) profile. */
function mergeProfile(
  base: DefendantCandidate | null,
  edit: z.infer<typeof profileSchema>,
): DefendantCandidate {
  return {
    // AI-only enrichment (sos_records, screens, scorecard…) rides along.
    ...(base ?? {}),
    company_name: edit.company_name,
    legal_name: edit.legal_name ?? base?.legal_name ?? null,
    website: edit.website ?? base?.website ?? null,
    goods_services: edit.goods_services ?? base?.goods_services ?? null,
    state_of_incorporation:
      edit.state_of_incorporation ?? base?.state_of_incorporation ?? null,
    hq_mailing_address:
      edit.hq_mailing_address ?? base?.hq_mailing_address ?? null,
    registered_agent: edit.registered_agent ?? base?.registered_agent ?? null,
    employees_estimate:
      edit.employees_estimate ?? base?.employees_estimate ?? null,
    revenue_estimate: edit.revenue_estimate ?? base?.revenue_estimate ?? null,
    solvability_tier:
      edit.solvability_tier ?? base?.solvability_tier ?? "unknown",
    confidence: edit.confidence ?? base?.confidence ?? 1,
    sources: edit.sources ?? base?.sources ?? [],
    evidence_files: edit.evidence_files ?? base?.evidence_files ?? [],
    notes: edit.notes ?? base?.notes ?? null,
  };
}

export async function POST(request: Request) {
  const log = baseLog.child(nextRequestId());
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }
  const { investigationId, actorName, companyId, profile, decision } =
    parsed.data;
  if (!companyId && !profile) {
    return Response.json(
      { error: "A new company needs a profile." },
      { status: 400 },
    );
  }
  const actor = { kind: "human" as const, name: actorName.trim() };
  const now = new Date().toISOString();

  try {
    let logLine: string | null = null;
    const doc = await mutateInvestigation(investigationId, (d) => {
      let company: InvestigationCompany | undefined = companyId
        ? d.companies.find((c) => c.id === companyId)
        : undefined;
      if (companyId && !company) {
        throw new Error("Company not found on this investigation.");
      }

      if (!company) {
        company = {
          id: newId(),
          origin: actor,
          status: "candidate",
          profile: mergeProfile(null, profile!),
          defendantRecordId: null,
          spawnedOpportunityId: null,
          decidedAt: null,
          decidedBy: null,
        };
        d.companies.push(company);
        logLine = `Added company "${company.profile.legal_name || company.profile.company_name}" (candidate).`;
      } else if (profile) {
        company.profile = mergeProfile(company.profile, profile);
      }

      if (decision && decision !== company.status) {
        if (company.spawnedOpportunityId) {
          throw new Error(
            "This company already has a spawned case opportunity; its decision can no longer change.",
          );
        }
        company.status = decision satisfies CompanyStatus;
        const decided = decision !== "candidate";
        company.decidedAt = decided ? now : null;
        company.decidedBy = decided ? actor : null;
        const name = company.profile.legal_name || company.profile.company_name;
        logLine =
          decision === "confirmed"
            ? `Confirmed company "${name}".`
            : decision === "rejected"
              ? `Rejected company "${name}".`
              : `Moved company "${name}" back to candidate.`;
      }
    });

    if (logLine) {
      doc.log.push(
        await appendLogEntry(investigationId, {
          at: now,
          author: actor,
          text: logLine,
          evidenceIds: [],
        }),
      );
    }

    log.info("company saved", { investigationId, companyId, decision });
    return Response.json({ doc });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const known =
      message.includes("not found") || message.includes("no longer change");
    log.error("company save failed", { investigationId, message });
    return Response.json(
      { error: known ? message : `Could not save the company: ${message}` },
      { status: known ? 409 : 502 },
    );
  }
}
