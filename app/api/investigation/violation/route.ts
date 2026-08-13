import { z } from "zod";
import {
  appendLogEntry,
  mutateInvestigation,
  newId,
  type ViolationFinding,
} from "@/lib/investigation-store";
import { createLogger, nextRequestId } from "@/lib/logger";

const baseLog = createLogger("investigation-violation");

/**
 * Add or update one violation finding — manual capture and accepted AI
 * suggestions both land here, producing the same ViolationFinding artifact so
 * review reads one list. Findings start as "potential" and a human promotes
 * them to "confirmed" (or dismisses them).
 *
 * A finding may carry `evidenceIds` — the exact screenshot/audio entries
 * proving it. Confirming such a finding also attributes that evidence to the
 * finding's company (role "confirmed", companyIds ∪ company), which is
 * exactly what the split-readiness gate asks for — one click instead of
 * hunting the proof through 50 raw exhibits.
 */

const SCREEN_LABELS: Record<string, string> = {
  prerecorded_voice: "Pre-recorded voice",
  failure_to_stop: "Failure to honor stop",
  quiet_hours: "Quiet hours",
  dnc_registry: "DNC registry",
};

const bodySchema = z.object({
  investigationId: z.string().min(1),
  actorName: z.string().min(1).max(80),
  /** Existing finding id to update; omit to add a new one. */
  violationId: z.string().min(1).nullable().optional(),
  screen: z
    .enum(["prerecorded_voice", "failure_to_stop", "quiet_hours", "dnc_registry"])
    .optional(),
  /** Optional extra context — the screen label alone is often basis enough. */
  basis: z.string().max(5000).optional(),
  /** Company the violation is pinned to; null while unattributed. */
  companyId: z.string().min(1).nullable().optional(),
  /** Evidence entries proving the finding (must exist on the investigation). */
  evidenceIds: z.array(z.string().min(1)).max(100).optional(),
  status: z.enum(["potential", "confirmed", "dismissed"]).optional(),
});

export async function POST(request: Request) {
  const log = baseLog.child(nextRequestId());
  const parsed = bodySchema.safeParse(await request.json().catch(() => null));
  if (!parsed.success) {
    return Response.json({ error: "Invalid request body." }, { status: 400 });
  }
  const {
    investigationId,
    actorName,
    violationId,
    screen,
    basis,
    companyId,
    evidenceIds,
    status,
  } = parsed.data;
  if (!violationId && !screen) {
    return Response.json(
      { error: "A new finding needs a screen." },
      { status: 400 },
    );
  }
  const actor = { kind: "human" as const, name: actorName.trim() };
  const now = new Date().toISOString();

  try {
    let logLine: string | null = null;
    const doc = await mutateInvestigation(investigationId, (d) => {
      if (
        companyId &&
        !d.companies.some((c) => c.id === companyId)
      ) {
        throw new Error("That company is not on this investigation.");
      }
      if (
        evidenceIds &&
        !evidenceIds.every((id) => d.evidence.some((e) => e.id === id))
      ) {
        throw new Error("Some linked evidence is not on this investigation.");
      }

      let finding: ViolationFinding | undefined = violationId
        ? d.violations.find((v) => v.id === violationId)
        : undefined;
      if (violationId && !finding) {
        throw new Error("Violation finding not found.");
      }

      if (!finding) {
        finding = {
          id: newId(),
          screen: screen!,
          status: "potential",
          basis: (basis ?? "").trim(),
          companyId: companyId ?? null,
          evidenceIds: evidenceIds ?? [],
          foundBy: actor,
        };
        d.violations.push(finding);
        logLine = `Recorded potential violation: ${SCREEN_LABELS[finding.screen]}.${
          finding.evidenceIds!.length
            ? ` Linked ${finding.evidenceIds!.length} proof file(s).`
            : ""
        }`;
      } else {
        if (screen) finding.screen = screen;
        if (basis !== undefined) finding.basis = basis.trim();
        if (companyId !== undefined) finding.companyId = companyId;
        if (evidenceIds !== undefined) finding.evidenceIds = evidenceIds;
      }

      if (status && status !== finding.status) {
        finding.status = status;
        logLine =
          status === "confirmed"
            ? `Confirmed violation: ${SCREEN_LABELS[finding.screen]}.`
            : status === "dismissed"
              ? `Dismissed violation: ${SCREEN_LABELS[finding.screen]}.`
              : `Moved violation back to potential: ${SCREEN_LABELS[finding.screen]}.`;

        // Confirming a finding also files its proof: the linked evidence
        // becomes confirmed and is attributed to the finding's company, so
        // the split gate (confirmed violation + attributed proof) is met in
        // one motion instead of a second pass through the exhibits.
        if (status === "confirmed" && finding.companyId) {
          const linked = (finding.evidenceIds ?? []).filter((id) =>
            d.evidence.some((e) => e.id === id),
          );
          let attributed = 0;
          for (const e of d.evidence) {
            if (!linked.includes(e.id)) continue;
            e.role = "confirmed";
            if (!e.companyIds.includes(finding.companyId)) {
              e.companyIds.push(finding.companyId);
            }
            attributed++;
          }
          if (attributed > 0) {
            const company = d.companies.find((c) => c.id === finding!.companyId);
            const name = company
              ? company.profile.legal_name || company.profile.company_name
              : "the company";
            logLine += ` Attributed ${attributed} proof file(s) to ${name}.`;
          }
        }
      }
    });

    if (logLine) {
      doc.log.push(
        await appendLogEntry(investigationId, {
          at: now,
          author: actor,
          text: logLine,
          evidenceIds: [],
        }),
      );
    }

    log.info("violation saved", { investigationId, violationId, status });
    return Response.json({ doc });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const known = message.includes("not found") || message.includes("not on this");
    log.error("violation save failed", { investigationId, message });
    return Response.json(
      { error: known ? message : `Could not save the violation: ${message}` },
      { status: known ? 409 : 502 },
    );
  }
}
