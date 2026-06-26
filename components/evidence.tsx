"use client";

import { useEffect } from "react";
import type { CaseFile } from "@/lib/types";
import { SpeakerIcon } from "./icons";

export function FileThumbnail({
  file,
  onClick,
}: {
  file: CaseFile;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className="group flex flex-col items-stretch gap-1 text-left"
      title={file.name}
    >
      <div className="relative aspect-square overflow-hidden rounded-lg border border-zinc-200 bg-zinc-100 transition-shadow group-hover:shadow-md dark:border-zinc-800 dark:bg-zinc-900">
        {file.kind === "image" ? (
          /* eslint-disable-next-line @next/next/no-img-element */
          <img
            src={file.url}
            alt={file.name}
            className="h-full w-full object-cover"
          />
        ) : (
          <div className="flex h-full w-full flex-col items-center justify-center gap-2 bg-linear-to-br from-blue-50 to-blue-100 text-blue-700 dark:from-blue-950 dark:to-blue-900 dark:text-blue-200">
            <SpeakerIcon />
            <span className="text-[10px] uppercase tracking-wide opacity-70">
              Audio
            </span>
          </div>
        )}

        {file.status === "processing" && (
          <div className="absolute inset-0 flex items-center justify-center bg-black/30 text-[10px] font-medium text-white">
            Processing…
          </div>
        )}
        {file.status === "error" && (
          <div className="absolute inset-0 flex items-center justify-center bg-red-500/40 text-[10px] font-medium text-white">
            Failed
          </div>
        )}
      </div>
      <span className="truncate text-[11px] text-zinc-600 dark:text-zinc-400">
        {file.name}
      </span>
    </button>
  );
}

export function FileModal({
  file,
  onClose,
}: {
  file: CaseFile;
  onClose: () => void;
}) {
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4 backdrop-blur-sm"
      onClick={onClose}
    >
      <div
        className="relative flex max-h-[90vh] w-full max-w-4xl flex-col gap-4 overflow-hidden rounded-xl bg-white p-5 text-zinc-900 shadow-2xl dark:bg-zinc-950 dark:text-zinc-100"
        onClick={(event) => event.stopPropagation()}
      >
        <header className="flex items-start justify-between gap-3">
          <div>
            <h3 className="text-sm font-semibold break-all">{file.name}</h3>
            <p className="text-xs uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              {file.kind}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="rounded-full bg-zinc-100 px-3 py-1 text-sm text-zinc-700 hover:bg-zinc-200 dark:bg-zinc-900 dark:text-zinc-300 dark:hover:bg-zinc-800"
            aria-label="Close"
          >
            ×
          </button>
        </header>

        <div className="flex min-h-0 flex-1 items-center justify-center overflow-auto rounded-lg bg-zinc-50 p-3 dark:bg-zinc-900">
          {file.kind === "image" ? (
            /* eslint-disable-next-line @next/next/no-img-element */
            <img
              src={file.url}
              alt={file.name}
              className="block h-auto w-auto max-w-full rounded object-contain"
              style={{ maxHeight: "70vh" }}
            />
          ) : (
            <audio controls src={file.url} className="w-full" />
          )}
        </div>

        {file.status === "processing" && (
          <p className="text-xs text-zinc-500 dark:text-zinc-400">
            {file.kind === "audio" ? "Transcribing…" : "Describing…"}
          </p>
        )}
        {file.status === "error" && (
          <p className="text-xs text-red-600">{file.error}</p>
        )}
        {file.status === "done" && file.text && (
          <div className="overflow-auto">
            <p className="text-[10px] uppercase tracking-wide text-zinc-500 dark:text-zinc-400">
              {file.kind === "audio" ? "Transcription" : "Description"}
            </p>
            <p className="mt-1 whitespace-pre-wrap text-sm leading-6 text-zinc-800 dark:text-zinc-200">
              {file.text}
            </p>
          </div>
        )}
      </div>
    </div>
  );
}
