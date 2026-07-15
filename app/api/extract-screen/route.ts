import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { Output, streamText } from "ai";
import { z } from "zod";
import { MODELS, model } from "@/lib/provider";
import { sniffImageMediaType } from "@/lib/image-media-type";
import { evaluateIntakeGate } from "@/lib/screening";
import type { EvidenceFacts } from "@/lib/types";
import { createLogger, nextRequestId } from "@/lib/logger";
import { isRateLimitError, runRateLimited } from "@/lib/rate-limit";

const baseLog = createLogger("extract-screen");

// The normalized fact set the LLM produces. It EXTRACTS atomic facts only — it
// does not score or decide which screens hit (that is deterministic code). Field
// descriptions double as extraction instructions for the model.
const contactSchema = z.object({
  file: z
    .string()
    .describe(
      "Exact filename from this contact's '### File N — … — <filename>' header.",
    ),
  sequence: z
    .number()
    .int()
    .describe(
      "1-based position of this message in the OVERALL conversation timeline, " +
        "ordered oldest→newest across ALL files. Use visible timestamps first, " +
        "then on-screen top-to-bottom order within a screenshot. The SAME message " +
        "shown in two overlapping screenshots must get ONE sequence number (extract " +
        "it once). A sent 'Stop'/opt-out bubble takes the position where it visually " +
        "sits in the thread — if a screenshot shows it above later marketing " +
        "messages, its sequence is LOWER than theirs.",
    ),
  direction: z
    .enum(["from_consumer", "from_company", "unknown"])
    .describe(
      "from_consumer = the client sent it (e.g. a STOP reply); from_company = the " +
        "spammer/collector sent it; unknown if unclear.",
    ),
  channel: z.enum(["text", "call", "voicemail", "email", "unknown"]),
  timestamp: z
    .string()
    .nullable()
    .describe(
      "ISO 8601 timestamp shown in the evidence, e.g. '2024-03-05T22:30:00'. Copy " +
        "the time exactly as shown — treat it as the consumer's LOCAL time, do not " +
        "convert. If the year is not shown, use the current year (and the SAME " +
        "assumed year for every contact in this case). If a message has NO visible " +
        "timestamp (e.g. a sent 'Stop' bubble), INFER one from its position between " +
        "the neighbouring timestamped messages in the thread so the conversation " +
        "order is preserved, and set `timestampInferred` to true. Null only if you " +
        "truly cannot place it in time.",
    ),
  timestampInferred: z
    .boolean()
    .describe(
      "True when `timestamp` was INFERRED from neighbouring messages because this " +
        "message had no visible time of its own (e.g. a sent 'Stop' bubble). False " +
        "when the time was read directly off the evidence.",
    ),
  dateReceived: z
    .string()
    .nullable()
    .describe(
      "Receipt date as 'YYYY-MM-DD' for the 4-year SOL clock. Messaging/email apps " +
        "show only the month and day for RECENT (current-year) messages and include " +
        "a 4-digit year only for OLDER ones. Set this ONLY when a 4-digit year is " +
        "explicitly visible; if only month/day are shown (no year), or no date at " +
        "all, set this to null — do NOT guess a year.",
    ),
  dateReceivedYearShown: z
    .boolean()
    .describe(
      "True ONLY if a 4-digit year is explicitly visible for this message's date. " +
        "False when only month/day are shown (the message is recent — current year).",
    ),
  messageType: z
    .enum(["marketing", "debt_collection", "informational", "unknown"])
    .describe(
      "marketing = purpose is ultimately to sell (a 'free webinar' that pitches " +
        "counts); debt_collection = collecting an alleged debt; informational = pure " +
        "notice (appointment, shipping, 2FA) with nothing sold and no debt.",
    ),
  isStopRequest: z
    .boolean()
    .describe(
      "True only for a message FROM the consumer asking to stop ('stop', " +
        "'unsubscribe', 'no more', 'remove me', 'do not text me').",
    ),
  isOptOutConfirmation: z
    .boolean()
    .describe(
      "True for a single automated 'you have been opted out' confirmation from the " +
        "company (the allowed carve-out — not a violation).",
    ),
  isPrerecorded: z
    .boolean()
    .describe(
      "Audio only: the voicemail is pre-recorded / artificial / robotic (scripted, " +
        "no pauses, impersonal). Use the forensic hint when provided. False for text.",
    ),
  consentSignal: z
    .enum(["cold_contact", "ambiguous", "prior_relationship", "unknown"])
    .describe(
      "cold_contact = no sign of any prior relationship/consent; prior_relationship " +
        "= evidence the consumer dealt with them before; ambiguous = some prior " +
        "contact but unclear; unknown if nothing indicates either way.",
    ),
  killSignal: z
    .enum(["job_scam", "true_healthcare", "none"])
    .describe(
      "job_scam = an employment/job offer scam; true_healthcare = genuine healthcare " +
        "SERVICES (note: marketing a medical DEVICE is NOT healthcare → use 'none'); " +
        "otherwise 'none'.",
    ),
  contentSummary: z
    .string()
    .describe("One-sentence factual summary of the message content."),
});

const factsSchema = z.object({
  contacts: z
    .array(contactSchema)
    .describe(
      "Every distinct message/call/voicemail in the evidence, one entry each. A " +
        "single screenshot of a thread yields several contacts.",
    ),
  notes: z
    .array(z.string())
    .describe("Anything ambiguous worth confirming at intake. Empty if none."),
});

const fileSchema = z.object({
  kind: z.enum(["audio", "image"]),
  name: z.string(),
  text: z.string(),
  image: z
    .object({
      data: z.string().describe("base64-encoded image bytes (no data: prefix)"),
      mediaType: z.string(),
    })
    .optional(),
  // Audio forensic hint (when already computed client-side), so isPrerecorded is
  // grounded in the acoustic analysis rather than guessed from the transcript.
  forensics: z
    .object({
      is_likely_prerecorded: z.boolean(),
      automated_likelihood: z.number(),
    })
    .optional(),
});

const requestSchema = z.object({
  files: z.array(fileSchema).min(1),
});

type ExtractFile = z.infer<typeof fileSchema>;

type UserContentPart =
  | { type: "text"; text: string }
  | { type: "file"; data: Uint8Array; mediaType: string };

function buildContent(files: ExtractFile[]): UserContentPart[] {
  const content: UserContentPart[] = [
    {
      type: "text",
      text:
        `This case contains ${files.length} file${files.length === 1 ? "" : "s"}. ` +
        "Extract every distinct contact (message/call/voicemail) into the schema. For " +
        "image files you are given the ORIGINAL screenshot — read it directly for exact " +
        "sender numbers, every timestamp, message order, and any STOP/opt-out text. " +
        "Multiple screenshots often overlap and show the SAME thread: extract each " +
        "distinct message ONCE and give every contact a `sequence` placing it in one " +
        "combined oldest→newest timeline across all files. Preserve the position of " +
        "any consumer STOP/opt-out relative to the messages around it. " +
        "Extract facts only; do not score.",
    },
  ];

  files.forEach((file, index) => {
    const label = file.kind === "audio" ? "AUDIO TRANSCRIPTION" : "IMAGE";
    content.push({
      type: "text",
      text: `### File ${index + 1} — ${label} — ${file.name}`,
    });
    if (file.image) {
      const data = new Uint8Array(Buffer.from(file.image.data, "base64"));
      content.push({
        type: "file",
        data,
        mediaType: sniffImageMediaType(data) ?? file.image.mediaType,
      });
      if (file.text) {
        content.push({
          type: "text",
          text: `Auto-generated description (reference only): ${file.text}`,
        });
      }
    } else {
      content.push({ type: "text", text: file.text });
      if (file.forensics) {
        content.push({
          type: "text",
          text: `Forensic hint: likely pre-recorded = ${file.forensics.is_likely_prerecorded} (automation likelihood ${file.forensics.automated_likelihood}/10).`,
        });
      }
    }
  });

  return content;
}

let cachedSpec: string | undefined;
async function loadScreeningSpec(): Promise<string> {
  if (!cachedSpec) {
    cachedSpec = await readFile(
      join(process.cwd(), "docs", "screening-spec.md"),
      "utf8",
    );
  }
  return cachedSpec;
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
  log.info("request received", {
    files: files.length,
    kinds: files.map((f) => f.kind).join(","),
  });
  const spec = await loadScreeningSpec();

  try {
    const done = log.start("model.extract");
    // Streamed, not generateText: a batch of dozens of screenshots takes the
    // model >5 minutes to answer, and Node's fetch aborts any request whose
    // response HEADERS haven't arrived by then (undici UND_ERR_HEADERS_TIMEOUT,
    // surfaced as "Headers Timeout Error"). Streaming makes headers arrive in
    // seconds; we still just await the complete parsed output.
    const output = await runRateLimited(
      async (): Promise<EvidenceFacts> => {
        // streamText does NOT reject on provider errors — it emits them as
        // error parts on the stream and finishes with empty output, so awaiting
        // `result.output` would surface a generic NoOutputGeneratedError that
        // runRateLimited can't classify (a retryable 529 "Overloaded" would be
        // treated as fatal). Capture the real error via onError and rethrow it
        // so retry/backoff sees the provider's status code and isRetryable flag.
        let streamError: unknown;
        const result = streamText({
          model: model(MODELS.analysis),
          maxRetries: 0,
          output: Output.object({ schema: factsSchema }),
          onError: ({ error }) => {
            streamError = error;
          },
          system:
            "You are an intake analyst for a consumer-protection law firm. From the " +
            "evidence, extract a normalized list of contacts as STRICT JSON per the " +
            "schema. Use the classification definitions in the screening spec below " +
            "(message type, kill signals, consent, opt-out vs confirmation). Extract " +
            "atomic facts ONLY — do NOT score, do NOT decide which screens apply. " +
            "Copy timestamps exactly as shown and treat them as the consumer's local " +
            "time.\n\n" +
            spec,
          messages: [{ role: "user", content: buildContent(files) }],
        });
        // Drain the stream fully (an unread stream can stall on backpressure,
        // and this guarantees onError has fired before we inspect the result).
        await result.consumeStream();
        if (streamError !== undefined) throw streamError;
        try {
          return await result.output;
        } catch (err) {
          throw streamError ?? err;
        }
      },
    );

    const facts: EvidenceFacts = output;
    const gate = evaluateIntakeGate(facts);
    done({
      contacts: facts.contacts.length,
      declined: gate.declined,
      declineReason: gate.declineReason,
    });
    return Response.json({ facts, gate });
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
    const message = err instanceof Error ? err.message : "Extraction failed";
    log.error("failed: model threw", {
      message,
      name: err instanceof Error ? err.name : typeof err,
    });
    return Response.json({ error: message }, { status: 500 });
  }
}
