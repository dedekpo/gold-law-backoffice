import { z } from "zod";
import {
  formatDefendantReport,
  getDefendantAgent,
} from "@/lib/agents/defendant-agent";
import { createLogger, nextRequestId } from "@/lib/logger";
import { isRateLimitError } from "@/lib/rate-limit";

const baseLog = createLogger("defendant-id");

const fileSchema = z.object({
  kind: z.enum(["audio", "image"]),
  name: z.string(),
  text: z.string(),
});

const requestSchema = z.object({
  files: z.array(fileSchema).min(1),
  evaluation: z
    .object({
      category: z.string(),
      message_type: z.string(),
      reasoning: z.string(),
    })
    .optional(),
});

// The agent loops through several search/fetch round-trips; give it room locally.
export const maxDuration = 300;

export async function POST(request: Request) {
  const log = baseLog.child(nextRequestId());
  const parsed = requestSchema.safeParse(await request.json());
  if (!parsed.success) {
    log.warn("rejected: invalid request body", {
      issues: parsed.error.issues.map((i) => i.path.join(".") || "(root)"),
    });
    return Response.json({ error: "Invalid request body" }, { status: 400 });
  }

  const { files, evaluation } = parsed.data;
  log.info("request received", {
    files: files.length,
    kinds: files.map((f) => f.kind).join(","),
    hasEvaluation: Boolean(evaluation),
    evaluationCategory: evaluation?.category,
  });

  const fileBlocks = files
    .map((file, index) => {
      const label =
        file.kind === "audio" ? "AUDIO TRANSCRIPTION" : "IMAGE DESCRIPTION";
      return `### File ${index + 1} — ${label} — ${file.name}\n\n${file.text}`;
    })
    .join("\n\n---\n\n");

  const evaluationBlock = evaluation
    ? `\n\nPRIOR TCPA EVALUATION (context): category=${evaluation.category}, message_type=${evaluation.message_type}.\nReasoning: ${evaluation.reasoning}`
    : "";

  const prompt = `The case below contains ${files.length} file${
    files.length === 1 ? "" : "s"
  }. Identify the company (or companies) behind the phone number(s) or company name(s) in this evidence, following the SOP.${evaluationBlock}\n\n${fileBlocks}`;

  try {
    const agent = await getDefendantAgent();

    // Phase 1 — investigate with tools, producing a free-text report.
    const doneInvestigate = log.start("agent.investigate");
    const result = await agent.generate({ prompt });
    doneInvestigate({
      steps: result.steps?.length,
      reportChars: result.text.length,
    });

    // Phase 2 — structure that report into the schema (tool-free, JSON output).
    const doneFormat = log.start("agent.format");
    const report = await formatDefendantReport(result.text);
    const candidates = report.candidates ?? [];
    doneFormat({
      candidates: candidates.length,
      companies: candidates.map((c) => c.company_name).join(" | ") || "(none)",
    });

    return Response.json(report);
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
      err instanceof Error ? err.message : "Defendant identification failed";
    log.error("failed: agent threw", {
      message,
      name: err instanceof Error ? err.name : typeof err,
    });
    return Response.json({ error: message }, { status: 500 });
  }
}
