import { generateText, Output } from "ai";
import { z } from "zod";
import { GhlError, ghlFetch, ghlLocationId } from "@/lib/ghl";
import { createLogger } from "@/lib/logger";
import { MODELS, model } from "@/lib/provider";
import { runRateLimited } from "@/lib/rate-limit";

/**
 * Intake response review — a READ-ONLY sweep of the "01 Intake-Investigation
 * Pipeline": for every open opportunity, look at the contact's latest
 * conversation and flag leads whose last message is from the client and has
 * gone unanswered for 5+ business days. An AI pass then separates true
 * "still waiting on us" threads (red) from loop-closing messages like
 * "ok, thank you" (green), so the intake team only sees real gaps.
 *
 * Nothing here writes to GHL: every call is a GET (plus the paginated
 * opportunity search, also a GET). Keep it that way.
 */

const log = createLogger("intake-review");

const PIPELINE_NAME = "01 Intake-Investigation Pipeline";
/** Business days (Mon–Fri) a client message may sit unanswered before flagging. */
export const BUSINESS_DAYS_THRESHOLD = 5;
/** Messages pulled per candidate conversation for the AI transcript. */
const MESSAGE_FETCH_LIMIT = 40;
/** Transcript lines actually shown to the model (tail of the thread). */
const TRANSCRIPT_TAIL = 15;
/** Concurrent GHL fetch workers (client-side throttle spaces the requests). */
const GHL_POOL = 5;
/** Concurrent AI triage calls (the shared rate limiter caps globally too). */
const TRIAGE_POOL = 4;

// ---------------------------------------------------------------------------
// Types

export type ReviewCategory =
  /** Client spoke last, 5+ business days ago, and the AI says a reply is owed. */
  | "needs-response"
  /** Client spoke last 5+ business days ago, but the message closed the loop. */
  | "resolved"
  /** The team (or an automation) sent the most recent message. */
  | "responded"
  /** Client spoke last, but within the business-day threshold. */
  | "waiting-recent"
  /** No conversation exists for the opportunity's contact. */
  | "no-conversation"
  /** This opportunity could not be analyzed (fetch/AI failure). */
  | "error";

export type ReviewItem = {
  opportunityId: string;
  opportunityName: string;
  stageName: string;
  createdAt: string | null;
  contactId: string | null;
  contactName: string | null;
  ownerId: string | null;
  ownerName: string;
  category: ReviewCategory;
  /** Business days the client's last message has waited (null when N/A). */
  businessDaysWaiting: number | null;
  lastMessageAt: string | null;
  lastMessageType: string | null;
  /** Snippet of the client's last inbound message. */
  lastClientMessage: string | null;
  /** One-line AI rationale (triaged items only). */
  aiReason: string | null;
  /** Transcript tail the AI judged (triaged items only). */
  transcript: string[] | null;
  /** Error/diagnostic note. */
  note: string | null;
  opportunityUrl: string;
  contactUrl: string | null;
};

export type OwnerStat = {
  ownerId: string | null;
  ownerName: string;
  /** Open opportunities in the pipeline assigned to this owner. */
  total: number;
  needsResponse: number;
  resolved: number;
  responded: number;
  waitingRecent: number;
  noConversation: number;
  errors: number;
  /** needsResponse / total. */
  pendingRatio: number;
};

export type IntakeReviewResult = {
  generatedAt: string;
  pipelineId: string;
  pipelineName: string;
  totals: {
    opportunities: number;
    needsResponse: number;
    resolved: number;
    responded: number;
    waitingRecent: number;
    noConversation: number;
    errors: number;
  };
  owners: OwnerStat[];
  items: ReviewItem[];
};

export type IntakeReviewProgress = {
  phase: "pipeline" | "opportunities" | "conversations" | "triage";
  done: number;
  total: number;
};

// ---------------------------------------------------------------------------
// Small helpers

function normName(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Business days (Mon–Fri) elapsed since `from`: counts weekday calendar days
 * strictly after `from`'s day, up to and including `to`'s day. A message sent
 * Monday reaches 5 on the following Monday. Holidays are not excluded.
 */
export function businessDaysBetween(from: Date, to: Date): number {
  const d = new Date(from);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + 1);
  const end = new Date(to);
  end.setHours(0, 0, 0, 0);
  let count = 0;
  while (d.getTime() <= end.getTime()) {
    const wd = d.getDay();
    if (wd !== 0 && wd !== 6) count++;
    d.setDate(d.getDate() + 1);
  }
  return count;
}

/** Epoch-ms number or ISO string → Date (GHL uses both). */
function toDate(value: unknown): Date | null {
  if (typeof value === "number") return new Date(value);
  if (typeof value === "string" && value) {
    const d = new Date(value);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

/** Crude HTML-to-text for email bodies. */
function stripHtml(s: string): string {
  return s
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(s: string, max: number): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** "TYPE_SMS" → "sms". */
function prettyType(messageType: string | undefined): string {
  return (messageType ?? "message").replace(/^TYPE_/, "").toLowerCase();
}

/**
 * One retry for transient transport failures ("fetch failed"). GhlError means
 * the API answered — ghlFetch already retried the retryable statuses — so
 * those are rethrown as-is.
 */
async function withRetry<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (err) {
    if (err instanceof GhlError) throw err;
    await new Promise((resolve) => setTimeout(resolve, 2_000));
    return fn();
  }
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

// ---------------------------------------------------------------------------
// GHL fetchers (all read-only)

type RawPipeline = {
  id: string;
  name?: string;
  stages?: { id: string; name?: string }[];
};

export async function resolveIntakePipeline(): Promise<{
  id: string;
  name: string;
  stageNames: Map<string, string>;
}> {
  const res = await ghlFetch<{ pipelines?: RawPipeline[] }>(
    `/opportunities/pipelines?locationId=${ghlLocationId()}`,
  );
  const pipelines = res.pipelines ?? [];
  const wanted = normName(PIPELINE_NAME);
  const match =
    pipelines.find((p) => normName(p.name ?? "") === wanted) ??
    pipelines.find((p) => normName(p.name ?? "").includes("intakeinvestigation"));
  if (!match) {
    const names = pipelines.map((p) => p.name).filter(Boolean).join(", ");
    throw new Error(
      `Pipeline "${PIPELINE_NAME}" not found. Available pipelines: ${names || "(none)"}`,
    );
  }
  const stageNames = new Map<string, string>();
  for (const s of match.stages ?? []) {
    if (s.id) stageNames.set(s.id, s.name ?? s.id);
  }
  return { id: match.id, name: match.name ?? PIPELINE_NAME, stageNames };
}

type RawOpportunity = {
  id: string;
  name?: string;
  status?: string;
  createdAt?: string;
  pipelineStageId?: string;
  assignedTo?: string | null;
  contactId?: string | null;
  contact?: { id?: string; name?: string; email?: string; phone?: string };
};

/**
 * Every OPEN opportunity in the pipeline, all stages. (Won/lost/abandoned
 * cards no longer need an intake reply, so they're excluded on purpose.)
 */
async function fetchPipelineOpportunities(
  pipelineId: string,
  onProgress: (done: number, total: number) => void,
): Promise<RawOpportunity[]> {
  const locationId = ghlLocationId();
  const pagePath = (page: number) =>
    `/opportunities/search?location_id=${locationId}&pipeline_id=${pipelineId}` +
    `&status=open&limit=100&page=${page}`;

  const first = await ghlFetch<{
    opportunities?: RawOpportunity[];
    meta?: { total?: number };
  }>(pagePath(1));
  const total = first.meta?.total ?? (first.opportunities?.length ?? 0);
  const pageCount = Math.max(1, Math.ceil(total / 100));
  onProgress(Math.min(100, total), total);

  const pages: RawOpportunity[][] = [first.opportunities ?? []];
  const remaining = Array.from({ length: pageCount - 1 }, (_, i) => i + 2);
  let fetched = pages[0].length;
  await pool(remaining, GHL_POOL, async (page) => {
    const res = await withRetry(() =>
      ghlFetch<{ opportunities?: RawOpportunity[] }>(pagePath(page)),
    );
    pages[page - 1] = res.opportunities ?? [];
    fetched += pages[page - 1].length;
    onProgress(Math.min(fetched, total), total);
  });
  return pages.flat().filter((o) => o?.id);
}

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

type RawConversation = {
  id: string;
  lastMessageBody?: string;
  lastMessageDate?: unknown;
  lastMessageDirection?: string;
  lastMessageType?: string;
  contactName?: string;
  fullName?: string;
};

/** The contact's most recently active conversation, or null. */
async function fetchLatestConversation(
  contactId: string,
): Promise<RawConversation | null> {
  const res = await withRetry(() =>
    ghlFetch<{ conversations?: RawConversation[] }>(
      `/conversations/search?locationId=${ghlLocationId()}` +
        `&contactId=${contactId}&limit=20`,
    ),
  );
  const conversations = (res.conversations ?? []).filter((c) => c?.id);
  if (conversations.length === 0) return null;
  return conversations.reduce((best, c) => {
    const bestAt = toDate(best.lastMessageDate)?.getTime() ?? 0;
    const at = toDate(c.lastMessageDate)?.getTime() ?? 0;
    return at > bestAt ? c : best;
  });
}

type RawMessage = {
  direction?: string;
  dateAdded?: string;
  body?: string;
  messageType?: string;
  status?: string;
};

async function fetchMessages(conversationId: string): Promise<RawMessage[]> {
  const res = await withRetry(() =>
    ghlFetch<{
      messages?: { messages?: RawMessage[] } | RawMessage[];
    }>(`/conversations/${conversationId}/messages?limit=${MESSAGE_FETCH_LIMIT}`),
  );
  const raw = Array.isArray(res.messages)
    ? res.messages
    : (res.messages?.messages ?? []);
  return raw
    .filter((m) => m && !m.messageType?.startsWith("TYPE_ACTIVITY"))
    .sort(
      (a, b) =>
        (toDate(a.dateAdded)?.getTime() ?? 0) -
        (toDate(b.dateAdded)?.getTime() ?? 0),
    );
}

/** Render one message as a transcript line, or null when it has no content. */
function transcriptLine(m: RawMessage): string | null {
  const type = prettyType(m.messageType);
  const who = m.direction === "inbound" ? "CLIENT" : "TEAM";
  let body = m.body ? truncate(stripHtml(m.body), 600) : "";
  if (!body && type === "call") {
    body = `[${m.direction ?? "logged"} call${m.status ? ` — ${m.status}` : ""}]`;
  }
  if (!body) return null;
  const when = toDate(m.dateAdded);
  const stamp = when ? when.toISOString().slice(0, 16).replace("T", " ") : "?";
  return `[${stamp}] ${who} (${type}): ${body}`;
}

// ---------------------------------------------------------------------------
// AI triage

const triageSchema = z.object({
  verdict: z
    .enum(["needs_response", "resolved"])
    .describe(
      "needs_response when the client is still owed a reply; resolved when their last message closed the loop",
    ),
  reason: z.string().describe("One short sentence explaining the verdict."),
});

async function triageConversation(
  transcript: string[],
  contactName: string | null,
  opportunityName: string,
): Promise<{ verdict: "needs_response" | "resolved"; reason: string }> {
  const { output } = await runRateLimited(() =>
    generateText({
      model: model(MODELS.analysis),
      output: Output.object({ schema: triageSchema }),
      system:
        "You audit intake-team conversations at a consumer-protection law firm. " +
        "You are given the tail of a conversation between the firm's intake team " +
        "(TEAM) and a prospective client (CLIENT). The client sent the most recent " +
        "message and it has gone unanswered for at least 5 business days. Decide " +
        "whether the intake team still owes the client a reply.\n\n" +
        "- needs_response: the client is waiting on the team — a question, a request " +
        "for an update ('any news?', 'could you get back to me?'), frustration about " +
        "silence, or substantive new information that clearly warrants acknowledgment.\n" +
        "- resolved: the client's last message closes the loop and needs no reply — " +
        "acknowledgments like 'ok, thank you', 'got it', confirmations that a question " +
        "was answered, or a clear opt-out / not-interested.\n\n" +
        "Note on reactions: SMS/iMessage reactions arrive as inbound messages that read " +
        "like `Liked \"…\"`, `Loved \"…\"`, or `Emphasized \"…\"` quoting the team's " +
        "message. A reaction is an acknowledgment, not an outreach — treat it as " +
        "resolved, UNLESS the team message it reacts to (or an earlier team message) " +
        "asked the client to provide something that they never actually provided.\n\n" +
        "Judge only whether a reply is owed. When genuinely ambiguous, prefer " +
        "needs_response — a needless reply is cheaper than an ignored client.",
      prompt:
        `Opportunity: ${opportunityName}\n` +
        `Client: ${contactName ?? "(unknown)"}\n\n` +
        `Conversation tail (oldest first):\n${transcript.join("\n")}`,
    }),
  );
  if (!output) throw new Error("Triage model returned no structured output");
  return output;
}

// ---------------------------------------------------------------------------
// Orchestration

export async function runIntakeReview(
  onProgress: (p: IntakeReviewProgress) => void,
): Promise<IntakeReviewResult> {
  const locationId = ghlLocationId();
  const appBase = `https://login.amicus-pro.com/v2/location/${locationId}`;
  const now = new Date();

  onProgress({ phase: "pipeline", done: 0, total: 1 });
  const [pipeline, userNames] = await Promise.all([
    resolveIntakePipeline(),
    fetchUserNames(),
  ]);

  onProgress({ phase: "opportunities", done: 0, total: 0 });
  const opportunities = await fetchPipelineOpportunities(pipeline.id, (done, total) =>
    onProgress({ phase: "opportunities", done, total }),
  );
  log.info("pipeline scan", {
    pipeline: pipeline.name,
    opportunities: opportunities.length,
  });

  const items: ReviewItem[] = opportunities.map((opp) => {
    const ownerId = opp.assignedTo ?? null;
    return {
      opportunityId: opp.id,
      opportunityName: opp.name ?? "(untitled)",
      stageName: opp.pipelineStageId
        ? (pipeline.stageNames.get(opp.pipelineStageId) ?? opp.pipelineStageId)
        : "(unknown stage)",
      createdAt: opp.createdAt ?? null,
      contactId: opp.contactId ?? opp.contact?.id ?? null,
      contactName: opp.contact?.name ?? null,
      ownerId,
      ownerName: ownerId
        ? (userNames.get(ownerId) ?? ownerId)
        : "Unassigned",
      category: "no-conversation",
      businessDaysWaiting: null,
      lastMessageAt: null,
      lastMessageType: null,
      lastClientMessage: null,
      aiReason: null,
      transcript: null,
      note: null,
      // ?tab=Opportunity+details is what actually opens the card in GHL.
      opportunityUrl: `${appBase}/opportunities/${opp.id}?tab=Opportunity+details`,
      contactUrl: null,
    };
  });

  // Phase: latest conversation per contact (cached — several cards can share
  // one contact), then message tails for the 5+ business-day candidates.
  const conversationCache = new Map<string, Promise<RawConversation | null>>();
  const candidates: ReviewItem[] = [];
  let scanned = 0;
  onProgress({ phase: "conversations", done: 0, total: items.length });

  await pool(items, GHL_POOL, async (item) => {
    try {
      if (!item.contactId) {
        item.note = "Opportunity has no contact attached.";
        return;
      }
      item.contactUrl = `${appBase}/contacts/detail/${item.contactId}`;
      let cached = conversationCache.get(item.contactId);
      if (!cached) {
        const contactId = item.contactId;
        cached = fetchLatestConversation(contactId);
        conversationCache.set(contactId, cached);
        // Don't cache failures — a sibling card for the same contact should
        // get a fresh attempt instead of inheriting the error.
        cached.catch(() => conversationCache.delete(contactId));
      }
      const convo = await cached;
      if (!convo) return; // stays "no-conversation"

      item.contactName ??= convo.contactName ?? convo.fullName ?? null;
      item.lastMessageType = prettyType(convo.lastMessageType);

      let lastAt = toDate(convo.lastMessageDate);
      let direction = convo.lastMessageDirection;
      let messages: RawMessage[] | null = null;

      // Search results occasionally omit direction/date — derive them from the
      // thread itself before judging.
      if (!direction || !lastAt) {
        messages = await fetchMessages(convo.id);
        const last = messages[messages.length - 1];
        if (!last) return;
        direction = last.direction;
        lastAt = toDate(last.dateAdded);
        item.lastMessageType = prettyType(last.messageType);
      }
      item.lastMessageAt = lastAt ? lastAt.toISOString() : null;

      if (direction !== "inbound") {
        item.category = "responded";
        return;
      }

      const waited = lastAt ? businessDaysBetween(lastAt, now) : null;
      item.businessDaysWaiting = waited;
      if (waited !== null && waited < BUSINESS_DAYS_THRESHOLD) {
        item.category = "waiting-recent";
        item.lastClientMessage = convo.lastMessageBody
          ? truncate(stripHtml(convo.lastMessageBody), 200)
          : null;
        return;
      }

      // Candidate for AI triage — build the transcript tail now.
      messages ??= await fetchMessages(convo.id);
      const lines = messages
        .map(transcriptLine)
        .filter((l): l is string => l !== null)
        .slice(-TRANSCRIPT_TAIL);
      const lastInbound = [...messages]
        .reverse()
        .find((m) => m.direction === "inbound" && m.body);
      item.lastClientMessage = lastInbound?.body
        ? truncate(stripHtml(lastInbound.body), 200)
        : convo.lastMessageBody
          ? truncate(stripHtml(convo.lastMessageBody), 200)
          : null;
      if (lines.length === 0) {
        item.category = "responded";
        item.note = "Conversation has no readable messages (activities only).";
        return;
      }
      item.transcript = lines;
      candidates.push(item);
    } catch (err) {
      item.category = "error";
      item.note = err instanceof Error ? err.message : String(err);
      log.warn("opportunity scan failed", {
        opportunityId: item.opportunityId,
        message: item.note,
      });
    } finally {
      scanned++;
      if (scanned % 10 === 0 || scanned === items.length) {
        onProgress({ phase: "conversations", done: scanned, total: items.length });
      }
    }
  });

  // Phase: AI triage on the stale-inbound candidates only.
  let triaged = 0;
  onProgress({ phase: "triage", done: 0, total: candidates.length });
  await pool(candidates, TRIAGE_POOL, async (item) => {
    try {
      const { verdict, reason } = await triageConversation(
        item.transcript ?? [],
        item.contactName,
        item.opportunityName,
      );
      item.category = verdict === "needs_response" ? "needs-response" : "resolved";
      item.aiReason = reason;
    } catch (err) {
      item.category = "error";
      item.note = `AI triage failed: ${err instanceof Error ? err.message : String(err)}`;
      log.warn("triage failed", {
        opportunityId: item.opportunityId,
        message: item.note,
      });
    } finally {
      triaged++;
      onProgress({ phase: "triage", done: triaged, total: candidates.length });
    }
  });

  // Owner rollup.
  const ownerMap = new Map<string, OwnerStat>();
  for (const item of items) {
    const key = item.ownerId ?? "(unassigned)";
    let stat = ownerMap.get(key);
    if (!stat) {
      stat = {
        ownerId: item.ownerId,
        ownerName: item.ownerName,
        total: 0,
        needsResponse: 0,
        resolved: 0,
        responded: 0,
        waitingRecent: 0,
        noConversation: 0,
        errors: 0,
        pendingRatio: 0,
      };
      ownerMap.set(key, stat);
    }
    stat.total++;
    if (item.category === "needs-response") stat.needsResponse++;
    else if (item.category === "resolved") stat.resolved++;
    else if (item.category === "responded") stat.responded++;
    else if (item.category === "waiting-recent") stat.waitingRecent++;
    else if (item.category === "no-conversation") stat.noConversation++;
    else stat.errors++;
  }
  const owners = [...ownerMap.values()]
    .map((s) => ({ ...s, pendingRatio: s.total ? s.needsResponse / s.total : 0 }))
    .sort(
      (a, b) => b.needsResponse - a.needsResponse || b.total - a.total,
    );

  const categoryRank: Record<ReviewCategory, number> = {
    "needs-response": 0,
    error: 1,
    "waiting-recent": 2,
    "no-conversation": 3,
    resolved: 4,
    responded: 5,
  };
  items.sort(
    (a, b) =>
      categoryRank[a.category] - categoryRank[b.category] ||
      (b.businessDaysWaiting ?? 0) - (a.businessDaysWaiting ?? 0),
  );

  const count = (c: ReviewCategory) =>
    items.filter((i) => i.category === c).length;
  return {
    generatedAt: now.toISOString(),
    pipelineId: pipeline.id,
    pipelineName: pipeline.name,
    totals: {
      opportunities: items.length,
      needsResponse: count("needs-response"),
      resolved: count("resolved"),
      responded: count("responded"),
      waitingRecent: count("waiting-recent"),
      noConversation: count("no-conversation"),
      errors: count("error"),
    },
    owners,
    items,
  };
}
