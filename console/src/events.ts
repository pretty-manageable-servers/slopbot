// Maps the bot's chat stream (/api/chats/:id/stream) to kit messages. The bot sends saved messages ("message")
// and live run events ("run.start", "run.delta", "run.tool", "run.end"). Live events build one assistant message
// per request with the kit's applyEvent. The saved reply replaces it when it arrives and keeps its thinking and
// tool parts. A reply loaded later gets those parts from its runs (/api/runs/:id).
import { applyEvent, type Message, type Part, type StreamEvent } from "agentic-ui-kit/core";

/** One saved message as the bot sends it (TranscriptMessage in src/run-events.ts). Only the fields used here. */
export interface BotMessage {
  id: string;
  text: string;
  timestamp: number | null;
  slopbot: boolean;
  runIds: string[];
  images?: { imageId: string; name: string; contentType: string; size: number }[];
  files?: { fileId: string; name: string; contentType: string; size: number }[];
}

/** One bot stream event: its SSE type, its numeric id and its JSON data. */
export type BotEvent =
  | { type: "message"; id: number; data: { action: "upsert"; message: BotMessage } | { action: "delete"; id: string } }
  | { type: "run.start"; id: number; data: { ref: string; requestId: string } }
  | { type: "run.delta"; id: number; data: { ref: string; part: "text" | "thinking"; text: string } | { ref: string; part: "tool"; index: number; name: string; text: string } }
  | { type: "run.tool"; id: number; data: { ref: string; requestId: string; id: string; name: string; status: string; args: string; reason?: string } }
  | { type: "run.end"; id: number; data: { ref: string; status: "done" | "failed" } };

/** One step of a saved run (RunStep in src/web-transcripts.ts). */
export type RunStep =
  | { type: "text" | "thinking"; text: string }
  | { type: "tool"; name: string; status: string; args: string; result?: string; input?: unknown };

export interface ChatState {
  /** Saved messages, oldest first. */
  saved: Message[];
  /** Live replies by request message id. */
  live: Record<string, Message>;
  /** The request of each live run. run.delta and run.end name only the run. */
  runs: Record<string, string>;
  /** The part of each tool activity (run.tool id). A tool whose input streamed keeps that part. */
  tools: Record<string, string>;
  /** The newest bot event id applied. Older ids are replays and are dropped. */
  seen: number;
}

export const emptyChat = (saved: Message[] = [], seen = 0): ChatState => ({ saved, live: {}, runs: {}, tools: {}, seen });

/** All messages to show: the saved ones, then the live replies that are not saved yet. */
export const chatMessages = (state: ChatState): Message[] => [...state.saved, ...Object.values(state.live)];

const createdAt = (timestamp: number | null) => new Date(timestamp ?? Date.now()).toISOString();

/** A saved bot message as a kit message. Slopbot's messages are the assistant's; all others are the user's. */
export function toKitMessage(message: BotMessage, chatId: string): Message {
  const parts: Part[] = [];
  for (const image of message.images ?? []) {
    parts.push({ type: "attachment", id: `image:${image.imageId}`, status: "done", fileId: image.imageId, name: image.name, mime: image.contentType, size: image.size, url: `/api/chats/${encodeURIComponent(chatId)}/images/${encodeURIComponent(image.imageId)}` });
  }
  for (const file of message.files ?? []) {
    parts.push({ type: "attachment", id: `file:${file.fileId}`, status: "done", fileId: file.fileId, name: file.name, mime: file.contentType, size: file.size, url: `/api/chats/${encodeURIComponent(chatId)}/files/${encodeURIComponent(file.fileId)}` });
  }
  if (message.text) parts.push({ type: "text", id: `${message.id}:text`, text: message.text, status: "done" });
  return { id: message.id, parentId: null, role: message.slopbot ? "assistant" : "user", status: "done", parts, createdAt: createdAt(message.timestamp) };
}

/** Tool status words of the bot (run.tool and run steps) as kit part endings. */
const TOOL_END: Record<string, "done" | "error"> = { completed: "done", delegated: "done", rejected: "error", failed: "error" };

/** Tool arguments as the bot sends them: JSON, cut to a short length. A cut text is kept as a string. */
function parseArgs(args: string): unknown {
  try { return JSON.parse(args); } catch { return args; }
}

/**
 * A saved reply with the thinking and tool steps of its runs before its own parts. The steps' text is the
 * reply itself, so it is not added again. A message that already has such parts is returned as it is.
 */
export function withRunSteps(message: Message, steps: readonly RunStep[]): Message {
  if (message.parts.some((part) => part.type === "thinking" || part.type === "tool_call")) return message;
  const parts = steps.flatMap((step, index): Part[] => {
    const id = `${message.id}:step${index}`;
    if (step.type === "thinking") return [{ type: "thinking", id, text: step.text, status: "done" }];
    if (step.type !== "tool") return [];
    const input = step.input ?? parseArgs(step.args);
    const status = TOOL_END[step.status] ?? "done";
    return [{ type: "tool_call", id, name: step.name, status, inputJson: JSON.stringify(input), input, ...(step.result !== undefined && (status === "error" ? { error: step.result } : { result: step.result })) }];
  });
  return parts.length ? { ...message, parts: [...parts, ...message.parts] } : message;
}

/** A part that still grows: text or thinking that is streaming. Tool parts are closed by run.tool. */
const openText = (live: Message) => {
  const last = live.parts.at(-1);
  return last && last.type !== "tool_call" && last.status === "streaming" ? last : undefined;
};

/** The kit events for one bot run event, and the tool part a run.tool event belongs to. */
function kitEvents(live: Message | undefined, requestId: string, event: Exclude<BotEvent, { type: "message" }>, tools: ChatState["tools"]): { events: StreamEvent[]; tool?: [string, string] } {
  // One bot event can give a few kit events. Each needs a higher seq than the one before.
  let n = 0;
  const seq = () => event.id * 8 + n++;
  if (event.type === "run.start") {
    return { events: [{ type: "run.start", runId: event.data.ref, seq: seq(), messageId: `live:${requestId}`, parentId: requestId, createdAt: new Date().toISOString() }] };
  }
  if (!live?.runId) return { events: [] };
  const runId = live.runId, open = openText(live), out: StreamEvent[] = [];
  const close = () => { if (open) out.push({ type: "part.end", runId, seq: seq(), partId: open.id }); };

  if (event.type === "run.delta") {
    const data = event.data;
    if (!data.text) return { events: [] };
    if (data.part === "tool") {
      // Streamed tool input (show_ui markup). A new model turn starts its indexes at 0 again, so only a part that
      // still takes input continues.
      const prefix = `input:${runId}:${data.index}:`;
      const current = live.parts.find((part) => part.type === "tool_call" && part.id.startsWith(prefix) && part.status === "input");
      if (current) return { events: [{ type: "part.delta", runId, seq: seq(), partId: current.id, inputJson: data.text }] };
      close();
      const id = prefix + live.parts.length;
      out.push({ type: "part.start", runId, seq: seq(), part: { type: "tool_call", id, name: data.name, status: "input", inputJson: "" } });
      out.push({ type: "part.delta", runId, seq: seq(), partId: id, inputJson: data.text });
      return { events: out };
    }
    if (open?.type === data.part) return { events: [{ type: "part.delta", runId, seq: seq(), partId: open.id, text: data.text }] };
    close();
    const id = `${runId}:${live.parts.length}`;
    out.push({ type: "part.start", runId, seq: seq(), part: { type: data.part, id, text: "", status: "streaming" } });
    out.push({ type: "part.delta", runId, seq: seq(), partId: id, text: data.text });
    return { events: out };
  }

  if (event.type === "run.tool") {
    const { id, name, status, args, reason } = event.data;
    let partId = tools[id];
    if (!partId) {
      // The activity id ends with the call's index in its model turn, the same index the streamed input had.
      const index = id.slice(id.lastIndexOf(":") + 1);
      const streamed = live.parts.find((part) => part.type === "tool_call" && part.name === name && part.status === "input" && part.id.startsWith(`input:${runId}:${index}:`));
      if (streamed) {
        partId = streamed.id;
        out.push({ type: "part.update", runId, seq: seq(), partId, status: "running" });
      } else {
        partId = `tool:${id}`;
        close();
        out.push({ type: "part.start", runId, seq: seq(), part: { type: "tool_call", id: partId, name, status: "running", inputJson: args, input: parseArgs(args) } });
      }
    }
    const end = TOOL_END[status];
    if (end) out.push({ type: "part.end", runId, seq: seq(), partId, status: end, ...(reason ? (end === "error" ? { error: reason } : { result: reason }) : {}) });
    return { events: out, tool: [id, partId] };
  }
  return { events: [{ type: "run.end", runId, seq: seq(), status: event.data.status === "failed" ? "error" : "done" }] };
}

/** Applies one bot event. Returns the same state when the event changes nothing. */
export function applyBotEvent(state: ChatState, event: BotEvent, chatId: string): ChatState {
  if (event.id && event.id <= state.seen) return state;
  const seen = event.id || state.seen;
  if (event.type === "message") {
    if (event.data.action === "delete") {
      const id = event.data.id;
      return { ...state, seen, saved: state.saved.filter((message) => message.id !== id) };
    }
    const message = event.data.message;
    let kit = toKitMessage(message, chatId);
    // The saved reply names its runs. Their live message is done; its thinking and tool parts stay on the reply.
    const live = { ...state.live }, kept: Part[] = [];
    for (const runId of message.runIds) {
      const requestId = state.runs[runId];
      const done = requestId ? live[requestId] : undefined;
      if (!requestId || !done) continue;
      kept.push(...done.parts.filter((part) => part.type !== "text"));
      delete live[requestId];
    }
    if (kept.length) kit = { ...kit, parts: [...kept, ...kit.parts] };
    const index = state.saved.findIndex((item) => item.id === message.id);
    // An edit of a reply keeps the parts it got from its runs.
    if (index >= 0 && !kept.length) kit = keepSteps(state.saved[index]!, kit);
    const saved = index < 0 ? [...state.saved, kit] : state.saved.with(index, kit);
    return { ...state, seen, saved, live };
  }
  const requestId = event.type === "run.start" || event.type === "run.tool" ? event.data.requestId : state.runs[event.data.ref];
  if (!requestId) return { ...state, seen };
  const runs = event.type === "run.start" ? { ...state.runs, [event.data.ref]: requestId } : state.runs;
  let message: Message | undefined = state.live[requestId];
  const { events, tool } = kitEvents(message, requestId, event, state.tools);
  for (const kit of events) message = applyEvent(message, kit);
  const tools = tool && state.tools[tool[0]] !== tool[1] ? { ...state.tools, [tool[0]]: tool[1] } : state.tools;
  if (!message || message === state.live[requestId]) return { ...state, seen, runs, tools };
  return { ...state, seen, runs, tools, live: { ...state.live, [requestId]: message } };
}

/** The new version of a saved message, with the thinking and tool parts of the old one. */
function keepSteps(old: Message, next: Message): Message {
  const steps = old.parts.filter((part) => part.type === "thinking" || part.type === "tool_call");
  return steps.length ? { ...next, parts: [...steps, ...next.parts] } : next;
}

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
