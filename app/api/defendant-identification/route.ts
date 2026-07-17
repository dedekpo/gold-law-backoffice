import { z } from "zod";
import {
  type CompanyEnrichment,
  type DefendantCandidate,
  enrichConfirmedEntity,
  formatDefendantReport,
  getDefendantAgent,
} from "@/lib/agents/defendant-agent";
import {
  lookupSosEntity,
  type SosEntity,
  type SosLookupResult,
} from "@/lib/agents/defendant-tools";
import { joinAddress, recordLabel } from "@/lib/display";
import { getJob, startJob } from "@/lib/jobs";
import { type Logger, createLogger, nextRequestId } from "@/lib/logger";
import { isRateLimitError } from "@/lib/rate-limit";
import { assessCompany } from "@/lib/scoring/assess";
import type {
  ExtractedContact,
  ScreenResult,
  Scorecard,
  Track,
} from "@/lib/types";

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
 * A registry result is a GENUINE hit only when it was found AND the returned
 * legal name actually matches what we searched. A name search returns the
 * registry's closest entry, not necessarily an exact hit (e.g. searching
 * "Software Finder LLC" in Florida returns Sunbiz's neighbouring "Software
 * Finders, Inc."). This one predicate gates BOTH record attachment and the
 * Florida-check outcome, so a fuzzy near-match can never become a confirmed
 * entity nor silently award the Florida forum bonus.
 */
function isGenuineHit(
  r: SosLookupResult,
): r is Extract<SosLookupResult, { found: true }> {
  return (
    r.found &&
    (!r.entity.entityName || namesMatch(r.queriedName, r.entity.entityName))
  );
}

/**
 * Merge found entities into `into`, deduping per (legal name, state). On a
 * same-state collision keep the Active/Good-Standing record.
 */
function collectEntities(into: SosEntity[], results: SosLookupResult[]): void {
  for (const r of results) {
    if (!isGenuineHit(r)) continue;
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
  // Set on candidates built from a registry record alone (synthesizeCandidateFromSos).
  synthesized?: boolean;
  // Per-company screening + scoring, attached after identification (Step 6).
  track?: Track;
  screens?: ScreenResult[];
  scorecard?: Scorecard;
};

/**
 * Cluster official records that describe the SAME company so each company is
 * synthesized once. A company's home registration and its Florida foreign
 * registration share a legal name but are distinct records — both belong to one
 * company. Records with no entity name fall into their own singleton group.
 */
function groupByCompany(entities: SosEntity[]): SosEntity[][] {
  const groups: SosEntity[][] = [];
  for (const entity of entities) {
    const group = groups.find((g) =>
      g.some(
        (e) =>
          !!e.entityName &&
          !!entity.entityName &&
          namesMatch(e.entityName, entity.entityName),
      ),
    );
    if (group) group.push(entity);
    else groups.push([entity]);
  }
  return groups;
}

/**
 * Build a candidate straight from confirmed Secretary of State records when the
 * investigator's report never tied them to a company. A registry-confirmed
 * entity IS a real defendant — the most authoritative output the investigation
 * has — so it must stand up its own company (and its own download folder) rather
 * than being stranded as an "official record" with no company attached. This is
 * what closes the gap where the SOS lookup found an entity but the UI said "no
 * companies identified" and the export produced no company folder.
 *
 * `records` are the official record(s) for ONE entity (its home registration
 * plus any Florida foreign one), ordered home-first. The registry supplies the
 * authoritative filing/service fields (legal name, state, addresses, agent);
 * `enrichment` (when present) supplies the commercial fields the registry lacks —
 * website, goods/services, headcount, revenue, solvability — recovered by the
 * enrichment pass. `evidenceFileNames` ties the case's evidence to the company so
 * the defendant and its proof land together.
 */
function synthesizeCandidateFromSos(
  records: SosEntity[],
  evidenceFileNames: string[],
  flOutcomeByName: Map<string, FlOutcome>,
  enrichment: CompanyEnrichment | null,
): CandidateWithSos {
  const home = records[0];
  // The firm serves in Florida, so prefer the FL registration's agent when present.
  const agentRecord = records.find(isFlorida) ?? home;
  const legalName = home.entityName?.trim() || "Unknown entity";
  const principal =
    joinAddress([
      home.principalAddress,
      home.principalCity,
      home.principalState,
      home.principalZip,
    ]) ??
    joinAddress([
      home.mailingAddress,
      home.mailingCity,
      home.mailingState,
      home.mailingZip,
    ]);
  const hasAgent =
    !!agentRecord.registeredAgentName ||
    !!agentRecord.registeredAgentAddress ||
    !!agentRecord.registeredAgentState;
  const registeredAgent = hasAgent
    ? {
        name: agentRecord.registeredAgentName ?? null,
        address: joinAddress([
          agentRecord.registeredAgentAddress,
          agentRecord.registeredAgentCity,
          agentRecord.registeredAgentState,
          agentRecord.registeredAgentZip,
        ]),
        state: agentRecord.registeredAgentState ?? null,
      }
    : null;
  // Source URLs: the official filing(s) plus anything the enrichment relied on.
  const sources = Array.from(
    new Set([
      ...records
        .map((r) => r.sosUrl)
        .filter((u): u is string => typeof u === "string" && u.length > 0),
      ...(enrichment?.sources ?? []),
    ]),
  );
  const baseNote =
    "Identified from the Secretary of State record: this entity was confirmed in " +
    "the official registry, but the investigator's written report did not tie it " +
    "to a company, so it is surfaced here directly from the authoritative record.";
  // Warn the intaker when the enrichment research suggests this entity's business
  // does not line up with the case evidence — that is a flag to verify, not file.
  const mismatchNote =
    enrichment && !enrichment.business_match
      ? " ⚠ Web research suggests this entity's business may NOT match the case " +
        "evidence — verify the company before filing."
      : "";
  const notes =
    [baseNote + mismatchNote, enrichment?.notes?.trim()]
      .filter(Boolean)
      .join(" ") || null;
  return {
    // Prefer the brand/trade name the enrichment found; fall back to the legal name.
    company_name: enrichment?.company_name?.trim() || legalName,
    legal_name: legalName,
    website: enrichment?.website ?? null,
    goods_services: enrichment?.goods_services ?? null,
    state_of_incorporation: home.jurisdiction ?? home.searchState ?? null,
    hq_mailing_address: principal,
    registered_agent: registeredAgent,
    employees_estimate: enrichment?.employees_estimate ?? null,
    revenue_estimate: enrichment?.revenue_estimate ?? null,
    solvability_tier: enrichment?.solvability_tier ?? "unknown",
    // The entity itself is registry-confirmed; the enrichment's confidence reflects
    // how well the commercial picture matches. Absent enrichment, keep it modest.
    confidence: enrichment?.confidence ?? 0.5,
    sources,
    evidence_files: evidenceFileNames,
    notes,
    sos_records: records,
    fl_check: flCheckStatus(records, flOutcomeByName),
    // Surfaced from the registry, not the evidence — so the UI/export must not
    // fall back to claiming the case's files as this company's proof.
    synthesized: true,
  };
}

/** Compact plain-text summary of a company's official record(s) for the enrichment pass. */
function sosContextFor(records: SosEntity[]): string {
  return records
    .map((r) => {
      const principal = joinAddress([
        r.principalAddress,
        r.principalCity,
        r.principalState,
        r.principalZip,
      ]);
      const agent = joinAddress([
        r.registeredAgentName,
        r.registeredAgentAddress,
        r.registeredAgentCity,
        r.registeredAgentState,
        r.registeredAgentZip,
      ]);
      const officers = (r.officers ?? [])
        .map((o) => [o.title, o.name].filter(Boolean).join(" "))
        .filter(Boolean)
        .join("; ");
      return [
        `Record (${recordLabel(r)}):`,
        `  Legal name: ${r.entityName ?? "—"}`,
        `  State of formation: ${r.jurisdiction ?? r.searchState ?? "—"}`,
        `  Status: ${r.status ?? "—"}`,
        `  Principal address: ${principal ?? "—"}`,
        `  Registered agent: ${agent ?? "—"}`,
        officers ? `  Officers: ${officers}` : "",
      ]
        .filter(Boolean)
        .join("\n");
    })
    .join("\n");
}

// The investigation payload the client ultimately renders. It's produced by the
// background job and handed back through a status poll, never returned directly
// from the POST that starts the work.
type DefendantResponse = {
  candidates: CandidateWithSos[];
  search_terms_used: string[];
  sos_records: SosEntity[];
  unmatched_sos_records: SosEntity[];
  sos_error?: string;
  // The agent's own written investigation narrative — surfaced so a case that
  // identifies no company still shows what was searched and why nothing stuck.
  investigation_summary?: string;
};

const fileSchema = z.object({
  kind: z.enum(["audio", "image"]),
  name: z.string(),
  text: z.string(),
  // Audio forensic hint, merged into the extracted contacts so Screen 01
  // (prerecorded voice) is grounded in the acoustic analysis.
  forensics: z
    .object({
      is_likely_prerecorded: z.boolean(),
      automated_likelihood: z.number(),
    })
    .optional(),
});

// Mirrors EvidenceFacts (lib/types) — the normalized facts from the extraction
// pass, used to screen + score each identified company.
const contactSchema = z.object({
  file: z.string(),
  // Chronological ordering + inferred-timestamp flag drive Screen 02 (failure to
  // stop). Defaulted so older extraction payloads without them still validate;
  // the route re-derives a stable order when `sequence` is absent.
  sequence: z.number().optional(),
  timestampInferred: z.boolean().optional(),
  direction: z.enum(["from_consumer", "from_company", "unknown"]),
  channel: z.enum(["text", "call", "voicemail", "email", "unknown"]),
  timestamp: z.string().nullable(),
  dateReceived: z.string().nullable(),
  dateReceivedYearShown: z.boolean(),
  messageType: z.enum([
    "marketing",
    "debt_collection",
    "informational",
    "unknown",
  ]),
  isStopRequest: z.boolean(),
  isOptOutConfirmation: z.boolean(),
  isPrerecorded: z.boolean(),
  consentSignal: z.enum([
    "cold_contact",
    "ambiguous",
    "prior_relationship",
    "unknown",
  ]),
  killSignal: z.enum(["job_scam", "true_healthcare", "none"]),
  contentSummary: z.string(),
});

const requestSchema = z.object({
  files: z.array(fileSchema).min(1),
  facts: z
    .object({
      contacts: z.array(contactSchema),
      notes: z.array(z.string()).optional(),
    })
    .optional(),
  // Operator-attested DNC registrations (manual registry lookups by an intaker).
  // Case-level: feeds Screen 04 for every identified company.
  dnc: z
    .object({
      national: z.boolean(),
      florida: z.boolean(),
    })
    .optional(),
});

// The investigation can run for ~10 minutes. Rather than hold one HTTP request
// open that long (a platform proxy such as Railway's will cut it with a 502 and
// orphan the result), POST starts the work as a background job and returns a job
// id immediately; the client polls GET ?jobId=… for the result. `maxDuration`
// only bounds the (now sub-second) POST/GET handlers themselves — the background
// job keeps running in the long-lived Node process regardless.
export const maxDuration = 60;

// POST starts the investigation and returns a job id right away. Because the
// response is immediate, no proxy can time the request out mid-investigation.
export async function POST(request: Request) {
  const log = baseLog.child(nextRequestId());
  const parsed = requestSchema.safeParse(await request.json());
  if (!parsed.success) {
    log.warn("rejected: invalid request body", {
      issues: parsed.error.issues.map((i) => i.path.join(".") || "(root)"),
    });
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const jobId = startJob(() => runInvestigation(parsed.data, log), {
    isRateLimited: isRateLimitError,
  });
  log.info("investigation queued", { jobId });
  return Response.json({ jobId }, { status: 202 });
}

// GET ?jobId=… reports the status of a queued investigation. Each poll is a
// fast, self-contained request, so a dropped connection mid-investigation is no
// longer fatal — the result is delivered whenever the client next polls.
export async function GET(request: Request) {
  const jobId = new URL(request.url).searchParams.get("jobId");
  if (!jobId) {
    return Response.json({ error: "Missing jobId" }, { status: 400 });
  }
  const job = getJob<DefendantResponse>(jobId);
  if (!job) {
    return Response.json(
      { error: "Unknown or expired investigation. Please run it again." },
      { status: 404 },
    );
  }
  if (job.status === "done") {
    return Response.json({ status: "done", report: job.result });
  }
  if (job.status === "error") {
    return Response.json({
      status: "error",
      error: job.rateLimited
        ? "AI gateway rate limit exceeded. Please wait a moment and try again."
        : job.error,
      rateLimited: job.rateLimited,
    });
  }
  return Response.json({ status: "running" });
}

async function runInvestigation(
  { files, facts, dnc }: z.infer<typeof requestSchema>,
  log: Logger,
): Promise<DefendantResponse> {
  log.info("request received", {
    files: files.length,
    kinds: files.map((f) => f.kind).join(","),
    hasFacts: Boolean(facts),
    contacts: facts?.contacts.length ?? 0,
    dnc: dnc ? `national=${dnc.national} florida=${dnc.florida}` : "none",
  });

  const fileBlocks = files
    .map((file, index) => {
      const label =
        file.kind === "audio" ? "AUDIO TRANSCRIPTION" : "IMAGE DESCRIPTION";
      return `### File ${index + 1} — ${label} — ${file.name}\n\n${file.text}`;
    })
    .join("\n\n---\n\n");

  const prompt = `The case below contains ${files.length} file${
    files.length === 1 ? "" : "s"
  }. Identify the company (or companies) behind the phone number(s) or company name(s) in this evidence, following the SOP.\n\n${fileBlocks}`;

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

    // Sequential on purpose: these all hit the SAME state's scraper, which
    // processes lookups serially — fired concurrently, the later ones spend
    // their entire abort window queued behind the first and ALL time out.
    const flResults: SosLookupResult[] = [];
    for (const name of flTargets.values()) {
      flResults.push(await lookupSosEntity(name, "FL"));
    }
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
      // Use the SAME genuine-hit rule as record attachment: a fuzzy near-match
      // (found, but the returned legal name isn't ours) is "FL checked, nothing
      // on file" — not a Florida hit — so it can't award the forum bonus.
      const outcome: FlOutcome = isGenuineHit(r)
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
      // Match official records by the brand (company_name) OR the legal entity
      // name. SOS records carry the LEGAL name, which often differs from the
      // brand (e.g. "Orlando Harley-Davidson South" → "American Road Group LLC").
      // Matching the brand alone orphans the record and splits one company into a
      // duplicate "synthesized" card.
      const candidateNames = [candidate.company_name, candidate.legal_name].filter(
        (n): n is string => Boolean(n),
      );
      const matches = foundEntities.filter(
        (e) =>
          !usedEntities.has(e) &&
          !!e.entityName &&
          candidateNames.some((n) => namesMatch(n, e.entityName!)),
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

    // Promote every registry-confirmed entity the investigator never wrote up as
    // a company into a real candidate, built straight from the authoritative
    // record. Without this, an entity the `sos_lookup` tool confirmed would show
    // as an orphan "official record" with no company and no download folder —
    // exactly the "no companies identified, yet the SOS lookup found one"
    // contradiction. Records for the same entity (home + FL foreign) group into
    // one company.
    const unmatchedGroups = groupByCompany(unmatchedEntities);
    // Only when the whole case resolves to a single synthesized company (no
    // attributed candidates, one entity) do we hand it all the case evidence, so
    // the company and its proof land together. With multiple companies in play we
    // cannot responsibly attribute the files, so leave its evidence empty rather
    // than duplicate it across folders.
    const soleCompany =
      candidatesWithSos.length === 0 && unmatchedGroups.length === 1;
    const allFileNames = files.map((f) => f.name);
    const synthesizedCandidates = await Promise.all(
      unmatchedGroups.map(async (group) => {
        const records = orderRecords(group);
        // Recover the commercial picture the registry doesn't hold (website,
        // goods/services, headcount, revenue, solvability) for this confirmed
        // entity. Best-effort: a failed or rate-limited enrichment must never drop
        // the company — we fall back to the registry-only synthesis.
        let enrichment: CompanyEnrichment | null = null;
        if (records[0]?.entityName?.trim()) {
          const doneEnrich = log.start("agent.enrich");
          try {
            enrichment = await enrichConfirmedEntity({
              sosContext: sosContextFor(records),
              fileBlocks,
              fileNames: allFileNames,
            });
            doneEnrich({
              company: records[0].entityName,
              solvability: enrichment.solvability_tier,
              businessMatch: enrichment.business_match,
            });
          } catch (err) {
            log.warn("enrichment failed; using registry-only synthesis", {
              company: records[0].entityName,
              message: err instanceof Error ? err.message : String(err),
            });
          }
        }
        // Prefer the enrichment's own file attribution; otherwise fall back to the
        // whole case only when this is the sole company.
        const attributed = (enrichment?.evidence_files ?? []).filter((name) =>
          knownFileNames.has(name),
        );
        const evidenceFileNames = attributed.length
          ? attributed
          : soleCompany
            ? allFileNames
            : [];
        return synthesizeCandidateFromSos(
          records,
          evidenceFileNames,
          flOutcomeByName,
          enrichment,
        );
      }),
    );
    const allCandidates = [...candidatesWithSos, ...synthesizedCandidates];

    // Per-company screening + scoring. Merge the audio forensics hint into the
    // extracted contacts (so Screen 01 is grounded in the acoustic analysis),
    // then assess each company against ONLY its attributed evidence.
    const rawContacts = facts?.contacts ?? [];
    const prerecordedFiles = new Set(
      files.filter((f) => f.forensics?.is_likely_prerecorded).map((f) => f.name),
    );
    // Normalize and put contacts in one chronological order (by `sequence`, with
    // extraction order as a stable fallback) so per-company screens see the thread
    // timeline — Screen 02 depends on "STOP then a later contact" being ordered.
    const mergedContacts: ExtractedContact[] = rawContacts
      .map((c, i) => ({
        ...c,
        sequence: c.sequence ?? i,
        timestampInferred: c.timestampInferred ?? c.timestamp === null,
        isPrerecorded: prerecordedFiles.has(c.file) ? true : c.isPrerecorded,
      }))
      .sort((a, b) => a.sequence - b.sequence);
    const scoredCandidates: CandidateWithSos[] = allCandidates.map(
      (candidate) => {
        const companyContacts = mergedContacts.filter((c) =>
          candidate.evidence_files.includes(c.file),
        );
        const assessment = assessCompany(candidate, companyContacts, { dnc });
        return {
          ...candidate,
          track: assessment.track,
          screens: assessment.screens,
          scorecard: assessment.scorecard,
        };
      },
    );

    log.info("companies scored", {
      companies: scoredCandidates.length,
      bands: scoredCandidates
        .map((c) => c.scorecard?.band ?? c.track)
        .join(" | "),
    });

    log.info("sos lookups summarized", {
      attempts: sosResults.length,
      flCrossLookups: flResults.length,
      found: foundEntities.length,
      attached: foundEntities.length - unmatchedEntities.length,
      synthesized: synthesizedCandidates.length,
      errors: sosErrors.length,
    });

    return {
      candidates: scoredCandidates,
      search_terms_used: report.search_terms_used ?? [],
      sos_records: foundEntities,
      // Every confirmed entity is now a candidate, so nothing is left orphaned.
      unmatched_sos_records: [],
      // Surface SOS trouble only when nothing came back, so a single bad
      // state guess alongside a good hit doesn't raise a false alarm.
      sos_error:
        foundEntities.length === 0 && sosErrors.length > 0
          ? sosErrors[0]
          : undefined,
      investigation_summary: result.text?.trim() || undefined,
    };
  } catch (err) {
    // The POST has already returned; the job store records this failure and the
    // client surfaces it on its next poll. We only log here so the cause stays
    // visible in the server console.
    if (isRateLimitError(err)) {
      log.error("failed: gateway rate limit exceeded (429)");
    } else {
      const message =
        err instanceof Error ? err.message : "Defendant identification failed";
      log.error("failed: agent threw", {
        message,
        name: err instanceof Error ? err.name : typeof err,
      });
    }
    throw err;
  }
}
