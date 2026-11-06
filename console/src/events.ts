// Maps the bot's chat stream (/api/chats/:id/stream) to kit messages. The bot sends saved messages ("message")
// and live run events ("run.start", "run.delta", "run.tool", "run.end"). Live events build one assistant message
// per request with the kit's applyEvent. The saved reply replaces it when it arrives.
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
  | { type: "run.delta"; id: number; data: { ref: string; part: "text" | "thinking"; text: string } }
  | { type: "run.tool"; id: number; data: { ref: string; requestId: string; id: string; name: string; status: string; args: string; reason?: string } }
  | { type: "run.end"; id: number; data: { ref: string; status: "done" | "failed" } };

export interface ChatState {
  /** Saved messages, oldest first. */
  saved: Message[];
  /** Live replies by request message id. */
  live: Record<string, Message>;
  /** The request of each live run. run.delta and run.end name only the run. */
  runs: Record<string, string>;
  /** The newest bot event id applied. Older ids are replays and are dropped. */
  seen: number;
}

export const emptyChat = (saved: Message[] = [], seen = 0): ChatState => ({ saved, live: {}, runs: {}, seen });

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

const TOOL_DONE: Record<string, "done" | "error"> = { completed: "done", delegated: "done", rejected: "error", failed: "error" };

/** The kit events for one bot run event. `seq` is derived from the bot event id, so it only goes up. */
function kitEvents(live: Message | undefined, requestId: string, event: Exclude<BotEvent, { type: "message" }>): StreamEvent[] {
  // One bot event can give up to three kit events. Each needs a higher seq than the one before.
  let n = 0;
  const seq = () => event.id * 4 + n++;
  if (event.type === "run.start") {
    return [{ type: "run.start", runId: event.data.ref, seq: seq(), messageId: `live:${requestId}`, parentId: requestId, createdAt: new Date().toISOString() }];
  }
  if (!live?.runId) return [];
  const runId = live.runId;
  const last = live.parts.at(-1);
  const open = last && (last.status === "streaming" || last.status === "running") ? last : undefined;
  const out: StreamEvent[] = [];
  if (event.type === "run.delta") {
    if (!event.data.text) return [];
    if (open?.type === event.data.part) return [{ type: "part.delta", runId, seq: seq(), partId: open.id, text: event.data.text }];
    if (open && open.type !== "tool_call") out.push({ type: "part.end", runId, seq: seq(), partId: open.id });
    const id = `${runId}:${live.parts.length}`;
    out.push({ type: "part.start", runId, seq: seq(), part: { type: event.data.part, id, text: "", status: "streaming" } });
    out.push({ type: "part.delta", runId, seq: seq(), partId: id, text: event.data.text });
    return out;
  }
  if (event.type === "run.tool") {
    const { id, name, status, args, reason } = event.data;
    const partId = `tool:${id}`;
    if (!live.parts.some((part) => part.id === partId)) {
      if (open && open.type !== "tool_call") out.push({ type: "part.end", runId, seq: seq(), partId: open.id });
      out.push({ type: "part.start", runId, seq: seq(), part: { type: "tool_call", id: partId, name, status: "running", inputJson: args, input: parseArgs(args) } });
    }
    const done = TOOL_DONE[status];
    if (done) out.push({ type: "part.end", runId, seq: seq(), partId, status: done, ...(reason ? (done === "error" ? { error: reason } : { result: reason }) : {}) });
    return out;
  }
  return [{ type: "run.end", runId, seq: seq(), status: event.data.status === "failed" ? "error" : "done" }];
}

/** Tool arguments as the bot sends them: JSON, cut to a short length. A cut text is kept as a string. */
function parseArgs(args: string): unknown {
  try { return JSON.parse(args); } catch { return args; }
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
    const kit = toKitMessage(message, chatId);
    const index = state.saved.findIndex((item) => item.id === message.id);
    const saved = index < 0 ? [...state.saved, kit] : state.saved.with(index, kit);
    // The saved reply names its runs. Their live message is done.
    const live = { ...state.live };
    for (const runId of message.runIds) {
      const requestId = state.runs[runId];
      if (requestId) delete live[requestId];
    }
    return { ...state, seen, saved, live };
  }
  const requestId = event.type === "run.start" || event.type === "run.tool" ? event.data.requestId : state.runs[event.data.ref];
  if (!requestId) return { ...state, seen };
  const runs = event.type === "run.start" ? { ...state.runs, [event.data.ref]: requestId } : state.runs;
  let message: Message | undefined = state.live[requestId];
  for (const kit of kitEvents(message, requestId, event)) message = applyEvent(message, kit);
  if (!message || message === state.live[requestId]) return { ...state, seen, runs };
  return { ...state, seen, runs, live: { ...state.live, [requestId]: message } };
}
