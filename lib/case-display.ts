import { amrToWavBlob, isAmr } from "@/lib/audio";
import type { Case, CaseFile } from "@/lib/types";
import type { CaseDoc } from "@/lib/case-store";
import type { EvidenceFile } from "@/lib/opportunity-evidence";

/**
 * Client-side helpers shared by the review/investigation views: turn a stored
 * AI run + the live GHL evidence into renderable CaseFiles, and rebuild a
 * displayable Case from a stored run. Browser-only (fetch + object URLs).
 */

export const proxied = (url: string) =>
  `/api/opportunity/file?url=${encodeURIComponent(url)}`;

/**
 * Turn the stored run's evidence + the live GHL field values into playable /
 * viewable CaseFiles. Live URLs win (stored ones can go stale); stored text
 * and forensics ride along. Audio is downloaded eagerly because voicemails
 * arrive as AMR more often than not and need decoding before <audio> can
 * play them.
 */
export async function buildDisplayFiles(
  stored: NonNullable<CaseDoc["run"]>["files"] | undefined,
  live: EvidenceFile[],
): Promise<CaseFile[]> {
  const liveByName = new Map(live.map((f) => [f.name, f] as const));
  const merged: Array<{
    name: string;
    kind: CaseFile["kind"];
    url: string | null;
    text?: string;
    forensics?: CaseFile["forensics"];
  }> = [];

  const seen = new Set<string>();
  for (const f of stored ?? []) {
    seen.add(f.name);
    merged.push({
      name: f.name,
      kind: f.kind,
      url: liveByName.get(f.name)?.url ?? f.ghlUrl,
      text: f.text ?? undefined,
      forensics: f.forensics ?? undefined,
    });
  }
  for (const f of live) {
    if (seen.has(f.name)) continue;
    merged.push({ name: f.name, kind: f.kind, url: f.url });
  }

  return Promise.all(
    merged.map(async (f, i): Promise<CaseFile> => {
      let url = f.url ? proxied(f.url) : "";
      if (f.url && f.kind === "audio") {
        try {
          const blob = await fetch(url).then((r) => {
            if (!r.ok) throw new Error(`download failed: ${r.status}`);
            return r.blob();
          });
          const playable = isAmr(blob, f.name) ? await amrToWavBlob(blob) : blob;
          url = URL.createObjectURL(playable);
        } catch {
          // Keep the proxy URL; the <audio> element will surface the failure.
        }
      }
      return {
        id: `${i}-${f.name}`,
        name: f.name,
        kind: f.kind,
        url,
        status: f.url ? "done" : "error",
        error: f.url ? undefined : "File no longer attached to the opportunity",
        text: f.text,
        forensics: f.forensics,
        forensicsStatus: f.forensics ? "done" : undefined,
      };
    }),
  );
}

/** Rebuild a renderable Case from the stored structured run. */
export function caseFromRun(
  opportunityId: string,
  doc: CaseDoc,
  files: CaseFile[],
): Case | null {
  const run = doc.run;
  if (!run) return null;
  return {
    id: opportunityId,
    name: run.caseName || doc.opportunity.name,
    createdAt: run.createdAt,
    completedAt: run.completedAt ?? undefined,
    files,
    dnc: run.dnc ?? undefined,
    opportunityId,
    facts: run.facts ?? undefined,
    gate: run.gate ?? undefined,
    screeningStatus: "done",
    defendantStatus: run.gate?.declined ? "idle" : "done",
    defendants: run.defendants,
    defendantSosError: run.defendantSosError ?? undefined,
    defendantUnmatchedSos: run.defendantUnmatchedSos,
    defendantSearchTerms: run.defendantSearchTerms,
    defendantInvestigation: run.defendantInvestigation ?? undefined,
  };
}
