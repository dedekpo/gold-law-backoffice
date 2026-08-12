import { z } from "zod";
import { syncContactDnc } from "@/lib/contact-dnc";
import { dncUnavailable } from "@/lib/dnc";
import { GhlError, ghlLocationId } from "@/lib/ghl";
import {
  AI_UNDER_INVESTIGATION_STAGE_NAME,
  moveOpportunityToStage,
  resolveIntakeStage,
} from "@/lib/investigation-queue";
import { type Logger, createLogger, nextRequestId } from "@/lib/logger";
import {
  customFieldString,
  fetchOpportunityWithEvidence,
} from "@/lib/opportunity-evidence";
import { AI_FIELD_IDS } from "@/lib/opportunity-fields";
import type { DncCheck } from "@/lib/types";

const baseLog = createLogger("opportunity-import");

/**
 * Resolve a pasted GHL opportunity URL to the case evidence attached to it.
 * Fetches the opportunity, the location's opportunity custom-field
 * definitions, and the opportunity's contact (for the client's phone
 * number), and returns the files held in the evidence FILE_UPLOAD fields.
 * The contact's number is checked against the DNC registries via the
 * RealValidation API right here, so every case starts with a fresh automated
 * DNC result, which is also mirrored onto the contact's dropdown custom
 * fields as a reference for intakers. Starting a fresh run also moves the
 * opportunity to 'AI Under Investigation' within the intake pipeline. The client
 * downloads each file through /api/opportunity/file and feeds it into the
 * pipeline.
 */

// e.g. https://login.amicus-pro.com/v2/location/{locationId}/opportunities/{id}?tab=…
const URL_RE = /\/location\/([A-Za-z0-9]+)\/opportunities\/([A-Za-z0-9]+)/;

const requestSchema = z
  .object({
    url: z.string().min(1).optional(),
    /** Direct id, used by the desk queues (no URL to paste there). */
    opportunityId: z.string().min(1).optional(),
  })
  .refine((body) => body.url || body.opportunityId, {
    message: "Either url or opportunityId is required.",
  });

/**
 * Run the opportunity's contact through the RealValidation DNC lookup and
 * mirror the result onto the contact's dropdown custom fields (a reference
 * for intakers — see lib/contact-dnc.ts). Every failure path returns a
 * DncCheck with `error` set rather than throwing, so an import never dies
 * on the DNC step.
 */
async function checkContactDnc(
  contactId: string | null,
  log: Logger,
): Promise<DncCheck> {
  if (!contactId) {
    return dncUnavailable("The opportunity has no contact attached.");
  }
  try {
    const { dnc, changedFields, writeError } = await syncContactDnc(contactId);
    if (writeError) {
      log.warn("contact dnc write-back failed", { contactId, writeError });
    }
    log.info("contact dnc synced", { contactId, changedFields });
    return dnc;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn("contact fetch failed", { contactId, message });
    return dncUnavailable(
      `Could not fetch the opportunity's contact from GHL: ${message}`,
    );
  }
}

export async function POST(request: Request) {
  const log = baseLog.child(nextRequestId());
  const parsed = requestSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json(
      { error: "Invalid request body: expected { url } or { opportunityId }" },
      { status: 400 },
    );
  }

  let opportunityId: string;
  if (parsed.data.url) {
    const match = URL_RE.exec(parsed.data.url);
    if (!match) {
      return Response.json(
        {
          error:
            "That doesn't look like a GHL opportunity URL. Expected …/location/{locationId}/opportunities/{opportunityId}.",
        },
        { status: 400 },
      );
    }
    const [, urlLocationId] = match;
    if (urlLocationId !== ghlLocationId()) {
      return Response.json(
        {
          error:
            "This opportunity belongs to a different GHL sub-account than the one this tool is connected to.",
        },
        { status: 400 },
      );
    }
    opportunityId = match[2];
  } else {
    opportunityId = parsed.data.opportunityId!;
  }

  log.info("importing opportunity", { opportunityId });

  try {
    const result = await fetchOpportunityWithEvidence(opportunityId);
    if (!result) {
      return Response.json(
        { error: "GHL returned no opportunity for that id." },
        { status: 502 },
      );
    }
    const { opportunity, files, skipped } = result;

    // Automated DNC check of the client's number (replaces the manual
    // checkboxes). Best-effort: a missing contact/phone or a registry failure
    // becomes a DncCheck with `error` set, so the case still starts and
    // Screen 04 reports the DNC status as unverified.
    const dnc = await checkContactDnc(opportunity.contactId, log);

    // A previous agent run leaves the "AI Run Status" custom field non-empty —
    // GHL is the run database. Report it so the UI can ask before re-running.
    const statusValue = customFieldString(
      opportunity.customFields,
      AI_FIELD_IDS.runStatus,
    );
    const existingRun = statusValue ? { status: statusValue } : null;

    // Starting a run moves the opportunity to 'AI Under Investigation' so the
    // pipeline reflects who's working it. Guarded three ways: only when a run
    // will actually start (there are files and no existing-run confirmation
    // pending — a re-run import may still be cancelled at the dialog), and
    // only within the intake pipeline (a PUT would otherwise drag a case
    // opportunity from another pipeline into it). Best-effort: a failed move
    // never blocks the run.
    if (files.length > 0 && !existingRun) {
      try {
        const stage = await resolveIntakeStage(
          AI_UNDER_INVESTIGATION_STAGE_NAME,
        );
        if (
          opportunity.pipelineId === stage.pipelineId &&
          opportunity.pipelineStageId !== stage.stageId
        ) {
          await moveOpportunityToStage(opportunityId, stage);
          log.info("moved to stage", { opportunityId, stage: stage.stageName });
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        log.warn("stage move failed", { opportunityId, message });
      }
    }

    log.info("opportunity imported", {
      opportunityId,
      name: opportunity.name,
      files: files.length,
      skipped,
      existingRun: existingRun?.status ?? "none",
      dnc: dnc.error
        ? `unavailable (${dnc.error})`
        : `national=${dnc.national} state=${dnc.state} litigator=${dnc.litigator}`,
    });

    return Response.json({
      opportunity: {
        id: opportunity.id,
        name: opportunity.name,
        status: opportunity.status,
        contactId: opportunity.contactId,
      },
      files,
      skipped,
      existingRun,
      dnc,
    });
  } catch (err) {
    if (err instanceof GhlError && err.status === 404) {
      return Response.json(
        { error: "Opportunity not found — check the URL or id and try again." },
        { status: 404 },
      );
    }
    const message = err instanceof Error ? err.message : String(err);
    log.error("import failed", { opportunityId, message });
    return Response.json(
      { error: `Could not fetch the opportunity from GHL: ${message}` },
      { status: 502 },
    );
  }
}
