import { logError } from "./errors.js";
import type { Json, Message, ModelEvent } from "./domain.js";
import type { ToolActivity } from "./tool-activity.js";
import { transcriptSwitchOn } from "./server-tools.js";
import type { MemberDirectory, MemberProfile } from "./member-directory.js";
import { imageAttachments, remoteImageAttachments } from "./web-chat-images.js";
import { fileAttachments, parseFileUrl, type ChatFileView } from "./web-chat-files.js";
import { LEGACY_FILE_NOTE } from "./source-context.js";
import type { UiDocument } from "./ui/schema.js";
import { engineEvents } from "./engine/event-log.js";
import { stableOperationId } from "./tools.js";

/** The store part the retention timer needs. */
export interface ConversationEventRetention {
  pruneConversationEvents(olderThan: number, maxRows: number): Promise<number>;
}

const DAY_MS = 86_400_000, HOUR_MS = 3_600_000;

/**
 * Prunes conversation events now and then every hour. Rows older than `days` go first, then the
 * oldest rows beyond `maxRows`. A run that is still pruning is not started again. Errors are
 * logged and the timer goes on. Returns stop().
 */
export function startConversationEventRetention(store: ConversationEventRetention, options: { days: number; maxRows: number }, intervalMs = HOUR_MS): () => void {
  let running = false;
  const prune = async (): Promise<void> => {
    if (running) return;
    running = true;
    try {
      const deleted = await store.pruneConversationEvents(Date.now() - options.days * DAY_MS, options.maxRows);
      console.log(JSON.stringify({ type: "conversation_events_pruned", deleted, retentionDays: options.days, maxRows: options.maxRows }));
    } catch (error) {
      logError("conversation_events_prune_failed", error, { stage: "conversation events retention" });
    } finally {
      running = false;
    }
  };
  void prune();
  const timer = setInterval(() => void prune(), intervalMs);
  timer.unref();
  return () => clearInterval(timer);
}

/** The message shape the web transcript shows. Names and avatars come from the member directory at read time, never from the database. */
/** A card saved with a private chat reply, such as an issue draft. Its action runs through the chat's action route. */
export interface ChatCard { id: string; revision: number; document: UiDocument }

export interface TranscriptMessage {
  id: string;
  channel: string;
  author: string;
  authorName: string;
  username: string | null;
  avatarUrl: string | null;
  text: string;
  timestamp: number | null;
  editedAt: number | null;
  slopbot: boolean;
  runIds: string[];
  /** The turn of a saved reply (its request message ID). Set when a page loads saved messages, so the page can read /turns/:turn/events. */
  turn?: string;
  /** Web chat images as saved placeholders. The page loads the bytes from the chat's image route. */
  images?: { imageId: string; name: string; contentType: string; size: number }[];
  remoteImages?: { src: string; name: string; size: number }[];
  /** Web chat files as saved placeholders. The page shows a chip. The bytes come from the chat's file route. */
  files?: ChatFileView[];
  /** The card of a private chat reply. Its buttons run through the chat's action route. */
  ui?: ChatCard;
  /** True for Slopbot's own messages, and for a person's message that a reply run used. Live messages start false. */
  used: boolean;
}

/** The part of the store that holds server settings. */
export interface SettingReader { setting(server: string, key: string): unknown }

/** The ID of Slopbot's own Discord user, saved when the bot becomes ready. */
export function slopbotId(store: SettingReader, server: string): string | undefined {
  const value = store.setting(server, "context_bot_author");
  return typeof value === "string" ? value : undefined;
}

/** True when the author's Discord profile is shown: Slopbot itself and human authors. Webhook posts have no user to look up. */
export function showsProfile(message: Message, slopbot: string | undefined): boolean {
  return message.author === slopbot || !message.isBot;
}

/** The label line that send() adds for each file. The model reads it from the saved text. The client view removes it. */
export function fileLabel(name: string, contentType: string, url: string, legacy = false): string {
  return `[Attachment ${name}, type ${contentType}: ${url}; content not inspected${legacy ? LEGACY_FILE_NOTE : ''}]`;
}

/** The saved text without the file label lines that send() added. authoredSourceText misses a message with images and files, so the file labels are matched here. */
export function withoutFileLabels(message: Message): Message {
  const files = (message.attachments ?? []).filter(item => parseFileUrl(item.url));
  if (!files.length) return message;
  // Saved messages from before the file_read removal have the old label ending, so both endings are removed.
  for (const legacy of [false, true]) {
    const labels = files.map(item => fileLabel(item.name, item.contentType ?? "application/octet-stream", item.url, legacy)).join("\n");
    if (message.text === labels) return { ...message, text: "" };
    if (message.text.endsWith("\n" + labels)) return { ...message, text: message.text.slice(0, -labels.length - 1) };
  }
  return message;
}

/** The same label removal for text alone, for a copied share. Only the fixed label wording is matched, so no attachment is needed. */
const FILE_LABEL_LINE = /^\[Attachment .*, type .*: web-file:\S*; content not inspected(?:; read with file_read, or if file_read cannot read this type, use sandbox import_attachment)?\]$/;
export function withoutFileLabelText(text: string): string {
  return text.split("\n").filter(line => !FILE_LABEL_LINE.test(line)).join("\n");
}

export function transcriptMessage(stored: Message, slopbot: string | undefined, runIds: readonly string[] = [], profile?: MemberProfile, used = false, card?: ChatCard): TranscriptMessage {
  const message = withoutFileLabels(stored);
  const timestamp = message.timestamp ?? null;
  const edited = message.revisionTimestamp !== undefined && message.revisionTimestamp > (message.timestamp ?? 0);
  const isSlopbot = slopbot !== undefined && message.author === slopbot;
  // An unknown user keeps the name stored with the message and gets no avatar.
  const named = profile && profile.username !== null ? profile : undefined;
  return {
    id: message.id,
    channel: message.channel,
    author: message.author,
    authorName: named?.displayName ?? message.authorName ?? message.author,
    username: named?.username ?? null,
    avatarUrl: named?.avatarUrl ?? null,
    text: message.text,
    timestamp,
    editedAt: edited ? message.revisionTimestamp! : null,
    slopbot: isSlopbot,
    runIds: isSlopbot ? [...runIds] : [],
    ...(imageAttachments(message.attachments).length ? { images: imageAttachments(message.attachments) } : {}),
    ...(remoteImageAttachments(message.attachments).length ? { remoteImages: remoteImageAttachments(message.attachments) } : {}),
    ...(fileAttachments(message.attachments).length ? { files: fileAttachments(message.attachments) } : {}),
    used: isSlopbot || used,
    ...(card ? { ui: card } : {}),
  };
}

const MAX_SHORT_ARGS = 300;

/** Shortens tool arguments for a live or stored view. */
export function shortArgs(args: unknown): string {
  const text = JSON.stringify(args ?? {}) ?? "{}";
  return text.length > MAX_SHORT_ARGS ? text.slice(0, MAX_SHORT_ARGS) + "…" : text;
}

/**
 * Sends a Discord message as an upsert. For a Slopbot message the run IDs come from the store
 * unless the caller passes them (a reply that is being delivered now).
 */
export async function publishMessage(store: { setting(server: string, key: string): unknown; taskThreads(server: string): { thread: string; parent: string }[]; replyRunIds(server: string, messageId: string): Promise<string[]> }, message: Message, runIds?: readonly string[], directory?: Pick<MemberDirectory, "profiles">, card?: ChatCard): Promise<void> {
  const slopbot = slopbotId(store, message.server);
  const ids = runIds ?? (slopbot !== undefined && message.author === slopbot ? await store.replyRunIds(message.server, message.id) : []);
  // Only a conversation that is switched on is read, so a quiet channel costs no Discord lookups.
  const profile = directory && showsProfile(message, slopbot) && transcriptSwitchOn(store, message.server, message.channel)
    ? (await directory.profiles(message.server, [message.author])).get(message.author) : undefined;
  const view = transcriptMessage(message, slopbot, ids, profile, false, card);
  engineEvents.publish({ server: message.server, channel: message.channel }, { type: "message.upsert", message: view });
}

export function publishMessageDelete(server: string, channel: string, id: string): void {
  engineEvents.publish({ server, channel }, { type: "message.delete", id });
}

/** Called by EventJournal when a model run starts. Only reply runs are shown live. */
export function publishRunStart(message: Message, runId: string): void {
  engineEvents.publish({ server: message.server, channel: message.channel }, { type: "round.start", turn: message.id, run: runId });
}

/** Called by EventJournal for each model event. Only text and thinking are shown live. */
export function publishModelEvent(message: Message, runId: string, event: ModelEvent): void {
  const conversation = { server: message.server, channel: message.channel };
  if (event.kind === "text") {
    if (event.payload.text) {
      engineEvents.publish(conversation, { type: "text.delta", turn: message.id, run: runId, text: event.payload.text });
    }
    return;
  }
  if (event.kind === "reasoning") {
    const text = reasoningText(event.payload);
    if (text) {
      engineEvents.publish(conversation, { type: "thinking.delta", turn: message.id, run: runId, text });
    }
    return;
  }
  if (event.kind === "tool_input") {
    const { index, name, text, id } = event.payload;
    // Without a provider call ID the call gets the ID the agent runner will give it (fallbackCallId).
    engineEvents.publish(conversation, { type: "tool.input", turn: message.id, run: runId, call: id ?? fallbackCallId(runId, index), name, text });
  }
}

/** The call ID of a tool call whose provider sent none. Keyed by the model round, which is known while the input streams. */
export const fallbackCallId = (runId: string, index: number): string => `call_${stableOperationId(runId, String(index))}`;

/** Tools whose arguments stream to the web view: show_ui markup is drawn as it is written. */
export const LIVE_INPUT_TOOLS: ReadonlySet<string> = new Set(["show_ui", "show_widget"]);

// The call ID of each running tool activity. A child (run_tools_code program call) names its parent by activity ID,
// but tool.status events key a call by its call ID, so the parent is looked up here.
const callOfActivity = new Map<string, string>();
const MAX_TRACKED_ACTIVITIES = 500;

/** Called by the tool progress observer. The ref is the request message, which the run belongs to. */
export function publishTool(message: Message, activity: ToolActivity): void {
  const call = activity.callId ?? activity.id;
  if (activity.status === "running" && activity.callId) {
    callOfActivity.set(activity.id, activity.callId);
    if (callOfActivity.size > MAX_TRACKED_ACTIVITIES) callOfActivity.delete(callOfActivity.keys().next().value!);
  } else if (activity.status !== "running") callOfActivity.delete(activity.id);
  engineEvents.publish({ server: message.server, channel: message.channel }, {
    type: "tool.status", turn: message.id, call, name: activity.name, status: activity.status,
    input: activity.arguments,
    ...(activity.reason ? { reason: activity.reason.slice(0, 2000) } : {}),
    ...(activity.code !== undefined ? { code: activity.code } : {}),
    ...(activity.parentId !== undefined ? { parent: callOfActivity.get(activity.parentId) ?? activity.parentId } : {}),
    ...(activity.durationMs !== undefined ? { durationMs: activity.durationMs } : {}),
  });
}

/** Thinking text from a provider reasoning delta. Unknown formats give an empty string. */
export function reasoningText(payload: Json): string {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return "";
  for (const field of ["reasoning_content", "reasoning", "text"]) {
    const value = (payload as Record<string, unknown>)[field];
    if (typeof value === "string") return value;
  }
  return "";
}
