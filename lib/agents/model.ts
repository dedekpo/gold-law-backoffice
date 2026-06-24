import { wrapLanguageModel, type LanguageModelMiddleware } from "ai";
import { model } from "@/lib/provider";
import { runRateLimited } from "@/lib/rate-limit";

/**
 * Routes every model call (each agent step AND each tool's own model call)
 * through the shared rate limiter, so the agent's many provider round-trips are
 * spaced out and 429s are retried with backoff instead of bursting and failing.
 * This is the single rate-limit layer for the agent — callers should not wrap
 * these models in `runRateLimited` again.
 */
const rateLimitMiddleware: LanguageModelMiddleware = {
  specificationVersion: "v3",
  wrapGenerate: ({ doGenerate }) =>
    runRateLimited(async () => doGenerate()),
  wrapStream: ({ doStream }) => runRateLimited(async () => doStream()),
};

export function rateLimitedModel(modelId: string) {
  return wrapLanguageModel({
    model: model(modelId),
    middleware: rateLimitMiddleware,
  });
}
