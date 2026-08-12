import { findDefendantByName } from "@/lib/defendant-migration";
import { createLogger, nextRequestId } from "@/lib/logger";

const baseLog = createLogger("investigation-defendant");

/**
 * Live Defendant-record lookup for the company form: as a name is typed, the
 * client asks whether a Defendant custom-object record with that exact
 * (normalized) name already exists, so the investigator sees "this company is
 * a repeat defendant — the record will be reused at the split" before saving.
 * Read-only; the actual reuse decision stays in the split (case-split.ts uses
 * the same findDefendantByName match).
 */
export async function GET(request: Request) {
  const log = baseLog.child(nextRequestId());
  const name = new URL(request.url).searchParams.get("name")?.trim() ?? "";
  if (name.length < 2) {
    return Response.json({ error: "Missing name parameter." }, { status: 400 });
  }
  try {
    const match = await findDefendantByName(name);
    log.info("defendant lookup", { name, matched: Boolean(match) });
    return Response.json({ match });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("defendant lookup failed", { name, message });
    return Response.json(
      { error: `Defendant lookup failed: ${message}` },
      { status: 502 },
    );
  }
}
