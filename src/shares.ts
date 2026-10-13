import { randomBytes } from "node:crypto";
import type { Json, Message } from "./domain.js";
import { webTranscriptsEnabled } from "./server-tools.js";
import { isPrivateChannel, privateChannel } from "./private-chat.js";

/** One share link. The body is a frozen snapshot, stored as JSON text. */
export interface ShareRow { id: string; server: string; channel: string; created_by: string; created_at: number; revoked_at: number | null; body: string }
export interface ShareListRow { id: string; channel: string; created_at: number; revoked_at: number | null }
export interface ShareMessageRange { from?: string | undefined; to?: string | undefined; limit: number }
export interface ShareMessageResult { messages: Message[]; more: boolean }

/** Store calls used by shares. SQLite and Postgres implement them in src/share-store.ts. */
export interface ShareStore {
  shareMessages(server: string, channel: string, range: ShareMessageRange): Promise<ShareMessageResult>;
  shareRequestEvents(server: string, requests: readonly string[]): Promise<readonly { request: string; kind: string; payload: Json }[]>;
  insertShare(row: ShareRow): Promise<void>;
  getShare(id: string): Promise<ShareRow | undefined>;
  /** Channel links only. Private chat links are never listed here. */
  listShares(server: string, limit: number): Promise<ShareListRow[]>;
  /** The links of one private chat, for its owner. */
  listChatShares(server: string, channel: string, limit: number): Promise<ShareListRow[]>;
  revokeShare(server: string, id: string, at: number): Promise<boolean>;
  /** Channel links only. Private chat links are never revoked here. */
  revokeAllShares(server: string, at: number): Promise<number>;
  /** Removes every link of a deleted private chat, with its frozen copies. */
  deleteChatShares(channel: string): Promise<number>;
}

export interface ShareToolLine { name: string; status: string }
export interface ShareMessage {
  author: string; bot: boolean; at?: number; text: string; attachments: number;
  tools: ShareToolLine[]; thinking?: string;
}
/** Chat shares do not show thinking or avatars. Owners share the answer text and tool labels. */
const CHAT_SHARE_OPTIONS = { show_avatars: false, show_thinking: false };
export interface ShareSnapshot {
  id: string; created_at: number;
  options: { show_avatars: boolean; show_thinking: boolean };
  messages: ShareMessage[];
}

/** The one rule for who may make, list and revoke share links. Add roles here later. */
export interface ShareRule {
  /** Manage Server in that Discord server. */
  manager(user: string, server: string): Promise<boolean>;
  /** Team admin panel check by Discord user ID. Optional until the team panel exists. */
  teamAdmin?(user: string): Promise<boolean>;
}
export async function canCreateShare(user: string, server: string, rule: ShareRule): Promise<boolean> {
  if (await rule.manager(user, server)) return true;
  return rule.teamAdmin ? await rule.teamAdmin(user) : false;
}

export class ShareError extends Error {
  constructor(readonly status: number, message: string) { super(message); this.name = "ShareError"; }
}

export const MAX_SHARE_MESSAGES = 200;
/** How long a private chat link remembers that its owner is (or is not) in the server. */
export const MEMBER_CACHE_MS = 60_000;
const snowflake = /^\d{17,20}$/;
const shareId = /^[A-Za-z0-9_-]{22}$/;
export const isShareId = (id: string): boolean => shareId.test(id);
/** Routes that change share links. The console uses this to allow POST. */
export function isShareWrite(path: string): boolean {
  return path === "/api/shares" || path === "/api/shares/revoke-all" || /^\/api\/shares\/[A-Za-z0-9_-]{22}\/revoke$/.test(path);
}

// Short labels for known tools. Arguments and results never go in a snapshot.
const toolStatus = new Map<string, string>([
  ["web_search", "Searched the web"], ["file_read", "Read a file"], ["file_store", "Used file storage"],
  ["sandbox", "Ran code in a sandbox"], ["history_search", "Searched channel history"], ["history_read", "Read channel history"],
  ["memory", "Checked saved memories"], ["memory_remember", "Saved a memory"], ["memory_forget", "Forgot a memory"],
  ["reminder", "Used a reminder"], ["poll_create", "Created a poll"], ["ui_publish", "Published a view"],
  ["task_start", "Started a task"], ["task_status", "Checked task status"], ["task_retry", "Retried a task"], ["task_manage", "Managed a task"],
  ["usage", "Checked usage"], ["timing_inspect", "Checked timings"], ["timing_active", "Checked active timings"],
  ["profile", "Used a profile"], ["status", "Checked status"], ["bot_info", "Checked bot info"],
]);
export function toolLine(name: string): ShareToolLine {
  const short = name.slice(0, 80);
  return { name: short, status: toolStatus.get(name) ?? `Used tool ${short}` };
}

/** Removes IDs and emails from text. Mentions become plain labels. */
export function scrubText(text: string): string {
  return text
    .replace(/<@&\d{17,20}>/g, "@role")
    .replace(/<@!?\d{17,20}>/g, "@member")
    .replace(/<#\d{17,20}>/g, "#channel")
    .replace(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, "[email]")
    .replace(/\b\d{17,20}\b/g, "[id]");
}

function toolNames(payload: Json): string[] {
  const calls: Json[] = Array.isArray(payload) ? payload : [payload];
  return calls.flatMap(call => call && typeof call === "object" && !Array.isArray(call) && typeof call.name === "string" ? [call.name] : []);
}
function reasoningText(payload: Json): string {
  if (typeof payload === "string") return payload;
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    for (const key of ["reasoning_content", "reasoning", "text", "delta"]) {
      const value = payload[key];
      if (typeof value === "string") return value;
    }
  }
  return "";
}

function optionalId(value: unknown, name: string): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !snowflake.test(value)) throw new ShareError(400, `Invalid ${name}.`);
  return value;
}
function optionalFlag(value: unknown, name: string): boolean {
  if (value === undefined || value === null) return false;
  if (typeof value !== "boolean") throw new ShareError(400, `${name} must be true or false.`);
  return value;
}

/** Builds the snapshot from stored messages. Only the message's own answer gets tool lines and thinking. */
export function buildMessages(messages: readonly Message[], events: readonly { request: string; kind: string; payload: Json }[], options: { show_thinking: boolean }): ShareMessage[] {
  const tools = new Map<string, string[]>(), thinking = new Map<string, string>();
  for (const event of events) {
    if (event.kind === "tool_call") tools.set(event.request, [...(tools.get(event.request) ?? []), ...toolNames(event.payload)]);
    else if (event.kind === "reasoning") thinking.set(event.request, (thinking.get(event.request) ?? "") + reasoningText(event.payload));
  }
  const claimed = new Set<string>();
  return messages.map(message => {
    const item: ShareMessage = {
      author: scrubText(message.authorName ?? (message.isBot ? "Slopbot" : "Member")),
      bot: message.isBot === true,
      ...(message.timestamp !== undefined ? { at: message.timestamp } : {}),
      text: scrubText(message.text),
      attachments: message.attachments?.length ?? 0,
      tools: [],
    };
    const request = message.isBot ? message.replyTo : undefined;
    if (request && !claimed.has(request)) {
      claimed.add(request);
      item.tools = (tools.get(request) ?? []).map(toolLine);
      if (options.show_thinking && thinking.get(request)) item.thinking = scrubText(thinking.get(request)!);
    }
    return item;
  });
}

/** The stored messages of a range, as snapshot messages. Tool lines and thinking come from the runs of the answers. */
async function snapshotOf(store: Pick<ShareStore, "shareMessages" | "shareRequestEvents">, server: string, channel: string, range: ShareMessageRange, options: { show_thinking: boolean }): Promise<{ messages: ShareMessage[]; more: boolean }> {
  const found = await store.shareMessages(server, channel, range);
  const requests = [...new Set(found.messages.flatMap(message => message.isBot && message.replyTo ? [message.replyTo] : []))];
  const events = await store.shareRequestEvents(server, requests);
  return { messages: buildMessages(found.messages, events, options), more: found.more };
}

export interface ShareDeps {
  /** Is this user in the server? Throws when Discord cannot say. Private chat links need it; without it they are not served. */
  member?: (user: string, server: string) => Promise<boolean>;
  store: ShareStore & {
    setting(server: string, key: string): unknown;
    taskThreads(server: string): { thread: string; parent: string }[];
  };
  access: { check(server: string, channel: string, user: string): Promise<{ view: boolean }> };
  rule: ShareRule;
  now?: () => number;
}

/** Operations for the console. Errors carry an HTTP status. */
export class ShareService {
  private readonly now: () => number;
  private readonly memberCache = new Map<string, { member: boolean; at: number }>();
  constructor(private readonly deps: ShareDeps) { this.now = deps.now ?? Date.now; }

  /**
   * Is the chat owner still in the home server? Cached for MEMBER_CACHE_MS so a busy link does not call Discord each time.
   * A Discord error is not cached and throws 503.
   */
  private async ownerIsMember(owner: string, server: string): Promise<boolean> {
    if (!this.deps.member) return false;
    const key = `${server}:${owner}`, now = this.now();
    const hit = this.memberCache.get(key);
    if (hit && now - hit.at < MEMBER_CACHE_MS) return hit.member;
    let member: boolean;
    try {
      member = await this.deps.member(owner, server);
    } catch {
      throw new ShareError(503, "Could not check the server right now. Try again.");
    }
    this.memberCache.set(key, { member, at: now });
    return member;
  }

  private async requireManager(user: string, server: string): Promise<void> {
    if (!(await canCreateShare(user, server, this.deps.rule))) throw new ShareError(403, "Only server managers can manage share links.");
  }

  async create(user: string, raw: unknown): Promise<{ id: string }> {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ShareError(400, "Invalid share.");
    const input = raw as Record<string, unknown>;
    const server = optionalId(input.server, "server"), channel = optionalId(input.channel, "channel");
    if (!server || !channel) throw new ShareError(400, "Choose a server and a channel.");
    const from = optionalId(input.from, "message"), to = optionalId(input.to, "message");
    const options = { show_avatars: optionalFlag(input.show_avatars, "show_avatars"), show_thinking: optionalFlag(input.show_thinking, "show_thinking") };
    await this.requireManager(user, server);
    if (isPrivateChannel(channel)) throw new ShareError(403, "Private chats cannot be shared.");
    if (!(await this.deps.access.check(server, channel, user)).view) throw new ShareError(403, "You cannot view that channel.");
    const parent = this.deps.store.taskThreads(server).find(task => task.thread === channel)?.parent ?? channel;
    if (!webTranscriptsEnabled(this.deps.store, server, parent)) throw new ShareError(403, "Web transcripts are off for this channel.");
    const found = await snapshotOf(this.deps.store, server, channel, { from, to, limit: MAX_SHARE_MESSAGES }, options);
    if ((from || to) && found.more) throw new ShareError(400, `Choose ${MAX_SHARE_MESSAGES} messages or fewer.`);
    if (!found.messages.length) throw new ShareError(400, "No messages in that range.");
    const created_at = this.now();
    const snapshot = { created_at, options, messages: found.messages };
    const id = randomBytes(16).toString("base64url");
    await this.deps.store.insertShare({ id, server, channel, created_by: user, created_at, revoked_at: null, body: JSON.stringify(snapshot) });
    return { id };
  }

  /** Public. Returns undefined for an unknown or revoked link. */
  async snapshot(id: string): Promise<ShareSnapshot | undefined> {
    if (!isShareId(id)) return undefined;
    const row = await this.deps.store.getShare(id);
    if (!row || row.revoked_at !== null) return undefined;
    // A private chat link works only while its owner is still in the home server. Otherwise it is not found.
    if (isPrivateChannel(row.channel) && !(await this.ownerIsMember(row.created_by, row.server))) return undefined;
    return { id: row.id, ...JSON.parse(row.body) as Omit<ShareSnapshot, "id"> };
  }

  /** Public HTML page for a live link, or undefined. */
  async page(id: string): Promise<string | undefined> {
    const snapshot = await this.snapshot(id);
    return snapshot ? renderSharePage(snapshot) : undefined;
  }

  async list(user: string, server: string): Promise<{ shares: { id: string; channel: string; created_at: number; revoked: boolean }[] }> {
    if (!snowflake.test(server)) throw new ShareError(400, "Invalid server.");
    await this.requireManager(user, server);
    const rows = await this.deps.store.listShares(server, 200);
    return { shares: rows.map(row => ({ id: row.id, channel: row.channel, created_at: row.created_at, revoked: row.revoked_at !== null })) };
  }

  async revoke(user: string, id: string): Promise<{ id: string; revoked: true }> {
    const row = isShareId(id) ? await this.deps.store.getShare(id) : undefined;
    // A private chat link is managed by its owner only (ChatShareService). Here it is simply not found.
    if (!row || isPrivateChannel(row.channel)) throw new ShareError(404, "Not found.");
    await this.requireManager(user, row.server);
    await this.deps.store.revokeShare(row.server, id, this.now());
    return { id, revoked: true };
  }

  async revokeAll(user: string, server: unknown): Promise<{ revoked: number }> {
    if (typeof server !== "string" || !snowflake.test(server)) throw new ShareError(400, "Invalid server.");
    await this.requireManager(user, server);
    return { revoked: await this.deps.store.revokeAllShares(server, this.now()) };
  }
}

/**
 * Share links of one private chat. The owner check is not here: WebChatService checks the owner and the
 * server membership first, then calls these. A chat link is a frozen copy, like a channel link.
 */
export class ChatShareService {
  private readonly now: () => number;
  constructor(private readonly store: Pick<ShareStore, "shareMessages" | "shareRequestEvents" | "insertShare" | "getShare" | "listChatShares" | "revokeShare" | "deleteChatShares">, now?: () => number) {
    this.now = now ?? Date.now;
  }

  /** Freezes the newest messages of the chat up to now, as a channel share does with no range. Later messages are not added. */
  async create(chat: { id: string; server: string }, user: string): Promise<{ id: string }> {
    const channel = privateChannel(chat.id);
    const found = await snapshotOf(this.store, chat.server, channel, { limit: MAX_SHARE_MESSAGES }, CHAT_SHARE_OPTIONS);
    if (!found.messages.length) throw new ShareError(400, "Send a message before you share this chat.");
    const created_at = this.now();
    const id = randomBytes(16).toString("base64url");
    const body = JSON.stringify({ created_at, options: CHAT_SHARE_OPTIONS, messages: found.messages });
    await this.store.insertShare({ id, server: chat.server, channel, created_by: user, created_at, revoked_at: null, body });
    return { id };
  }

  async list(chat: { id: string; server: string }): Promise<{ shares: { id: string; created_at: number; revoked: boolean }[] }> {
    const rows = await this.store.listChatShares(chat.server, privateChannel(chat.id), 200);
    return { shares: rows.map(row => ({ id: row.id, created_at: row.created_at, revoked: row.revoked_at !== null })) };
  }

  /** Revokes one link of this chat only. Any other link ID is 404. */
  async revoke(chat: { id: string; server: string }, id: string): Promise<{ id: string; revoked: true }> {
    const row = isShareId(id) ? await this.store.getShare(id) : undefined;
    if (!row || row.server !== chat.server || row.channel !== privateChannel(chat.id)) throw new ShareError(404, "Not found.");
    await this.store.revokeShare(chat.server, id, this.now());
    return { id, revoked: true };
  }

  /** Called when the chat is deleted. Its links stop working and their frozen copies are removed. */
  async removeChat(chat: { id: string }): Promise<void> {
    await this.store.deleteChatShares(privateChannel(chat.id));
  }
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, character => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[character]!);
}
const block = (text: string): string => escapeHtml(text).replace(/\r?\n/g, "<br>");

export function renderSharePage(snapshot: ShareSnapshot): string {
  const messages = snapshot.messages.map(message => {
    const time = message.at === undefined ? "" : `<time datetime="${escapeHtml(new Date(message.at).toISOString())}">${escapeHtml(new Date(message.at).toISOString().slice(0, 16).replace("T", " "))} UTC</time>`;
    const attachments = message.attachments ? `<p class="share-att">${"[attachment] ".repeat(message.attachments).trim()}</p>` : "";
    const tools = message.tools.length ? `<ul class="share-tools">${message.tools.map(tool => `<li>${escapeHtml(tool.status)}</li>`).join("")}</ul>` : "";
    const thinking = message.thinking ? `<details class="share-thinking"><summary>Thinking</summary><div>${block(message.thinking)}</div></details>` : "";
    return `<article class="share-msg${message.bot ? " bot" : ""}"><header><strong>${escapeHtml(message.author)}</strong>${message.bot ? '<span class="tag">Slopbot</span>' : ""}${time}</header><div class="share-text">${block(message.text)}</div>${attachments}${tools}${thinking}</article>`;
  }).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><meta name="referrer" content="no-referrer"><title>Shared conversation · Slopbot</title><link rel="icon" href="/console/assets/logo-light.svg"><link rel="stylesheet" href="/console/style.css"><link rel="stylesheet" href="/console/shares.css"></head><body class="share-page"><main class="share"><p class="eyebrow">Shared from Slopbot</p><h1>Shared conversation</h1><p class="small">This is a frozen copy. Messages sent later are not included.</p><section class="share-list">${messages}</section></main></body></html>`;
}
