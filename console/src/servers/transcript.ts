// A channel transcript as kit messages. A saved message (TranscriptMessage, GET /api/conversations/:channel/messages)
// and a live one (the channel stream) become a kit message with a meta part: who wrote it, its group and its
// Discord images. A Slopbot reply gets the steps of its runs (GET /api/runs/:runId) when the page shows it.
import type { AttachmentPart, CustomPart, Message, Part } from "agentic-ui-kit/core";
import type { TranscriptMessage } from "../api-types";
import { applyBotEvent, toKitMessage, withRunSteps, type BotEvent, type ChatState, type RunStep } from "../events";

/** Avatars load from Discord's CDN only, the rule the old console used. */
const AVATAR_HOST = "https://cdn.discordapp.com/";
/** Messages by one author within this many ms are a group: the later ones have no author line. */
export const GROUP_MS = 5 * 60 * 1000;
const META = "meta";

/** Who wrote a message, and where it sits in its group. Kept as a custom part so the live stream keeps it with the text. */
export interface Meta {
  /** The same key is the same author. Slopbot's messages share "slopbot". */
  key: string;
  name: string;
  username: string | null;
  avatarUrl: string | null;
  /** The viewer's own message: on the right, with no author line. */
  mine: boolean;
  slopbot: boolean;
  edited: boolean;
  /** A reply run used this message. Only other people's messages fold when it is false. */
  used: boolean;
  runIds: string[];
  /** Set by displayMessages: the message before is by the same author, within GROUP_MS. */
  continued: boolean;
}

/** The channel stream's events. A message event carries the channel's own message view (with remoteImages). */
export type TranscriptEvent =
  | Exclude<BotEvent, { type: "message" }>
  | { type: "message"; id: number; data: { action: "upsert"; message: TranscriptMessage } | { action: "delete"; id: string } };

const LIVE_META: Meta = { key: "slopbot", name: "Slopbot", username: null, avatarUrl: null, mine: false, slopbot: true, edited: false, used: true, runIds: [], continued: false };

/** A Discord avatar on the CDN, or null. */
export function avatarSrc(url: string | null): string | null {
  return url?.startsWith(AVATAR_HOST) ? url : null;
}

/** The meta of a part, when it is the message's meta part. */
export function metaOfPart(part: Part): Meta | undefined {
  return part.type === "custom" && part.kind === META ? part.data as Meta : undefined;
}

/** The meta of a message. Live replies have none: they are Slopbot's. */
export function metaOf(message: Message): Meta | undefined {
  for (const part of message.parts) {
    const meta = metaOfPart(part);
    if (meta) return meta;
  }
  return undefined;
}

/** The run IDs of the Slopbot replies on a page, for their steps. */
export function runIdsOf(messages: readonly Message[]): string[] {
  return messages.flatMap((message) => metaOf(message)?.runIds ?? []);
}

const metaPart = (id: string, meta: Meta): CustomPart => ({ type: "custom", id: `${id}:meta`, status: "done", kind: META, data: meta });

/**
 * A channel message's images: Discord's own URLs, shown as thumbnails. The bot does not keep their types (only
 * that they are images), so the mime is generic.
 */
function imageParts(message: TranscriptMessage): AttachmentPart[] {
  return (message.remoteImages ?? []).map((image, index) => ({
    type: "attachment", id: `${message.id}:image:${index}`, status: "done", fileId: image.src, name: image.name, mime: "image/*", size: image.size, url: image.src,
  }));
}

/** A channel message with its meta and images. The viewer's own messages are the user's turns; the others are the assistant's (left). */
function decorate(kit: Message, message: TranscriptMessage, user: string): Message {
  const mine = !message.slopbot && message.author === user;
  const meta: Meta = {
    key: message.slopbot ? "slopbot" : `user:${message.author}`,
    name: message.slopbot ? "Slopbot" : message.authorName || message.author,
    username: message.username,
    avatarUrl: avatarSrc(message.avatarUrl),
    mine,
    slopbot: message.slopbot,
    edited: message.editedAt !== null,
    used: message.used,
    runIds: message.runIds,
    continued: false,
  };
  return { ...kit, role: mine ? "user" : "assistant", parts: [metaPart(message.id, meta), ...imageParts(message), ...kit.parts] };
}

/** A saved channel message as a kit message. */
export function channelMessage(message: TranscriptMessage, user: string, channel: string): Message {
  // Only web chats keep bot-hosted images and files. A channel message's images are remoteImages.
  return decorate(toKitMessage({ ...message, images: undefined, files: undefined }, channel), message, user);
}

/** One channel stream event applied to the page. A message event is decorated the same way as a saved one. */
export function applyTranscriptEvent(state: ChatState, event: TranscriptEvent, channel: string, user: string): ChatState {
  const next = applyBotEvent(state, event, channel);
  if (next === state || event.type !== "message" || event.data.action !== "upsert") return next;
  const message = event.data.message;
  return { ...next, saved: next.saved.map((item) => (item.id === message.id ? decorate(item, message, user) : item)) };
}

/**
 * The messages as the page shows them. Each one says whether it continues the group before it. A Slopbot reply
 * gets the steps of its runs before its parts (a reply that already has steps keeps them).
 */
export function displayMessages(messages: readonly Message[], steps: ReadonlyMap<string, readonly RunStep[]>): Message[] {
  let previous: { key: string; time: number } | undefined;
  return messages.map((message) => {
    const meta = metaOf(message) ?? LIVE_META;
    const time = Date.parse(message.createdAt);
    const continued = previous !== undefined && previous.key === meta.key && Math.abs(time - previous.time) <= GROUP_MS;
    previous = { key: meta.key, time };
    const parts = message.parts.filter((part) => metaOfPart(part) === undefined);
    const body = withRunSteps({ ...message, parts }, meta.runIds.flatMap((runId) => steps.get(runId) ?? []));
    // The meta stays first: the author line is drawn above the steps and the text.
    return { ...body, parts: [metaPart(message.id, { ...meta, continued }), ...body.parts] };
  });
}

const FOLD = "fold";

/** A folded run's row. Its key is the ID of the run's first message. */
export interface FoldRow { key: string; count: number; open: boolean }

/** The fold row of a part, when it is one. */
export function foldOfPart(part: Part): FoldRow | undefined {
  return part.type === "custom" && part.kind === FOLD ? part.data as FoldRow : undefined;
}

/** Another person's message that no reply used. The viewer's own and Slopbot's never fold. */
function unusedByOthers(message: Message): boolean {
  const meta = metaOf(message);
  return meta !== undefined && !meta.slopbot && !meta.mine && !meta.used;
}

/**
 * The messages with each run of unused messages from other people folded into one muted row. A run's row shows its
 * messages after it when `shown` has the run's key. Nothing folds from the trigger of a live run onward: `live` lists
 * the trigger IDs. A trigger that is not in the list counts as the first message, so nothing folds (the old console's rule).
 */
export function foldUnused(messages: readonly Message[], live: readonly string[], shown: ReadonlySet<string>): Message[] {
  const guard = Math.min(messages.length, ...live.map((id) => Math.max(0, messages.findIndex((message) => message.id === id))));
  const rows: Message[] = [];
  // The fold row rides on top of a message from someone else (the open run's first one, or the next one), so the kit
  // draws no copy button and time for it. Only the viewer's own next message, or none, needs a row of its own.
  let carry: Part | null = null;
  const withCarry = (message: Message): Message => {
    const part = carry;
    carry = null;
    return { ...message, parts: [part!, ...message.parts] };
  };
  const push = (message: Message) => {
    if (carry && message.role !== "assistant") rows.push({ id: carry.id, parentId: null, role: "assistant", status: "done", createdAt: message.createdAt, parts: [carry] }), carry = null;
    rows.push(carry ? withCarry(message) : message);
  };
  let run: Message[] = [];
  const flush = () => {
    const first = run[0];
    if (!first) return;
    const row: FoldRow = { key: first.id, count: run.length, open: shown.has(first.id) };
    carry = { type: "custom", id: `fold:${first.id}:row`, status: "done", kind: FOLD, data: row };
    if (row.open) for (const message of run) push(message);
    run = [];
  };
  messages.forEach((message, index) => {
    if (index < guard && unusedByOthers(message)) run.push(message);
    else {
      flush();
      push(message);
    }
  });
  flush();
  if (carry) rows.push({ id: (carry as Part).id, parentId: null, role: "assistant", status: "done", createdAt: rows.at(-1)?.createdAt ?? new Date(0).toISOString(), parts: [carry] });
  return rows;
}

/** The ids of other people's messages no reply used yet, newest 200: the ones a finished run may have used now. */
export function unusedIds(messages: Message[]): string[] {
  return messages.filter(unusedByOthers).slice(-200).map((message) => message.id);
}

/** Marks the given messages as used by a reply, so they stop folding. */
export function markUsed(messages: Message[], used: ReadonlySet<string>): Message[] {
  if (!used.size) return messages;
  return messages.map((message) => {
    if (!used.has(message.id)) return message;
    return { ...message, parts: message.parts.map((part) => { const meta = metaOfPart(part); return meta ? { ...part, data: { ...meta, used: true } } as Part : part; }) };
  });
}
