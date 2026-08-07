import { promises as fs } from "node:fs";
import path from "node:path";
import type { Metadata } from "next";
import { PipelineDashboard } from "./pipeline-dashboard";

export const metadata: Metadata = {
  title: "Pipeline Tracking",
};

/**
 * New Leads → Signed Case tracking. The dataset is a one-time export of the
 * #notifications-intake-tcpa Slack channel (data/slack-pipeline-events.json):
 * every ":phone: Call New Lead!!" and ":white_check_mark: PandaDoc Alert"
 * notification with its exact timestamp. Slack was used because GHL only keeps
 * an opportunity's *latest* stage-change date — a July 2026 bulk move wiped the
 * historical Signed Case entry dates.
 */

type SlackEvent = { ts: string; type: "lead" | "signed"; name: string };

/** A signing matched back to that person's most recent prior lead event. */
export type MatchedCase = { leadTs: number; ts: number; days: number };

function normName(s: string): string {
  return s.replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Collapse duplicate lead notifications: the workflow sometimes fires several
 * "Call New Lead" messages for the same person minutes apart (~200 of ~3,950
 * events land within an hour of the previous one). Same normalized name within
 * 24h of the last kept event counts as the same lead; a re-appearance after
 * that is a genuine returning contact and stays.
 */
function dedupeLeads(events: SlackEvent[]): {
  leadTimes: Map<string, number[]>;
  kept: number[];
  removed: number;
} {
  const byName = new Map<string, number[]>();
  const unnamed: number[] = [];
  for (const e of events) {
    if (e.type !== "lead") continue;
    const key = normName(e.name);
    const ts = Number.parseFloat(e.ts);
    if (!key) {
      unnamed.push(ts);
      continue;
    }
    byName.set(key, [...(byName.get(key) ?? []), ts]);
  }
  const leadTimes = new Map<string, number[]>();
  const kept: number[] = [...unnamed];
  let removed = 0;
  for (const [key, times] of byName) {
    times.sort((a, b) => a - b);
    const keptTimes: number[] = [];
    for (const t of times) {
      if (keptTimes.length && t - keptTimes[keptTimes.length - 1] < 86_400) {
        removed += 1;
        continue;
      }
      keptTimes.push(t);
    }
    leadTimes.set(key, keptTimes);
    kept.push(...keptTimes);
  }
  kept.sort((a, b) => a - b);
  return { leadTimes, kept, removed };
}

/**
 * Match each signing to its lead by client name, for time-to-sign and cohort
 * conversion. One person can produce several leads and several signed cases
 * (one per defendant), so a signing anchors to that person's most recent
 * (deduplicated) lead event before it.
 *
 * PandaDoc names come in two shapes: "First Last - Company" (matched on the
 * full name) and "Surname v. Company" (matched only when exactly one lead name
 * has that surname). Repeat notifications for the same person + company are
 * dropped. Signings with no parseable name or no prior lead event (mostly
 * cases whose lead predates the channel) are simply unmatched — roughly half.
 */
function matchCases(
  events: SlackEvent[],
  leadTimes: Map<string, number[]>,
): MatchedCase[] {
  const bySurname = new Map<string, Set<string>>();
  for (const key of leadTimes.keys()) {
    const parts = key.split(" ");
    const surname = parts[parts.length - 1];
    bySurname.set(surname, (bySurname.get(surname) ?? new Set()).add(key));
  }

  const seenCase = new Set<string>();
  const out: MatchedCase[] = [];
  const signed = events
    .filter((e) => e.type === "signed")
    .sort((a, b) => Number.parseFloat(a.ts) - Number.parseFloat(b.ts));
  for (const e of signed) {
    const ts = Number.parseFloat(e.ts);
    const dash = e.name.match(/^(.*?)\s+-\s*(.*)$/);
    const versus = e.name.match(/^(\S+)\s+v\.?\s+(.*)$/i);
    let person: string | null = null;
    let company = "";
    if (dash && dash[1].trim()) {
      person = normName(dash[1]);
      company = normName(dash[2]);
    } else if (versus) {
      const candidates = bySurname.get(normName(versus[1]));
      if (candidates && candidates.size === 1) {
        person = [...candidates][0];
        company = normName(versus[2]);
      }
    }
    if (!person) continue;
    const caseKey = `${person}|${company}`;
    if (seenCase.has(caseKey)) continue;
    const prior = (leadTimes.get(person) ?? []).filter((t) => t < ts);
    if (prior.length === 0) continue;
    seenCase.add(caseKey);
    const leadTs = Math.max(...prior);
    out.push({
      leadTs: Math.floor(leadTs),
      ts: Math.floor(ts),
      days: (ts - leadTs) / 86_400,
    });
  }
  return out;
}

export default async function PipelineTrackingPage() {
  const raw = await fs.readFile(
    path.join(process.cwd(), "data", "slack-pipeline-events.json"),
    "utf8",
  );
  const events = JSON.parse(raw) as SlackEvent[];

  const { leadTimes, kept, removed } = dedupeLeads(events);

  // Epoch seconds, ascending — the client buckets them in the viewer's
  // timezone, so day boundaries aren't baked in on the server.
  const signed = events
    .filter((e) => e.type === "signed")
    .map((e) => Math.floor(Number.parseFloat(e.ts)))
    .sort((a, b) => a - b);

  return (
    <PipelineDashboard
      leads={kept.map((t) => Math.floor(t))}
      signed={signed}
      cases={matchCases(events, leadTimes)}
      dedupedLeads={removed}
    />
  );
}
