import { logError } from "./errors.js";
import type { Json, Message, ModelEvent } from "./domain.js";
import type { ToolActivity } from "./tool-activity.js";
import { transcriptSwitchOn } from "./server-tools.js";
import type { MemberDirectory, MemberProfile } from "./member-directory.js";
import { imageAttachments } from "./web-chat-images.js";
import { fileAttachments, parseFileUrl, type ChatFileView } from "./web-chat-files.js";
import { LEGACY_FILE_NOTE } from "./source-context.js";

/** Kinds of events a web transcript stream sends. */
export type ConversationKind = "message" | "run.start" | "run.delta" | "run.tool" | "run.end";

/** One event before the store gives it a stream ID. `data` is a small JSON object. */
export interface ConversationRow {
  server: string;
  channel: string;
  kind: ConversationKind;
  /** The message ID for message events, the run ID for run events. */
  ref: string;
  data: Json;
}
export interface ConversationEvent extends ConversationRow { streamId: number; createdAt: number }

/** The store part the publisher and the stream need. Stream IDs only go up. */
export interface ConversationEventStore {
  setting(server: string, key: string): unknown;
  taskThreads(server: string): { thread: string; parent: string }[];
  appendConversationEvent(row: ConversationRow & { createdAt: number }): Promise<number>;
  conversationEventsAfter(server: string, channel: string, after: number, limit: number): Promise<ConversationEvent[]>;
  /** The lowest stream ID kept for the channel, or undefined when no rows are kept. */
  oldestStreamId(server: string, channel: string): Promise<number | undefined>;
}

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
  /** Web chat images as saved placeholders. The page loads the bytes from the chat's image route. */
  images?: { imageId: string; name: string; contentType: string; size: number }[];
  /** Web chat files as saved placeholders. The page shows a chip. The bytes come from the chat's file route. */
  files?: ChatFileView[];
  /** True for Slopbot's own messages, and for a person's message that a reply run used. Live messages start false. */
  used: boolean;
}

/** The ID of Slopbot's own Discord user, saved when the bot becomes ready. */
export function slopbotId(store: Pick<ConversationEventStore, "setting">, server: string): string | undefined {
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

export function transcriptMessage(stored: Message, slopbot: string | undefined, runIds: readonly string[] = [], profile?: MemberProfile, used = false): TranscriptMessage {
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
    ...(fileAttachments(message.attachments).length ? { files: fileAttachments(message.attachments) } : {}),
    used: isSlopbot || used,
  };
}

interface Pending extends ConversationRow { createdAt: number }
type Listener = (event: ConversationEvent) => void;
const key = (server: string, channel: string) => JSON.stringify([server, channel]);
const MAX_SHORT_ARGS = 300;

/** Shortens tool arguments for a live or stored view. */
export function shortArgs(args: unknown): string {
  const text = JSON.stringify(args ?? {}) ?? "{}";
  return text.length > MAX_SHORT_ARGS ? text.slice(0, MAX_SHORT_ARGS) + "…" : text;
}

/**
 * In-process publisher for conversation events. Events are saved in publish order with a
 * stream ID, then sent to subscribers. Consecutive text or thinking deltas of one run are
 * saved as one row, so the stored order always matches the send order.
 */
export class RunEvents {
  private store: ConversationEventStore | undefined;
  private queue: Pending[] = [];
  private running = false;
  private current: Promise<void> = Promise.resolve();
  private readonly listeners = new Map<string, Set<Listener>>();
  private readonly changes = new Map<string, Set<() => void>>();
  // Every model token is published, so the switch is read at most once a second per conversation.
  private readonly switches = new Map<string, { on: boolean; until: number }>();

  /** Until a store is attached, publishing does nothing. */
  attach(store: ConversationEventStore): void { this.store = store; }

  /** Saves and sends one event, if the channel's web transcripts switch is on. */
  publish(server: string, channel: string, kind: ConversationKind, ref: string, data: Json): void {
    const store = this.store;
    if (!store || !this.switchOn(store, server, channel)) return;
    this.queue.push({ server, channel, kind, ref, data, createdAt: Date.now() });
    if (!this.running) {
      this.running = true;
      this.current = this.drain();
    }
  }

  /** Resolves when every event published so far is saved and sent. */
  async idle(): Promise<void> { while (this.running) await this.current; }

  subscribe(server: string, channel: string, listener: Listener): () => void {
    const id = key(server, channel);
    const set = this.listeners.get(id) ?? new Set<Listener>();
    set.add(listener);
    this.listeners.set(id, set);
    return () => { set.delete(listener); if (!set.size) this.listeners.delete(id); };
  }

  private switchOn(store: ConversationEventStore, server: string, channel: string): boolean {
    const id = key(server, channel), now = Date.now(), hit = this.switches.get(id);
    if (hit && hit.until > now) return hit.on;
    const on = transcriptSwitchOn(store, server, channel);
    this.switches.set(id, { on, until: now + 1000 });
    return on;
  }

  /** Tells streams of a server to check access and switches again. Also clears the switch cache. */
  changed(server: string): void {
    this.switches.clear();
    for (const listener of this.changes.get(server) ?? []) {
      try { listener(); } catch (error) { logError("run_events_listener_failed", error, { server }); }
    }
  }

  onChange(server: string, listener: () => void): () => void {
    const set = this.changes.get(server) ?? new Set<() => void>();
    set.add(listener);
    this.changes.set(server, set);
    return () => { set.delete(listener); if (!set.size) this.changes.delete(server); };
  }

  private async drain(): Promise<void> {
    while (this.queue.length) {
      const batch = mergeDeltas(this.queue.splice(0));
      const store = this.store;
      for (const row of batch) {
        if (!store) break;
        let streamId: number;
        try { streamId = await store.appendConversationEvent(row); }
        catch (error) { logError("run_events_save_failed", error, { stage: "live events", server: row.server, channel: row.channel }, true); continue; }
        const event: ConversationEvent = { ...row, streamId };
        for (const listener of this.listeners.get(key(row.server, row.channel)) ?? []) {
          try { listener(event); } catch (error) { logError("run_events_listener_failed", error, { server: row.server, channel: row.channel }); }
        }
      }
    }
    this.running = false;
  }
}

/** Joins consecutive text (or thinking) deltas of the same run. Order is kept. */
function mergeDeltas(items: Pending[]): Pending[] {
  const out: Pending[] = [];
  for (const item of items) {
    const last = out.at(-1);
    if (last && last.kind === "run.delta" && item.kind === "run.delta" && last.server === item.server && last.channel === item.channel && last.ref === item.ref) {
      const a = last.data as { part: string; text: string }, b = item.data as { part: string; text: string };
      if (a.part === b.part) { last.data = { part: a.part, text: a.text + b.text }; continue; }
    }
    out.push({ ...item });
  }
  return out;
}

/** The process-wide publisher. The Discord adapter attaches the store once. */
export const runEvents = new RunEvents();

/**
 * Sends a Discord message as an upsert. For a Slopbot message the run IDs come from the store
 * unless the caller passes them (a reply that is being delivered now).
 */
export async function publishMessage(store: Pick<ConversationEventStore, "setting" | "taskThreads"> & { replyRunIds(server: string, messageId: string): Promise<string[]> }, message: Message, runIds?: readonly string[], directory?: Pick<MemberDirectory, "profiles">): Promise<void> {
  const slopbot = slopbotId(store, message.server);
  const ids = runIds ?? (slopbot !== undefined && message.author === slopbot ? await store.replyRunIds(message.server, message.id) : []);
  // Only a conversation that is switched on is read, so a quiet channel costs no Discord lookups.
  const profile = directory && showsProfile(message, slopbot) && transcriptSwitchOn(store, message.server, message.channel)
    ? (await directory.profiles(message.server, [message.author])).get(message.author) : undefined;
  const view = transcriptMessage(message, slopbot, ids, profile);
  runEvents.publish(message.server, message.channel, "message", message.id, { action: "upsert", message: view as unknown as Json });
}

export function publishMessageDelete(server: string, channel: string, id: string): void {
  runEvents.publish(server, channel, "message", id, { action: "delete", id });
}

/** Called by EventJournal when a model run starts. Only reply runs are shown live. */
export function publishRunStart(message: Message, runId: string): void {
  runEvents.publish(message.server, message.channel, "run.start", runId, { requestId: message.id });
}

/** Called by EventJournal for each model event. Only text and thinking are shown live. */
export function publishModelEvent(message: Message, runId: string, event: ModelEvent): void {
  if (event.kind === "text") {
    if (event.payload.text) runEvents.publish(message.server, message.channel, "run.delta", runId, { part: "text", text: event.payload.text });
    return;
  }
  if (event.kind === "reasoning") {
    const text = reasoningText(event.payload);
    if (text) runEvents.publish(message.server, message.channel, "run.delta", runId, { part: "thinking", text });
  }
}

/** Called by EventJournal when the model stream ends. */
export function publishRunEnd(message: Message, runId: string, status: "done" | "failed"): void {
  runEvents.publish(message.server, message.channel, "run.end", runId, { status });
}

/** Called by the tool progress observer. The ref is the request message, which the run belongs to. */
export function publishTool(message: Message, activity: ToolActivity): void {
  runEvents.publish(message.server, message.channel, "run.tool", message.id, {
    requestId: message.id,
    id: activity.id,
    name: activity.name,
    status: activity.status,
    args: shortArgs(activity.arguments),
    ...(activity.reason ? { reason: activity.reason.slice(0, 300) } : {}),
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
