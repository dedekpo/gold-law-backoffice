import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Output, ToolLoopAgent, generateText, stepCountIs } from "ai";
import { z } from "zod";
import { MODELS } from "@/lib/provider";
import { fetchPageTool, sosLookupTool, webSearchTool } from "./defendant-tools";
import { rateLimitedModel } from "./model";

export const candidateSchema = z.object({
  company_name: z.string().describe("Best-guess brand or trade name of the company."),
  legal_name: z
    .string()
    .nullable()
    .describe(
      "Exact registered legal entity name (e.g. 'Sunshine Marketing, LLC'), distinct " +
        "from the brand company_name. Prefer the name from the Secretary of State record. " +
        "Null if not found.",
    ),
  website: z.string().nullable().describe("Primary website URL, or null if unknown."),
  goods_services: z
    .string()
    .nullable()
    .describe("What the company sells or does (must match the message's subject)."),
  state_of_incorporation: z
    .string()
    .nullable()
    .describe(
      "Home state of formation / incorporation if found (e.g. 'Florida'), else null.",
    ),
  hq_mailing_address: z
    .string()
    .nullable()
    .describe(
      "Main office / headquarters mailing address (the principal address from the " +
        "official record when available). Null if not found.",
    ),
  registered_agent: z
    .object({
      name: z.string().nullable().describe("Registered agent name, or null."),
      address: z
        .string()
        .nullable()
        .describe("Registered agent's full address, or null."),
      state: z
        .string()
        .nullable()
        .describe("Registered agent's state (e.g. 'FL'), or null."),
    })
    .nullable()
    .describe(
      "The registered agent the firm would serve, from the Secretary of State record. " +
        "Null if no agent was found.",
    ),
  employees_estimate: z
    .string()
    .nullable()
    .describe("Approximate employee count or range, else null."),
  revenue_estimate: z
    .string()
    .nullable()
    .describe("Approximate annual revenue, else null."),
  solvability_tier: z
    .enum(["risk", "good", "whale", "unknown"])
    .describe(
      "risk = under ~10 employees; good = ~11-50; whale = 50+; unknown if no signal.",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("How confident you are this is the right entity, 0 to 1."),
  sources: z.array(z.string()).describe("URLs that support this candidate."),
  evidence_files: z
    .array(z.string())
    .describe(
      "The exact filename(s) of the originating evidence that point to THIS company — copied " +
        "verbatim from the '### File N — … — <filename>' header of each file the company was " +
        "identified from (e.g. its phone number, brand, or message names this company). A company " +
        "may come from several files, and different companies may come from different files. Empty " +
        "only when no specific file can be tied to this company.",
    ),
  notes: z
    .string()
    .nullable()
    .describe("Anything notable: registered agent leads, caveats, next steps."),
});

export const defendantReportSchema = z.object({
  candidates: z
    .array(candidateSchema)
    .describe("Companies identified behind the message. Empty if none found."),
  search_terms_used: z
    .array(z.string())
    .describe("The phone numbers / company names / queries the agent investigated."),
});

export type DefendantCandidate = z.infer<typeof candidateSchema>;
export type DefendantReport = z.infer<typeof defendantReportSchema>;

const INSTRUCTIONS_PREAMBLE = `You are a forensic intake investigator for a consumer-protection law firm.

You are given the extracted contents of a case — transcriptions of voicemails and/or
descriptions of screenshots (SMS, call logs). Your job is to identify the COMPANY behind the
phone number or company name in that evidence, so the firm can sue the right legal entity.

Follow the SOP below. Use the \`web_search\` and \`fetch_page\` tools to investigate. Work the
problem in a loop:

1. Extract every phone number (try both 305-555-0199 and 3055550199 formats) and any company /
   brand name from the evidence.
2. Search for them. Search the exact message text in quotes too.
3. When you find a likely website, fetch_page its home page, then its Terms of Service / Privacy
   Policy, and look for the legal entity ("LLC", "Inc", "Company", "governed by"). Verify the
   business it does matches the message — a personal-loan text should map to a personal-loan
   company, not an unrelated business.
4. Resolve short links (bit.ly etc.) with fetch_page before trusting them.
5. Estimate solvability: search "<company> employees linkedin" and "<company> revenue".
6. CONFIRM the entity in the official record with the \`sos_lookup\` tool. Once you have a
   candidate legal name, look it up in the Secretary of State registry to obtain the
   authoritative legal name, state of formation, principal and mailing addresses, and the
   registered agent's name and address — this is what the firm needs to file and serve.
   - Search NATIONWIDE, not one fixed state. Pass the entity's most likely state of
     registration first: the state in its principal/contact address, the state named in its
     Terms ("a California corporation"), or 'DE' for many incorporated businesses.
   - If the first state returns no match, retry with other plausible 2-letter state codes
     (a not-found result is free). Prefer an entity whose status is Active/Good Standing and
     whose address/officers corroborate your other evidence.
   - Always run \`sos_lookup\` before finishing if you have any plausible legal name — the
     official record is the most valuable output of this investigation.

When you have finished investigating, write a concise FINAL REPORT in plain text. For EACH distinct
company you can support with evidence, state: the brand/trade name; the exact registered legal name
(use the exact legal name from the Secretary of State record when you found one — note when it differs
from the brand name); website; the goods or services it sells; the home state of incorporation /
formation (prefer the official state from \`sos_lookup\`); the main office / HQ mailing address (the
principal address from the official record when available); the registered agent's name, address, and
state (exactly as they appear in the Secretary of State record); an employee-count estimate and a
revenue estimate (if found); your solvability rating (risk / good / whale / unknown); your confidence
from 0 to 1; the source URLs you relied on; and any notable next steps. Also state which evidence
file(s) this company was identified from, citing the EXACT filename shown in that file's
"### File N — … — <filename>" header (a company may come from more than one file, and different
companies may come from different files). State any of these you could not find as "not found" rather
than guessing. Note in the report which state's registry confirmed the entity.

If you genuinely cannot identify any company, say so plainly — do not invent one — and this is
REQUIRED: explain the "why not" so a reviewer doesn't have to redo your work. Spell out (1) every
phone number and brand/company name you searched and the exact queries you ran; (2) what the web
results showed — name the specific candidate websites you looked at and, for each, why you accepted
or (more importantly) rejected it (e.g. "softwarefinder.com — a software-review directory, not the
sender; business doesn't match a lead-gen SMS"); and (3) the concrete reason no legal entity could
be confirmed (number unlisted, brand too generic, site business didn't match the messages, no
matching Secretary of State record, etc.). Write this even when you find nothing.

--- SOP (source of truth) ---
`;

const FORMAT_INSTRUCTIONS = `You convert a forensic investigator's written report into a strict JSON
structure. Extract every company the investigator identified into the schema, using ONLY facts present
in the report — never invent companies, websites, numbers, or sources. If a field is not stated in the
report, use null (or an empty array for sources). If the report identifies no company, return an empty
\`candidates\` array.

For \`evidence_files\`, list the originating evidence file(s) the report ties to each company. Match
each one to the EXACT filename from the "Available evidence files" list below — copy the name verbatim
and never invent a name or include one that is not in that list. If the report does not tie a company
to any specific file, use an empty array.`;

let cachedAgent: Promise<ToolLoopAgent<never, typeof tools>> | undefined;

const tools = {
  web_search: webSearchTool,
  fetch_page: fetchPageTool,
  sos_lookup: sosLookupTool,
};

async function loadSop(): Promise<string> {
  return readFile(
    join(process.cwd(), "docs", "defendant-identification-sop.md"),
    "utf8",
  );
}

/**
 * The investigation agent. It loops over the search/fetch tools and ends with a
 * plain-text final report. It deliberately does NOT use structured `Output`:
 * a free-text report keeps the investigation richer (rejections, caveats, next
 * steps), and structuring it is a separate, tool-free step — see
 * `formatDefendantReport`.
 */
export function getDefendantAgent() {
  if (!cachedAgent) {
    cachedAgent = (async () => {
      const sop = await loadSop();
      return new ToolLoopAgent({
        model: rateLimitedModel(MODELS.agent),
        instructions: `${INSTRUCTIONS_PREAMBLE}${sop}`,
        tools,
        // A large case (many files → many phone numbers/brands to search and look
        // up) can exhaust a tight step budget before the agent writes its final
        // report, leaving zero candidates. Give it room to search, run sos_lookup,
        // and still summarize. A confirmed SOS entity is no longer lost when this
        // cap is hit (see synthesizeCandidateFromSos in the route), but a written
        // report is still the richer result, so allow more steps.
        stopWhen: stepCountIs(24),
        // The rate-limit middleware owns retries/backoff.
        maxRetries: 0,
      });
    })();
  }
  return cachedAgent;
}

/**
 * Second phase: turn the agent's free-text report into the structured
 * `DefendantReport`. No tools here, so the JSON response mime type is allowed.
 * Returns an empty report when the agent produced nothing (e.g. it hit the step
 * cap mid-search), so callers never have to handle a missing output.
 */
export async function formatDefendantReport(
  report: string,
  fileNames: string[] = [],
): Promise<DefendantReport> {
  if (!report.trim()) {
    return { candidates: [], search_terms_used: [] };
  }
  // Give the formatter the canonical filenames so it attributes each company to
  // exact names from this case rather than a paraphrase it read in the report.
  const fileList = fileNames.length
    ? `Available evidence files (use these exact names for evidence_files):\n${fileNames
        .map((name) => `- ${name}`)
        .join("\n")}\n\n--- REPORT ---\n`
    : "";
  const { output } = await generateText({
    model: rateLimitedModel(MODELS.agent),
    maxRetries: 0,
    output: Output.object({ schema: defendantReportSchema }),
    system: FORMAT_INSTRUCTIONS,
    prompt: `${fileList}${report}`,
  });
  return output;
}

// --- Enrichment recovery ------------------------------------------------------
// When the investigation confirms an entity in the Secretary of State registry
// but its report never carries that entity forward as a company (e.g. it hit the
// step cap mid-loop), the registry gives us the authoritative filing/service data
// but NOT the commercial picture — website, goods/services, headcount, revenue,
// solvability. This pass recovers exactly those fields for one already-confirmed
// entity, so a synthesized company is not stranded with null enrichment.

/** The commercial fields the registry does not contain, recovered by web research. */
export const enrichmentSchema = z.object({
  company_name: z
    .string()
    .nullable()
    .describe("Brand / trade name if it differs from the legal name; null if unknown."),
  website: z.string().nullable().describe("Primary website URL, or null."),
  goods_services: z
    .string()
    .nullable()
    .describe("What the company sells or does, or null if not found."),
  employees_estimate: z
    .string()
    .nullable()
    .describe("Approximate employee count or range, else null."),
  revenue_estimate: z
    .string()
    .nullable()
    .describe("Approximate annual revenue, else null."),
  solvability_tier: z
    .enum(["risk", "good", "whale", "unknown"])
    .describe("risk = under ~10 employees; good = ~11-50; whale = 50+; unknown if no signal."),
  business_match: z
    .boolean()
    .describe(
      "True if the company's goods/services plausibly match the case evidence; " +
        "false if the research shows it is clearly a different kind of business.",
    ),
  confidence: z
    .number()
    .min(0)
    .max(1)
    .describe("Confidence that this commercial picture is correct, 0 to 1."),
  sources: z.array(z.string()).describe("URLs that support this enrichment."),
  evidence_files: z
    .array(z.string())
    .describe(
      "Exact filename(s) from the '### File N' headers whose phone number / brand / " +
        "message point to THIS company. Empty if none can be tied.",
    ),
  notes: z.string().nullable().describe("Anything notable or any caveat."),
});

export type CompanyEnrichment = z.infer<typeof enrichmentSchema>;

const EMPTY_ENRICHMENT: CompanyEnrichment = {
  company_name: null,
  website: null,
  goods_services: null,
  employees_estimate: null,
  revenue_estimate: null,
  solvability_tier: "unknown",
  business_match: true,
  confidence: 0.5,
  sources: [],
  evidence_files: [],
  notes: null,
};

const ENRICHMENT_INSTRUCTIONS = `You are a forensic intake investigator for a consumer-protection law firm.

The firm has ALREADY confirmed a defendant in the official Secretary of State registry — its legal
entity, state of formation, addresses, and registered agent are established and given to you below.
Do NOT re-verify that the entity exists; take its identity as ground truth. Your job is to recover the
COMMERCIAL details the registry does not contain, so the firm can size up the case:

- the company's public website;
- the goods or services it sells, and whether that plausibly matches the case evidence;
- an employee-count estimate and an annual-revenue estimate;
- a solvability rating: risk = under ~10 employees; good = ~11-50; whale = 50+; unknown if no signal;
- which evidence file(s) (by the phone number, brand, or message they contain) point to this company.

Use the \`web_search\` and \`fetch_page\` tools. Search the legal/brand name, "<name> employees linkedin",
and "<name> revenue"; fetch the company site to read what it sells; resolve short links with
\`fetch_page\`. Confirm the business is consistent with the case evidence — if the research shows it is
clearly a DIFFERENT kind of business than the evidence describes, say so plainly. State anything you
cannot find as "not found" rather than guessing.

When done, write a short plain-text report stating each field above, your confidence (0 to 1), the
source URLs, and the exact evidence filename(s) from the "### File N — … — <filename>" headers that
point to this company.`;

const ENRICHMENT_FORMAT_INSTRUCTIONS = `You convert a forensic investigator's written enrichment note
into a strict JSON structure, using ONLY facts present in the note — never invent websites, numbers, or
sources. If a field is not stated, use null (empty array for sources/evidence_files; "unknown" for
solvability_tier; true for business_match unless the note says it is a different business). For
\`evidence_files\`, copy filenames verbatim from the "Available evidence files" list below; never invent
one or include a name not on that list.`;

let cachedEnrichmentAgent:
  | Promise<ToolLoopAgent<never, typeof enrichmentTools>>
  | undefined;

// No sos_lookup here: the entity is already confirmed in the registry, so this
// pass only needs the web to fill in the commercial picture.
const enrichmentTools = {
  web_search: webSearchTool,
  fetch_page: fetchPageTool,
};

function getEnrichmentAgent() {
  if (!cachedEnrichmentAgent) {
    cachedEnrichmentAgent = Promise.resolve(
      new ToolLoopAgent({
        model: rateLimitedModel(MODELS.agent),
        instructions: ENRICHMENT_INSTRUCTIONS,
        tools: enrichmentTools,
        // Bounded: a handful of searches/fetches to size up one known company.
        stopWhen: stepCountIs(10),
        maxRetries: 0,
      }),
    );
  }
  return cachedEnrichmentAgent;
}

/**
 * Recover the commercial fields (website, goods/services, headcount, revenue,
 * solvability, evidence attribution) for ONE entity already confirmed in the
 * Secretary of State registry. `sosContext` is a plain-text summary of that
 * record; `fileBlocks` is the same case evidence the main agent saw, so the pass
 * can confirm the business match and attribute files. Returns an empty
 * enrichment when the agent produced nothing, so callers never handle a missing
 * result.
 */
export async function enrichConfirmedEntity(params: {
  sosContext: string;
  fileBlocks: string;
  fileNames: string[];
}): Promise<CompanyEnrichment> {
  const agent = await getEnrichmentAgent();
  const result = await agent.generate({
    prompt: `CONFIRMED ENTITY (from the Secretary of State registry — treat as ground truth):\n${params.sosContext}\n\n--- CASE EVIDENCE ---\n${params.fileBlocks}\n\nRecover this confirmed company's commercial details per your instructions.`,
  });
  if (!result.text.trim()) return EMPTY_ENRICHMENT;
  const fileList = params.fileNames.length
    ? `Available evidence files (use these exact names for evidence_files):\n${params.fileNames
        .map((name) => `- ${name}`)
        .join("\n")}\n\n--- ENRICHMENT NOTE ---\n`
    : "";
  const { output } = await generateText({
    model: rateLimitedModel(MODELS.agent),
    maxRetries: 0,
    output: Output.object({ schema: enrichmentSchema }),
    system: ENRICHMENT_FORMAT_INSTRUCTIONS,
    prompt: `${fileList}${result.text}`,
  });
  return output;
}
