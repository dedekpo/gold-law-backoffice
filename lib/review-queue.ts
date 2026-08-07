import { ghlFetch, ghlLocationId } from "@/lib/ghl";

/**
 * GHL plumbing for the case-review queue: the '👀 For Chris Review' stage of
 * the New Client Signup pipeline feeds the queue, and a decision moves the
 * opportunity to '✅ Approved for Signup' or 'Needs Work'.
 *
 * Pipelines/stages are matched by normalized name (emoji and punctuation
 * stripped) so a cosmetic rename in GHL doesn't silently break the queue —
 * a missing name throws with the available options listed.
 */

export const REVIEW_PIPELINE_NAME = "02 New Client Signup Pipeline";
export const REVIEW_STAGE_NAME = "👀 For Chris Review";
export const APPROVED_STAGE_NAME = "✅ Approved for Signup";
export const DECLINED_STAGE_NAME = "Needs Work";

export type ReviewStages = {
  pipelineId: string;
  pipelineName: string;
  review: { id: string; name: string };
  approved: { id: string; name: string };
  declined: { id: string; name: string };
};

const normName = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]/g, "");

type RawPipeline = {
  id: string;
  name?: string;
  stages?: { id: string; name?: string }[];
};

export async function resolveReviewStages(): Promise<ReviewStages> {
  const res = await ghlFetch<{ pipelines?: RawPipeline[] }>(
    `/opportunities/pipelines?locationId=${ghlLocationId()}`,
  );
  const pipelines = res.pipelines ?? [];
  const pipeline =
    pipelines.find(
      (p) => normName(p.name ?? "") === normName(REVIEW_PIPELINE_NAME),
    ) ??
    // Renamed pipeline fallback: whichever one holds the review stage.
    pipelines.find((p) =>
      (p.stages ?? []).some(
        (s) => normName(s.name ?? "") === normName(REVIEW_STAGE_NAME),
      ),
    );
  if (!pipeline) {
    const names = pipelines.map((p) => p.name).filter(Boolean).join(", ");
    throw new Error(
      `Pipeline "${REVIEW_PIPELINE_NAME}" not found. Available: ${names || "(none)"}`,
    );
  }

  const stages = pipeline.stages ?? [];
  const findStage = (wanted: string) => {
    const stage = stages.find((s) => normName(s.name ?? "") === normName(wanted));
    if (!stage) {
      const names = stages.map((s) => s.name).filter(Boolean).join(", ");
      throw new Error(
        `Stage "${wanted}" not found in pipeline "${pipeline.name}". Available: ${names || "(none)"}`,
      );
    }
    return { id: stage.id, name: stage.name ?? wanted };
  };

  return {
    pipelineId: pipeline.id,
    pipelineName: pipeline.name ?? REVIEW_PIPELINE_NAME,
    review: findStage(REVIEW_STAGE_NAME),
    approved: findStage(APPROVED_STAGE_NAME),
    declined: findStage(DECLINED_STAGE_NAME),
  };
}

export type QueueOpportunity = {
  id: string;
  name: string;
  createdAt: string | null;
  contactId: string | null;
  contactName: string | null;
};

type RawOpportunity = {
  id?: string;
  name?: string;
  createdAt?: string;
  contactId?: string | null;
  contact?: { id?: string; name?: string };
};

/** Every OPEN opportunity currently sitting in the review stage. */
export async function listReviewQueue(
  stages: ReviewStages,
): Promise<QueueOpportunity[]> {
  const locationId = ghlLocationId();
  const pagePath = (page: number) =>
    `/opportunities/search?location_id=${locationId}` +
    `&pipeline_id=${stages.pipelineId}` +
    `&pipeline_stage_id=${stages.review.id}` +
    `&status=open&limit=100&page=${page}`;

  const collected: QueueOpportunity[] = [];
  for (let page = 1; ; page++) {
    const res = await ghlFetch<{
      opportunities?: RawOpportunity[];
      meta?: { total?: number };
    }>(pagePath(page));
    const batch = res.opportunities ?? [];
    for (const o of batch) {
      if (!o.id) continue;
      collected.push({
        id: o.id,
        name: (o.name ?? "").trim() || o.id,
        createdAt: o.createdAt ?? null,
        contactId: o.contactId ?? o.contact?.id ?? null,
        contactName: o.contact?.name ?? null,
      });
    }
    const total = res.meta?.total ?? collected.length;
    if (batch.length < 100 || collected.length >= total) break;
  }
  return collected;
}

/** Move an opportunity to another stage of the review pipeline. */
export async function moveToStage(
  opportunityId: string,
  stages: ReviewStages,
  stageId: string,
): Promise<void> {
  await ghlFetch(`/opportunities/${opportunityId}`, {
    method: "PUT",
    body: {
      pipelineId: stages.pipelineId,
      pipelineStageId: stageId,
    },
  });
}
