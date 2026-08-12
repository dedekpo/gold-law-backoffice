import { z } from "zod";
import { executeSplit } from "@/lib/case-split";
import { GhlError } from "@/lib/ghl";
import { createLogger, nextRequestId } from "@/lib/logger";
import type { DefendantCandidate } from "@/lib/types";

const baseLog = createLogger("investigation-split");

/**
 * Execute the split for an investigation: spawn one case opportunity (plus
 * Defendant record and association) per selected company, then retire the
 * intake opportunity to the "Converted to Case(s)" stage. See lib/case-split.
 */

// The profile is produced by our own UI from typed investigation data;
// validate the fields the split writes to GHL and carry the rest through.
const profileSchema = z
  .object({
    company_name: z.string(),
    legal_name: z.string().nullable(),
    website: z.string().nullable(),
    state_of_incorporation: z.string().nullable(),
    hq_mailing_address: z.string().nullable(),
    revenue_estimate: z.string().nullable(),
    employees_estimate: z.string().nullable(),
    registered_agent: z
      .object({
        name: z.string().nullable(),
        address: z.string().nullable(),
        state: z.string().nullable(),
      })
      .nullable(),
  })
  .passthrough();

const bodySchema = z.object({
  opportunityId: z.string().min(1),
  investigationId: z.string().min(1).nullable().optional(),
  actorName: z.string().min(1).max(80).optional(),
  companies: z
    .array(
      z.object({
        // Must reference a vetted company on the investigation doc — the
        // split is hard-gated on the doc's own data (see lib/split-readiness).
        companyId: z.string().min(1),
        name: z.string().min(2).max(200),
        profile: profileSchema,
      }),
    )
    .min(1)
    .max(10),
});

// Each spawn re-uploads the company's evidence files to the child, so the
// budget scales with file count/size; GHL requests are throttled client-side.
export const maxDuration = 300;

export async function POST(request: Request) {
  const log = baseLog.child(nextRequestId());

  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid split request body." },
      { status: 400 },
    );
  }
  const { opportunityId, investigationId, actorName, companies } = parsed.data;

  try {
    const outcome = await executeSplit({
      opportunityId,
      investigationId: investigationId ?? null,
      companies: companies.map((c) => ({
        companyId: c.companyId,
        name: c.name.trim(),
        profile: c.profile as unknown as DefendantCandidate,
      })),
      actor: { kind: "human", name: actorName?.trim() || "backoffice" },
      appBase: process.env.APP_BASE_URL ?? new URL(request.url).origin,
    });
    log.info("split finished", {
      opportunityId,
      investigationId: outcome.investigationId,
      ok: outcome.ok,
      spawned: outcome.results.filter((r) => r.opportunityId).length,
      failed: outcome.results.filter((r) => r.error).length,
    });
    return Response.json(outcome, { status: outcome.ok ? 200 : 207 });
  } catch (err) {
    if (err instanceof GhlError && err.status === 404) {
      return Response.json(
        { error: "Opportunity not found in GHL." },
        { status: 404 },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error("split failed", { opportunityId, message });
    return Response.json(
      { error: `Split failed: ${message}` },
      { status: 502 },
    );
  }
}
