import { generateText, tool } from "ai";
import { z } from "zod";
import { createLogger } from "@/lib/logger";
import { MODELS, google } from "@/lib/provider";
import { rateLimitedModel } from "./model";

const log = createLogger("defendant-tools");

const FETCH_TIMEOUT_MS = 15_000;
const MAX_PAGE_CHARS = 8_000;

// A desktop user agent — many sites return a stripped page or block obvious bots.
const USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/124.0 Safari/537.36";

function sourceUrls(sources: readonly unknown[] | undefined): string[] {
  if (!sources) return [];
  const urls = sources
    .map((s) =>
      s && typeof s === "object" && "url" in s
        ? (s as { url?: unknown }).url
        : undefined,
    )
    .filter((u): u is string => typeof u === "string" && u.length > 0);
  return Array.from(new Set(urls));
}

/** Strip a raw HTML document down to readable visible text. */
function htmlToText(html: string): string {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<noscript[\s\S]*?<\/noscript>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'")
    .replace(/[ \t\r\f\v]+/g, " ")
    .replace(/\n\s*\n\s*\n+/g, "\n\n")
    .trim();
}

/**
 * Web search backed by a Gemini model with Google Search grounding. Returns a
 * synthesized answer plus the source URLs it cited, so the agent can follow up
 * with `fetch_page` on the most promising links. We stay on the same Gemini
 * family as the rest of the app so web search is covered by the same gateway
 * tier (perplexity/openai search models are premium-only).
 */
export const webSearchTool = tool({
  description:
    "Search the web for information about a company, phone number, or message. " +
    "Returns a synthesized answer with source URLs. Use targeted queries such as: " +
    "the brand/company name; the phone number both with and without dashes; the exact " +
    "message text in quotes; '<company> LLC OR Inc'; '<company> terms of service'; " +
    "'<company> employees linkedin'; '<company> revenue'.",
  inputSchema: z.object({
    query: z.string().describe("The search query to run."),
  }),
  execute: async ({ query }) => {
    const done = log.start("web_search", { query });
    try {
      const { text, sources } = await generateText({
        model: rateLimitedModel(MODELS.agent),
        maxRetries: 0,
        temperature: 0,
        prompt: query,
        // Search grounding is a provider-defined tool in @ai-sdk/google (the old
        // `providerOptions.useSearchGrounding` flag is gone).
        tools: { google_search: google.tools.googleSearch({}) },
      });
      const urls = sourceUrls(sources);
      done({ answerChars: text.length, sources: urls.length });
      return { answer: text, sources: urls };
    } catch (err) {
      log.error("web_search failed", {
        query,
        message: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }
  },
});

/**
 * Fetch the visible text of a page. Follows redirects (so it doubles as a
 * short-link unmasker) and returns the final URL after redirects.
 */
export const fetchPageTool = tool({
  description:
    "Fetch the visible text of a web page by URL. Use it to read a company's website " +
    "footer, Terms of Service, or Privacy Policy and find the legal entity name (look for " +
    "'LLC', 'Inc', 'Company', 'governed by'). Follows redirects, so it also resolves " +
    "short links (bit.ly, tinyurl, etc.) — check the returned finalUrl.",
  inputSchema: z.object({
    url: z
      .string()
      .describe("Absolute URL to fetch, including the https:// scheme."),
  }),
  execute: async ({ url }) => {
    const done = log.start("fetch_page", { url });
    try {
      const response = await fetch(url, {
        redirect: "follow",
        headers: { "user-agent": USER_AGENT, accept: "text/html,*/*" },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      const html = await response.text();
      const text = htmlToText(html).slice(0, MAX_PAGE_CHARS);
      done({
        status: response.status,
        redirected: response.url !== url ? response.url : undefined,
        textChars: text.length,
      });
      return {
        url,
        finalUrl: response.url,
        status: response.status,
        text,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to fetch page";
      // A timeout/abort here is the common "stuck on one URL" cause — surface it.
      log.warn("fetch_page failed", { url, message });
      return { url, error: message };
    }
  },
});
