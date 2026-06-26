import { z } from "zod";
import {
  type DefendantCandidate,
  formatDefendantReport,
  getDefendantAgent,
} from "@/lib/agents/defendant-agent";
import {
  lookupSosEntity,
  type SosEntity,
  type SosLookupResult,
} from "@/lib/agents/defendant-tools";
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

function stateOf(entity: SosEntity): string {
  return (entity.searchState ?? "").toUpperCase();
}

const isFlorida = (entity: SosEntity): boolean => stateOf(entity) === "FL";

/**
 * Whether two records describe the SAME registration. Registrations in
 * different states are kept separate (a company's home registration and its
 * Florida foreign registration share a name but are distinct records, and we
 * want both). Within one state, the same entity is matched by id, then name.
 */
function sameRegistration(a: SosEntity, b: SosEntity): boolean {
  if (stateOf(a) !== stateOf(b)) return false;
  if (a.entityId && b.entityId) return a.entityId === b.entityId;
  return (
    !!a.entityName && !!b.entityName && namesMatch(a.entityName, b.entityName)
  );
}

/**
 * Merge found entities into `into`, deduping per (legal name, state). On a
 * same-state collision keep the Active/Good-Standing record.
 */
function collectEntities(into: SosEntity[], results: SosLookupResult[]): void {
  for (const r of results) {
    if (!r.found) continue;
    const dupeIndex = into.findIndex((e) => sameRegistration(e, r.entity));
    if (dupeIndex === -1) into.push(r.entity);
    else if (isActive(r.entity) && !isActive(into[dupeIndex])) {
      into[dupeIndex] = r.entity;
    }
  }
}

/**
 * Order a company's official records for display: the home/domestic
 * registration first (the canonical identity — legal name, state of formation),
 * then any Florida foreign registration after it.
 */
function orderRecords(records: SosEntity[]): SosEntity[] {
  return [...records].sort(
    (a, b) => (isFlorida(a) ? 1 : 0) - (isFlorida(b) ? 1 : 0),
  );
}

// Outcome of a single Florida registry check for one legal name.
type FlOutcome = "found" | "not_found" | "error";

/**
 * What the Florida cross-lookup found for a candidate, so the UI can tell the
 * user FL was actually checked:
 * - `found`        — a Florida record exists for this company (shown as a record).
 * - `not_found`    — FL was checked and there is no registration on file.
 * - `error`        — the FL lookup failed (timeout / scraper error) — worth a retry.
 * - `not_applicable` — no confirmed entity to cross-look-up (nothing to report).
 */
type FlCheckStatus = FlOutcome | "not_applicable";

function flCheckStatus(
  records: SosEntity[],
  flOutcomeByName: Map<string, FlOutcome>,
): FlCheckStatus {
  if (records.length === 0) return "not_applicable";
  // A Florida record is attached (its own FL registration or a foreign one).
  if (records.some(isFlorida)) return "found";
  // Non-FL records only — report how the FL check for those names resolved.
  for (const entity of records) {
    const key = entity.entityName ? normalizeName(entity.entityName) : "";
    const outcome = key ? flOutcomeByName.get(key) : undefined;
    if (outcome) return outcome;
  }
  return "not_applicable";
}

type CandidateWithSos = DefendantCandidate & {
  sos_records: SosEntity[];
  fl_check: FlCheckStatus;
};

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

// The agent loops through several search/fetch round-trips, and a single slow
// Secretary of State scrape can now hold for up to 5 minutes (see
// SOS_LOOKUP_TIMEOUT_MS). Give the route generous headroom so a slow lookup
// isn't killed mid-flight. NOTE: hosted platforms cap function duration by plan
// (e.g. Vercel) — this value is only honored where the platform allows it.
export const maxDuration = 800;

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
    const report = await formatDefendantReport(
      result.text,
      files.map((f) => f.name),
    );
    // Keep only attributions that name a real file in this case, so a stray /
    // paraphrased filename never points the UI at evidence that isn't there.
    const knownFileNames = new Set(files.map((f) => f.name));
    const candidates = (report.candidates ?? []).map((c) => ({
      ...c,
      evidence_files: (c.evidence_files ?? []).filter((name) =>
        knownFileNames.has(name),
      ),
    }));
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

    // Confirmed entities, deduped per (legal name, state) so a company's home
    // registration and its Florida foreign registration are BOTH kept.
    const foundEntities: SosEntity[] = [];
    collectEntities(foundEntities, sosResults);

    // Florida cross-lookup. The firm prefers to serve a Florida registered
    // agent, so for every confirmed entity that is NOT already a Florida record,
    // run an extra lookup in FL for the same legal name to capture the foreign
    // registration (and its FL agent). Skip names the agent already queried in
    // FL — found or not — so we never pay for a redundant lookup.
    const flAlreadyQueried = new Set(
      sosResults
        .filter((r) => r.state.toUpperCase() === "FL")
        .map((r) => normalizeName(r.queriedName)),
    );
    const flTargets = new Map<string, string>(); // normalized name -> legal name
    for (const entity of foundEntities) {
      if (isFlorida(entity)) continue; // already a Florida record
      const legalName = entity.entityName?.trim();
      if (!legalName) continue;
      const norm = normalizeName(legalName);
      if (!norm || flAlreadyQueried.has(norm) || flTargets.has(norm)) continue;
      flTargets.set(norm, legalName);
    }

    const flResults =
      flTargets.size > 0
        ? await Promise.all(
            [...flTargets.values()].map((name) => lookupSosEntity(name, "FL")),
          )
        : [];
    collectEntities(foundEntities, flResults);

    // How the Florida check resolved for each legal name — whether the agent ran
    // it or our cross-lookup did — so each candidate can show that FL was
    // checked even when nothing was found. Prefer the most informative outcome
    // on collisions: found > not_found > error.
    const flOutcomeByName = new Map<string, FlOutcome>();
    for (const r of [...sosResults, ...flResults]) {
      if (r.state.toUpperCase() !== "FL") continue;
      const key = normalizeName(r.queriedName);
      if (!key) continue;
      const outcome: FlOutcome = r.found
        ? "found"
        : "error" in r
          ? "error"
          : "not_found";
      const existing = flOutcomeByName.get(key);
      if (
        !existing ||
        outcome === "found" ||
        (existing === "error" && outcome === "not_found")
      ) {
        flOutcomeByName.set(key, outcome);
      }
    }

    const sosErrors = [...sosResults, ...flResults]
      .filter((r): r is Extract<SosLookupResult, { error: string }> =>
        "error" in r,
      )
      .map((r) => r.error);

    // Attach every matching record to its candidate (home + Florida foreign);
    // surface the rest. Each record is claimed once so two similarly-named
    // candidates don't both grab it.
    const usedEntities = new Set<SosEntity>();
    const candidatesWithSos: CandidateWithSos[] = candidates.map((candidate) => {
      const matches = foundEntities.filter(
        (e) =>
          !usedEntities.has(e) &&
          !!e.entityName &&
          namesMatch(candidate.company_name, e.entityName),
      );
      matches.forEach((e) => usedEntities.add(e));
      const orderedRecords = orderRecords(matches);
      return {
        ...candidate,
        sos_records: orderedRecords,
        fl_check: flCheckStatus(orderedRecords, flOutcomeByName),
      };
    });
    const unmatchedEntities = foundEntities.filter((e) => !usedEntities.has(e));

    log.info("sos lookups summarized", {
      attempts: sosResults.length,
      flCrossLookups: flResults.length,
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
