import { createGoogleGenerativeAI } from "@ai-sdk/google";

/**
 * Direct Google Generative AI provider.
 *
 * We talk to Google's API directly (via GOOGLE_GENERATIVE_AI_API_KEY) instead of
 * routing through the Vercel AI Gateway. The gateway's free tier rate-limits the
 * defendant agent's many search/fetch round-trips with 429s; Google's own quota
 * is a separate, more generous pool. Add credits to the gateway if you ever want
 * to switch back.
 */
export const google = createGoogleGenerativeAI({
  apiKey: process.env.GOOGLE_GENERATIVE_AI_API_KEY,
});

/**
 * Resolve a model id to a Google model. Accepts both the bare Google id
 * ("gemini-2.5-flash") and the legacy gateway form ("google/gemini-2.5-flash"),
 * so existing call sites keep working.
 */
export function model(id: string) {
  return google(id.replace(/^google\//, ""));
}

/**
 * Model assignments by role. Centralised so swapping a model is a one-line
 * change here instead of hunting through routes.
 *
 * We deliberately run the mature 2.5 family rather than the newer 3.x models:
 * at the moment the 3.x models (e.g. gemini-3.5-flash) frequently return 503
 * "high demand", while 2.5-pro/2.5-flash have far more provisioned capacity and
 * respond reliably. Revisit once 3.x capacity stabilises.
 */
export const MODELS = {
  /**
   * Legal reasoning and scoring (TCPA evaluation). Pro-tier for the smartest,
   * most consistent judgment; it also has native vision for image analysis.
   */
  analysis: "gemini-2.5-pro",
  /** Image description & audio transcription — fast multimodal extraction. */
  media: "gemini-2.5-flash",
  /** Defendant agent: many tool-loop steps, so favour a fast model. */
  agent: "gemini-2.5-flash",
} as const;
