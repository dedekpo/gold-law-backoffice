"use client";

import { useRef, useState } from "react";
import type { InvestigationDoc } from "@/lib/investigation-store";
import { Btn, Empty, Eyebrow, Tag, useWorkbench } from "./ui";
import { ExhibitTile, type Exhibit } from "./file-viewer";

/**
 * The exhibits rail: every file on the record, numbered, with upload for the
 * open investigation. Client-sent files arrive as "raw"; the investigator
 * promotes what proves the case to "confirmed" inside the exhibit viewer.
 */

export function ExhibitsSection({
  exhibits,
  onOpen,
  canUpload,
}: {
  exhibits: Exhibit[];
  onOpen: (exhibit: Exhibit) => void;
  canUpload: boolean;
}) {
  const confirmed = exhibits.filter((e) => e.role === "confirmed").length;
  return (
    <section id="exhibits">
      <Eyebrow
        right={
          exhibits.length > 0 ? (
            <Tag>
              {exhibits.length} file{exhibits.length === 1 ? "" : "s"}
              {confirmed > 0 ? ` · ${confirmed} proof` : ""}
            </Tag>
          ) : undefined
        }
      >
        Exhibits
      </Eyebrow>
      {exhibits.length > 0 ? (
        <div className="grid grid-cols-3 gap-2">
          {exhibits.map((exhibit) => (
            <ExhibitTile
              key={exhibit.key}
              exhibit={exhibit}
              onOpen={() => onOpen(exhibit)}
            />
          ))}
        </div>
      ) : (
        <Empty>No evidence on this file yet.</Empty>
      )}
      {canUpload && <UploadBox />}
    </section>
  );
}

function UploadBox() {
  const { doc, actorName, ready, busy, run } = useWorkbench();
  const fileInput = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<File[]>([]);
  const [dragOver, setDragOver] = useState(false);

  const upload = (files: File[]) => {
    if (files.length === 0) return;
    void run("upload", async () => {
      const form = new FormData();
      form.set("investigationId", doc.id);
      form.set("actorName", actorName.trim());
      form.set("role", "raw");
      form.set("companyIds", "[]");
      for (const f of files) form.append("files", f);
      const res = await fetch("/api/investigation/evidence", {
        method: "POST",
        body: form,
      });
      const data = (await res.json().catch(() => null)) as {
        doc?: InvestigationDoc;
        error?: string;
      } | null;
      if (!res.ok || !data?.doc) {
        throw new Error(data?.error ?? `Upload failed: ${res.status}`);
      }
      setPending([]);
      if (fileInput.current) fileInput.current.value = "";
      return data.doc;
    });
  };

  return (
    <div
      className={`mt-3 rounded-xs border border-dashed px-3 py-3 text-center transition-colors ${
        dragOver ? "border-ink bg-wash" : "border-rule-strong"
      }`}
      onDragOver={(e) => {
        e.preventDefault();
        setDragOver(true);
      }}
      onDragLeave={() => setDragOver(false)}
      onDrop={(e) => {
        e.preventDefault();
        setDragOver(false);
        if (!ready) return;
        upload(
          Array.from(e.dataTransfer.files).filter(
            (f) => f.type.startsWith("image/") || f.type.startsWith("audio/"),
          ),
        );
      }}
    >
      <input
        ref={fileInput}
        type="file"
        multiple
        accept="image/*,audio/*"
        className="hidden"
        onChange={(e) => setPending(Array.from(e.target.files ?? []))}
      />
      {pending.length === 0 ? (
        <p className="text-xs text-soft">
          {busy === "upload" ? (
            "Filing exhibits…"
          ) : (
            <>
              Drop screenshots or recordings here, or{" "}
              <button
                type="button"
                disabled={!ready}
                onClick={() => fileInput.current?.click()}
                className="text-ink underline decoration-rule-strong underline-offset-2 hover:decoration-stamp disabled:opacity-40"
              >
                browse
              </button>
              . New files are filed as raw; mark proof inside the exhibit.
            </>
          )}
        </p>
      ) : (
        <div className="flex flex-wrap items-center justify-center gap-2">
          <span className="text-xs text-soft">
            {pending.length} file{pending.length === 1 ? "" : "s"} selected
          </span>
          <Btn
            variant="primary"
            small
            disabled={!ready}
            onClick={() => upload(pending)}
          >
            {busy === "upload" ? "Filing…" : "File as exhibits"}
          </Btn>
          <Btn
            small
            onClick={() => {
              setPending([]);
              if (fileInput.current) fileInput.current.value = "";
            }}
          >
            Clear
          </Btn>
        </div>
      )}
    </div>
  );
}
