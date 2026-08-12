import type { DncCheck, FileKind } from "@/lib/types";

/**
 * Client-side plumbing for starting an AI run from a GHL opportunity — shared
 * by the New Case modal (pasted URL) and the Ready-for-AI queue (direct id).
 * The import route resolves the opportunity, runs the automated DNC lookup,
 * and lists the evidence files; the browser then downloads each file through
 * the proxy and feeds it into the pipeline.
 */

/** One piece of evidence ready to enter the pipeline. */
export type NewCaseInput = { blob: Blob; name: string; kind: FileKind };

export type NewCaseMeta = {
  /** Automated DNC lookup of the client's number, run by the import route. */
  dnc?: DncCheck;
  /** Case display name; defaults to the timestamp name when absent. */
  name?: string;
  opportunityId?: string;
};

export type ImportResponse = {
  opportunity: { id: string; name: string };
  files: { url: string; name: string; mimetype: string; kind: FileKind }[];
  skipped: number;
  /** Set when the opportunity's "AI Run Status" field shows a previous run. */
  existingRun: { status: string } | null;
  /** Automated DNC registry check of the opportunity contact's number. */
  dnc: DncCheck;
};

export async function importOpportunity(body: {
  url?: string;
  opportunityId?: string;
}): Promise<ImportResponse> {
  const res = await fetch("/api/opportunity/import", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const data = (await res.json().catch(() => null)) as
    | (ImportResponse & { error?: string })
    | null;
  if (!res.ok || !data) {
    throw new Error(data?.error ?? `Import failed: ${res.status}`);
  }
  return data;
}

/** Download an import's evidence files so the case can enter the pipeline. */
export async function downloadImportFiles(
  data: ImportResponse,
): Promise<NewCaseInput[]> {
  return Promise.all(
    data.files.map(async (file): Promise<NewCaseInput> => {
      const download = await fetch(
        `/api/opportunity/file?url=${encodeURIComponent(file.url)}`,
      );
      if (!download.ok) {
        throw new Error(`Could not download ${file.name}.`);
      }
      return { blob: await download.blob(), name: file.name, kind: file.kind };
    }),
  );
}

/** Meta for a case entering the pipeline from an import. */
export function importMeta(data: ImportResponse): NewCaseMeta {
  return {
    dnc: data.dnc,
    name: data.opportunity.name,
    opportunityId: data.opportunity.id,
  };
}
