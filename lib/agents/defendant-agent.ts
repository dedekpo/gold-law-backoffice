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
from 0 to 1; the source URLs you relied on; and any notable next steps. State any of these you could
not find as "not found" rather than guessing. Note in the report which state's registry confirmed the
entity. If you genuinely cannot identify any company, say so plainly — do not invent one.

--- SOP (source of truth) ---
`;

const FORMAT_INSTRUCTIONS = `You convert a forensic investigator's written report into a strict JSON
structure. Extract every company the investigator identified into the schema, using ONLY facts present
in the report — never invent companies, websites, numbers, or sources. If a field is not stated in the
report, use null (or an empty array for sources). If the report identifies no company, return an empty
\`candidates\` array.`;

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
 * Gemini rejects any request that combines function calling (tools) with a JSON
 * response mime type. Structuring the result is a separate, tool-free step —
 * see `formatDefendantReport`.
 */
export function getDefendantAgent() {
  if (!cachedAgent) {
    cachedAgent = (async () => {
      const sop = await loadSop();
      return new ToolLoopAgent({
        model: rateLimitedModel(MODELS.agent),
        instructions: `${INSTRUCTIONS_PREAMBLE}${sop}`,
        tools,
        temperature: 0,
        stopWhen: stepCountIs(16),
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
): Promise<DefendantReport> {
  if (!report.trim()) {
    return { candidates: [], search_terms_used: [] };
  }
  const { output } = await generateText({
    model: rateLimitedModel(MODELS.agent),
    maxRetries: 0,
    temperature: 0,
    output: Output.object({ schema: defendantReportSchema }),
    system: FORMAT_INSTRUCTIONS,
    prompt: report,
  });
  return output;
}
