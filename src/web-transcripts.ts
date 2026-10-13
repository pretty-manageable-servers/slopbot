import type { IncomingMessage, ServerResponse } from "node:http";
import { logError } from "./errors.js";
import type { Json, Message, ModelEvent } from "./domain.js";
import type { ChannelAccess, ChannelAccessResult } from "./channel-access.js";
import { parseToolCalls, toolResult, type ToolCall, type ToolOutput } from "./tools.js";
import type { HistoryPage, HistoryQuery } from "./search/history-search.js";
import { reasoningText, runEvents, shortArgs, showsProfile, slopbotId, transcriptMessage, type ConversationEvent, type ConversationEventStore, type RunEvents, type TranscriptMessage } from "./run-events.js";
import type { MemberDirectory } from "./member-directory.js";
import { transcriptSwitchOn } from "./server-tools.js";
import { canCreateShare, type ShareRule } from "./shares.js";
import { isPrivateChannel } from "./private-chat.js";

export interface TranscriptRun { id: string; message: Message; purpose: string; status: string; result: string | null }
export interface ToolTurn { calls: ToolCall[]; results: Record<string, ToolOutput> }

/** Everything the web transcript routes read. Both SQLite and PostgreSQL stores implement it. */
export interface TranscriptStore extends ConversationEventStore {
  canonicalMessage(server: string, id: string): Message | undefined | Promise<Message | undefined>;
  conversationActivity(server: string): Promise<{ channel: string; newest: number }[]>;
  conversationMessages(server: string, channel: string, before: { time: number; id: string } | undefined, limit: number): Promise<Message[]>;
  latestStreamId(server: string, channel: string): Promise<number>;
  replyRunIds(server: string, messageId: string): Promise<string[]>;
  /** Which of these messages of one channel a reply run used. Participation runs do not count. */
  usedSourceIds(server: string, channel: string, messageIds: readonly string[]): Promise<string[]>;
  requestRunIds(server: string, requestId: string): Promise<string[]>;
  runRecord(runId: string): Promise<TranscriptRun | undefined>;
  events(runId: string): ModelEvent[] | Promise<ModelEvent[]>;
  toolTurns(server: string, messageId: string): Promise<ToolTurn[]>;
  searchHistory(query: HistoryQuery): Promise<HistoryPage>;
}

export interface TranscriptHost {
  store: TranscriptStore;
  access: ChannelAccess;
  /** Text channels that Slopbot serves in the server. */
  configured(server: string): readonly string[];
  channelName(server: string, channel: string): Promise<string | undefined>;
  /** Who may share the channel. Without it, canShare is always false. */
  shareRule?: ShareRule;
  /** Names and avatars of human authors. Without it, messages have no username or avatarUrl. */
  members?: Pick<MemberDirectory, "profiles">;
  /** True when the user owns this private chat and is in its server. A private chat has no Discord channel, so only its run view uses this. */
  ownsPrivateChat?(server: string, channel: string, user: string): Promise<boolean>;
}

export interface TranscriptRoutes {
  handles(path: string): boolean;
  handle(req: IncomingMessage, res: ServerResponse, url: URL, user: string | undefined): Promise<void>;
}

/** One step of a saved run, in the order it happened. Costs and raw provider usage are never included. */
export type RunStep =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | { type: "tool"; name: string; status: string; args: string; result?: string };

/** enabled is false for a channel whose web transcripts are off. Only channels are listed that way, never threads. */
export interface Conversation { id: string; name: string; kind: "channel" | "thread"; parent: string | null; newest: number | null; canSend: boolean; enabled: boolean }

const SNOWFLAKE = /^\d{17,20}$/;
const ID = /^[\w:.-]{1,64}$/;
const RUN_ID = /^[\w:.-]{1,200}$/;
const MAX_RESULT_CHARS = 500;
const BACKLOG_PAGE = 200;

/**
 * Lists the channels Slopbot serves that the user can view now, newest first. A channel with its switch off is listed
 * with enabled false. A thread is listed only when its switch is on. Reads check the switch again (see granted).
 */
export async function visibleConversations(host: TranscriptHost, server: string, user: string): Promise<Conversation[]> {
  const { store } = host;
  const newest = new Map((await store.conversationActivity(server)).map(item => [item.channel, item.newest]));
  const candidates: { id: string; kind: "channel" | "thread"; parent: string | null }[] = [
    ...host.configured(server).map(id => ({ id, kind: "channel" as const, parent: null })),
    ...store.taskThreads(server).map(task => ({ id: task.thread, kind: "thread" as const, parent: task.parent })),
  ];
  const seen = new Set<string>();
  const found: Conversation[] = [];
  for (const candidate of candidates) {
    // Private chats are never listed here. They have their own list (web-chats.ts).
    if (isPrivateChannel(candidate.id) || seen.has(candidate.id)) continue;
    seen.add(candidate.id);
    const enabled = transcriptSwitchOn(store, server, candidate.id);
    if (!enabled && candidate.kind === "thread") continue;
    const access = await host.access.check(server, candidate.id, user);
    if (!access.view) continue;
    found.push({ ...candidate, name: (await host.channelName(server, candidate.id)) ?? candidate.id, newest: newest.get(candidate.id) ?? null, canSend: enabled && access.send, enabled });
  }
  return found.sort((a, b) => (b.newest ?? 0) - (a.newest ?? 0) || a.name.localeCompare(b.name));
}

/** The one gate for every transcript read: the switch (a thread uses its parent) and live View Channel. */
async function granted(host: TranscriptHost, server: string, channel: string, user: string): Promise<ChannelAccessResult | undefined> {
  if (!transcriptSwitchOn(host.store, server, channel)) return undefined;
  const access = await host.access.check(server, channel, user);
  return access.view ? access : undefined;
}

/** Turns a saved run into ordered steps. Tool results come from the agent turns with the same calls. */
export function runSteps(events: readonly ModelEvent[], turns: readonly ToolTurn[], fallbackCalls: readonly ToolCall[] = []): RunStep[] {
  const steps: RunStep[] = [];
  const pool = turns.map(turn => ({ ...turn, used: new Set<number>() }));
  const addText = (type: "text" | "thinking", text: string) => {
    const last = steps.at(-1);
    if (last && last.type === type) last.text += text;
    else steps.push({ type, text });
  };
  const addTool = (call: ToolCall) => {
    let output: ToolOutput | undefined;
    search: for (const turn of pool) {
      for (let index = 0; index < turn.calls.length; index++) {
        if (turn.used.has(index)) continue;
        const candidate = turn.calls[index]!;
        if (candidate.name === call.name && JSON.stringify(candidate.arguments) === JSON.stringify(call.arguments)) {
          turn.used.add(index);
          output = turn.results[String(index)];
          break search;
        }
      }
    }
    const step: RunStep = { type: "tool", name: call.name, status: "pending", args: shortArgs(call.arguments) };
    if (output !== undefined) {
      const result = toolResult(output);
      step.status = result.status === "failed" || result.status === "rejected" ? result.status : result.handoff ? "delegated" : "completed";
      // Usage results can show spend, so only the status is kept for them.
      if (call.name !== "usage") step.result = result.text.slice(0, MAX_RESULT_CHARS);
    }
    steps.push(step);
  };
  let toolCount = 0;
  for (const event of events) {
    if (event.kind === "text") addText("text", event.payload.text);
    else if (event.kind === "reasoning") { const text = reasoningText(event.payload); if (text) addText("thinking", text); }
    else if (event.kind === "tool_call") for (const call of callsOf(event.payload)) { addTool(call); toolCount++; }
  }
  if (!toolCount && fallbackCalls.length) {
    // A text-protocol round writes its tool request as text. That text is the request, not an answer.
    for (let index = steps.length - 1; index >= 0; index--) if (steps[index]!.type === "text") steps.splice(index, 1);
    for (const call of fallbackCalls) addTool(call);
  }
  return steps;
}

function callsOf(payload: Json): ToolCall[] {
  try { return parseToolCalls(JSON.stringify({ tool_calls: payload })) ?? []; } catch { return []; }
}

export function textCalls(text: string | null): ToolCall[] {
  if (!text) return [];
  try { return parseToolCalls(text) ?? []; } catch { return []; }
}

export interface StreamOptions {
  server: string;
  channel: string;
  user: string;
  /** The last stream ID the client has. Events after it are sent first. */
  cursor: number;
  store: Pick<TranscriptStore, "conversationEventsAfter" | "oldestStreamId" | "latestStreamId">;
  bus: RunEvents;
  access: ChannelAccess;
  /** True while the switch is on and the user can view the channel. */
  allowed(): Promise<boolean>;
  write(text: string): void;
  end(): void;
  heartbeatMs?: number;
  recheckMs?: number;
}

/**
 * True when the cursor is older than the oldest kept row of the channel, so some events were
 * pruned. A channel with no rows left counts as pruned too, because a cursor only exists for a saved row.
 */
async function pruned(store: Pick<TranscriptStore, "oldestStreamId">, server: string, channel: string, cursor: number): Promise<boolean> {
  const oldest = await store.oldestStreamId(server, channel);
  return oldest === undefined || cursor < oldest;
}

/**
 * Sends events of one channel as SSE text. It saves nothing itself. A live event that arrives
 * during the backlog read is kept and sent after it, so no event is lost or sent twice.
 * Returns stop(), which the caller uses when the client disconnects.
 */
export function openStream(options: StreamOptions): () => void {
  const { server, channel, user, store, bus, access } = options;
  let lastSent = options.cursor, live = false, closed = false;
  const buffer: ConversationEvent[] = [];
  const timers: ReturnType<typeof setInterval>[] = [];
  const offs: (() => void)[] = [];
  const send = (event: ConversationEvent) => {
    if (closed || event.streamId <= lastSent) return;
    lastSent = event.streamId;
    options.write(`id: ${event.streamId}\nevent: ${event.kind}\ndata: ${JSON.stringify({ ref: event.ref, ...(event.data as Record<string, Json>) })}\n\n`);
  };
  const stop = (reason?: string) => {
    if (closed) return;
    closed = true;
    for (const timer of timers) clearInterval(timer);
    for (const off of offs) off();
    if (reason) options.write(`event: closed\ndata: ${JSON.stringify({ reason })}\n\n`);
    options.end();
  };
  const recheck = async () => {
    if (closed) return;
    try { if (!(await options.allowed())) stop("access"); }
    catch (error) { logError("web_stream_check_failed", error, { server, channel }); stop("error"); }
  };
  const matchesClear = (change: { server?: string; channel?: string; user?: string }) =>
    (change.server === undefined || change.server === server) && (change.user === undefined || change.user === user) && (change.channel === undefined || change.channel === channel);
  offs.push(bus.subscribe(server, channel, event => { if (live) send(event); else buffer.push(event); }));
  offs.push(bus.onChange(server, () => void recheck()));
  offs.push(access.onClear(change => { if (matchesClear(change)) void recheck(); }));
  const heartbeat = setInterval(() => { if (!closed) options.write(": ping\n\n"); }, options.heartbeatMs ?? 15000);
  const recheckTimer = setInterval(() => void recheck(), options.recheckMs ?? 30000);
  heartbeat.unref(); recheckTimer.unref();
  timers.push(heartbeat, recheckTimer);
  void (async () => {
    try {
      let after = lastSent;
      // A pruned cursor cannot be resumed. The client reloads its messages, and the stream goes on live from the newest row.
      if (lastSent > 0 && await pruned(store, server, channel, lastSent)) {
        const latest = await store.latestStreamId(server, channel);
        if (closed) return;
        lastSent = Math.max(lastSent, latest);
        after = lastSent;
        options.write(`event: reset\ndata: ${JSON.stringify({ reason: "pruned" })}\n\n`);
      }
      for (;;) {
        const rows = await store.conversationEventsAfter(server, channel, after, BACKLOG_PAGE);
        if (closed) return;
        for (const row of rows) { send(row); after = row.streamId; }
        if (rows.length < BACKLOG_PAGE) break;
      }
      for (const event of buffer.splice(0)) send(event);
      live = true;
    } catch (error) {
      logError("web_stream_failed", error, { server, channel });
      stop("error");
    }
  })();
  return () => stop();
}

export async function messageViews(store: TranscriptStore, members: Pick<MemberDirectory, "profiles"> | undefined, server: string, messages: readonly Message[]): Promise<TranscriptMessage[]> {
  const slopbot = slopbotId(store, server);
  // One directory call per page. The directory caches each user for 10 minutes.
  const authors = [...new Set(messages.filter(message => showsProfile(message, slopbot)).map(message => message.author))];
  const profiles = members && authors.length ? await members.profiles(server, authors) : new Map();
  // One query for each channel on the page. Only messages that a reply run used are marked.
  const used = new Set<string>();
  const people = messages.filter(message => message.author !== slopbot);
  for (const channel of new Set(people.map(message => message.channel))) {
    for (const id of await store.usedSourceIds(server, channel, people.filter(message => message.channel === channel).map(message => message.id))) used.add(id);
  }
  return Promise.all(messages.map(async message => transcriptMessage(message, slopbot, message.author === slopbot ? await store.replyRunIds(server, message.id) : [], profiles.get(message.author), used.has(message.id))));
}

export function createTranscripts(host: TranscriptHost): TranscriptRoutes {
  const { store } = host;
  const json = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
  const parseLimit = (raw: string | null, fallback: number, max: number): number | undefined => {
    if (raw === null || raw === "") return fallback;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 1 && value <= max ? value : undefined;
  };
  const views = (server: string, messages: readonly Message[]) => messageViews(store, host.members, server, messages);
  const parentOf = async (server: string, channel: string): Promise<string | null> =>
    store.taskThreads(server).find(task => task.thread === channel)?.parent ?? null;

  async function messages(res: ServerResponse, url: URL, server: string, channel: string, user: string): Promise<void> {
    const access = await granted(host, server, channel, user);
    if (!access) return json(res, 403, { error: "You cannot view this conversation." });
    // Read the stream position before the page, so a live event after it is never skipped.
    const streamId = await store.latestStreamId(server, channel);
    const limit = parseLimit(url.searchParams.get("limit"), 50, 100);
    if (limit === undefined) return json(res, 400, { error: "Invalid limit." });
    const beforeId = url.searchParams.get("before");
    let before: { time: number; id: string } | undefined;
    if (beforeId !== null) {
      if (!ID.test(beforeId)) return json(res, 400, { error: "Invalid cursor." });
      const found = await store.canonicalMessage(server, beforeId);
      if (!found || found.channel !== channel) return json(res, 400, { error: "That message is no longer stored. Reload the conversation." });
      before = { time: found.timestamp ?? 0, id: found.id };
    }
    const rows = await store.conversationMessages(server, channel, before, limit + 1);
    json(res, 200, {
      channel: { id: channel, name: (await host.channelName(server, channel)) ?? channel, parent: await parentOf(server, channel) },
      canSend: access.send,
      canShare: host.shareRule ? await canCreateShare(user, server, host.shareRule).catch(() => false) : false,
      streamId,
      hasMore: rows.length > limit,
      messages: await views(server, rows.slice(0, limit).reverse()),
    });
  }

  async function runRoute(res: ServerResponse, runId: string, user: string): Promise<void> {
    if (!RUN_ID.test(runId)) return json(res, 400, { error: "Invalid run." });
    const record = await store.runRecord(runId);
    if (!record || record.purpose !== "reply") return json(res, 404, { error: "Run not found." });
    const { server, channel } = record.message;
    // A private chat has no Discord channel, so the owner check replaces the channel access check.
    const visible = isPrivateChannel(channel) ? await host.ownsPrivateChat?.(server, channel, user) === true : Boolean(await granted(host, server, channel, user));
    if (!visible) return json(res, 403, { error: "You cannot view this run." });
    const events = await store.events(runId);
    const turns = await store.toolTurns(server, record.message.id);
    const fallback = record.status === "tool_calls" ? textCalls(record.result) : [];
    json(res, 200, {
      runId, requestId: record.message.id, channel, status: record.status,
      ...(record.status === "failed" && record.result ? { error: record.result.slice(0, 500) } : {}),
      steps: runSteps(events, turns, fallback),
    });
  }

  // Which of the given messages a reply run used. The same access check as the messages route.
  async function used(res: ServerResponse, url: URL, server: string, channel: string, user: string): Promise<void> {
    if (!(await granted(host, server, channel, user))) return json(res, 403, { error: "You cannot view this conversation." });
    const ids = (url.searchParams.get("ids") ?? "").split(",").filter(id => id !== "");
    if (ids.length > 200 || ids.some(id => !ID.test(id))) return json(res, 400, { error: "Invalid message IDs." });
    json(res, 200, { used: ids.length ? await store.usedSourceIds(server, channel, ids) : [] });
  }

  async function search(res: ServerResponse, url: URL, server: string, user: string): Promise<void> {
    const query = (url.searchParams.get("q") ?? "").trim();
    if (query.length < 2 || query.length > 200) return json(res, 400, { error: "Search needs 2 to 200 characters." });
    const mode = url.searchParams.get("mode") ?? "keyword";
    if (!["keyword", "exact", "hybrid", "semantic"].includes(mode)) return json(res, 400, { error: "Invalid search mode." });
    // Search reads messages, so it covers only channels whose switch is on.
    const visible = (await visibleConversations(host, server, user)).filter(item => item.enabled).slice(0, 40);
    const found: Message[] = [];
    for (const conversation of visible) {
      const page = await store.searchHistory({ server, channel: conversation.id, query, mode: mode as HistoryQuery["mode"], limit: 10, requester: user });
      found.push(...page.messages);
    }
    found.sort((a, b) => (b.timestamp ?? 0) - (a.timestamp ?? 0));
    json(res, 200, {
      query,
      channels: visible.map(item => ({ id: item.id, name: item.name })),
      messages: await views(server, found.slice(0, 50)),
    });
  }

  async function stream(req: IncomingMessage, res: ServerResponse, url: URL, server: string, channel: string, user: string): Promise<void> {
    if (!(await granted(host, server, channel, user))) return json(res, 403, { error: "You cannot view this conversation." });
    // The browser sends Last-Event-ID on reconnect. A page load passes the stream position as ?after=.
    const raw = Number(req.headers["last-event-id"] ?? url.searchParams.get("after") ?? 0);
    const cursor = Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 3000\n\n");
    const stop = openStream({
      server, channel, user, cursor, store, bus: runEvents, access: host.access,
      allowed: async () => (await granted(host, server, channel, user)) !== undefined,
      write: text => { res.write(text); },
      end: () => { res.end(); },
    });
    res.on("close", () => stop());
  }

  return {
    handles: path => path === "/api/conversations" || path.startsWith("/api/conversations/") || path.startsWith("/api/runs/"),
    async handle(req, res, url, user) {
      try {
        if (!user) return json(res, 403, { error: "Sign in with Discord to continue." });
        const parts = url.pathname.split("/").slice(2);
        if (parts[0] === "runs") {
          if (parts.length !== 2) return json(res, 404, { error: "Not found." });
          return await runRoute(res, parts[1]!, user);
        }
        if (parts[0] !== "conversations") return json(res, 404, { error: "Not found." });
        const server = url.searchParams.get("server") ?? "";
        if (!SNOWFLAKE.test(server)) return json(res, 400, { error: "Invalid server." });
        if (parts.length === 1) return json(res, 200, { conversations: await visibleConversations(host, server, user) });
        if (parts.length === 2 && parts[1] === "search") return await search(res, url, server, user);
        const channel = parts[1] ?? "";
        if (!SNOWFLAKE.test(channel)) return json(res, 400, { error: "Invalid conversation." });
        if (parts.length === 3 && parts[2] === "messages") return await messages(res, url, server, channel, user);
        if (parts.length === 3 && parts[2] === "used") return await used(res, url, server, channel, user);
        if (parts.length === 3 && parts[2] === "stream") return await stream(req, res, url, server, channel, user);
        return json(res, 404, { error: "Not found." });
      } catch (error) {
        logError("web_transcript_failed", error, { stage: "web transcripts" });
        if (!res.headersSent) json(res, 502, { error: "Could not load this conversation." });
        else res.end();
      }
    },
  };
}
