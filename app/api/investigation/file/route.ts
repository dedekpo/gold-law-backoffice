import { downloadEvidenceObject } from "@/lib/evidence-storage";
import { getInvestigation } from "@/lib/investigation-store";
import { createLogger, nextRequestId } from "@/lib/logger";

const baseLog = createLogger("investigation-file");

/**
 * Serve one evidence file from Firebase Storage (the canonical copy of
 * app-uploaded evidence): GET ?inv=<investigationId>&ev=<evidenceId>. The
 * object path is looked up on the investigation doc — never taken from the
 * query — so this can only ever serve files that belong to the investigation.
 * GHL-hosted evidence keeps going through /api/opportunity/file.
 */
export async function GET(request: Request) {
  const log = baseLog.child(nextRequestId());
  const url = new URL(request.url);
  const investigationId = url.searchParams.get("inv");
  const evidenceId = url.searchParams.get("ev");
  if (!investigationId || !evidenceId) {
    return Response.json({ error: "Missing inv or ev parameter." }, { status: 400 });
  }

  try {
    const doc = await getInvestigation(investigationId);
    const entry = doc?.evidence.find((e) => e.id === evidenceId);
    if (!entry?.storageUrl) {
      return Response.json(
        { error: "No stored file for that evidence id." },
        { status: 404 },
      );
    }
    const data = await downloadEvidenceObject(entry.storageUrl);
    if (!data) {
      return Response.json(
        { error: "The stored file is missing from the bucket." },
        { status: 404 },
      );
    }
    return new Response(new Uint8Array(data), {
      headers: {
        "Content-Type": entry.mimetype || "application/octet-stream",
        "Content-Disposition": `inline; filename="${entry.name.replace(/"/g, "")}"`,
        "Cache-Control": "private, max-age=3600",
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("evidence file serve failed", {
      investigationId,
      evidenceId,
      message,
    });
    return Response.json({ error: "Could not load the file." }, { status: 502 });
  }
}
