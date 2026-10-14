import type { Json, Message, PromptItem } from "./domain.js";

/**
 * One message in the prompt transcript. Only these fields reach the model.
 * Everything else on a Message (IDs, aliases, server, channel, flags) stays out.
 */
export interface TranscriptLine {
  ref: string;            // "m1", "m2", ... in order
  time: string;           // "HH:MM" UTC from message.timestamp ("--:--" if missing)
  name: string;           // authorName (fallback "unknown")
  handle?: string;        // authorIdentity.discord_handle
  bot?: true;             // isBot and not own
  notice?: true;          // own message without model reply
  replyTo?: string;       // ref of the target, if it is in the transcript
  replyTarget?: true;     // this line is the message being replied to
  edited?: true;          // revisionTimestamp > timestamp
  attachments?: string[]; // file names only
  text: string;
}

const NO_TIME = "--:--";
const REF_VALUE = /^#?[ms]\d+$/;

function clockTime(timestamp: number | undefined): string {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return NO_TIME;
  return new Date(timestamp).toISOString().slice(11, 16);
}

/** Builds one line. `slopbot` is true for Slopbot's own message that has no model reply. */
function lineOf(message: Message, ref: string, refs: ReadonlyMap<string, string>, slopbot: boolean, targetId?: string): TranscriptLine {
  const handle = message.authorIdentity?.discord_handle;
  const replied = message.replyTo !== undefined ? refs.get(message.replyTo) : undefined;
  const files = (message.attachments ?? []).map(file => file.name).filter(name => name.length > 0);
  const edited = message.revisionTimestamp !== undefined && message.revisionTimestamp > (message.timestamp ?? 0);
  return {
    ref,
    time: clockTime(message.timestamp),
    name: message.authorName || "unknown",
    ...(handle && !slopbot ? { handle } : {}),
    ...(message.isBot && !slopbot ? { bot: true as const } : {}),
    ...(slopbot ? { notice: true as const } : {}),
    ...(replied !== undefined ? { replyTo: replied } : {}),
    ...(targetId !== undefined && message.id === targetId ? { replyTarget: true as const } : {}),
    ...(edited ? { edited: true as const } : {}),
    ...(files.length ? { attachments: files } : {}),
    text: message.text,
  };
}

/** One message as a line. `refs` maps real message ID to ref, for the reply lookup. */
export function toLine(message: Message, ref: string, refs: ReadonlyMap<string, string>): TranscriptLine {
  return lineOf(message, ref, refs, false);
}

/**
 * The current request as the model reads it: same time, name, handle, edited and file fields as a transcript line, no ref.
 * `text` replaces message.text when a reply subject was added. Example: "[14:05] Alice (@alice) [current request]: text"
 */
export function requestLine(message: Message, text: string = message.text): string {
  const line = lineOf(message, "", new Map(), false);
  let head = `[${line.time}] ${line.name}`;
  if (line.handle) head += ` (@${line.handle})`;
  if (line.bot) head += " [bot]";
  if (line.edited) head += " [edited]";
  if (line.attachments?.length) head += ` [files: ${line.attachments.join(", ")}]`;
  return `${head} [current request]: ${text}`;
}

/** The text of one line for the prompt. Example: "[14:02] #m3 Alice (@alice) ↩#m1 [edited] [files: a.png]: text" */
export function formatLine(line: TranscriptLine): string {
  let head = `[${line.time}] #${line.ref} ${line.notice ? "Slopbot notice" : line.name}`;
  if (line.handle) head += ` (@${line.handle})`;
  if (line.bot) head += " [bot]";
  if (line.replyTo) head += ` ↩#${line.replyTo}`;
  if (line.edited) head += " [edited]";
  if (line.attachments?.length) head += ` [files: ${line.attachments.join(", ")}]`;
  if (line.replyTarget) head += " [reply target]";
  return `${head}: ${line.text}`;
}

/**
 * Turns channel messages into prompt items.
 * Slopbot's own messages with a model reply become assistant turns (one per run, with the run's text).
 * Other messages become user-side lines. Consecutive lines share one user turn.
 * `replyTo` is the real ID of the message being answered.
 * `refPrefix` is the letter of the refs: "m" for history, "s" for a task seed.
 */
export function renderTranscript(messages: readonly Message[], selfId: string | undefined,
  modelReplies: ReadonlyMap<string, { runId: string; text: string }>, replyTo?: string, refPrefix = "m"):
  { items: PromptItem[]; refs: Map<string, string> } {
  type Slot = { kind: "assistant"; text: string } | { kind: "user"; message: Message; own: boolean; ref: string };
  // Pass 1: decide each message's side, and give user-side lines their refs.
  const slots: Slot[] = [];
  const refs = new Map<string, string>(); // ref -> real message ID
  const ids = new Map<string, string>(); // real message ID -> ref
  const seenRuns = new Set<string>();
  for (const message of messages) {
    const own = selfId !== undefined && message.author === selfId;
    const reply = own ? modelReplies.get(message.id) : undefined;
    if (reply) {
      // One assistant turn per run. Later messages of the same run add nothing.
      if (seenRuns.has(reply.runId)) continue;
      seenRuns.add(reply.runId);
      slots.push({ kind: "assistant", text: reply.text });
      continue;
    }
    const ref = `${refPrefix}${refs.size + 1}`;
    refs.set(ref, message.id);
    ids.set(message.id, ref);
    slots.push({ kind: "user", message, own, ref });
  }

  // Pass 2: build the items.
  const items: PromptItem[] = [];
  let pending: TranscriptLine[] = [];
  const flush = (): void => {
    if (!pending.length) return;
    items.push({ role: "user", contextOnly: true, content: pending.map(formatLine).join("\n") });
    pending = [];
  };
  for (const slot of slots) {
    if (slot.kind === "assistant") {
      flush();
      const last = items.at(-1);
      if (last?.role === "assistant") items[items.length - 1] = { role: "assistant", content: `${last.content}\n\n${slot.text}` };
      else items.push({ role: "assistant", content: slot.text });
      continue;
    }
    pending.push(lineOf(slot.message, slot.ref, ids, slot.own, replyTo));
  }
  flush();
  // The first item is never an assistant turn.
  while (items[0]?.role === "assistant") items.shift();
  return { items, refs };
}

/**
 * The parts of a comma-separated ref list such as "m3, #m5", trimmed.
 * Returns undefined unless the string has a comma and every part is a ref.
 */
export function refListParts(value: string): string[] | undefined {
  if (!value.includes(",")) return undefined;
  const parts = value.split(",").map(part => part.trim());
  return parts.every(part => REF_VALUE.test(part)) ? parts : undefined;
}

/**
 * Replaces refs such as "m3" or "#m3" in tool arguments with the real message ID.
 * A comma-separated list of refs ("m3, #m5") maps each part and joins them with ",".
 * Unknown refs stay as they are.
 */
export function resolveRefs(args: Json, refs: ReadonlyMap<string, string>): Json {
  if (typeof args === "string") {
    if (REF_VALUE.test(args)) return refs.get(args.replace(/^#/, "")) ?? args;
    const parts = refListParts(args);
    if (parts) return parts.map(part => refs.get(part.replace(/^#/, "")) ?? part).join(",");
    return args;
  }
  if (Array.isArray(args)) return args.map(item => resolveRefs(item, refs));
  if (args !== null && typeof args === "object") {
    return Object.fromEntries(Object.entries(args).map(([key, value]) => [key, resolveRefs(value, refs)]));
  }
  return args;
}

/** The store methods that keep task refs. Both adapters have them; the Store port does not declare them. */
export interface SettingsPort {
  setting?(server: string, key: string): unknown;
  setSetting?(server: string, key: string, value: Json): unknown;
}

const taskRefsKey = (thread: string): string => `task_refs:${thread}`;

/**
 * Saves the refs of a task seed (ref -> real message ID) for the task thread.
 * Refs from earlier seeds of the same thread are kept.
 */
export async function saveTaskRefs(store: SettingsPort, server: string, thread: string, refs: ReadonlyMap<string, string>): Promise<void> {
  if (!store.setSetting) throw new Error("Store cannot save task refs");
  const merged = new Map([...await loadTaskRefs(store, server, thread), ...refs]);
  await store.setSetting(server, taskRefsKey(thread), Object.fromEntries(merged));
}

/** The saved refs of a task thread. Missing or malformed values give an empty map. */
export async function loadTaskRefs(store: SettingsPort, server: string, thread: string | undefined): Promise<Map<string, string>> {
  if (!thread || !store.setting) return new Map();
  const value = await store.setting(server, taskRefsKey(thread));
  if (value === null || typeof value !== "object" || Array.isArray(value)) return new Map();
  return new Map(Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string"));
}
