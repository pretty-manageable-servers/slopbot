import { randomUUID } from "node:crypto";
import type { ChatGateway } from "../bot.js";
import type { Attachment, Message } from "../domain.js";
import type { ToolActivity } from "../tool-activity.js";
import type { UiDocument } from "../ui/schema.js";
import { prepareUi } from "../ui/runtime.js";
import type { RecordStore } from "../records.js";
import { ToolError, stableOperationId } from "../tools.js";
import { requestTimings } from "../request-timing.js";
import { PRIVATE_CHANNEL_PREFIX } from "../private-chat.js";
import { publishMessage, slopbotId } from "../run-events.js";
import { CHAT_IMAGE_SCHEME, chatImageKey, newChatImageId } from "../web-chat-images.js";
import { chatFileKey, fileUrl, newChatFileId } from "../web-chat-files.js";
import type { ObjectStorageProvider } from "../object-storage.js";
import { AttachQueue, runKey, type QueuedFile } from "../attach-file.js";

const IMAGE_EXTENSIONS: Record<string, "png" | "jpg" | "gif" | "webp"> = { "image/png": "png", "image/jpeg": "jpg", "image/gif": "gif", "image/webp": "webp" };

/** The store calls the gateway makes. The Discord client builds it for a server; the web client does not use it. */
export interface GatewayStore extends Pick<RecordStore, "record" | "putRecord"> {
  setting(server: string, key: string): unknown;
  taskThreads(server: string): { thread: string; parent: string }[];
  requestRunIds(server: string, requestId: string): Promise<string[]>;
  replyRunIds(server: string, messageId: string): Promise<string[]>;
}

/** Replies that Slopbot posts in a private chat. They are saved and published, never sent to Discord. */
export class WebChatGateway implements ChatGateway {
  constructor(private readonly store: GatewayStore, private readonly server: string, private readonly files?: { queue: AttachQueue; storage: ObjectStorageProvider }) {}

  /** Keeps one queued file in private storage and returns it as a chat attachment. Images show inline; other files are download links. */
  private async keep(chat: string, file: QueuedFile): Promise<Attachment> {
    const storage = this.files!.storage, size = file.bytes.length;
    const extension = IMAGE_EXTENSIONS[file.contentType];
    if (extension) {
      const imageId = newChatImageId(extension);
      await storage.put(chatImageKey(this.server, chat, imageId), file.bytes, file.contentType);
      return { name: file.name, url: CHAT_IMAGE_SCHEME + imageId, contentType: file.contentType, size };
    }
    const fileId = newChatFileId(file.name);
    await storage.put(chatFileKey(this.server, chat, fileId), file.bytes, file.contentType);
    return { name: file.name, url: fileUrl(this.server, chat, fileId), contentType: file.contentType, size };
  }

  /**
   * Saves the reply text. The web UI shows the tools in the run summary, so the Discord tool footer is not added.
   * Live tool progress is published by the bot's tool observer. A card is saved as a UI record under the reply ID, so it survives a reload.
   */
  async reply(message: Message, text: string, deliveryId?: string, _activity?: readonly ToolActivity[], ui?: UiDocument): Promise<readonly Message[]> {
    const queued = this.files?.queue.take(runKey(message.server, message.id)) ?? { files: [], links: [] };
    const chat = message.channel.slice(PRIVATE_CHANNEL_PREFIX.length);
    const attachments = await Promise.all(queued.files.map(file => this.keep(chat, file)));
    const links = queued.links.map(link => `[${link.name}](${link.url})${link.description ? ` — ${link.description}` : ""}`);
    const output: Message = {
      id: `chat-reply-${deliveryId ? stableOperationId(deliveryId) : randomUUID()}`,
      server: this.server, channel: message.channel,
      author: slopbotId(this.store, this.server) ?? "slopbot", authorName: "Slopbot", isBot: true,
      text: [text, ...links].filter(Boolean).join("\n\n"), timestamp: Date.now(), addressed: false,
      ...(attachments.length ? { attachments } : {}),
    };
    const runIds = await this.store.requestRunIds(this.server, message.id);
    const saved = ui ? await prepareUi(this.store, message, ui, output.id) : undefined;
    await publishMessage(this.store, output, runIds, undefined, saved && { id: saved.id, revision: saved.revision, document: saved.state.document });
    requestTimings.finish(message);
    return [output];
  }
  typing(): () => void { return () => undefined; }
  async createTaskThread(): Promise<string> { throw new ToolError("Not available in private chats."); }
  async react(): Promise<void> { /* Private chats have no reactions. */ }
}
