import type { EngineEnvelope, EngineEvent } from "@slopbot/contracts";
import { engineEvents } from "../../engine/event-log.js";
import type { EngineEventLog } from "../../engine/api.js";
import { applyOut, json, type WebContext } from "./env.js";
import { conversationRoutes, type TranscriptRoutes } from "./routes/conversations.js";
import { logError } from "../../errors.js";
import type { Json, Message, ModelEvent } from "../../domain.js";
import type { ChannelAccess, ChannelAccessResult } from "../../channel-access.js";
import { parseToolCalls, toolResult, type ToolCall, type ToolOutput } from "../../tools.js";
import type { HistoryPage, HistoryQuery } from "../../search/history-search.js";
import type { FuzzyHit, FuzzyQuery } from "../../search/fuzzy.js";
import { LIVE_INPUT_TOOLS, reasoningText, shortArgs, showsProfile, slopbotId, transcriptMessage, type ChatCard, type TranscriptMessage } from "../../run-events.js";
import { uiKey, type UiState } from "../../ui/runtime.js";
import type { RecordStore } from "../../records.js";
import type { MemberDirectory } from "../../member-directory.js";
import { transcriptSwitchOn } from "../../server-tools.js";
import { canCreateShare, type ShareRule } from "../../shares.js";
import { isPrivateChannel } from "../../private-chat.js";
import { conversationSummary, groupConversations, type ChannelReply, type ChannelRun, type ConversationGroup, type RunSource } from "../../conversation-groups.js";

export interface TranscriptRun { id: string; message: Message; purpose: string; status: string; result: string | null; context?: Json }
export interface ToolTurn { calls: ToolCall[]; results: Record<string, ToolOutput>; diagnosticArgs?: Json[] | null }

/** Everything the web transcript routes read. Both SQLite and PostgreSQL stores implement it. */
export interface TranscriptStore extends Pick<RecordStore, "record"> {
  setting(server: string, key: string): unknown;
  taskThreads(server: string): { thread: string; parent: string }[];
  canonicalMessage(server: string, id: string): Message | undefined | Promise<Message | undefined>;
  conversationActivity(server: string): Promise<{ channel: string; newest: number }[]>;
  conversationMessages(server: string, channel: string, before: { time: number; id: string } | undefined, limit: number): Promise<Message[]>;
  replyRunIds(server: string, messageId: string): Promise<string[]>;
  /** Which of these messages of one channel a reply run used. Participation runs do not count. */
  usedSourceIds(server: string, channel: string, messageIds: readonly string[]): Promise<string[]>;
  requestRunIds(server: string, requestId: string): Promise<string[]>;
  /** The reply runs of one channel, with their trigger messages, oldest first. Input of the conversation list. */
  channelRuns(server: string, channel: string): Promise<ChannelRun[]>;
  /** The Slopbot reply messages of one channel, with the reply runs that wrote them. */
  channelReplies(server: string, channel: string): Promise<ChannelReply[]>;
  /** Source links of the reply runs of one channel. Only messages that still exist in the channel are listed. */
  channelSources(server: string, channel: string): Promise<RunSource[]>;
  /** Stored messages of one channel by ID, in time order. */
  messagesById(server: string, channel: string, ids: readonly string[]): Promise<Message[]>;
  runRecord(runId: string): Promise<TranscriptRun | undefined>;
  events(runId: string): ModelEvent[] | Promise<ModelEvent[]>;
  toolTurns(server: string, messageId: string): Promise<ToolTurn[]>;
  searchHistory(query: HistoryQuery): Promise<HistoryPage>;
  /** Fuzzy match of one channel: words in any order, partial words and typos. See search/fuzzy.ts. */
  searchFuzzy(query: FuzzyQuery): Promise<FuzzyHit[]>;
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
  /** The engine event log the events routes read. Defaults to the process-wide log. */
  events?: EngineEventLog;
}

export type { TranscriptRoutes };

/** One step of a saved run, in the order it happened. Costs and raw provider usage are never included. */
export type RunStep =
  | { type: "text"; text: string }
  | { type: "thinking"; text: string }
  | ToolStep;
/** A tool call. A run_tools_code call has its program code and the calls it made (children, each with parentId). */
export interface ToolStep { type: "tool"; name: string; status: string; args: string; result?: string; code?: string; /** Full arguments, for tools the web view draws (LIVE_INPUT_TOOLS). */ input?: Json; parentId?: string; children?: ToolStep[] }

/** enabled is false for a channel whose web transcripts are off. Only channels are listed that way, never threads. */
export interface Conversation { id: string; name: string; kind: "channel" | "thread"; parent: string | null; newest: number | null; canSend: boolean; enabled: boolean }

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
    const step: ToolStep = { type: "tool", name: call.name, status: "pending", args: shortArgs(call.arguments) };
    // The web view draws these from their full input, so it is kept.
    if (LIVE_INPUT_TOOLS.has(call.name)) step.input = call.arguments;
    if (output !== undefined) {
      const result = toolResult(output);
      step.status = result.status === "failed" || result.status === "rejected" ? result.status : result.handoff ? "delegated" : "completed";
      // Usage results can show spend, so only the status is kept for them.
      if (call.name !== "usage") step.result = result.text.slice(0, MAX_RESULT_CHARS);
      if (call.name === "run_tools_code") {
        if (typeof call.arguments.code === "string") step.code = call.arguments.code;
        step.children = childSteps(result.data, call.id);
      }
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

/** The calls a run_tools_code program made, from its saved result. Each child names its parent. */
function childSteps(data: Json | undefined, parentId: string | undefined): ToolStep[] {
  const calls = (data && typeof data === "object" && !Array.isArray(data) ? (data as { childCalls?: unknown }).childCalls : undefined);
  if (!Array.isArray(calls)) return [];
  return calls.flatMap(item => {
    if (!item || typeof item !== "object") return [];
    const child = item as { name?: unknown; status?: unknown };
    if (typeof child.name !== "string") return [];
    return [{ type: "tool" as const, name: child.name, status: typeof child.status === "string" ? child.status : "completed", args: "", ...(parentId ? { parentId } : {}) }];
  });
}

function callsOf(payload: Json): ToolCall[] {
  try { return parseToolCalls(JSON.stringify({ tool_calls: payload })) ?? []; } catch { return []; }
}

/**
 * Engine events for a turn saved before the engine log existed, made from its saved runs. A tool step with no saved
 * result counts as completed. A run_tools_code step's children name it as their parent.
 */
export function legacyTurnEvents(turn: string, runs: readonly { id: string; steps: readonly RunStep[]; failed?: boolean }[]): EngineEvent[] {
  const events: EngineEvent[] = [{ type: "turn.start", turn }];
  for (const { id: run, steps } of runs) {
    events.push({ type: "round.start", turn, run });
    const tool = (step: ToolStep, call: string, parent?: string) => {
      const status = (["running", "completed", "rejected", "failed", "delegated"] as const).find(item => item === step.status) ?? "completed";
      const failed = status === "failed" || status === "rejected";
      const input = step.input ?? (step.args ? parseJson(step.args) : undefined);
      events.push({
        type: "tool.status", turn, call, name: step.name, status,
        ...(input !== undefined ? { input } : {}),
        ...(step.result !== undefined ? (failed ? { reason: step.result } : { result: step.result }) : {}),
        ...(step.code !== undefined ? { code: step.code } : {}),
        ...(parent !== undefined ? { parent } : {}),
      });
    };
    steps.forEach((step, index) => {
      if (step.type === "text") events.push({ type: "text.delta", turn, run, text: step.text });
      else if (step.type === "thinking") events.push({ type: "thinking.delta", turn, run, text: step.text });
      else {
        const call = `${run}:${index}`;
        tool(step, call);
        step.children?.forEach((child, i) => tool(child, `${call}:${i}`, call));
      }
    });
  }
  events.push({ type: "turn.end", turn, status: runs.some(run => run.failed) ? "failed" : "done" });
  return events;
}

/** Tool arguments are cut after 300 characters in a saved step, so a cut text gives no input. */
function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/**
 * The events of one turn: the saved log rows, or for an older turn with none, events made from its saved runs.
 * Returns undefined for a turn that has neither, or whose runs belong to another conversation.
 */
export async function turnEventsOf(store: TranscriptStore, events: Pick<EngineEventLog, "turn">, server: string, channel: string, turn: string): Promise<EngineEvent[] | undefined> {
  const saved = await events.turn({ server, channel }, turn);
  if (saved.length) return saved;
  const runs: { id: string; steps: RunStep[]; failed: boolean }[] = [];
  const turns = await store.toolTurns(server, turn);
  for (const id of await store.requestRunIds(server, turn)) {
    const record = await store.runRecord(id);
    if (!record || record.message.channel !== channel) continue;
    runs.push({ id, steps: runSteps(await store.events(id), turns, record.status === "tool_calls" ? textCalls(record.result) : []), failed: record.status === "failed" });
  }
  return runs.length ? legacyTurnEvents(turn, runs) : undefined;
}

export function textCalls(text: string | null): ToolCall[] {
  if (!text) return [];
  try { return parseToolCalls(text) ?? []; } catch { return []; }
}

export interface EngineStreamOptions {
  server: string;
  channel: string;
  user: string;
  /** Saved events after this seq are sent first. Without it the stream starts at the newest event. */
  cursor: number | undefined;
  events: Pick<EngineEventLog, "after" | "subscribe">;
  access: ChannelAccess;
  /** True while the switch is on and the user can view the channel. */
  allowed(): Promise<boolean>;
  write(text: string): void;
  end(): void;
  heartbeatMs?: number;
  recheckMs?: number;
}

/**
 * Sends the engine events of one conversation as SSE text: `event: engine`, `id` = seq, data = the envelope. A live
 * event that arrives during the backlog read is kept and sent after it. Events with no seq are not saved and are not sent.
 * Deltas saved as one row share its seq, so a live delta is dropped only when the backlog already held its row.
 */
export function openEngineStream(options: EngineStreamOptions): () => void {
  const { server, channel, user, events, access } = options;
  let backlogEnd = options.cursor ?? 0, live = options.cursor === undefined, closed = false;
  const buffer: EngineEnvelope[] = [];
  const timers: ReturnType<typeof setInterval>[] = [];
  const offs: (() => void)[] = [];
  const send = (envelope: EngineEnvelope) => {
    if (closed || envelope.seq === undefined) return;
    options.write(`id: ${envelope.seq}\nevent: engine\ndata: ${JSON.stringify(envelope)}\n\n`);
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
  offs.push(events.subscribe({ server, channel }, envelope => {
    if (envelope.seq === undefined) return;
    if (live) send(envelope); else buffer.push(envelope);
  }));
  offs.push(access.onClear(change => { if (matchesClear(change)) void recheck(); }));
  const heartbeat = setInterval(() => { if (!closed) options.write(": ping\n\n"); }, options.heartbeatMs ?? 15000);
  const recheckTimer = setInterval(() => void recheck(), options.recheckMs ?? 30000);
  heartbeat.unref(); recheckTimer.unref();
  timers.push(heartbeat, recheckTimer);
  if (!live) void (async () => {
    try {
      for (;;) {
        const rows = await events.after({ server, channel }, backlogEnd, BACKLOG_PAGE);
        if (closed) return;
        for (const row of rows) { send(row); backlogEnd = row.seq ?? backlogEnd; }
        if (rows.length < BACKLOG_PAGE) break;
      }
      for (const envelope of buffer.splice(0)) if ((envelope.seq ?? 0) > backlogEnd) send(envelope);
      live = true;
    } catch (error) {
      logError("web_stream_failed", error, { server, channel });
      stop("error");
    }
  })();
  return () => stop();
}

/** The stream position of a request: Last-Event-ID on a reconnect, else ?after=. Undefined when it has neither. */
export function streamCursor(lastEventId: string | undefined, after: string | null): number | undefined {
  const raw = lastEventId ?? after;
  if (raw === undefined || raw === null || raw === "") return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) && value >= 0 ? value : 0;
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
  return Promise.all(messages.map(async message => {
    const runIds = message.author === slopbot ? await store.replyRunIds(server, message.id) : [];
    const turn = await turnOfRuns(store, runIds);
    return { ...transcriptMessage(message, slopbot, runIds, profiles.get(message.author), used.has(message.id), await cardOf(store, server, message)), ...(turn ? { turn } : {}) };
  }));
}

/** The turn of a saved reply: the request message of its reply run, which the engine events name as the turn. Replies from before the engine log have it from the run record too. */
async function turnOfRuns(store: Pick<TranscriptStore, "runRecord">, runIds: readonly string[]): Promise<string | undefined> {
  for (const id of runIds) {
    const record = await store.runRecord(id);
    if (record?.purpose === "reply") return record.message.id;
  }
  return undefined;
}

/** The card saved with a private chat reply, under the reply's message ID. Read at view time, so a button's result shows after a reload. */
async function cardOf(store: Pick<TranscriptStore, "record">, server: string, message: Message): Promise<ChatCard | undefined> {
  if (!isPrivateChannel(message.channel)) return undefined;
  const id = uiKey(message.id);
  const record = await store.record(server, "ui", id);
  return record ? { id, revision: record.revision, document: (record.value as unknown as UiState).document } : undefined;
}

export function createTranscripts(host: TranscriptHost): TranscriptRoutes {
  const { store } = host;
  const parseLimit = (raw: string | null, fallback: number, max: number): number | undefined => {
    if (raw === null || raw === "") return fallback;
    const value = Number(raw);
    return Number.isSafeInteger(value) && value >= 1 && value <= max ? value : undefined;
  };
  const views = (server: string, messages: readonly Message[]) => messageViews(store, host.members, server, messages);
  const parentOf = async (server: string, channel: string): Promise<string | null> =>
    store.taskThreads(server).find(task => task.thread === channel)?.parent ?? null;

  async function messages(url: URL, server: string, channel: string, user: string): Promise<Response> {
    const access = await granted(host, server, channel, user);
    if (!access) return json(403, { error: "You cannot view this conversation." });
    // Read the engine seq before the page, so /events?after=<streamId> misses and repeats no event.
    const streamId = await (host.events ?? engineEvents).latest({ server, channel });
    const limit = parseLimit(url.searchParams.get("limit"), 50, 100);
    if (limit === undefined) return json(400, { error: "Invalid limit." });
    const beforeId = url.searchParams.get("before");
    let before: { time: number; id: string } | undefined;
    if (beforeId !== null) {
      if (!ID.test(beforeId)) return json(400, { error: "Invalid cursor." });
      const found = await store.canonicalMessage(server, beforeId);
      if (!found || found.channel !== channel) return json(400, { error: "That message is no longer stored. Reload the conversation." });
      before = { time: found.timestamp ?? 0, id: found.id };
    }
    const rows = await store.conversationMessages(server, channel, before, limit + 1);
    return json(200, {
      ...(await header(server, channel, access, user)),
      streamId,
      hasMore: rows.length > limit,
      messages: await views(server, rows.slice(0, limit).reverse()),
    });
  }

  // The channel name, parent and the send and share flags. The messages and conversation routes both send it.
  async function header(server: string, channel: string, access: ChannelAccessResult, user: string) {
    return {
      channel: { id: channel, name: (await host.channelName(server, channel)) ?? channel, parent: await parentOf(server, channel) },
      canSend: access.send,
      canShare: host.shareRule ? await canCreateShare(user, server, host.shareRule).catch(() => false) : false,
    };
  }

  // The conversations of one channel, newest first. See conversation-groups.ts for the grouping rules.
  async function conversationsOf(server: string, channel: string): Promise<ConversationGroup[]> {
    const [runs, replies, sources] = await Promise.all([store.channelRuns(server, channel), store.channelReplies(server, channel), store.channelSources(server, channel)]);
    return groupConversations(runs, replies, sources);
  }

  async function conversationList(url: URL, server: string, channel: string, user: string): Promise<Response> {
    if (!(await granted(host, server, channel, user))) return json(403, { error: "You cannot view this conversation." });
    const limit = parseLimit(url.searchParams.get("limit"), 20, 50);
    if (limit === undefined) return json(400, { error: "Invalid limit." });
    const rawOffset = url.searchParams.get("offset") ?? "";
    const offset = rawOffset === "" ? 0 : Number(rawOffset);
    if (!Number.isSafeInteger(offset) || offset < 0) return json(400, { error: "Invalid offset." });
    const groups = await conversationsOf(server, channel);
    return json(200, { conversations: groups.slice(offset, offset + limit).map(conversationSummary), hasMore: groups.length > offset + limit });
  }

  // All messages of the conversation that holds this run: the triggers, the sources they used and Slopbot's replies, in time order.
  async function conversation(server: string, channel: string, runId: string, user: string): Promise<Response> {
    if (!RUN_ID.test(runId)) return json(400, { error: "Invalid run." });
    const access = await granted(host, server, channel, user);
    if (!access) return json(403, { error: "You cannot view this conversation." });
    const group = (await conversationsOf(server, channel)).find(item => item.runIds.includes(runId));
    if (!group) return json(404, { error: "Conversation not found." });
    const rows = await store.messagesById(server, channel, group.messageIds);
    return json(200, {
      ...(await header(server, channel, access, user)),
      streamId: await (host.events ?? engineEvents).latest({ server, channel }),
      conversation: { ...conversationSummary(group), runIds: group.runIds },
      hasMore: false,
      messages: await views(server, rows),
    });
  }

  // Which of the given messages a reply run used. The same access check as the messages route.
  async function used(url: URL, server: string, channel: string, user: string): Promise<Response> {
    if (!(await granted(host, server, channel, user))) return json(403, { error: "You cannot view this conversation." });
    const ids = (url.searchParams.get("ids") ?? "").split(",").filter(id => id !== "");
    if (ids.length > 200 || ids.some(id => !ID.test(id))) return json(400, { error: "Invalid message IDs." });
    return json(200, { used: ids.length ? await store.usedSourceIds(server, channel, ids) : [] });
  }

  async function search(url: URL, server: string, user: string): Promise<Response> {
    const query = (url.searchParams.get("q") ?? "").trim();
    if (query.length < 2 || query.length > 200) return json(400, { error: "Search needs 2 to 200 characters." });
    // Search reads messages, so it covers only channels whose switch is on. The access check is in visibleConversations.
    const visible = (await visibleConversations(host, server, user)).filter(item => item.enabled).slice(0, 40);
    const found: FuzzyHit[] = [];
    for (const conversation of visible) found.push(...await store.searchFuzzy({ server, channel: conversation.id, query, limit: 50 }));
    found.sort((a, b) => b.score - a.score || (b.message.timestamp ?? 0) - (a.message.timestamp ?? 0));
    return json(200, {
      query,
      channels: visible.map(item => ({ id: item.id, name: item.name })),
      messages: await views(server, found.slice(0, 50).map(hit => hit.message)),
    });
  }

  async function engineStream(c: WebContext, server: string, channel: string, user: string): Promise<Response | undefined> {
    if (!(await granted(host, server, channel, user))) return json(403, { error: "You cannot view this conversation." });
    const { incoming: req, outgoing: res } = c.env;
    const header = req.headers["last-event-id"];
    const cursor = streamCursor(Array.isArray(header) ? header[0] : header, new URL(c.req.url).searchParams.get("after"));
    applyOut(c);
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 3000\n\n");
    const stop = openEngineStream({
      server, channel, user, cursor, events: host.events ?? engineEvents, access: host.access,
      allowed: async () => (await granted(host, server, channel, user)) !== undefined,
      write: text => { res.write(text); },
      end: () => { res.end(); },
    });
    res.on("close", () => stop());
  }

  async function turnEvents(server: string, channel: string, turn: string, user: string): Promise<Response> {
    if (!RUN_ID.test(turn)) return json(400, { error: "Invalid turn." });
    if (!(await granted(host, server, channel, user))) return json(403, { error: "You cannot view this conversation." });
    const events = await turnEventsOf(store, host.events ?? engineEvents, server, channel, turn);
    return events ? json(200, { events }) : json(404, { error: "Turn not found." });
  }

  return conversationRoutes({
    events: engineStream, turnEvents,
    list: async (server, user) => json(200, { conversations: await visibleConversations(host, server, user) }),
    search, messages, used, runs: conversationList, conversation,
  });
}
