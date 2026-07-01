import { createVertex } from "@ai-sdk/google-vertex";

/**
 * Google Vertex AI provider.
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
 * Resolve a model id to a Vertex model. Accepts both the bare Google id
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
 * These are version-pinned Vertex model IDs, confirmed available in this
 * project/region. Vertex does NOT accept the Gemini-API "-latest" aliases
 * (e.g. `gemini-pro-latest` returns 404), so pin explicit versions here. We run
 * the mature 2.5 family — it has ample provisioned capacity on Vertex, unlike
 * the 3.x models which still return 503 "high demand".
 */
export const MODELS = {
  /**
   * Legal reasoning and scoring (TCPA evaluation + audio forensics). Pro-tier
   * for the smartest, most consistent judgment; native vision for images.
   */
  analysis: "gemini-2.5-pro",
  /** Image description & audio transcription — fast multimodal extraction. */
  media: "gemini-2.5-flash",
  /** Defendant agent: many tool-loop steps, so favour a fast model. */
  agent: "gemini-2.5-flash",
} as const;
