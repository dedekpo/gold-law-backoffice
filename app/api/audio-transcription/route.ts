import { generateText } from "ai";
import { MODELS, model } from "@/lib/provider";
import { createLogger, nextRequestId } from "@/lib/logger";
import { isRateLimitError, runRateLimited } from "@/lib/rate-limit";

const baseLog = createLogger("audio-transcribe");

const PROMPT = [
  "Transcribe this audio clip in full detail.",
  "Include every spoken word verbatim.",
  "Also describe all non-speech audio inline using [brackets]:",
  "background noises, music (name songs/artists if recognizable and quote lyrics you can hear),",
  "sound effects, ambient sounds, tone of voice, laughter, silence, and any other acoustic information.",
  "Return a single continuous transcription, no preamble.",
].join(" ");

export async function POST(request: Request) {
  const log = baseLog.child(nextRequestId());
  const mediaType = request.headers.get("content-type") ?? "audio/webm";
  const data = new Uint8Array(await request.arrayBuffer());
  log.info("request received", { mediaType, bytes: data.byteLength });

  try {
    const done = log.start("model.transcribe");
    const { text } = await runRateLimited(() =>
      generateText({
        model: model(MODELS.audio),
        maxRetries: 0,
        temperature: 0,
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: PROMPT },
              { type: "file", data, mediaType },
            ],
          },
        ],
      }),
    );

    done({ textChars: text.length });
    return Response.json({ text });
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
      err instanceof Error ? err.message : "Transcription failed";
    log.error("failed: model threw", {
      message,
      name: err instanceof Error ? err.name : typeof err,
    });
    return Response.json({ error: message }, { status: 500 });
  }
}
