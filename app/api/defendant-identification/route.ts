import { z } from "zod";
import {
  type DefendantCandidate,
  formatDefendantReport,
  getDefendantAgent,
} from "@/lib/agents/defendant-agent";
import type { SosEntity, SosLookupResult } from "@/lib/agents/defendant-tools";
import { createLogger, nextRequestId } from "@/lib/logger";
import { isRateLimitError } from "@/lib/rate-limit";

const baseLog = createLogger("defendant-id");

// Legal-entity suffixes to ignore when matching a Secretary of State record to
// an identified candidate (so "Sunshine Marketing, LLC" matches "Sunshine
// Marketing Inc").
const NAME_SUFFIXES = new Set([
  "LLC",
  "INC",
  "CORP",
  "CO",
  "PA",
  "PC",
  "PLLC",
  "LP",
  "LLP",
  "LLLP",
  "LTD",
  "COMPANY",
  "CORPORATION",
  "INCORPORATED",
]);

function normalizeName(name: string): string {
  return name
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, " ")
    .split(/\s+/)
    .filter((token) => token && !NAME_SUFFIXES.has(token))
    .join(" ");
}

function namesMatch(a: string, b: string): boolean {
  const na = normalizeName(a);
  const nb = normalizeName(b);
  if (!na || !nb) return false;
  return na === nb || na.includes(nb) || nb.includes(na);
}

/** Prefer Active / Good Standing records when the same entity is found twice. */
function isActive(entity: SosEntity): boolean {
  return /active|good standing/i.test(entity.status ?? "");
}

type CandidateWithSos = DefendantCandidate & { sos: SosEntity | null };

const fileSchema = z.object({
  kind: z.enum(["audio", "image"]),
  name: z.string(),
  text: z.string(),
});

const requestSchema = z.object({
  files: z.array(fileSchema).min(1),
  evaluation: z
    .object({
      category: z.string(),
      message_type: z.string(),
      reasoning: z.string(),
    })
    .optional(),
});

// The agent loops through several search/fetch round-trips; give it room locally.
export const maxDuration = 300;

export async function POST(request: Request) {
  const log = baseLog.child(nextRequestId());
  const parsed = requestSchema.safeParse(await request.json());
  if (!parsed.success) {
    log.warn("rejected: invalid request body", {
      issues: parsed.error.issues.map((i) => i.path.join(".") || "(root)"),
    });
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { files, evaluation } = parsed.data;
  log.info("request received", {
    files: files.length,
    kinds: files.map((f) => f.kind).join(","),
    hasEvaluation: Boolean(evaluation),
    evaluationCategory: evaluation?.category,
  });

  const fileBlocks = files
    .map((file, index) => {
      const label =
        file.kind === "audio" ? "AUDIO TRANSCRIPTION" : "IMAGE DESCRIPTION";
      return `### File ${index + 1} — ${label} — ${file.name}\n\n${file.text}`;
    })
    .join("\n\n---\n\n");

  const evaluationBlock = evaluation
    ? `\n\nPRIOR TCPA EVALUATION (context): category=${evaluation.category}, message_type=${evaluation.message_type}.\nReasoning: ${evaluation.reasoning}`
    : "";

  const prompt = `The case below contains ${files.length} file${
    files.length === 1 ? "" : "s"
  }. Identify the company (or companies) behind the phone number(s) or company name(s) in this evidence, following the SOP.${evaluationBlock}\n\n${fileBlocks}`;

  try {
    const agent = await getDefendantAgent();

    // Phase 1 — investigate with tools, producing a free-text report.
    const doneInvestigate = log.start("agent.investigate");
    const result = await agent.generate({ prompt });
    doneInvestigate({
      steps: result.steps?.length,
      reportChars: result.text.length,
    });

    // Phase 2 — structure that report into the schema (tool-free, JSON output).
    const doneFormat = log.start("agent.format");
    const report = await formatDefendantReport(result.text);
    const candidates = report.candidates ?? [];
    doneFormat({
      candidates: candidates.length,
      companies: candidates.map((c) => c.company_name).join(" | ") || "(none)",
    });

    // Phase 3 — attach the authoritative Secretary of State records. These come
    // straight from the `sos_lookup` tool outputs (NOT the LLM), so the legal
    // name, addresses, and registered agent are byte-exact for filing/service.
    // `result.staticToolResults` only holds the final step; the lookup happens
    // mid-loop, so aggregate tool results across every step.
    const sosResults = (result.steps ?? [])
      .flatMap((step) => step.staticToolResults ?? [])
      .filter((r) => r.toolName === "sos_lookup")
      .map((r) => r.output as SosLookupResult);

    const foundEntities: SosEntity[] = [];
    for (const r of sosResults) {
      if (!r.found) continue;
      // Dedupe across state retries; keep the Active record on a tie.
      const dupeIndex = foundEntities.findIndex(
        (e) =>
          (e.entityId && r.entity.entityId && e.entityId === r.entity.entityId) ||
          (!!e.entityName &&
            !!r.entity.entityName &&
            namesMatch(e.entityName, r.entity.entityName)),
      );
      if (dupeIndex === -1) foundEntities.push(r.entity);
      else if (isActive(r.entity) && !isActive(foundEntities[dupeIndex])) {
        foundEntities[dupeIndex] = r.entity;
      }
    }

    const sosErrors = sosResults
      .filter((r): r is Extract<SosLookupResult, { error: string }> =>
        "error" in r,
      )
      .map((r) => r.error);

    // Attach each entity to its best-matching candidate; surface the rest.
    const usedEntities = new Set<SosEntity>();
    const candidatesWithSos: CandidateWithSos[] = candidates.map((candidate) => {
      const match = foundEntities.find(
        (e) =>
          !usedEntities.has(e) &&
          !!e.entityName &&
          namesMatch(candidate.company_name, e.entityName),
      );
      if (match) usedEntities.add(match);
      return { ...candidate, sos: match ?? null };
    });
    const unmatchedEntities = foundEntities.filter((e) => !usedEntities.has(e));

    log.info("sos lookups summarized", {
      attempts: sosResults.length,
      found: foundEntities.length,
      attached: foundEntities.length - unmatchedEntities.length,
      errors: sosErrors.length,
    });

    return Response.json({
      candidates: candidatesWithSos,
      search_terms_used: report.search_terms_used ?? [],
      sos_records: foundEntities,
      unmatched_sos_records: unmatchedEntities,
      // Surface SOS trouble only when nothing came back, so a single bad
      // state guess alongside a good hit doesn't raise a false alarm.
      sos_error:
        foundEntities.length === 0 && sosErrors.length > 0
          ? sosErrors[0]
          : undefined,
    });
  } catch (err) {
    if (isRateLimitError(err)) {
      log.error("failed: gateway rate limit exceeded (429)");
      return Response.json(
        {
          error:
            "AI gateway rate limit exceeded. Please wait a moment and try again.",
        },
        { status: 429 },
      );
    }
    const message =
      err instanceof Error ? err.message : "Defendant identification failed";
    log.error("failed: agent threw", {
      message,
      name: err instanceof Error ? err.name : typeof err,
    });
    return Response.json({ error: message }, { status: 500 });
  }
}
