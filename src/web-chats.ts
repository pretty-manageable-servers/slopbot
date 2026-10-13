import { randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { logError } from "./errors.js";
import type { ChatGateway } from "./bot.js";
import { parseEffort, type Effort, type Message } from "./domain.js";
import type { ToolActivity } from "./tool-activity.js";
import type { UiDocument } from "./ui/schema.js";
import type { ChannelAccess } from "./channel-access.js";
import type { MemberDirectory } from "./member-directory.js";
import type { UserLimiter } from "./user-limiter.js";
import { ToolError, stableOperationId } from "./tools.js";
import { requestTimings } from "./request-timing.js";
import { PRIVATE_CHANNEL_PREFIX, PRIVATE_CHAT_MAX_CHARS, PRIVATE_CHAT_TITLE_CHARS, isPrivateChannel, newPrivateChatId, privateChannel, privateChatTitle } from "./private-chat.js";
import { publishMessage, runEvents, slopbotId, type ConversationEventStore, type RunEvents } from "./run-events.js";
import { messageViews, openStream, type TranscriptStore } from "./web-transcripts.js";
import type { WebChatRow } from "./web-chat-store.js";
import { CHAT_IMAGE_ID, CHAT_IMAGE_MAX_BYTES, CHAT_IMAGE_MAX_COUNT, CHAT_IMAGE_SCHEME, LocalDiskStorage, chatImageContentType, chatImageKey, imageAttachments, imageName, newChatImageId, sniffImage } from "./web-chat-images.js";
import type { ObjectStorageProvider } from "./object-storage.js";
import { ChatShareService, ShareError, type ShareService, type ShareStore } from "./shares.js";

/** Store calls for private chats. SQLite and Postgres implement them. */
export interface ChatStore extends TranscriptStore, ConversationEventStore, ShareStore {
  ingest(message: Message): Promise<boolean>;
  insertWebChat(row: WebChatRow): Promise<void>;
  webChat(id: string): Promise<WebChatRow | undefined>;
  webChats(server: string, owner: string): Promise<WebChatRow[]>;
  renameWebChat(id: string, title: string, updated: number): Promise<void>;
  setWebChatEffort(id: string, effort: Effort | null): Promise<void>;
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
  /** Stops the responses in a channel that this user may stop. Returns how many stopped. */
  stopResponses(channel: string, user: string, manager: boolean): Promise<number>;
}

export interface ChatHost {
  /** True when the user and Slopbot are both in the server. */
  member(user: string, server: string): Promise<boolean>;
  handle(server: string): Promise<PrivateChatHandle | undefined>;
  limiter: Pick<UserLimiter, "check">;
  access: ChannelAccess;
  members?: Pick<MemberDirectory, "profiles">;
  /** Private storage for chat images. Without it, a local disk folder is used (development only). */
  images?: ObjectStorageProvider;
}

/** An error with the HTTP status the route sends. resetAt is set for a usage limit. */
export class ChatError extends Error {
  override name = "ChatError";
  constructor(readonly status: number, message: string, readonly resetAt?: number) { super(message); }
}

const CHAT_ID = /^[0-9a-f]{32}$/;
const SNOWFLAKE = /^\d{17,20}$/;
/** The model reads an image soon after the send. */
const MODEL_LINK_SECONDS = 900;
const PENDING_IMAGE_MS = 60 * 60 * 1000;
const MESSAGE_ID = /^[\w:.-]{1,64}$/;

/** Replies that Slopbot posts in a private chat. They are saved and published, never sent to Discord. */
export class WebChatGateway implements ChatGateway {
  constructor(private readonly store: Pick<ChatStore, "setting" | "taskThreads" | "requestRunIds" | "replyRunIds">, private readonly server: string) {}

  /**
   * Saves the reply text only. The web UI shows the tools in the run summary, so the Discord tool footer is not added.
   * Live tool progress is published by the bot's tool observer. A UI document has no place in a saved Message, so it is not kept here.
   */
  async reply(message: Message, text: string, deliveryId?: string, _activity?: readonly ToolActivity[], _ui?: UiDocument): Promise<readonly Message[]> {
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
  private readonly shares: ChatShareService;
  private readonly storage: ObjectStorageProvider;
  /** Images that are uploaded but not sent yet. A restart forgets them; their objects stay until the chat is deleted. */
  private readonly pending = new Map<string, { chat: string; user: string; name: string; contentType: string; size: number; at: number }>();
  constructor(private readonly store: ChatStore, private readonly host: ChatHost, private readonly bus: RunEvents = runEvents, private readonly now: () => number = Date.now) {
    this.shares = new ChatShareService(store, now);
    this.storage = host.images ?? new LocalDiskStorage();
  }

  async list(user: string, server: string): Promise<{ id: string; title: string; updated: number; effort: Effort }[]> {
    await this.requireMember(user, server);
    return (await this.store.webChats(server, user)).map(chat => ({ id: chat.id, title: chat.title, updated: chat.updated, effort: this.effortOf(chat) }));
  }

  /** The chat's own effort, else the server default, else medium. */
  private effortOf(chat: WebChatRow): Effort {
    return chat.effort ?? parseEffort(this.store.setting(chat.server, "default_effort")) ?? "medium";
  }

  /** Saves the chat's effort. null returns the chat to the server default. */
  async setEffort(user: string, id: string, raw: unknown): Promise<void> {
    const chat = await this.owned(user, id);
    const effort = raw === null ? null : parseEffort(raw);
    if (effort === undefined) throw new ChatError(400, "Choose low, medium or xhigh.");
    await this.store.setWebChatEffort(chat.id, effort);
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
    const handle = await this.handle(chat.server);
    // The chat's images go first. If this fails, the chat stays and the user can try again.
    await this.removeImages(chat);
    handle.closeChat(channel);
    // The chat's share links stop working and their frozen copies go with the chat.
    await this.shares.removeChat(chat);
    await this.store.deleteWebChat(chat.id, chat.server, channel, this.now());
    // Wakes open streams, which then see that the chat is gone and close.
    this.bus.changed(chat.server);
  }

  /** The owner's share links of this chat. Anyone else gets 404. */
  async shareList(user: string, id: string): Promise<{ shares: { id: string; created_at: number; revoked: boolean }[] }> {
    return this.shares.list(await this.owned(user, id));
  }

  /** A new link with a frozen copy of the chat's messages up to now. */
  async shareCreate(user: string, id: string): Promise<{ id: string }> {
    return this.shares.create(await this.owned(user, id), user);
  }

  /** Revokes one link of this chat. Anyone else gets 404. */
  async shareRevoke(user: string, id: string, shareId: string): Promise<{ id: string; revoked: true }> {
    return this.shares.revoke(await this.owned(user, id), shareId);
  }

  /**
   * Copies a live share into a new private chat of the signed-in user. The copied messages are saved in that chat,
   * so the model reads them as earlier history. An unknown or revoked share, or a private chat link whose owner left
   * the server, is 404 (the snapshot check). Images and tool lines are not copied.
   */
  async continueShare(user: string, shareId: string, shares: Pick<ShareService, "snapshot">): Promise<{ id: string; title: string }> {
    const row = await this.store.getShare(shareId);
    const copy = row ? await shares.snapshot(shareId) : undefined;
    if (!row || !copy) throw new ChatError(404, "Not found.");
    await this.requireMember(user, row.server);
    const handle = await this.handle(row.server);
    const id = newPrivateChatId(), channel = privateChannel(id), at = this.now();
    // A message with no text (only images) is not copied. Images are never copied.
    const messages = copy.messages.filter(item => item.text.trim());
    const title = privateChatTitle(messages[0]?.text ?? "");
    await this.store.insertWebChat({ id, server: row.server, owner: user, title, created: at, updated: at, deleted: false });
    const slopbot = slopbotId(this.store, row.server) ?? "slopbot";
    // Each copied row gets a new ID. Slopbot replies keep the Slopbot author, so the model reads them as its own answers.
    for (const [index, item] of messages.entries()) {
      const saved: Message = {
        id: `chat-share-${randomUUID()}`, server: row.server, channel,
        author: item.bot ? slopbot : `share:${shareId}:${index}`,
        authorName: item.bot ? "Slopbot" : item.author,
        ...(item.bot ? { isBot: true } : {}),
        text: item.text,
        timestamp: Math.min(item.at ?? at - messages.length + index, at - 1),
        addressed: false,
      };
      await this.store.ingest(saved);
    }
    handle.openChat(channel);
    return { id, title };
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
  async send(user: string, id: string, raw: unknown, rawImages: unknown = undefined): Promise<{ id: string }> {
    const chat = await this.owned(user, id);
    const ids = rawImages === undefined ? [] : rawImages;
    if (!Array.isArray(ids) || ids.length > CHAT_IMAGE_MAX_COUNT || new Set(ids).size !== ids.length) throw new ChatError(400, `Send ${CHAT_IMAGE_MAX_COUNT} images or fewer.`);
    const images = ids.map(imageId => {
      const found = typeof imageId === "string" ? this.pending.get(imageId) : undefined;
      if (!found || found.chat !== chat.id || found.user !== user) throw new ChatError(400, "An image was not found. Attach it again.");
      return { imageId: imageId as string, ...found };
    });
    const text = typeof raw === "string" ? raw.trim() : "";
    if (!text && !images.length) throw new ChatError(400, "Write a message.");
    const body = text || "Please look at the attached image" + (images.length > 1 ? "s." : ".");
    if ([...body].length > PRIVATE_CHAT_MAX_CHARS) throw new ChatError(400, `Write ${PRIVATE_CHAT_MAX_CHARS} characters or fewer.`);
    const limit = await this.host.limiter.check(user);
    if (!limit.allowed) throw new ChatError(429, "Usage limit reached.", limit.resetAt);
    const handle = await this.handle(chat.server);
    const channel = privateChannel(chat.id), at = this.now();
    const name = (await this.host.members?.profiles(chat.server, [user]))?.get(user)?.displayName ?? user;
    // The saved row keeps a placeholder per image (name, type, size, ID), never image bytes.
    const attachments = images.map(item => ({ name: item.name, url: CHAT_IMAGE_SCHEME + item.imageId, contentType: item.contentType, size: item.size }));
    const message: Message = { id: `chat-${randomUUID()}`, server: chat.server, channel, author: user, authorName: name, text: body, timestamp: at, addressed: true, source: "web", effort: this.effortOf(chat), ...(attachments.length ? { attachments } : {}) };
    // The model gets short-lived signed links, only in memory.
    const modelImages = await Promise.all(images.map(async item => ({ url: await this.storage.link(chatImageKey(chat.server, chat.id, item.imageId), item.name, MODEL_LINK_SECONDS), label: item.name })));
    await this.store.ingest(message);
    for (const item of images) this.pending.delete(item.imageId);
    if (chat.title) await this.store.touchWebChat(chat.id, at); else await this.store.renameWebChat(chat.id, privateChatTitle(text || images[0]!.name), at);
    await publishMessage(this.store, message, undefined, this.host.members);
    void handle.receiveChat(modelImages.length ? { ...message, modelImages } : message).catch(error => logError("web_chat_receive_failed", error, { server: chat.server, channel, messageId: message.id }));
    return { id: message.id };
  }

  /** Stores one uploaded image in private storage and returns its ID. The usage limit is checked first. The type comes from the bytes. */
  async uploadImage(user: string, id: string, bytes: Uint8Array, rawName: string | null): Promise<{ imageId: string; name: string; contentType: string; size: number }> {
    const chat = await this.owned(user, id);
    if (!bytes.length) throw new ChatError(400, "The image is empty.");
    if (bytes.length > CHAT_IMAGE_MAX_BYTES) throw new ChatError(413, "Images can be 25 MB or smaller.");
    const kind = sniffImage(bytes);
    if (!kind) throw new ChatError(415, "Use a PNG, JPEG, GIF or WebP image.");
    const at = this.now();
    for (const [key, item] of this.pending) if (at - item.at > PENDING_IMAGE_MS) { this.pending.delete(key); void this.storage.delete(chatImageKey(chat.server, item.chat, key)).catch(error => logError("web_chat_image_sweep_failed", error, { server: chat.server }, true)); }
    if ([...this.pending.values()].filter(item => item.chat === chat.id && item.user === user).length >= CHAT_IMAGE_MAX_COUNT) throw new ChatError(400, `Attach ${CHAT_IMAGE_MAX_COUNT} images or fewer.`);
    const limit = await this.host.limiter.check(user);
    if (!limit.allowed) throw new ChatError(429, "Usage limit reached.", limit.resetAt);
    const imageId = newChatImageId(kind.extension), name = imageName(rawName, kind.extension);
    await this.storage.put(chatImageKey(chat.server, chat.id, imageId), bytes, kind.contentType);
    this.pending.set(imageId, { chat: chat.id, user, name, contentType: kind.contentType, size: bytes.length, at });
    return { imageId, name, contentType: kind.contentType, size: bytes.length };
  }

  /** Removes an image that is uploaded but not sent. A sent image goes only with its chat. */
  async discardImage(user: string, id: string, imageId: string): Promise<void> {
    const chat = await this.owned(user, id);
    const found = this.pending.get(imageId);
    if (!found || found.chat !== chat.id || found.user !== user) throw new ChatError(404, "Not found.");
    this.pending.delete(imageId);
    await this.storage.delete(chatImageKey(chat.server, chat.id, imageId));
  }

  /** The bytes of one image of an owned chat. The key has the chat in it, so another chat's image is never reached. */
  async readImage(user: string, id: string, imageId: string): Promise<{ bytes: Uint8Array; contentType: string }> {
    const chat = await this.owned(user, id);
    if (!CHAT_IMAGE_ID.test(imageId)) throw new ChatError(404, "Not found.");
    const bytes = await this.storage.get(chatImageKey(chat.server, chat.id, imageId), CHAT_IMAGE_MAX_BYTES).catch(() => undefined);
    if (!bytes) throw new ChatError(404, "Not found.");
    return { bytes, contentType: chatImageContentType(imageId) };
  }

  /** Deletes every stored image of a chat: the sent ones (from the message rows) and the pending ones. */
  private async removeImages(chat: WebChatRow): Promise<void> {
    const channel = privateChannel(chat.id), ids = new Set<string>();
    for (const [imageId, item] of this.pending) if (item.chat === chat.id) ids.add(imageId);
    let cursor: { time: number; id: string } | undefined;
    for (;;) {
      const rows = await this.store.conversationMessages(chat.server, channel, cursor, 100);
      for (const row of rows) for (const item of imageAttachments(row.attachments)) ids.add(item.imageId);
      const last = rows.at(-1);
      if (rows.length < 100 || !last) break;
      cursor = { time: last.timestamp ?? 0, id: last.id };
    }
    for (const imageId of ids) { await this.storage.delete(chatImageKey(chat.server, chat.id, imageId)); this.pending.delete(imageId); }
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

  /** True when the user owns the private chat in this channel, and the chat is in this server. Errors count as no. */
  async owns(user: string, server: string, channel: string): Promise<boolean> {
    if (!isPrivateChannel(channel)) return false;
    return this.owned(user, channel.slice(PRIVATE_CHANNEL_PREFIX.length)).then(chat => chat.server === server, () => false);
  }

  /** The chat, when the user owns it and is still in its server. Anything else is a 404. */
  /** Stops the Slopbot response in a chat. Only the owner can open the chat, so the owner stops it. */
  async stop(user: string, id: string): Promise<{ stopped: number }> {
    const chat = await this.owned(user, id);
    const handle = await this.handle(chat.server);
    return { stopped: await handle.stopResponses(privateChannel(chat.id), user, false) };
  }

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
    if (error instanceof ShareError) return json(res, error.status, { error: error.message });
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
        if (parts[2] === "images") {
          if (parts.length === 3 && req.method === "POST" && Buffer.isBuffer(body)) return json(res, 201, await service.uploadImage(user, id, body, url.searchParams.get("name")));
          if (parts.length === 4 && req.method === "DELETE") { await service.discardImage(user, id, parts[3] ?? ""); return json(res, 200, { ok: true }); }
          if (parts.length === 4 && req.method === "GET") {
            const image = await service.readImage(user, id, parts[3] ?? "");
            res.writeHead(200, { "Content-Type": image.contentType, "Content-Length": image.bytes.length, "Cache-Control": "private, max-age=600", "X-Content-Type-Options": "nosniff" });
            return void res.end(image.bytes);
          }
        }
        if (parts.length === 2) {
          if (req.method === "PATCH") {
            if ("effort" in input) await service.setEffort(user, id, input.effort);
            if ("title" in input || !("effort" in input)) await service.rename(user, id, input.title);
            return json(res, 200, { ok: true });
          }
          if (req.method === "DELETE") { await service.remove(user, id); return json(res, 200, { ok: true }); }
        }
        if (parts.length === 3 && parts[2] === "messages") {
          if (req.method === "GET") {
            const raw = url.searchParams.get("limit");
            const limit = raw === null || raw === "" ? 50 : Number(raw);
            if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ChatError(400, "Invalid limit.");
            return json(res, 200, await service.messages(user, id, limit, url.searchParams.get("before") || null));
          }
          if (req.method === "POST") return json(res, 201, await service.send(user, id, input.text, input.images));
        }
        if (parts.length === 3 && parts[2] === "stop" && req.method === "POST") return json(res, 200, await service.stop(user, id));
        if (parts.length === 3 && parts[2] === "stream" && req.method === "GET") return await service.openStream(req, res, user, id);
        if (parts[2] === "shares") {
          if (parts.length === 3 && req.method === "GET") return json(res, 200, await service.shareList(user, id));
          if (parts.length === 3 && req.method === "POST") return json(res, 201, await service.shareCreate(user, id));
          if (parts.length === 5 && parts[4] === "revoke" && req.method === "POST") return json(res, 200, await service.shareRevoke(user, id, parts[3] ?? ""));
        }
        return json(res, 404, { error: "Not found." });
      } catch (error) { fail(res, error); }
    },
  };
}
