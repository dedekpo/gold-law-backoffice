"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import Link from "next/link";
import { zipSync } from "fflate";
import { amrToMp3Blob } from "@/lib/audio";
import { Btn, Eyebrow, Stamp, Tag } from "@/components/investigation/ui";

/**
 * Internal utility: convert AMR call recordings (the format phones and GHL
 * hand us) to MP3 so they can be played, shared, and filed anywhere.
 * Everything runs in the browser — no file ever leaves the machine.
 */

type ItemStatus = "converting" | "done" | "failed";

type Item = {
  id: number;
  name: string;
  size: number;
  status: ItemStatus;
  mp3?: Blob;
  /** Object URL for download + playback; revoked when the list is cleared. */
  url?: string;
  error?: string;
};

let nextId = 1;

const mp3Name = (name: string) => name.replace(/\.[^.]+$/, "") + ".mp3";

function fmtSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export default function AmrToMp3Page() {
  const [items, setItems] = useState<Item[]>([]);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const itemsRef = useRef(items);
  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  useEffect(
    () => () => {
      for (const item of itemsRef.current) {
        if (item.url) URL.revokeObjectURL(item.url);
      }
    },
    [],
  );

  const convert = useCallback((files: File[]) => {
    for (const file of files) {
      const id = nextId++;
      setItems((prev) => [
        ...prev,
        { id, name: file.name, size: file.size, status: "converting" },
      ]);
      void (async () => {
        let patch: Partial<Item>;
        try {
          const mp3 = await amrToMp3Blob(file);
          patch = {
            status: "done",
            mp3,
            url: URL.createObjectURL(mp3),
          };
        } catch {
          patch = {
            status: "failed",
            error: "Could not decode — is this an AMR recording?",
          };
        }
        setItems((prev) =>
          prev.map((it) => (it.id === id ? { ...it, ...patch } : it)),
        );
      })();
    }
  }, []);

  const clear = () => {
    for (const item of itemsRef.current) {
      if (item.url) URL.revokeObjectURL(item.url);
    }
    setItems([]);
  };

  const done = items.filter((it) => it.status === "done");
  const converting = items.some((it) => it.status === "converting");

  const downloadAll = async () => {
    // Zip entry names must be unique; suffix duplicates.
    const seen = new Map<string, number>();
    const entries: Record<string, Uint8Array> = {};
    for (const item of done) {
      if (!item.mp3) continue;
      let name = mp3Name(item.name);
      const count = seen.get(name) ?? 0;
      seen.set(name, count + 1);
      if (count > 0) name = name.replace(/\.mp3$/, ` (${count}).mp3`);
      entries[name] = new Uint8Array(await item.mp3.arrayBuffer());
    }
    const zip = zipSync(entries, { level: 0 });
    const url = URL.createObjectURL(
      new Blob([zip as BlobPart], { type: "application/zip" }),
    );
    const a = document.createElement("a");
    a.href = url;
    a.download = "recordings-mp3.zip";
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <main className="min-h-0 flex-1 overflow-y-auto bg-paper font-sans text-ink">
      <div className="mx-auto flex max-w-3xl gap-5 px-4 py-12 sm:px-6 sm:py-16">
        {/* The pleading-paper margin rule. */}
        <div
          aria-hidden
          className="hidden w-[5px] shrink-0 self-stretch border-x border-stamp/35 sm:block"
        />

        <div className="min-w-0 flex-1">
          <header className="border-b-2 border-ink/80 pb-5">
            <p className="font-mono text-[11px] tracking-[0.22em] text-stamp uppercase">
              Gold Law · Utilities
            </p>
            <h1 className="mt-2 font-serif text-3xl font-semibold text-ink">
              AMR to MP3
            </h1>
            <p className="mt-2 max-w-xl text-sm leading-6 text-soft">
              Drop AMR call recordings below and download them as MP3s.
              Conversion happens entirely in your browser — nothing is
              uploaded anywhere.
            </p>
            <p className="mt-3">
              <Link
                href="/"
                className="font-mono text-[11px] text-faint underline-offset-4 hover:underline"
              >
                ← Back to the lobby
              </Link>
            </p>
          </header>

          <section className="mt-8">
            <div
              onDragOver={(e) => {
                e.preventDefault();
                setDragging(true);
              }}
              onDragLeave={() => setDragging(false)}
              onDrop={(e) => {
                e.preventDefault();
                setDragging(false);
                convert(Array.from(e.dataTransfer.files));
              }}
              onClick={() => inputRef.current?.click()}
              role="button"
              tabIndex={0}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  inputRef.current?.click();
                }
              }}
              className={`flex cursor-pointer flex-col items-center gap-1.5 rounded-xs border border-dashed px-6 py-12 text-center transition-colors ${
                dragging
                  ? "border-ink bg-wash"
                  : "border-rule-strong hover:bg-wash"
              }`}
            >
              <p className="text-sm font-medium text-ink">
                Drop .amr files here
              </p>
              <p className="font-mono text-[11px] text-faint">
                or click to browse — multiple files welcome
              </p>
              <input
                ref={inputRef}
                type="file"
                accept=".amr,audio/amr,audio/amr-wb,audio/3gpp"
                multiple
                className="hidden"
                onChange={(e) => {
                  convert(Array.from(e.target.files ?? []));
                  e.target.value = "";
                }}
              />
            </div>
          </section>

          {items.length > 0 && (
            <section className="mt-10">
              <Eyebrow
                right={
                  <span className="flex items-center gap-2">
                    {done.length > 1 && (
                      <Btn small variant="ledger" onClick={downloadAll}>
                        Download all (.zip)
                      </Btn>
                    )}
                    <Btn small disabled={converting} onClick={clear}>
                      Clear
                    </Btn>
                  </span>
                }
              >
                Conversions · {done.length}/{items.length} ready
              </Eyebrow>

              <ul>
                {items.map((item, i) => (
                  <li
                    key={item.id}
                    className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-rule py-3"
                  >
                    <span className="w-12 shrink-0 font-mono text-[11px] text-faint">
                      {String(i + 1).padStart(3, "0")}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-sm text-ink">
                        {item.name}
                      </p>
                      <p className="mt-0.5">
                        <Tag>
                          {fmtSize(item.size)}
                          {item.mp3 && ` → ${fmtSize(item.mp3.size)} mp3`}
                        </Tag>
                      </p>
                      {item.error && (
                        <p className="mt-1 text-xs text-stamp">{item.error}</p>
                      )}
                    </div>
                    {item.status === "done" && item.url && (
                      <audio
                        controls
                        src={item.url}
                        preload="metadata"
                        className="h-8 w-56 max-w-full"
                      />
                    )}
                    <span className="shrink-0">
                      {item.status === "converting" && (
                        <Stamp tone="pending">Converting</Stamp>
                      )}
                      {item.status === "failed" && (
                        <Stamp tone="stamp">Failed</Stamp>
                      )}
                      {item.status === "done" && item.url && (
                        <a
                          href={item.url}
                          download={mp3Name(item.name)}
                          className="inline-block rounded-xs border border-ledger/60 px-2 py-0.5 text-xs font-medium text-ledger transition-colors hover:bg-ledger-soft"
                        >
                          Download
                        </a>
                      )}
                    </span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </div>
      </div>
    </main>
  );
}
