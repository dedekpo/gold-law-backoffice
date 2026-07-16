import { createAnthropic } from "@ai-sdk/anthropic";
import { createVertex } from "@ai-sdk/google-vertex";
import { defaultSettingsMiddleware, wrapLanguageModel } from "ai";

/**
 * Google Vertex AI provider — audio work only (transcription + audio
 * forensics). Gemini remains the better model for audio understanding; all
 * other reasoning runs on Anthropic (see `MODELS` below).
 *
 * We run Gemini through Vertex AI (a paid, provisioned-capacity Google Cloud
 * surface) rather than a Gemini API key. Vertex has far higher, dedicated quota,
 * which avoids the free-tier 429 / 503 ("high demand") failures.
 *
 * Auth is resolved by google-auth-library:
 *   - Production (Railway): set GOOGLE_CLIENT_EMAIL + GOOGLE_PRIVATE_KEY (from
 *     the service-account JSON), plus GOOGLE_VERTEX_PROJECT / GOOGLE_VERTEX_LOCATION.
 *   - Local dev: point GOOGLE_APPLICATION_CREDENTIALS at the service-account
 *     JSON file (the inline-credentials branch below is skipped and the library
 *     reads the file), or run `gcloud auth application-default login`.
 *
 * NEVER commit the service-account key — it is gitignored. Rotate it if exposed.
 */
const clientEmail = process.env.GOOGLE_CLIENT_EMAIL;
const privateKey = process.env.GOOGLE_PRIVATE_KEY?.replace(/\\n/g, "\n");

export const google = createVertex({
  project: process.env.GOOGLE_VERTEX_PROJECT,
  location: process.env.GOOGLE_VERTEX_LOCATION ?? "us-central1",
  // Prefer inline credentials from env (Railway, which has no file mount). When
  // they're absent, fall through to ADC / GOOGLE_APPLICATION_CREDENTIALS.
  ...(clientEmail && privateKey
    ? {
        googleAuthOptions: {
          credentials: { client_email: clientEmail, private_key: privateKey },
        },
      }
    : {}),
});

/**
 * Anthropic provider (direct API). Claude is the default for all text/vision
 * reasoning. Auth: set ANTHROPIC_API_KEY in the environment.
 */
export const anthropic = createAnthropic();

/**
 * Applied to every Claude call: adaptive thinking lets the model decide when
 * and how much to reason per request (Opus 4.8 runs without thinking when the
 * param is omitted). Centralised here so call sites stay provider-agnostic.
 * Note Opus 4.8 rejects sampling params (temperature/topP/topK/seed) — the
 * provider strips them with a warning, so don't set them on Claude calls.
 */
const claudeDefaults = defaultSettingsMiddleware({
  settings: {
    providerOptions: { anthropic: { thinking: { type: "adaptive" } } },
  },
});

/**
 * Resolve a model id to the right provider: "claude-*" ids go to Anthropic,
 * everything else to Vertex. Accepts both the bare Google id
 * ("gemini-2.5-flash") and the legacy gateway form ("google/gemini-2.5-flash"),
 * so existing call sites keep working.
 */
/**
 * Claude models we deliberately run WITHOUT the adaptive-thinking default.
 * On the 4.6 family, omitting `thinking` runs thinking-off — the lowest-
 * latency configuration, which is the point of the search model. (Pre-4.6
 * ids like claude-sonnet-4-5 would belong here too: they reject the adaptive
 * param outright.)
 */
const THINKING_OFF_MODELS = new Set(["claude-sonnet-4-6"]);

export function model(id: string) {
  if (id.startsWith("claude-")) {
    if (THINKING_OFF_MODELS.has(id)) {
      return anthropic(id);
    }
    return wrapLanguageModel({
      model: anthropic(id),
      middleware: claudeDefaults,
    });
  }
  return google(id.replace(/^google\//, ""));
}

/**
 * Model assignments by role. Centralised so swapping a model is a one-line
 * change here instead of hunting through routes.
 *
 * Claude Sonnet 5 is the default for investigation work (analysis, images,
 * the defendant agent) — near-Opus quality on agentic/coding work at a much
 * better latency (Opus 4.8 ran the pipeline ~3x slower). Audio stays on
 * Gemini — Anthropic models take no audio
 * input, and Gemini is stronger at audio understanding (especially forensics).
 * The Gemini ids are version-pinned Vertex model IDs confirmed available in
 * this project/region; Vertex does NOT accept the Gemini-API "-latest" aliases
 * (e.g. `gemini-pro-latest` returns 404), so pin explicit versions here.
 */
export const MODELS = {
  /** Legal reasoning and scoring (TCPA evaluation, screen extraction). */
  analysis: "claude-sonnet-5",
  /** Image description — native vision extraction. */
  media: "claude-sonnet-5",
  /** Defendant agent tool loop + report formatting. */
  agent: "claude-sonnet-5",
  /**
   * Web-search backend (the agent's web_search tool). Sonnet 4.6 on purpose:
   * Sonnet 5 nearly doubled search latency, and synthesizing search results
   * doesn't need frontier reasoning. Runs thinking-off for latency (see
   * THINKING_OFF_MODELS above).
   */
  search: "claude-sonnet-4-6",
  /** Audio transcription — Gemini native-audio, fast tier. */
  audio: "gemini-2.5-flash",
  /** Audio forensics — Gemini native-audio, pro tier for careful judgment. */
  audioForensics: "gemini-2.5-pro",
} as const;
