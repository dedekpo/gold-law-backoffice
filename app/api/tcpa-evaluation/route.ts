import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { generateText, Output } from "ai";
import { z } from "zod";
import { MODELS, model } from "@/lib/provider";
import { createLogger, nextRequestId } from "@/lib/logger";
import { isRateLimitError, runRateLimited } from "@/lib/rate-limit";

const baseLog = createLogger("tcpa-eval");

const evaluationSchema = z.object({
  score: z.number().int().min(0).max(10),
  category: z.enum([
    "prerecorded_voicemail",
    "idnc_failure_to_stop",
    "idnc_debt_collection",
    "quiet_hours",
    "quiet_hours_debt_collection",
    "ndnc_federal",
    "ndnc_florida",
    "none",
  ]),
  message_type: z.enum([
    "marketing",
    "debt_collection",
    "informational",
    "unknown",
  ]),
  needs_external_check: z.array(z.string()),
  reasoning: z.string(),
});

const fileSchema = z.object({
  kind: z.enum(["audio", "image"]),
  name: z.string(),
  text: z.string(),
  // For image files the client also sends the original bytes, so the evaluator
  // can read the screenshot directly (native vision) instead of relying on the
  // lossy text description. Absent for audio (and as a fallback if encoding it
  // client-side fails).
  image: z
    .object({
      data: z.string().describe("base64-encoded image bytes (no data: prefix)"),
      mediaType: z.string(),
    })
    .optional(),
});

const requestSchema = z.object({
  files: z.array(fileSchema).min(1),
});

type EvalFile = z.infer<typeof fileSchema>;

type UserContentPart =
  | { type: "text"; text: string }
  | { type: "file"; data: Uint8Array; mediaType: string };

/**
 * Build the multimodal user message: each image file contributes the actual
 * screenshot (plus its description as a labelled fallback); audio files
 * contribute their transcription text.
 */
function buildContent(files: EvalFile[]): UserContentPart[] {
  const content: UserContentPart[] = [
    {
      type: "text",
      text:
        `The case below contains ${files.length} file${files.length === 1 ? "" : "s"}. ` +
        "Evaluate the case as a whole against the rubric. For image files you are given the " +
        "ORIGINAL screenshot — read it directly: exact sender numbers, every timestamp, the " +
        'order of messages, and any "STOP"/opt-out text. A text description may also be ' +
        "included as a fallback, but trust the image itself when they disagree.",
    },
  ];

  files.forEach((file, index) => {
    const label = file.kind === "audio" ? "AUDIO TRANSCRIPTION" : "IMAGE";
    content.push({
      type: "text",
      text: `### File ${index + 1} — ${label} — ${file.name}`,
    });
    if (file.image) {
      content.push({
        type: "file",
        data: new Uint8Array(Buffer.from(file.image.data, "base64")),
        mediaType: file.image.mediaType,
      });
      if (file.text) {
        content.push({
          type: "text",
          text: `Auto-generated description (reference only): ${file.text}`,
        });
      }
    } else {
      content.push({ type: "text", text: file.text });
    }
  });

  return content;
}

let cachedRubric: string | undefined;

async function loadRubric(): Promise<string> {
  if (!cachedRubric) {
    cachedRubric = await readFile(
      join(process.cwd(), "docs", "tcpa-evaluation.md"),
      "utf8",
    );
  }
  return cachedRubric;
}

export async function POST(request: Request) {
  const log = baseLog.child(nextRequestId());
  const parsed = requestSchema.safeParse(await request.json());
  if (!parsed.success) {
    log.warn("rejected: invalid request body", {
      issues: parsed.error.issues.map((i) => i.path.join(".") || "(root)"),
    });
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { files } = parsed.data;
  const imageCount = files.filter((f) => f.image).length;
  log.info("request received", {
    files: files.length,
    kinds: files.map((f) => f.kind).join(","),
    imagesViewedDirectly: imageCount,
  });
  const rubric = await loadRubric();

  try {
    const done = log.start("model.evaluate");
    const { output: object } = await runRateLimited(() =>
      generateText({
        model: model(MODELS.analysis),
        maxRetries: 0,
        // Deterministic scoring: the same case should yield the same evaluation.
        // temperature 0 + a fixed seed is the most reproducible config (Gemini
        // "thinking" models still aren't 100% deterministic, but this minimises
        // the spread).
        temperature: 0,
        seed: 7,
        output: Output.object({ schema: evaluationSchema }),
        system: `You are an evaluator for TCPA-related telecom violations. Apply the rubric below precisely. You will be given a single CASE made up of one or more files. Image files are provided as the ORIGINAL screenshots for you to read directly; audio files are provided as transcriptions. Evaluate the case as a whole — correlate facts across files (e.g. a stop request in one screenshot followed by another message in a later screenshot or call). Return strictly the JSON object defined by the schema, with no commentary.\n\n${rubric}`,
        messages: [{ role: "user", content: buildContent(files) }],
      }),
    );

    done({
      score: object.score,
      category: object.category,
      messageType: object.message_type,
    });
    return Response.json(object);
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
      err instanceof Error ? err.message : "Evaluation failed";
    log.error("failed: model threw", {
      message,
      name: err instanceof Error ? err.name : typeof err,
    });
    return Response.json({ error: message }, { status: 500 });
  }
}
