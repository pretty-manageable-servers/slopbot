import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from "node:crypto";
import { logError } from "./errors.js";
import type { Incoming } from "./bot.js";
import type { ChannelAccess } from "./channel-access.js";
import type { UserLimiter } from "./user-limiter.js";

/** How long a buffered webhook event waits for its web reply post to return. */
export const WEB_REPLY_WAIT_MS = 10_000;
export const WEBHOOK_NAME = "Slopbot web replies";
const TIMED_OUT = Symbol("timed out");

export type WebReplyStatus = "pending" | "posted" | "failed";
export interface WebWebhookRow { server: string; channel: string; webhook_id: string; token_encrypted: string }
export interface WebReplyRow { id: string; server: string; channel: string; user_id: string; status: WebReplyStatus; message_id: string | null; created_at: number }
export interface WebAuthor { name: string; avatarURL: string; aliases: string[]; identity: Record<string, string> }
export interface WebOrigin { user: string; author: WebAuthor }
export interface WebHook { id: string; token: string }

/** Database rows for webhooks and web replies. Both SQLite and PostgreSQL implement it. */
export interface WebReplyStore {
  webWebhook(server: string, channel: string): WebWebhookRow | undefined | Promise<WebWebhookRow | undefined>;
  webWebhookByHook(server: string, webhookId: string): WebWebhookRow | undefined | Promise<WebWebhookRow | undefined>;
  saveWebWebhook(row: WebWebhookRow): void | Promise<void>;
  insertWebReply(row: WebReplyRow): void | Promise<void>;
  /** Changes only a pending row. Returns false when the row was already settled. */
  finishWebReply(id: string, status: "posted" | "failed", messageId?: string): boolean | Promise<boolean>;
  webReplyByMessage(server: string, messageId: string): WebReplyRow | undefined | Promise<WebReplyRow | undefined>;
}

/** The Discord calls that web replies need. discord-web-replies.ts implements them. */
export interface WebReplyDiscord {
  /** The channel a message lands in. For a thread, `parent` is the text channel that owns its webhook. */
  channel(server: string, channel: string): Promise<{ parent: string; thread: boolean } | undefined>;
  member(server: string, user: string): Promise<WebAuthor | undefined>;
  createWebhook(parent: string): Promise<WebHook>;
  deleteWebhook(parent: string, id: string): Promise<void>;
  /** Posts with wait=true and returns the exact message ID that Discord made. */
  send(hook: WebHook, post: { text: string; username: string; avatarURL: string; threadId?: string }): Promise<string>;
}

export class WebReplyError extends Error {
  override name = "WebReplyError";
  constructor(readonly status: number, message: string, readonly resetAt?: number) { super(message); }
}

type PostResult = { ok: true; messageId: string; user: string; author: WebAuthor } | { ok: false };
interface Post { done: Promise<PostResult>; expire(): Promise<void> }

/** Reads WEB_REPLY_KEY: 32 bytes, base64. A missing or bad key turns web replies off. */
export function webReplyKey(env: NodeJS.ProcessEnv = process.env): { key: Buffer } | { error: string } {
  if (!env.WEB_REPLY_KEY) return { error: "Web replies are disabled. Set WEB_REPLY_KEY to 32 random bytes, base64 encoded." };
  const key = Buffer.from(env.WEB_REPLY_KEY, "base64");
  if (key.length !== 32) return { error: "Web replies are disabled. WEB_REPLY_KEY must decode to 32 bytes." };
  return { key };
}

/** AES-256-GCM. The stored value is base64 of iv (12 bytes), tag (16 bytes) and ciphertext. */
export function sealToken(key: Buffer, token: string): string {
  const iv = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, iv);
  const body = Buffer.concat([cipher.update(token, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString("base64");
}
export function openToken(key: Buffer, sealed: string): string {
  const data = Buffer.from(sealed, "base64");
  const decipher = createDecipheriv("aes-256-gcm", key, data.subarray(0, 12));
  decipher.setAuthTag(data.subarray(12, 28));
  return Buffer.concat([decipher.update(data.subarray(28)), decipher.final()]).toString("utf8");
}

/** The message as a real user's. Used only for a webhook message that matched its exact returned ID. */
export function asWebUser(message: Incoming, origin: WebOrigin): Incoming {
  return { ...message, author: origin.user, authorName: origin.author.name, authorAliases: origin.author.aliases, authorIdentity: origin.author.identity, isBot: false, botAuthor: false, addressed: true, source: "web" };
}

export interface WebRepliesOptions {
  store: WebReplyStore;
  discord: WebReplyDiscord;
  access: Pick<ChannelAccess, "check">;
  limiter: Pick<UserLimiter, "check">;
  secret: { key: Buffer } | { error: string };
  /** The web transcript switch for a text channel (threads pass their parent). */
  enabled(parent: string): boolean;
  /** Slopbot answers in this channel or thread. */
  accepts(channel: string): boolean;
  waitMs?: number;
  now?: () => number;
}

/** Posts web replies through channel webhooks and recognises them when Discord sends the event back. */
export class WebReplies {
  private readonly inFlight = new Map<string, Set<Post>>();
  private readonly hooks = new Map<string, Promise<WebHook>>();
  private readonly waitMs: number;
  private readonly now: () => number;
  constructor(private readonly options: WebRepliesOptions) {
    this.waitMs = options.waitMs ?? WEB_REPLY_WAIT_MS;
    this.now = options.now ?? Date.now;
  }
  private get store(): WebReplyStore { return this.options.store; }
  private get discord(): WebReplyDiscord { return this.options.discord; }

  /** Checks in this order, then posts. Nothing is posted when a check fails. */
  async reply(input: { user: string; server: string; channel: string; text: string }): Promise<{ id: string; messageId: string; status: "posted" | "failed" }> {
    const { user, server, channel } = input;
    const secret = this.options.secret;
    if (!("key" in secret)) throw new WebReplyError(503, secret.error);
    const target = await this.discord.channel(server, channel);
    if (!target) throw new WebReplyError(403, "Slopbot cannot see that channel.");
    if (!this.options.enabled(target.parent)) throw new WebReplyError(403, "Web transcripts are off for this channel.");
    if (!this.options.accepts(channel)) throw new WebReplyError(403, "Slopbot does not answer in this channel.");
    if (!(await this.options.access.check(server, channel, user)).send) throw new WebReplyError(403, "You cannot send messages in this channel.");
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text || [...text].length > 2000) throw new WebReplyError(400, "Write 1 to 2000 characters.");
    const limit = await this.options.limiter.check(server, user);
    if (!limit.allowed) throw new WebReplyError(429, "Usage limit reached.", limit.resetAt);
    const author = await this.discord.member(server, user);
    if (!author) throw new WebReplyError(403, "You are not a member of this server.");
    const hook = await this.hookFor(server, target.parent);

    const id = randomUUID();
    await this.store.insertWebReply({ id, server, channel, user_id: user, status: "pending", message_id: null, created_at: this.now() });
    let finish!: (result: PostResult) => void;
    const post: Post = {
      done: new Promise<PostResult>(resolve => { finish = resolve; }),
      expire: async () => { await this.store.finishWebReply(id, "failed"); },
    };
    this.track(channel, post);
    let outcome: PostResult = { ok: false };
    try {
      const messageId = await this.discord.send(hook, { text, username: author.name, avatarURL: author.avatarURL, ...(target.thread ? { threadId: channel } : {}) });
      outcome = { ok: true, messageId, user, author };
    } catch (error) {
      logError("web_reply_post_failed", error, { stage: "web reply post", server, channel });
    }
    let status: "posted" | "failed" = "failed";
    try {
      // The row is written before waiters are released, so a late event can find it by message_id.
      const changed = await this.store.finishWebReply(id, outcome.ok ? "posted" : "failed", outcome.ok ? outcome.messageId : undefined);
      if (outcome.ok && changed) status = "posted";
      if (outcome.ok && !changed) logError("web_reply_posted_after_timeout", new Error("Web reply posted after its wait ended"), { server, channel, messageId: outcome.messageId }, true);
    } finally {
      this.untrack(channel, post);
      finish(outcome);
    }
    if (!outcome.ok) throw new WebReplyError(502, "Discord did not accept the reply.");
    // "failed" here means Discord has the message, but Slopbot will not answer it.
    return { id, messageId: outcome.messageId, status };
  }

  /**
   * Decides whether a webhook message is a web reply. Returns the user only when the exact
   * message ID matches a row that Slopbot posted (or is posting now). Anything else is a bot message.
   */
  async origin(event: { server: string; channel: string; id: string; webhookId: string }): Promise<WebOrigin | undefined> {
    if (!(await this.store.webWebhookByHook(event.server, event.webhookId))) return undefined;
    // Take the in-flight snapshot before the database lookup. A post that finishes in between is then seen by one of the two.
    const posts = [...(this.inFlight.get(event.channel) ?? [])];
    const row = await this.store.webReplyByMessage(event.server, event.id);
    if (row && row.status === "posted" && row.channel === event.channel) {
      const author = await this.discord.member(event.server, row.user_id);
      return author ? { user: row.user_id, author } : undefined;
    }
    if (!posts.length) return undefined;
    const hit = await this.until(posts, event.id);
    if (hit === TIMED_OUT) {
      for (const post of posts) await post.expire();
      return undefined;
    }
    return hit ? { user: hit.user, author: hit.author } : undefined;
  }

  /** Deletes a channel's web webhook and makes a new one. Old tokens stop working. */
  async rotateWebhook(server: string, channel: string): Promise<{ webhookId: string }> {
    const secret = this.options.secret;
    if (!("key" in secret)) throw new WebReplyError(503, secret.error);
    const old = await this.store.webWebhook(server, channel);
    if (old) await this.discord.deleteWebhook(channel, old.webhook_id);
    const created = await this.discord.createWebhook(channel);
    await this.store.saveWebWebhook({ server, channel, webhook_id: created.id, token_encrypted: sealToken(secret.key, created.token) });
    return { webhookId: created.id };
  }

  /** Resolves with the first matching ok result, undefined when every post settles without a match, or TIMED_OUT. */
  private until(posts: Post[], messageId: string): Promise<Extract<PostResult, { ok: true }> | undefined | typeof TIMED_OUT> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const matched = new Promise<Extract<PostResult, { ok: true }> | undefined>(resolve => {
      let left = posts.length;
      for (const post of posts) void post.done.then(result => {
        if (result.ok && result.messageId === messageId) resolve(result);
        if (--left === 0) resolve(undefined);
      });
    });
    const timeout = new Promise<typeof TIMED_OUT>(resolve => { timer = setTimeout(() => resolve(TIMED_OUT), this.waitMs); });
    return Promise.race([matched, timeout]).finally(() => clearTimeout(timer));
  }

  private track(channel: string, post: Post): void {
    const set = this.inFlight.get(channel) ?? new Set<Post>();
    set.add(post); this.inFlight.set(channel, set);
  }
  private untrack(channel: string, post: Post): void {
    const set = this.inFlight.get(channel);
    if (!set) return;
    set.delete(post);
    if (!set.size) this.inFlight.delete(channel);
  }

  /** One webhook per text channel. Concurrent first replies share one create. */
  private hookFor(server: string, parent: string): Promise<WebHook> {
    const key = JSON.stringify([server, parent]);
    const existing = this.hooks.get(key);
    if (existing) return existing;
    const pending = this.loadOrCreateHook(server, parent).finally(() => { this.hooks.delete(key); });
    this.hooks.set(key, pending);
    return pending;
  }
  private async loadOrCreateHook(server: string, parent: string): Promise<WebHook> {
    const secret = this.options.secret;
    if (!("key" in secret)) throw new WebReplyError(503, secret.error);
    const row = await this.store.webWebhook(server, parent);
    if (row) return { id: row.webhook_id, token: openToken(secret.key, row.token_encrypted) };
    const created = await this.discord.createWebhook(parent);
    await this.store.saveWebWebhook({ server, channel: parent, webhook_id: created.id, token_encrypted: sealToken(secret.key, created.token) });
    return created;
  }
}
