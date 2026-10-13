import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { logError } from "./errors.js";
import type { ChatGateway } from "./bot.js";
import type { Message } from "./domain.js";
import type { ChannelAccess } from "./channel-access.js";
import type { MemberDirectory } from "./member-directory.js";
import type { UserLimiter } from "./user-limiter.js";
import { ToolError, stableOperationId } from "./tools.js";
import { requestTimings } from "./request-timing.js";
import { PRIVATE_CHAT_MAX_CHARS, PRIVATE_CHAT_TITLE_CHARS, newPrivateChatId, privateChannel, privateChatTitle } from "./private-chat.js";
import { publishMessage, runEvents, slopbotId, type ConversationEventStore, type RunEvents } from "./run-events.js";
import { messageViews, openStream, type TranscriptStore } from "./web-transcripts.js";
import type { WebChatRow } from "./web-chat-store.js";

/** Store calls for private chats. SQLite and Postgres implement them. */
export interface ChatStore extends TranscriptStore, ConversationEventStore {
  ingest(message: Message): Promise<boolean>;
  insertWebChat(row: WebChatRow): Promise<void>;
  webChat(id: string): Promise<WebChatRow | undefined>;
  webChats(server: string, owner: string): Promise<WebChatRow[]>;
  renameWebChat(id: string, title: string, updated: number): Promise<void>;
  touchWebChat(id: string, updated: number): Promise<void>;
  deleteWebChat(id: string, server: string, channel: string, at: number): Promise<void>;
  setting(server: string, key: string): unknown;
}

/** What the Discord side gives the chat service for one server. */
export interface PrivateChatHandle {
  openChat(channel: string): void;
  closeChat(channel: string): void;
  /** Hands a message that is already saved to the bot. The limit is checked by the service first. */
  receiveChat(message: Message): Promise<void>;
}

export interface ChatHost {
  /** True when the user and Slopbot are both in the server. */
  member(user: string, server: string): Promise<boolean>;
  handle(server: string): Promise<PrivateChatHandle | undefined>;
  limiter: Pick<UserLimiter, "check">;
  access: ChannelAccess;
  members?: Pick<MemberDirectory, "profiles">;
}

/** An error with the HTTP status the route sends. resetAt is set for a usage limit. */
export class ChatError extends Error {
  override name = "ChatError";
  constructor(readonly status: number, message: string, readonly resetAt?: number) { super(message); }
}

const CHAT_ID = /^[0-9a-f]{32}$/;
const SNOWFLAKE = /^\d{17,20}$/;
const MESSAGE_ID = /^[\w:.-]{1,64}$/;

/** Replies that Slopbot posts in a private chat. They are saved and published, never sent to Discord. */
export class WebChatGateway implements ChatGateway {
  constructor(private readonly store: Pick<ChatStore, "setting" | "taskThreads" | "requestRunIds" | "replyRunIds">, private readonly server: string) {}

  async reply(message: Message, text: string, deliveryId?: string): Promise<readonly Message[]> {
    const output: Message = {
      id: `chat-reply-${deliveryId ? stableOperationId(deliveryId) : randomUUID()}`,
      server: this.server, channel: message.channel,
      author: slopbotId(this.store, this.server) ?? "slopbot", authorName: "Slopbot", isBot: true,
      text, timestamp: Date.now(), addressed: false,
    };
    const runIds = await this.store.requestRunIds(this.server, message.id);
    await publishMessage(this.store, output, runIds);
    requestTimings.finish(message);
    return [output];
  }
  typing(): () => void { return () => undefined; }
  async createTaskThread(): Promise<string> { throw new ToolError("Not available in private chats."); }
  async react(): Promise<void> { /* Private chats have no reactions. */ }
}

/** The private chat API: list, create, rename, delete, messages, live stream and send. Every call checks the owner and the server membership. */
export class WebChatService {
  constructor(private readonly store: ChatStore, private readonly host: ChatHost, private readonly bus: RunEvents = runEvents, private readonly now: () => number = Date.now) {}

  async list(user: string, server: string): Promise<{ id: string; title: string; updated: number }[]> {
    await this.requireMember(user, server);
    return (await this.store.webChats(server, user)).map(chat => ({ id: chat.id, title: chat.title, updated: chat.updated }));
  }

  async create(user: string, server: string): Promise<{ id: string }> {
    await this.requireMember(user, server);
    const handle = await this.handle(server);
    const id = newPrivateChatId(), at = this.now();
    await this.store.insertWebChat({ id, server, owner: user, title: "", created: at, updated: at, deleted: false });
    handle.openChat(privateChannel(id));
    return { id };
  }

  async rename(user: string, id: string, raw: unknown): Promise<void> {
    const chat = await this.owned(user, id);
    const title = typeof raw === "string" ? raw.replace(/\s+/g, " ").trim() : "";
    if (!title || [...title].length > PRIVATE_CHAT_TITLE_CHARS) throw new ChatError(400, `Write a title of 1 to ${PRIVATE_CHAT_TITLE_CHARS} characters.`);
    await this.store.renameWebChat(chat.id, title, this.now());
  }

  async remove(user: string, id: string): Promise<void> {
    const chat = await this.owned(user, id);
    const channel = privateChannel(chat.id);
    (await this.handle(chat.server)).closeChat(channel);
    await this.store.deleteWebChat(chat.id, chat.server, channel, this.now());
    // Wakes open streams, which then see that the chat is gone and close.
    this.bus.changed(chat.server);
  }

  async messages(user: string, id: string, limit: number, before: string | null): Promise<{ messages: unknown[]; hasMore: boolean; streamId: number }> {
    const chat = await this.owned(user, id);
    const channel = privateChannel(chat.id);
    const streamId = await this.store.latestStreamId(chat.server, channel);
    let cursor: { time: number; id: string } | undefined;
    if (before !== null) {
      if (!MESSAGE_ID.test(before)) throw new ChatError(400, "Invalid cursor.");
      const found = await this.store.canonicalMessage(chat.server, before);
      if (!found || found.channel !== channel) throw new ChatError(400, "That message is no longer stored. Reload the chat.");
      cursor = { time: found.timestamp ?? 0, id: found.id };
    }
    const rows = await this.store.conversationMessages(chat.server, channel, cursor, limit + 1);
    return {
      messages: await messageViews(this.store, this.host.members, chat.server, rows.slice(0, limit).reverse()),
      hasMore: rows.length > limit,
      streamId,
    };
  }

  /** Saves the user message, publishes it, then lets the bot answer. The usage limit is checked before anything is saved. */
  async send(user: string, id: string, raw: unknown): Promise<{ id: string }> {
    const chat = await this.owned(user, id);
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text) throw new ChatError(400, "Write a message.");
    if ([...text].length > PRIVATE_CHAT_MAX_CHARS) throw new ChatError(400, `Write ${PRIVATE_CHAT_MAX_CHARS} characters or fewer.`);
    const limit = await this.host.limiter.check(chat.server, user);
    if (!limit.allowed) throw new ChatError(429, "Usage limit reached.", limit.resetAt);
    const handle = await this.handle(chat.server);
    const channel = privateChannel(chat.id), at = this.now();
    const name = (await this.host.members?.profiles(chat.server, [user]))?.get(user)?.displayName ?? user;
    const message: Message = { id: `chat-${randomUUID()}`, server: chat.server, channel, author: user, authorName: name, text, timestamp: at, addressed: true, source: "web" };
    await this.store.ingest(message);
    if (chat.title) await this.store.touchWebChat(chat.id, at); else await this.store.renameWebChat(chat.id, privateChatTitle(text), at);
    await publishMessage(this.store, message, undefined, this.host.members);
    void handle.receiveChat(message).catch(error => logError("web_chat_receive_failed", error, { server: chat.server, channel, messageId: message.id }));
    return { id: message.id };
  }

  /** Opens the live stream of one chat. Throws ChatError before the stream starts, so the route can still send an error. */
  async openStream(req: IncomingMessage, res: ServerResponse, user: string, id: string): Promise<void> {
    const chat = await this.owned(user, id);
    const channel = privateChannel(chat.id);
    const raw = Number(req.headers["last-event-id"] ?? new URL(req.url || "/", "http://local").searchParams.get("after") ?? 0);
    const cursor = Number.isSafeInteger(raw) && raw >= 0 ? raw : 0;
    res.writeHead(200, { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-cache, no-transform", Connection: "keep-alive", "X-Accel-Buffering": "no" });
    res.write("retry: 3000\n\n");
    const stop = openStream({
      server: chat.server, channel, user, cursor, store: this.store, bus: this.bus, access: this.host.access,
      allowed: async () => { try { await this.owned(user, id); return true; } catch { return false; } },
      write: text => { res.write(text); },
      end: () => { res.end(); },
    });
    res.on("close", () => stop());
  }

  /** The chat, when the user owns it and is still in its server. Anything else is a 404. */
  private async owned(user: string, id: string): Promise<WebChatRow> {
    const chat = CHAT_ID.test(id) ? await this.store.webChat(id) : undefined;
    if (!chat || chat.deleted || chat.owner !== user) throw new ChatError(404, "Not found.");
    await this.requireMember(user, chat.server);
    return chat;
  }
  private async requireMember(user: string, server: string): Promise<void> {
    if (!SNOWFLAKE.test(server) || !await this.host.member(user, server)) throw new ChatError(404, "Not found.");
  }
  private async handle(server: string): Promise<PrivateChatHandle> {
    const handle = await this.host.handle(server);
    if (!handle) throw new ChatError(404, "Not found.");
    return handle;
  }
}

/** Route handler for /api/chats. The console checks the session and CSRF before it calls this. */
export interface ChatRoutes {
  handles(path: string): boolean;
  handle(req: IncomingMessage, res: ServerResponse, url: URL, user: string, body: unknown): Promise<void>;
}

export function createChatRoutes(service: WebChatService): ChatRoutes {
  const json = (res: ServerResponse, status: number, value: unknown) => { res.writeHead(status, { "Content-Type": "application/json" }); res.end(JSON.stringify(value)); };
  const fail = (res: ServerResponse, error: unknown) => {
    if (error instanceof ChatError) return json(res, error.status, { error: error.message, ...(error.resetAt !== undefined ? { resetAt: error.resetAt } : {}) });
    logError("web_chat_failed", error, { stage: "web chats" });
    if (!res.headersSent) json(res, 502, { error: "Could not complete this chat request." });
    else res.end();
  };
  return {
    handles: path => path === "/api/chats" || path.startsWith("/api/chats/"),
    async handle(req, res, url, user, body) {
      try {
        const parts = url.pathname.split("/").slice(2);
        const input = (body && typeof body === "object" ? body : {}) as Record<string, unknown>;
        if (parts.length === 1) {
          if (req.method === "GET") return json(res, 200, await service.list(user, url.searchParams.get("server") ?? ""));
          if (req.method === "POST") return json(res, 201, await service.create(user, String(input.server ?? "")));
        }
        const id = parts[1] ?? "";
        if (parts.length === 2) {
          if (req.method === "PATCH") { await service.rename(user, id, input.title); return json(res, 200, { ok: true }); }
          if (req.method === "DELETE") { await service.remove(user, id); return json(res, 200, { ok: true }); }
        }
        if (parts.length === 3 && parts[2] === "messages") {
          if (req.method === "GET") {
            const raw = url.searchParams.get("limit");
            const limit = raw === null || raw === "" ? 50 : Number(raw);
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ChatError(400, "Invalid limit.");
            return json(res, 200, await service.messages(user, id, limit, url.searchParams.get("before")));
          }
          if (req.method === "POST") return json(res, 201, await service.send(user, id, input.text));
        }
        if (parts.length === 3 && parts[2] === "stream" && req.method === "GET") return await service.openStream(req, res, user, id);
        return json(res, 404, { error: "Not found." });
      } catch (error) { fail(res, error); }
    },
  };
}
