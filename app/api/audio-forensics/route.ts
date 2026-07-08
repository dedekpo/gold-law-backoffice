import { generateText, Output } from "ai";
import { z } from "zod";
import { MODELS, model } from "@/lib/provider";
import { createLogger, nextRequestId } from "@/lib/logger";
import { isRateLimitError, runRateLimited } from "@/lib/rate-limit";

const baseLog = createLogger("audio-forensics");

const forensicsSchema = z.object({
  automated_likelihood: z
    .number()
    .int()
    .min(0)
    .max(10)
    .describe("0 = clearly a live human recording, 10 = clearly automated/pre-recorded."),
  is_likely_prerecorded: z
    .boolean()
    .describe("Headline conclusion: is this audio likely a pre-recorded/automated message."),
  factors: z
    .array(
      z.object({
        name: z
          .string()
          .describe("Short technical label for the cue, e.g. 'Uniform cadence'."),
        explanation: z
          .string()
          .describe(
            "Brief technical explanation of why this specific audio cue suggests " +
              "automation or human origin.",
          ),
      }),
    )
    .min(1)
    .describe("The acoustic/technical factors behind the assessment."),
  personalization_analysis: z
    .string()
    .describe(
      "Whether the message uses dynamic insertion (e.g. a spliced 'Hi Courtney') or AI " +
        "voice cloning to sound personalized, or shows no personalization. Cite the cues.",
    ),
});

const requestSchema = z.object({
  audio: z.object({
    data: z.string().describe("base64-encoded audio bytes (no data: prefix)"),
    mediaType: z.string(),
  }),
  /** The transcription, as reference context for the personalization analysis. */
  transcription: z.string().optional(),
  name: z.string().optional(),
});

const SYSTEM = `You are an expert Audio Forensic Analyst specializing in identifying automated "ringless voicemail" drops, AI voice synthesis, and pre-recorded marketing messages.

Your task: analyze the provided audio recording to determine whether it is a live human recording or an automated/pre-recorded message. Base every conclusion on the ACTUAL AUDIO you are given — acoustic cues such as cadence and prosody, breathing and mouth sounds, room tone and background noise, abrupt edits or splices, compression/codec artifacts, level consistency, and any signs of synthetic (TTS / cloned) speech. A transcription may be supplied as reference, but trust the audio itself.

This analysis will be filed as EVIDENCE in a potential lawsuit, so be precise, factual, and declarative. Do not speculate beyond what the audio supports; if a cue is ambiguous, say so. Provide at least three distinct factors.

For the personalization analysis, explain whether the message uses dynamic insertion (a name or detail spliced in, e.g. "Hi Courtney", often audible as a tone/level/voice mismatch at that word) or AI voice cloning to sound personalized — or whether it shows no personalization at all.

Return strictly the JSON object defined by the schema, with no commentary.`;

export const maxDuration = 120;

export async function POST(request: Request) {
  const log = baseLog.child(nextRequestId());
  const parsed = requestSchema.safeParse(await request.json());
  if (!parsed.success) {
    log.warn("rejected: invalid request body", {
      issues: parsed.error.issues.map((i) => i.path.join(".") || "(root)"),
    });
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { audio, transcription, name } = parsed.data;
  const data = new Uint8Array(Buffer.from(audio.data, "base64"));
  log.info("request received", {
    name,
    mediaType: audio.mediaType,
    bytes: data.byteLength,
    hasTranscription: Boolean(transcription),
  });

  try {
    const done = log.start("model.forensics");
    const { output } = await runRateLimited(() =>
      generateText({
        model: model(MODELS.audioForensics),
        maxRetries: 0,
        // Reproducible assessment: the same recording should yield the same
        // analysis when it is filed and later re-checked.
        temperature: 0,
        seed: 7,
        output: Output.object({ schema: forensicsSchema }),
        system: SYSTEM,
        messages: [
          {
            role: "user",
            content: [
              {
                type: "text",
                text:
                  "Analyze this audio recording per your instructions." +
                  (transcription
                    ? `\n\nReference transcription:\n${transcription}`
                    : ""),
              },
              { type: "file", data, mediaType: audio.mediaType },
            ],
          },
        ],
      }),
    );

    done({
      automatedLikelihood: output.automated_likelihood,
      prerecorded: output.is_likely_prerecorded,
      factors: output.factors.length,
    });
    return Response.json(output);
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
      err instanceof Error ? err.message : "Forensic analysis failed";
    log.error("failed: model threw", {
      message,
      name: err instanceof Error ? err.name : typeof err,
    });
    return Response.json({ error: message }, { status: 500 });
  }
}
