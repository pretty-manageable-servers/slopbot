// Maps the bot's engine events (/api/chats/:id/events) to kit messages. Every turn is one TurnView, built by the
// shared reduceTurn from the live events or from the saved ones (/turns/:turn/events). The kit message is made from
// that view in one place (turnParts), so a reply looks the same live and loaded. A saved reply (message.upsert)
// replaces its turn's live message and keeps the turn's thinking and tool parts before its text.
import { reduceTurn, type EngineEnvelope, type EngineEvent, type TurnView } from "@slopbot/contracts";
import { parsePartialJson, type Message, type Part, type ToolCallPart } from "agentic-ui-kit/core";

/** One saved message as the bot sends it (the message of a message.upsert event). */
export type BotMessage = Extract<EngineEvent, { type: "message.upsert" }>["message"];

export interface ChatState {
  /** Saved messages, oldest first. */
  saved: Message[];
  /** The model runs of each saved reply, by message id. */
  replies: Record<string, string[]>;
  /** The turns whose events arrived live, by turn (the request message id). */
  live: Record<string, TurnView>;
  /** The live turns whose first event (turn.start) arrived. A turn the page joined later is incomplete and is loaded. */
  begun: Record<string, true>;
  /** The turns of earlier replies, loaded from their saved events. */
  loaded: Record<string, TurnView>;
  /** The turn of each model run. */
  runs: Record<string, string>;
  /** The newest event seq applied. Older ones are replays and are dropped. */
  seen: number;
}

export const emptyChat = (saved: Message[] = [], replies: Record<string, string[]> = {}, runs: Record<string, string> = {}): ChatState => ({ saved, replies, live: {}, begun: {}, loaded: {}, runs, seen: 0 });

/** The runs of each Slopbot reply in a page of messages. */
export const repliesOf = (messages: readonly Pick<BotMessage, "id" | "slopbot" | "runIds">[]): Record<string, string[]> =>
  Object.fromEntries(messages.filter((m) => m.slopbot && m.runIds.length).map((m) => [m.id, m.runIds]));

/** The turn of each run of the saved replies in a page of messages, when the server named it. */
export const runTurnsOf = (messages: readonly Pick<BotMessage, "slopbot" | "runIds" | "turn">[]): Record<string, string> =>
  Object.fromEntries(messages.flatMap((m) => (m.slopbot && m.turn ? m.runIds.map((run) => [run, m.turn!] as const) : [])));

const createdAt = (timestamp: number | null) => new Date(timestamp ?? Date.now()).toISOString();

/** A saved bot message as a kit message. Slopbot's messages are the assistant's; all others are the user's. */
export function toKitMessage(message: BotMessage, chatId: string): Message {
  const parts: Part[] = [];
  for (const image of message.images ?? []) {
    parts.push({ type: "attachment", id: `image:${image.imageId}`, status: "done", fileId: image.imageId, name: image.name, mime: image.contentType, size: image.size, url: `/api/chats/${encodeURIComponent(chatId)}/images/${encodeURIComponent(image.imageId)}` });
  }
  for (const file of (message.files ?? []) as { fileId: string; name: string; contentType: string; size: number }[]) {
    parts.push({ type: "attachment", id: `file:${file.fileId}`, status: "done", fileId: file.fileId, name: file.name, mime: file.contentType, size: file.size, url: `/api/chats/${encodeURIComponent(chatId)}/files/${encodeURIComponent(file.fileId)}` });
  }
  if (message.text) parts.push({ type: "text", id: `${message.id}:text`, text: message.text, status: "done" });
  return { id: message.id, parentId: null, role: message.slopbot ? "assistant" : "user", status: "done", parts, createdAt: createdAt(message.timestamp) };
}

const TOOL_PART_STATUS = { running: "running", completed: "done", delegated: "done", rejected: "error", failed: "error" } as const;

function parseJson(text: string): unknown {
  try { return JSON.parse(text); } catch { return undefined; }
}

/**
 * The kit parts of a turn: its thinking, tool calls and text, in order. A tool whose input still streams is an
 * "input" part with the text so far, so show_ui and show_widget draw while the model writes them. A child tool call
 * (run_tools_code) follows its parent. This is the one place a TurnView becomes kit parts.
 */
export function turnParts(view: TurnView): Part[] {
  const open = view.status === "streaming";
  const tools = view.parts.filter((p) => p.kind === "tool");
  const children = (call: string) => tools.filter((p) => p.parent === call);
  const known = new Set(tools.map((p) => p.call));
  const out: Part[] = [];
  const addTool = (part: (typeof tools)[number]) => {
    const id = `${view.turn}:tool:${part.call}`;
    const streaming = part.status === "streaming";
    const input = part.input ?? (streaming ? undefined : parseJson(part.inputText));
    const tool: ToolCallPart = streaming
      ? { type: "tool_call", id, name: part.name, status: open ? "input" : "error", inputJson: part.inputText, ...(open ? { partialInput: parsePartialJson(part.inputText) } : {}) }
      : { type: "tool_call", id, name: part.name, status: TOOL_PART_STATUS[part.status], inputJson: JSON.stringify(input ?? {}), input: input ?? {} };
    if (part.status === "failed" || part.status === "rejected") tool.error = part.reason ?? part.result ?? "";
    else if (part.result !== undefined) tool.result = part.result;
    out.push(tool);
    for (const child of children(part.call)) addTool(child);
  };
  view.parts.forEach((part, index) => {
    if (part.kind === "tool") {
      if (!part.parent || !known.has(part.parent)) addTool(part);
      return;
    }
    const last = index === view.parts.length - 1;
    out.push({ type: part.kind, id: `${view.turn}:${index}`, text: part.text, status: open && last ? "streaming" : "done" });
  });
  return out;
}

const VIEW_STATUS = { streaming: "streaming", done: "done", failed: "error", interrupted: "stopped" } as const;

/** The live reply of a turn: every part of the view. */
export function liveMessage(view: TurnView): Message {
  return { id: `live:${view.turn}`, parentId: view.turn, role: "assistant", status: VIEW_STATUS[view.status], parts: turnParts(view), createdAt: new Date().toISOString() };
}

/** A saved reply with the thinking and tool parts of its turn before its own parts. Its text is the reply, so the view's text is not added. */
export function withSteps(message: Message, view: TurnView | undefined): Message {
  const steps = view ? turnParts(view).filter((part) => part.type !== "text") : [];
  return steps.length ? { ...message, parts: [...steps, ...message.parts] } : message;
}

/** The view of the turn a saved reply came from, when its events are known. */
function viewOfReply(state: ChatState, id: string): TurnView | undefined {
  for (const run of state.replies[id] ?? []) {
    const turn = state.runs[run];
    const view = turn === undefined ? undefined : completeView(state, turn);
    if (view) return view;
  }
  return undefined;
}

/** The live view of a turn when the page saw it from its start, else the loaded one. */
const completeView = (state: ChatState, turn: string): TurnView | undefined => (state.begun[turn] ? state.live[turn] : undefined) ?? state.loaded[turn];

/** All messages to show: the saved ones with their steps, then the live replies whose reply is not saved yet. */
export function chatMessages(state: ChatState): Message[] {
  // A turn with a saved reply shows as that reply, even before its events are loaded.
  const claimed = new Set(state.saved.flatMap((message) => (state.replies[message.id] ?? []).flatMap((run) => state.runs[run] ?? [])));
  const saved = state.saved.map((message) => withSteps(message, viewOfReply(state, message.id)));
  const started = new Set(Object.values(state.runs));
  const live = Object.values(state.live).filter((view) => started.has(view.turn) && !claimed.has(view.turn) && (view.status === "streaming" || view.parts.length > 0));
  return [...saved, ...live.map(liveMessage)];
}

/** Applies one engine event. Returns the same state when the event changes nothing. */
export function applyEngineEvent(state: ChatState, envelope: EngineEnvelope, chatId: string): ChatState {
  // The rows of one run of deltas share a seq, so only an older seq is a replay.
  if (envelope.seq !== undefined && envelope.seq < state.seen) return state;
  const seen = Math.max(state.seen, envelope.seq ?? 0);
  const event = envelope.event;
  if (event.type === "message.delete") return { ...state, seen, saved: state.saved.filter((message) => message.id !== event.id) };
  if (event.type === "message.upsert") {
    const kit = toKitMessage(event.message, chatId);
    const index = state.saved.findIndex((item) => item.id === kit.id);
    const saved = index < 0 ? [...state.saved, kit] : state.saved.with(index, kit);
    const replies = event.message.slopbot && event.message.runIds.length ? { ...state.replies, [kit.id]: event.message.runIds } : state.replies;
    // A turn the page joined mid-way was loaded part way, so the finished reply loads it again.
    const stale = event.message.runIds.map((run) => state.runs[run]).filter((turn) => turn !== undefined && !state.begun[turn] && state.loaded[turn]);
    const loaded = stale.length ? Object.fromEntries(Object.entries(state.loaded).filter(([turn]) => !stale.includes(turn))) : state.loaded;
    return { ...state, seen, saved, replies, loaded };
  }
  // Any event of a round names its run, so a page that joined mid-turn still knows the turn.
  const runs = "run" in event && state.runs[event.run] !== event.turn ? { ...state.runs, [event.run]: event.turn } : state.runs;
  const begun = event.type === "turn.start" ? { ...state.begun, [event.turn]: true as const } : state.begun;
  return { ...state, seen, runs, begun, live: { ...state.live, [event.turn]: reduceTurn(state.live[event.turn], event) } };
}

/** Where a loaded page gets the events of a reply: the turn's saved events. The turn is on the saved reply (state.runs). */
export interface TurnSource {
  turnEvents(turn: string): Promise<EngineEvent[]>;
}

/** The saved replies that have no turn view yet, by message id. */
export const unloadedReplies = (state: ChatState): string[] =>
  state.saved.filter((message) => state.replies[message.id] && !viewOfReply(state, message.id)).map((message) => message.id);

/** Loads the turns of these replies. A turn that fails to load is left out, so the reply shows without steps. */
export async function loadTurns(state: ChatState, ids: readonly string[], source: TurnSource): Promise<Pick<ChatState, "runs" | "loaded">> {
  const runs: Record<string, string> = {}, loaded: Record<string, TurnView> = {};
  await Promise.all(ids.map(async (id) => {
    for (const run of state.replies[id] ?? []) {
      try {
        const turn = state.runs[run];
        if (turn === undefined) continue;
        runs[run] = turn;
        if (!completeView(state, turn) && !loaded[turn]) {
          const view = (await source.turnEvents(turn)).reduce<TurnView | undefined>(reduceTurn, undefined);
          if (view) loaded[turn] = view;
        }
        return;
      } catch { /* try the next run */ }
    }
  }));
  return { runs, loaded };
}

/** Adds loaded turns to the state. What the live events already built is kept. */
export const withLoadedTurns = (state: ChatState, found: Pick<ChatState, "runs" | "loaded">): ChatState =>
  ({ ...state, runs: { ...found.runs, ...state.runs }, loaded: { ...found.loaded, ...state.loaded } });

/** A sent message before the bot's events show it. `from` is the message count when it was sent. */
export interface PendingSend { user: Message; from: number }

/** A sent message as a pending user message. Image drafts show their local preview. */
export function pendingSend(text: string, drafts: { id: string; name: string; mime: string; size: number; fileId?: string; previewUrl?: string }[], from: number): PendingSend {
  const parts: Part[] = drafts.map((draft) => ({ type: "attachment", id: `pending:${draft.id}`, status: "done", fileId: draft.fileId ?? draft.id, name: draft.name, mime: draft.mime, size: draft.size, ...(draft.previewUrl && { url: draft.previewUrl }) }));
  if (text) parts.push({ type: "text", id: "pending:text", text, status: "done" });
  return { from, user: { id: "pending:user", parentId: null, role: "user", status: "done", parts, createdAt: new Date().toISOString() } };
}

/**
 * The messages with a pending send at the end: its user message until the bot's copy shows,
 * and an empty streaming reply (the thinking row) until the bot's reply starts. done: the reply started.
 */
export function withPending(messages: Message[], pending: PendingSend | undefined): { messages: Message[]; done: boolean } {
  if (!pending) return { messages, done: false };
  const after = messages.slice(pending.from);
  if (after.some((m) => m.role === "assistant")) return { messages, done: true };
  const shown = [...messages];
  if (!after.some((m) => m.role === "user")) shown.push(pending.user);
  shown.push({ id: "pending:reply", parentId: pending.user.id, role: "assistant", status: "streaming", parts: [], createdAt: pending.user.createdAt });
  return { messages: shown, done: false };
}
