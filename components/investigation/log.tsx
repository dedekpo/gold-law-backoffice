"use client";

import { useState } from "react";
import type { LogEntry } from "@/lib/investigation-store";
import {
  api,
  Btn,
  Empty,
  Eyebrow,
  fmtDateTime,
  inputCls,
  useWorkbench,
} from "./ui";

/**
 * The docket: every step of the investigation in one attributed, timestamped
 * stream — replaces scattering the trail across GHL notes. Entries can still
 * be mirrored to the contact's GHL notes while staff live there.
 */

export function LogSection() {
  const { doc, ready, busy, actorName, run } = useWorkbench();
  const [text, setText] = useState("");
  const [mirror, setMirror] = useState(true);

  const submit = () =>
    void run("log", async () => {
      const { entry } = await api<{ entry: LogEntry; mirrored: boolean }>(
        "/api/investigation/log",
        "POST",
        {
          investigationId: doc.id,
          actorName: actorName.trim(),
          text: text.trim(),
          mirrorToGhl: mirror,
        },
      );
      setText("");
      return { ...doc, log: [...doc.log, entry] };
    });

  return (
    <section>
      <Eyebrow>Docket</Eyebrow>
      {doc.log.length > 0 ? (
        <DocketList log={doc.log} />
      ) : (
        <Empty>Nothing on the docket yet.</Empty>
      )}

      <div className="mt-3 flex flex-col gap-2">
        <textarea
          value={text}
          onChange={(e) => setText(e.target.value)}
          rows={2}
          placeholder="What did you find, try, or rule out?"
          className={inputCls}
        />
        <div className="flex flex-wrap items-center gap-3">
          <Btn
            variant="primary"
            disabled={!ready || text.trim().length === 0}
            onClick={submit}
          >
            {busy === "log" ? "Adding…" : "Add to docket"}
          </Btn>
          <label className="flex items-center gap-1.5 text-xs text-soft">
            <input
              type="checkbox"
              checked={mirror}
              onChange={(e) => setMirror(e.target.checked)}
              className="accent-(--ink)"
            />
            Also add as a GHL contact note
          </label>
        </div>
      </div>
    </section>
  );
}

export function DocketList({ log }: { log: LogEntry[] }) {
  return (
    <ol className="flex flex-col">
      {log.map((entry) => (
        <li
          key={entry.id}
          className="border-l-2 border-rule py-1.5 pl-4 hover:border-rule-strong"
        >
          <p className="font-mono text-[10px] tracking-wide text-faint">
            {fmtDateTime(entry.at)} ·{" "}
            {entry.author.kind === "ai" ? "AI" : entry.author.name}
          </p>
          <p className="text-sm leading-6 break-words whitespace-pre-wrap text-ink">
            {entry.text}
          </p>
        </li>
      ))}
    </ol>
  );
}
