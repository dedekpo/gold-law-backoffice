import { generateText } from "ai";
import { MODELS, model } from "@/lib/provider";
import { createLogger, nextRequestId } from "@/lib/logger";
import { isRateLimitError, runRateLimited } from "@/lib/rate-limit";

const baseLog = createLogger("image-desc");

const PROMPT = [
  "Describe this image in exhaustive detail.",
  "Cover: the overall scene and setting; every visible subject and object with their position, size, color, material, texture, and condition;",
  "people (apparent age, expression, posture, clothing, accessories) without guessing private identities;",
  "background elements, lighting, time of day, weather, depth/perspective, and notable shadows;",
  "any visible text (transcribe it verbatim), logos, signs, screens, or symbols;",
  "the apparent mood, style, and likely context or purpose;",
  "any unusual, surprising, or notable details a careful observer would call out.",
  "Write as flowing prose paragraphs, no preamble, no bullet headers.",
].join(" ");

export async function POST(request: Request) {
  const log = baseLog.child(nextRequestId());
  const mediaType = request.headers.get("content-type") ?? "image/png";
  const data = new Uint8Array(await request.arrayBuffer());
  log.info("request received", { mediaType, bytes: data.byteLength });

  try {
    const done = log.start("model.describe");
    const { text } = await runRateLimited(() =>
      generateText({
        model: model(MODELS.media),
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
      err instanceof Error ? err.message : "Description failed";
    log.error("failed: model threw", {
      message,
      name: err instanceof Error ? err.name : typeof err,
    });
    return Response.json({ error: message }, { status: 500 });
  }
}
