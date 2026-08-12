"use client";

import type {
  InvestigationViewResponse,
  LegacyField,
} from "@/app/api/investigation/route";
import type { ContactNote } from "@/lib/contact-notes";
import { proxied } from "@/lib/case-display";
import { Empty, Eyebrow, fmtDateTime, Tag } from "./ui";

/**
 * The record rail: everything already on file in GHL — the contact's note
 * stream, the AI Intake fields, report PDFs, and the legacy Company 1/2/3
 * fields. Read-only reference material, collapsed by default so the working
 * surfaces keep the room.
 */

export function ContextRail({ data }: { data: InvestigationViewResponse }) {
  return (
    <section>
      <Eyebrow>The record</Eyebrow>
      <div className="flex flex-col gap-2">
        <Folder
          label="Contact notes"
          count={data.notes.length}
          defaultOpen={data.notes.length > 0 && data.notes.length <= 4}
        >
          <Notes notes={data.notes} />
        </Folder>

        {(data.ghlAiFields.runStatus || data.reportFiles.length > 0) && (
          <Folder label="AI intake fields (GHL)">
            <AiFields data={data} />
          </Folder>
        )}

        {groups(data.legacyFields).map((group) => (
          <Folder
            key={group}
            label={group}
            count={data.legacyFields.filter((f) => f.group === group).length}
          >
            <FieldList
              fields={data.legacyFields.filter((f) => f.group === group)}
            />
          </Folder>
        ))}
      </div>
    </section>
  );
}

const groups = (fields: LegacyField[]) => [...new Set(fields.map((f) => f.group))];

function Folder({
  label,
  count,
  defaultOpen,
  children,
}: {
  label: string;
  count?: number;
  defaultOpen?: boolean;
  children: React.ReactNode;
}) {
  return (
    <details
      open={defaultOpen}
      className="group rounded-xs border border-rule bg-card"
    >
      <summary className="flex cursor-pointer items-center gap-2 px-3 py-2 select-none">
        <span aria-hidden className="font-mono text-[10px] text-faint">
          <span className="group-open:hidden">▸</span>
          <span className="hidden group-open:inline">▾</span>
        </span>
        <span className="flex-1 text-sm font-medium text-ink">{label}</span>
        {typeof count === "number" && <Tag>{count}</Tag>}
      </summary>
      <div className="border-t border-rule px-3 py-2.5">{children}</div>
    </details>
  );
}

function Notes({ notes }: { notes: ContactNote[] }) {
  if (notes.length === 0) return <Empty>No notes on this contact.</Empty>;
  return (
    <ol className="flex flex-col gap-3">
      {notes.map((note) => (
        <li key={note.id} className="border-l-2 border-rule pl-3">
          {note.dateAdded && (
            <p className="mb-0.5 font-mono text-[10px] text-faint">
              {fmtDateTime(note.dateAdded)}
            </p>
          )}
          <p className="text-sm leading-6 break-words whitespace-pre-wrap text-ink">
            {note.text}
          </p>
        </li>
      ))}
    </ol>
  );
}

function AiFields({ data }: { data: InvestigationViewResponse }) {
  const f = data.ghlAiFields;
  const rows: Array<[string, string | null]> = [
    ["Run status", f.runStatus],
    ["Top score", f.topScore],
    ["Companies found", f.companiesFound],
    ["Violations", f.violations],
  ];
  return (
    <div className="flex flex-col gap-2">
      <dl className="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        {rows.map(
          ([label, value]) =>
            value && (
              <div key={label} className="contents">
                <dt className="font-mono text-xs text-soft">{label}</dt>
                <dd className="break-words whitespace-pre-wrap text-ink">{value}</dd>
              </div>
            ),
        )}
      </dl>
      {f.companySummary && <LongText label="Company summary" text={f.companySummary} />}
      {f.investigationNotes && (
        <LongText label="Investigation notes" text={f.investigationNotes} />
      )}
      {data.reportFiles.length > 0 && (
        <div>
          <p className="mb-1 font-mono text-[10px] tracking-[0.12em] text-soft uppercase">
            Intake reports
          </p>
          <ul className="flex flex-col gap-0.5">
            {data.reportFiles.map((file) => (
              <li key={file.url}>
                <a
                  href={proxied(file.url)}
                  target="_blank"
                  rel="noreferrer"
                  className="text-sm text-ink underline decoration-rule-strong underline-offset-2 hover:decoration-stamp"
                >
                  {file.name} ↗
                </a>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function LongText({ label, text }: { label: string; text: string }) {
  return (
    <div>
      <p className="mb-1 font-mono text-[10px] tracking-[0.12em] text-soft uppercase">
        {label}
      </p>
      <p className="text-sm leading-6 break-words whitespace-pre-wrap text-ink">{text}</p>
    </div>
  );
}

function FieldList({ fields }: { fields: LegacyField[] }) {
  return (
    <dl className="grid grid-cols-1 gap-y-2 text-sm">
      {fields.map((field) => (
        <div key={field.name}>
          <dt className="font-mono text-xs text-soft">{field.name}</dt>
          <dd className="break-words whitespace-pre-wrap text-ink">
            {field.value}
          </dd>
        </div>
      ))}
    </dl>
  );
}
