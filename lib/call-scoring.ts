import { generateText, Output } from "ai";
import { z } from "zod";
import { GhlError, ghlFetch, ghlFetchBinary, ghlLocationId } from "@/lib/ghl";
import { createLogger } from "@/lib/logger";
import { MODELS, model } from "@/lib/provider";
import { runRateLimited } from "@/lib/rate-limit";

/**
 * Call Scoring (Conversation QA) — v1 prototype. Finds the most recent
 * answered, recorded intake calls in GHL, downloads each recording, transcribes
 * it with speaker labels (Gemini native audio), and scores the intaker's
 * performance against the starter rubric below (Claude). The AI produces
 * per-criterion 0–5 scores + rationale; the 0–100 overall is computed here with
 * fixed weights, so the arithmetic is deterministic.
 *
 * Everything against GHL is a read (conversation search, message list,
 * recording download). Nothing is written back.
 *
 * The rubric is a STARTING POINT for validation — the real criteria will be
 * decided with the team after the boss reviews this prototype.
 */

const log = createLogger("call-scoring");

/** Recorded calls to collect and score per run. */
export const CALL_TARGET = 10;
/** Skip calls shorter than this — nothing to grade on a 10-second connect. */
const MIN_CALL_SECONDS = 20;
/** At most this many calls from a single conversation, for variety. */
const MAX_PER_CONVERSATION = 2;
/** Conversation-search pages to walk (100 conversations each) before giving up. */
const MAX_SEARCH_PAGES = 5;
/** Concurrent conversation scans (GHL client throttle also spaces requests). */
const SCAN_POOL = 5;
/** Concurrent Gemini transcriptions (~1 MB WAV each). */
const TRANSCRIBE_POOL = 3;
/** Concurrent Claude scoring calls. */
const SCORE_POOL = 4;

// ---------------------------------------------------------------------------
// Rubric (v1 starter — shared with the UI so the page renders the criteria)

export const CRITERIA = [
  {
    id: "professionalism",
    label: "Greeting & professionalism",
    weight: 15,
    description:
      "Opens professionally: identifies the firm and themself, confirms who they are speaking with, courteous tone throughout, no unprofessional language.",
  },
  {
    id: "empathy",
    label: "Empathy & rapport",
    weight: 15,
    description:
      "Acknowledges the client's frustration with unwanted calls/texts/emails, listens without interrupting, sounds engaged rather than reading flatly from a script.",
  },
  {
    id: "gathering",
    label: "Information & evidence gathering",
    weight: 20,
    description:
      "Collects what the investigation needs: who contacted the client, from which numbers, timing and frequency, message content, available evidence (screenshots, voicemails, call logs), whether the client replied STOP, DNC-registry status, and any prior consent given to the company.",
  },
  {
    id: "process",
    label: "Process explanation & expectations",
    weight: 20,
    description:
      "Explains what happens next and sets honest expectations: how the investigation works, what the firm does with the evidence, realistic timelines, and how and when the client will hear back.",
  },
  {
    id: "compliance",
    label: "Compliance & accuracy",
    weight: 15,
    description:
      "Stays within the intake role: no legal advice, no guaranteed outcomes or dollar promises, accurate statements about the firm and the process, verifies identity before discussing case details.",
  },
  {
    id: "management",
    label: "Call control & closing",
    weight: 15,
    description:
      "Keeps the call on track, answers questions clearly, recaps action items, confirms contact information, and ends with clear next steps.",
  },
] as const;

export type CriterionId = (typeof CRITERIA)[number]["id"];

// ---------------------------------------------------------------------------
// Types

export type ScoredCriterion = {
  /** 0–5, or null when the criterion doesn't apply to this call. */
  score: number | null;
  rationale: string;
  /** Short verbatim quote backing the score, when one exists. */
  quote: string | null;
};

export type ScoreBand = "excellent" | "good" | "needs-work" | "poor";

export type ScoredCall = {
  messageId: string;
  conversationId: string;
  contactId: string | null;
  contactName: string | null;
  intakerName: string;
  direction: "inbound" | "outbound";
  callDate: string | null;
  durationSeconds: number | null;
  transcript: string | null;
  scores: Record<CriterionId, ScoredCriterion> | null;
  /** Weighted 0–100 (computed here, not by the model). Null until scored. */
  overall: number | null;
  band: ScoreBand | null;
  summary: string | null;
  strengths: string[];
  improvements: string[];
  emergency: { flagged: boolean; reason: string | null };
  error: string | null;
  contactUrl: string | null;
};

export type IntakerStat = {
  intakerName: string;
  calls: number;
  /** Average overall across this intaker's scored calls. */
  averageScore: number | null;
  emergencies: number;
};

export type CallScoringResult = {
  generatedAt: string;
  rubric: { id: CriterionId; label: string; weight: number; description: string }[];
  totals: {
    calls: number;
    scored: number;
    errors: number;
    emergencies: number;
    averageScore: number | null;
  };
  intakers: IntakerStat[];
  items: ScoredCall[];
};

export type CallScoringProgress = {
  phase: "scan" | "transcribe" | "score";
  done: number;
  total: number;
};

// ---------------------------------------------------------------------------
// Small helpers

/** Epoch-ms number or ISO string → Date (GHL uses both). */
function toDate(value: unknown): Date | null {
  if (typeof value === "number") return new Date(value);
  if (typeof value === "string" && value) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

async function pool<T>(
  items: T[],
  size: number,
  worker: (item: T, index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, items.length) }, async () => {
      for (;;) {
        const i = next++;
        if (i >= items.length) return;
        await worker(items[i], i);
      }
    }),
  );
}

export function scoreBand(overall: number): ScoreBand {
  if (overall >= 90) return "excellent";
  if (overall >= 75) return "good";
  if (overall >= 60) return "needs-work";
  return "poor";
}

/** Weighted 0–100 over the applicable (non-null) criteria. */
export function computeOverall(
  scores: Record<CriterionId, ScoredCriterion>,
): number | null {
  let earned = 0;
  let applicableWeight = 0;
  for (const c of CRITERIA) {
    const s = scores[c.id]?.score;
    if (s === null || s === undefined) continue;
    earned += (s / 5) * c.weight;
    applicableWeight += c.weight;
  }
  if (applicableWeight === 0) return null;
  return Math.round((earned / applicableWeight) * 100);
}

// ---------------------------------------------------------------------------
// GHL scan (all read-only)

type RawConversation = {
  id: string;
  contactId?: string;
  contactName?: string;
  fullName?: string;
  assignedTo?: string;
  lastMessageDate?: unknown;
};

type RawMessage = {
  id?: string;
  direction?: string;
  dateAdded?: string;
  messageType?: string;
  status?: string;
  userId?: string;
  meta?: { call?: { duration?: number | null; status?: string | null } };
};

type CandidateCall = {
  messageId: string;
  conversationId: string;
  contactId: string | null;
  contactName: string | null;
  userId: string | null;
  assignedTo: string | null;
  direction: "inbound" | "outbound";
  callDate: string | null;
  durationSeconds: number | null;
  audio: Uint8Array;
  audioType: string;
};

/** User id → display name. Missing scope degrades to raw ids, not a failure. */
async function fetchUserNames(): Promise<Map<string, string>> {
  const names = new Map<string, string>();
  try {
    const res = await ghlFetch<{
      users?: { id?: string; name?: string; firstName?: string; lastName?: string }[];
    }>(`/users/?locationId=${ghlLocationId()}`);
    for (const u of res.users ?? []) {
      if (!u.id) continue;
      const name =
        u.name?.trim() ||
        [u.firstName, u.lastName].filter(Boolean).join(" ").trim();
      if (name) names.set(u.id, name);
    }
  } catch (err) {
    log.warn("could not fetch user names (users.readonly scope?)", {
      message: err instanceof Error ? err.message : String(err),
    });
  }
  return names;
}

async function fetchMessages(conversationId: string): Promise<RawMessage[]> {
  const res = await ghlFetch<{
    messages?: { messages?: RawMessage[] } | RawMessage[];
  }>(`/conversations/${conversationId}/messages?limit=100`);
  return Array.isArray(res.messages)
    ? res.messages
    : (res.messages?.messages ?? []);
}

/**
 * Walk recent conversations (newest activity first) and collect the latest
 * answered calls that actually have a recording, downloading each recording as
 * we go. Calls without a recording (422) are skipped, not errors.
 */
async function findRecordedCalls(
  onProgress: (done: number, total: number) => void,
): Promise<CandidateCall[]> {
  const locationId = ghlLocationId();
  const candidates: CandidateCall[] = [];
  let startAfterDate: number | null = null;

  for (let page = 0; page < MAX_SEARCH_PAGES; page++) {
    if (candidates.length >= CALL_TARGET) break;
    const cursor: string =
      startAfterDate !== null ? `&startAfterDate=${startAfterDate}` : "";
    const res: { conversations?: RawConversation[] } = await ghlFetch(
      `/conversations/search?locationId=${locationId}` +
        `&limit=100&sortBy=last_message_date&sort=desc${cursor}`,
    );
    const conversations: RawConversation[] = (res.conversations ?? []).filter(
      (c) => c?.id,
    );
    if (conversations.length === 0) break;

    await pool(conversations, SCAN_POOL, async (convo) => {
      if (candidates.length >= CALL_TARGET) return;
      let messages: RawMessage[];
      try {
        messages = await fetchMessages(convo.id);
      } catch (err) {
        log.warn("message fetch failed during scan", {
          conversationId: convo.id,
          message: err instanceof Error ? err.message : String(err),
        });
        return;
      }
      const calls = messages
        .filter((m) => {
          const duration = m.meta?.call?.duration ?? null;
          return (
            m.id &&
            m.messageType === "TYPE_CALL" &&
            m.status === "completed" &&
            duration !== null &&
            duration >= MIN_CALL_SECONDS
          );
        })
        .sort(
          (a, b) =>
            (toDate(b.dateAdded)?.getTime() ?? 0) -
            (toDate(a.dateAdded)?.getTime() ?? 0),
        )
        .slice(0, MAX_PER_CONVERSATION);

      for (const call of calls) {
        if (candidates.length >= CALL_TARGET) return;
        try {
          const { data, contentType } = await ghlFetchBinary(
            `/conversations/messages/${call.id}/locations/${locationId}/recording`,
          );
          if (candidates.length >= CALL_TARGET) return;
          candidates.push({
            messageId: call.id as string,
            conversationId: convo.id,
            contactId: convo.contactId ?? null,
            contactName: convo.contactName ?? convo.fullName ?? null,
            userId: call.userId ?? null,
            assignedTo: convo.assignedTo ?? null,
            direction: call.direction === "inbound" ? "inbound" : "outbound",
            callDate: toDate(call.dateAdded)?.toISOString() ?? null,
            durationSeconds: call.meta?.call?.duration ?? null,
            audio: data,
            audioType: contentType.includes("wav") ? "audio/wav" : contentType,
          });
          onProgress(Math.min(candidates.length, CALL_TARGET), CALL_TARGET);
        } catch (err) {
          // 422 = "Message does not have recording" — expected, skip quietly.
          if (err instanceof GhlError && err.status === 422) continue;
          log.warn("recording download failed", {
            messageId: call.id,
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });

    const lastDate: number | undefined = toDate(
      conversations[conversations.length - 1]?.lastMessageDate,
    )?.getTime();
    if (!lastDate || lastDate === startAfterDate) break;
    startAfterDate = lastDate;
  }

  return candidates
    .sort(
      (a, b) =>
        (b.callDate ? Date.parse(b.callDate) : 0) -
        (a.callDate ? Date.parse(a.callDate) : 0),
    )
    .slice(0, CALL_TARGET);
}

// ---------------------------------------------------------------------------
// Transcription (Gemini native audio, diarized)

async function transcribeCall(candidate: CandidateCall): Promise<string> {
  const initiated =
    candidate.direction === "outbound"
      ? "The INTAKER placed this call to the CLIENT."
      : "The CLIENT called the firm and the INTAKER answered.";
  const { text } = await runRateLimited(() =>
    generateText({
      model: model(MODELS.audio),
      maxRetries: 0,
      temperature: 0,
      messages: [
        {
          role: "user",
          content: [
            {
              type: "text",
              text:
                "Transcribe this recorded phone call between an intake specialist " +
                "at a consumer-protection law firm (INTAKER) and a client or " +
                `prospective client (CLIENT). ${initiated}\n\n` +
                "Rules:\n" +
                "- One line per speaker turn, prefixed `INTAKER:` or `CLIENT:` " +
                "(use `SYSTEM:` for voicemail prompts, hold menus, or other automated audio).\n" +
                "- Transcribe every spoken word verbatim.\n" +
                "- Note meaningful non-speech audio inline in [brackets]: long silence, " +
                "hold music, notable tone of voice (frustrated, upbeat), interruptions.\n" +
                "- If you genuinely cannot tell the speakers apart, use `SPEAKER 1:` / " +
                "`SPEAKER 2:` consistently instead of guessing.\n" +
                "Return only the transcript, no preamble.",
            },
            { type: "file", data: candidate.audio, mediaType: candidate.audioType },
          ],
        },
      ],
    }),
  );
  return text.trim();
}

// ---------------------------------------------------------------------------
// Scoring (Claude, structured output; arithmetic stays in computeOverall)

const criterionSchema = z.object({
  score: z
    .number()
    .int()
    .min(0)
    .max(5)
    .nullable()
    .describe(
      "0–5, or null ONLY when the criterion cannot be assessed on this call at all.",
    ),
  rationale: z
    .string()
    .describe("One or two sentences citing what actually happened on the call."),
  quote: z
    .string()
    .nullable()
    .describe("Short verbatim quote from the transcript backing the score, or null."),
});

const scoreSchema = z.object({
  professionalism: criterionSchema,
  empathy: criterionSchema,
  gathering: criterionSchema,
  process: criterionSchema,
  compliance: criterionSchema,
  management: criterionSchema,
  strengths: z
    .array(z.string())
    .max(3)
    .describe("Up to 3 concrete things the intaker did well."),
  improvements: z
    .array(z.string())
    .max(3)
    .describe("Up to 3 specific, actionable coaching points."),
  summary: z
    .string()
    .describe("2–3 sentences a QA manager could read at a glance."),
  emergency: z.object({
    flagged: z
      .boolean()
      .describe("True only for situations needing the managing attorney's immediate attention."),
    reason: z.string().nullable().describe("Why this needs escalation, or null."),
  }),
});

const SCORING_SYSTEM =
  "You are a quality-assurance reviewer at a consumer-protection law firm. " +
  "The firm represents clients who receive unlawful spam calls, texts, and emails " +
  "(TCPA and related claims): clients send in their evidence, the firm investigates " +
  "whether the contacts qualify as infractions, and identifies the companies behind " +
  "them. Intake specialists answer client calls, gather facts and evidence about the " +
  "spam contacts, explain the investigation process, and keep clients informed.\n\n" +
  "You are given the diarized transcript of ONE recorded call. Score the INTAKER's " +
  "performance on each rubric criterion from 0 to 5:\n" +
  "5 = exemplary · 4 = strong, minor gaps · 3 = adequate · 2 = below expectations · " +
  "1 = poor · 0 = harmful or entirely absent.\n" +
  "Use null for a criterion that genuinely does not apply to this call (e.g. " +
  "evidence-gathering on a 30-second scheduling call). Never use null just because " +
  "performance was weak — weak performance is a low score.\n\n" +
  "Rubric:\n" +
  CRITERIA.map((c) => `- ${c.id} (${c.label}): ${c.description}`).join("\n") +
  "\n\nEmergency flag — reserve it for situations the managing attorney must see " +
  "immediately: the intaker gives materially wrong legal information or promises an " +
  "outcome or dollar amount; rude, hostile, or unprofessional conduct toward the " +
  "client; the client threatens a bar complaint or mentions an imminent legal " +
  "deadline; signs the client is in danger or being threatened; a privacy or " +
  "confidentiality breach. Routine poor performance is NOT an emergency.\n\n" +
  "Judge only what is in the transcript. Short calls legitimately leave several " +
  "criteria null. Quote the transcript wherever a quote supports a score.";

async function scoreCall(
  transcript: string,
  candidate: CandidateCall,
  intakerName: string,
): Promise<z.infer<typeof scoreSchema>> {
  const { output } = await runRateLimited(() =>
    generateText({
      model: model(MODELS.analysis),
      output: Output.object({ schema: scoreSchema }),
      system: SCORING_SYSTEM,
      prompt:
        `Call direction: ${candidate.direction}\n` +
        `Duration: ${candidate.durationSeconds ?? "?"} seconds\n` +
        `Intaker: ${intakerName}\n` +
        `Client: ${candidate.contactName ?? "(unknown)"}\n\n` +
        `Transcript:\n${transcript}`,
    }),
  );
  if (!output) throw new Error("Scoring model returned no structured output");
  return output;
}

// ---------------------------------------------------------------------------
// Orchestration

export async function runCallScoring(
  onProgress: (p: CallScoringProgress) => void,
): Promise<CallScoringResult> {
  const locationId = ghlLocationId();
  const appBase = `https://login.amicus-pro.com/v2/location/${locationId}`;

  onProgress({ phase: "scan", done: 0, total: CALL_TARGET });
  const [userNames, candidates] = await Promise.all([
    fetchUserNames(),
    findRecordedCalls((done, total) => onProgress({ phase: "scan", done, total })),
  ]);
  log.info("scan complete", { recordedCalls: candidates.length });
  if (candidates.length === 0) {
    throw new Error(
      "No answered calls with recordings found in the most recent conversations.",
    );
  }

  const items: ScoredCall[] = candidates.map((c) => {
    const intakerId = c.userId ?? c.assignedTo;
    return {
      messageId: c.messageId,
      conversationId: c.conversationId,
      contactId: c.contactId,
      contactName: c.contactName,
      intakerName: intakerId
        ? (userNames.get(intakerId) ?? intakerId)
        : "(unknown intaker)",
      direction: c.direction,
      callDate: c.callDate,
      durationSeconds: c.durationSeconds,
      transcript: null,
      scores: null,
      overall: null,
      band: null,
      summary: null,
      strengths: [],
      improvements: [],
      emergency: { flagged: false, reason: null },
      error: null,
      contactUrl: c.contactId ? `${appBase}/contacts/detail/${c.contactId}` : null,
    };
  });

  // Phase: transcription.
  let transcribed = 0;
  onProgress({ phase: "transcribe", done: 0, total: candidates.length });
  await pool(candidates, TRANSCRIBE_POOL, async (candidate, i) => {
    try {
      items[i].transcript = await transcribeCall(candidate);
    } catch (err) {
      items[i].error = `Transcription failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      log.warn("transcription failed", {
        messageId: candidate.messageId,
        message: items[i].error,
      });
    } finally {
      transcribed++;
      onProgress({ phase: "transcribe", done: transcribed, total: candidates.length });
    }
  });

  // Phase: scoring (only calls that transcribed).
  const scorable = items
    .map((item, i) => ({ item, candidate: candidates[i] }))
    .filter(({ item }) => item.transcript && !item.error);
  let scored = 0;
  onProgress({ phase: "score", done: 0, total: scorable.length });
  await pool(scorable, SCORE_POOL, async ({ item, candidate }) => {
    try {
      const output = await scoreCall(
        item.transcript as string,
        candidate,
        item.intakerName,
      );
      const scores: Record<CriterionId, ScoredCriterion> = {
        professionalism: output.professionalism,
        empathy: output.empathy,
        gathering: output.gathering,
        process: output.process,
        compliance: output.compliance,
        management: output.management,
      };
      item.scores = scores;
      item.overall = computeOverall(scores);
      item.band = item.overall !== null ? scoreBand(item.overall) : null;
      item.summary = output.summary;
      item.strengths = output.strengths;
      item.improvements = output.improvements;
      item.emergency = output.emergency;
    } catch (err) {
      item.error = `Scoring failed: ${
        err instanceof Error ? err.message : String(err)
      }`;
      log.warn("scoring failed", {
        messageId: item.messageId,
        message: item.error,
      });
    } finally {
      scored++;
      onProgress({ phase: "score", done: scored, total: scorable.length });
    }
  });

  // Rollups.
  const scoredItems = items.filter((i) => i.overall !== null);
  const average = (values: number[]): number | null =>
    values.length
      ? Math.round(values.reduce((a, b) => a + b, 0) / values.length)
      : null;

  const intakerMap = new Map<string, { scores: number[]; calls: number; emergencies: number }>();
  for (const item of items) {
    let stat = intakerMap.get(item.intakerName);
    if (!stat) {
      stat = { scores: [], calls: 0, emergencies: 0 };
      intakerMap.set(item.intakerName, stat);
    }
    stat.calls++;
    if (item.overall !== null) stat.scores.push(item.overall);
    if (item.emergency.flagged) stat.emergencies++;
  }
  const intakers: IntakerStat[] = [...intakerMap.entries()]
    .map(([intakerName, s]) => ({
      intakerName,
      calls: s.calls,
      averageScore: average(s.scores),
      emergencies: s.emergencies,
    }))
    .sort((a, b) => (a.averageScore ?? 101) - (b.averageScore ?? 101));

  // Emergencies first, then worst scores, then errors, then the rest.
  items.sort((a, b) => {
    if (a.emergency.flagged !== b.emergency.flagged) {
      return a.emergency.flagged ? -1 : 1;
    }
    return (a.overall ?? 999) - (b.overall ?? 999);
  });

  return {
    generatedAt: new Date().toISOString(),
    rubric: CRITERIA.map((c) => ({ ...c })),
    totals: {
      calls: items.length,
      scored: scoredItems.length,
      errors: items.filter((i) => i.error !== null).length,
      emergencies: items.filter((i) => i.emergency.flagged).length,
      averageScore: average(scoredItems.map((i) => i.overall as number)),
    },
    intakers,
    items,
  };
}
