"use client";

import { useState } from "react";
import { downloadBlob } from "@/lib/export";
import { DownloadIcon } from "./icons";

/**
 * A download button that builds its payload lazily (zipping evidence is async)
 * and reflects progress/failure inline, so the user gets feedback while the
 * bundle is assembled.
 */
export function DownloadButton({
  build,
  label = "Download",
  title,
  className,
}: {
  /** Produce the file to download. Called on click; may fetch + zip. */
  build: () => Promise<{ filename: string; blob: Blob }>;
  label?: string;
  title?: string;
  className?: string;
}) {
  const [state, setState] = useState<"idle" | "busy" | "error">("idle");

  async function handleClick() {
    if (state === "busy") return;
    setState("busy");
    try {
      const { filename, blob } = await build();
      downloadBlob(filename, blob);
      setState("idle");
    } catch {
      setState("error");
    }
  }

  return (
    <button
      type="button"
      onClick={handleClick}
      disabled={state === "busy"}
      title={title}
      className={
        className ??
        "flex shrink-0 items-center gap-1.5 rounded-full border border-zinc-300 px-3 py-1.5 text-xs font-medium text-zinc-700 transition-colors hover:bg-zinc-100 disabled:opacity-60 dark:border-zinc-700 dark:text-zinc-200 dark:hover:bg-zinc-900"
      }
    >
      <DownloadIcon />
      {state === "busy" ? "Preparing…" : state === "error" ? "Retry" : label}
    </button>
  );
}
