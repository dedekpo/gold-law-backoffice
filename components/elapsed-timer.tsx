"use client";

import { useEffect, useState } from "react";
import type { Case } from "@/lib/types";
import { ClockIcon } from "./icons";

function formatElapsed(ms: number): string {
  const totalSeconds = Math.max(0, Math.floor(ms / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${minutes}:${String(seconds).padStart(2, "0")}`;
}

/**
 * Live "time since this case started" indicator. Ticks every second while the
 * case is still processing, then freezes on the total once it reaches a terminal
 * state (`completedAt`). Gives the user a sense of how long an in-flight
 * investigation has been running — these can take minutes for slow states.
 */
export function ElapsedTimer({ caseItem }: { caseItem: Case }) {
  const { createdAt, completedAt } = caseItem;
  const running = completedAt == null;
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [running]);

  const elapsed = (completedAt ?? now) - createdAt;

  return (
    <span
      title={
        running
          ? "Time since this case started processing"
          : "Total processing time"
      }
      className={`flex shrink-0 items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] font-medium tabular-nums ${
        running
          ? "bg-zinc-100 text-zinc-600 dark:bg-zinc-900 dark:text-zinc-400"
          : "bg-zinc-100 text-zinc-500 dark:bg-zinc-900 dark:text-zinc-500"
      }`}
    >
      {running ? (
        <span className="relative flex h-1.5 w-1.5" aria-hidden>
          <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-zinc-400 opacity-75" />
          <span className="relative inline-flex h-1.5 w-1.5 rounded-full bg-zinc-500" />
        </span>
      ) : (
        <ClockIcon />
      )}
      {formatElapsed(elapsed)}
    </span>
  );
}
