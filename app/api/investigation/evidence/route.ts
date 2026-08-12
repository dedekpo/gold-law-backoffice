import { z } from "zod";
import { detectKind } from "@/lib/file-kind";
import {
  evidenceObjectPath,
  uploadEvidenceObject,
} from "@/lib/evidence-storage";
import {
  appendLogEntry,
  mutateInvestigation,
  newId,
  type InvestigationEvidence,
} from "@/lib/investigation-store";
import { createLogger, nextRequestId } from "@/lib/logger";

const baseLog = createLogger("investigation-evidence");

export const maxDuration = 120;

/**
 * Phase 3 evidence capture.
 *
 * POST (multipart/form-data): upload files into the investigation. Firebase
 * Storage is the canonical copy; each file becomes an evidence entry with an
 * explicit role — "raw" (client-sent, unvetted) or "confirmed" (vetted proof,
 * attributed to companies via companyIds). Fields: investigationId, actorName,
 * role, companyIds (JSON array), files.
 *
 * PATCH (JSON): change an existing entry's role / company attribution — how a
 * raw file gets promoted to confirmed proof against a company.
 */

const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Confirmed evidence must be pinned to at least one company. */
function checkConfirmedAttribution(
  role: "raw" | "confirmed",
  companyIds: string[],
): string | null {
  return role === "confirmed" && companyIds.length === 0
    ? 'Confirmed evidence must be attributed to at least one company (or keep it "raw").'
    : null;
}

export async function POST(request: Request) {
  const log = baseLog.child(nextRequestId());

  const form = await request.formData().catch(() => null);
  if (!form) {
    return Response.json({ error: "Expected multipart form data." }, { status: 400 });
  }
  const investigationId = String(form.get("investigationId") ?? "");
  const actorName = String(form.get("actorName") ?? "").trim();
  const role = String(form.get("role") ?? "raw") as "raw" | "confirmed";
  let companyIds: string[];
  try {
    const parsed: unknown = JSON.parse(String(form.get("companyIds") ?? "[]"));
    companyIds = z.array(z.string().min(1)).parse(parsed);
  } catch {
    return Response.json({ error: "Invalid companyIds." }, { status: 400 });
  }
  const files = form
    .getAll("files")
    .filter((f): f is File => f instanceof File && f.size > 0);

  if (!investigationId || !actorName || !["raw", "confirmed"].includes(role)) {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }
  if (files.length === 0) {
    return Response.json({ error: "No files in the upload." }, { status: 400 });
  }
  const attributionError = checkConfirmedAttribution(role, companyIds);
  if (attributionError) {
    return Response.json({ error: attributionError }, { status: 400 });
  }
  const oversize = files.find((f) => f.size > MAX_FILE_BYTES);
  if (oversize) {
    return Response.json(
      { error: `"${oversize.name}" is larger than 50 MB.` },
      { status: 400 },
    );
  }
  const unsupported = files.find((f) => !detectKind(f.type, f.name));
  if (unsupported) {
    return Response.json(
      {
        error: `"${unsupported.name}" is not an image or audio file — only those count as evidence.`,
      },
      { status: 400 },
    );
  }

  const actor = { kind: "human" as const, name: actorName };
  const now = new Date().toISOString();

  try {
    // Upload to Storage first; the doc references only files that made it.
    const entries: InvestigationEvidence[] = [];
    for (const file of files) {
      const id = newId();
      const path = evidenceObjectPath(investigationId, id, file.name);
      const contentType = file.type || "application/octet-stream";
      await uploadEvidenceObject(
        path,
        Buffer.from(await file.arrayBuffer()),
        contentType,
      );
      entries.push({
        id,
        name: file.name,
        kind: detectKind(file.type, file.name)!,
        mimetype: contentType,
        size: file.size,
        role,
        source: "manual_upload",
        storageUrl: path,
        ghlUrl: null,
        ghlField: null,
        text: null,
        companyIds,
        addedAt: now,
        addedBy: actor,
      });
    }

    const doc = await mutateInvestigation(investigationId, (d) => {
      if (companyIds.some((id) => !d.companies.some((c) => c.id === id))) {
        throw new Error("An attributed company is not on this investigation.");
      }
      d.evidence.push(...entries);
    });
    doc.log.push(
      await appendLogEntry(investigationId, {
        at: now,
        author: actor,
        text: `Uploaded ${entries.length} ${role} evidence file(s): ${entries
          .map((e) => e.name)
          .join(", ")}.`,
        evidenceIds: entries.map((e) => e.id),
      }),
    );

    log.info("evidence uploaded", {
      investigationId,
      count: entries.length,
      role,
    });
    return Response.json({ doc, addedIds: entries.map((e) => e.id) });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error("evidence upload failed", { investigationId, message });
    return Response.json(
      { error: `Upload failed: ${message}` },
      { status: 502 },
    );
  }
}

const patchSchema = z.object({
  investigationId: z.string().min(1),
  actorName: z.string().min(1).max(80),
  evidenceId: z.string().min(1),
  role: z.enum(["raw", "confirmed"]).optional(),
  companyIds: z.array(z.string().min(1)).max(20).optional(),
});

export async function PATCH(request: Request) {
  const log = baseLog.child(nextRequestId());
  const parsed = patchSchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }
  const { investigationId, evidenceId, role, companyIds } = parsed.data;

  try {
    const doc = await mutateInvestigation(investigationId, (d) => {
      const entry = d.evidence.find((e) => e.id === evidenceId);
      if (!entry) throw new Error("Evidence file not found.");
      if (
        companyIds?.some((id) => !d.companies.some((c) => c.id === id))
      ) {
        throw new Error("An attributed company is not on this investigation.");
      }
      const nextRole = role ?? entry.role;
      const nextCompanies = companyIds ?? entry.companyIds;
      const attributionError = checkConfirmedAttribution(nextRole, nextCompanies);
      if (attributionError) throw new Error(attributionError);
      entry.role = nextRole;
      entry.companyIds = nextCompanies;
    });
    log.info("evidence updated", { investigationId, evidenceId, role });
    return Response.json({ doc });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const known =
      message.includes("not found") ||
      message.includes("not on this") ||
      message.includes("attributed to at least one");
    log.error("evidence update failed", { investigationId, message });
    return Response.json(
      { error: known ? message : `Update failed: ${message}` },
      { status: known ? 409 : 502 },
    );
  }
}
