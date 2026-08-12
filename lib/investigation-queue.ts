import { ghlFetch, ghlLocationId } from "@/lib/ghl";
import {
  customFieldString,
  type RawCustomFieldValue,
} from "@/lib/opportunity-evidence";
import { AI_FIELD_IDS } from "@/lib/opportunity-fields";

/**
 * GHL plumbing for the investigation desks' work queues, all stages of the
 * '01 Intake-Investigation Pipeline':
 * - the AI desk drains '👀 Ready for AI Investigation'
 * - the review desk works 'AI Under Investigation' (agent results → split)
 * - the investigator desk drains '🔍 Manual Investigation'
 *
 * Pipeline/stage are matched by normalized name (emoji, spacing and
 * punctuation stripped) so a cosmetic rename in GHL doesn't silently break a
 * queue — a missing name throws with the available options listed. Same
 * convention as lib/review-queue.ts.
 */

export const INTAKE_PIPELINE_NAME = "01 Intake-Investigation Pipeline";

export type QueueDesk = "ai" | "review" | "manual";

/** Where an opportunity goes the moment an AI run starts on it. */
export const AI_UNDER_INVESTIGATION_STAGE_NAME = "AI Under Investigation";

export const DESK_STAGE_NAMES: Record<QueueDesk, string> = {
  ai: "👀 Ready for AI Investigation",
  review: AI_UNDER_INVESTIGATION_STAGE_NAME,
  manual: "🔍 Manual Investigation",
};

const normName = (name: string): string =>
  name.toLowerCase().replace(/[^a-z0-9]/g, "");

type RawPipeline = {
  id: string;
  name?: string;
  stages?: { id: string; name?: string }[];
};

export type QueueStage = {
  pipelineId: string;
  pipelineName: string;
  stageId: string;
  stageName: string;
};

export async function resolveQueueStage(desk: QueueDesk): Promise<QueueStage> {
  return resolveIntakeStage(DESK_STAGE_NAMES[desk]);
}

/** Resolve any stage of the intake pipeline by (normalized) name. */
export async function resolveIntakeStage(
  wantedStage: string,
): Promise<QueueStage> {
  const res = await ghlFetch<{ pipelines?: RawPipeline[] }>(
    `/opportunities/pipelines?locationId=${ghlLocationId()}`,
  );
  const pipelines = res.pipelines ?? [];
  const pipeline =
    pipelines.find(
      (p) => normName(p.name ?? "") === normName(INTAKE_PIPELINE_NAME),
    ) ??
    // Renamed pipeline fallback: whichever one holds the wanted stage.
    pipelines.find((p) =>
      (p.stages ?? []).some(
        (s) => normName(s.name ?? "") === normName(wantedStage),
      ),
    );
  if (!pipeline) {
    const names = pipelines.map((p) => p.name).filter(Boolean).join(", ");
    throw new Error(
      `Pipeline "${INTAKE_PIPELINE_NAME}" not found. Available: ${names || "(none)"}`,
    );
  }

  const stage = (pipeline.stages ?? []).find(
    (s) => normName(s.name ?? "") === normName(wantedStage),
  );
  if (!stage) {
    const names = (pipeline.stages ?? [])
      .map((s) => s.name)
      .filter(Boolean)
      .join(", ");
    throw new Error(
      `Stage "${wantedStage}" not found in pipeline "${pipeline.name}". Available: ${names || "(none)"}`,
    );
  }

  return {
    pipelineId: pipeline.id,
    pipelineName: pipeline.name ?? INTAKE_PIPELINE_NAME,
    stageId: stage.id,
    stageName: stage.name ?? wantedStage,
  };
}

/**
 * Move an opportunity into a stage — the caller guards that the opportunity
 * actually belongs to the stage's pipeline (a PUT would otherwise drag an
 * opportunity from another pipeline into this one).
 */
export async function moveOpportunityToStage(
  opportunityId: string,
  stage: QueueStage,
): Promise<void> {
  await ghlFetch(`/opportunities/${opportunityId}`, {
    method: "PUT",
    body: { pipelineId: stage.pipelineId, pipelineStageId: stage.stageId },
  });
}

export type QueueOpportunity = {
  id: string;
  name: string;
  createdAt: string | null;
  contactId: string | null;
  contactName: string | null;
  /**
   * "AI Run Status" custom-field value, verbatim (see RUN_STATUS in
   * opportunity-fields). Null when the agent never finished a run — on the
   * review desk that means it's still running, or it died mid-run.
   */
  aiRunStatus: string | null;
};

type RawOpportunity = {
  id?: string;
  name?: string;
  createdAt?: string;
  contactId?: string | null;
  contact?: { id?: string; name?: string };
  customFields?: RawCustomFieldValue[];
};

/**
 * Every OPEN opportunity currently sitting in the desk's stage, oldest first —
 * a work queue is drained in arrival order.
 */
export async function listQueueOpportunities(
  stage: QueueStage,
): Promise<QueueOpportunity[]> {
  const locationId = ghlLocationId();
  const pagePath = (page: number) =>
    `/opportunities/search?location_id=${locationId}` +
    `&pipeline_id=${stage.pipelineId}` +
    `&pipeline_stage_id=${stage.stageId}` +
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
        aiRunStatus: customFieldString(
          o.customFields ?? [],
          AI_FIELD_IDS.runStatus,
        ),
      });
    }
    const total = res.meta?.total ?? collected.length;
    if (batch.length < 100 || collected.length >= total) break;
  }
  return collected.sort((a, b) =>
    (a.createdAt ?? "").localeCompare(b.createdAt ?? ""),
  );
}
