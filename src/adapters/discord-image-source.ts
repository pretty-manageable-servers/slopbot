import type { Attachment, Message } from "../domain.js";
import type { ImageSource } from "../model-images.js";
import type { ObjectStorageProvider } from "../object-storage.js";
import { discordChannelId, PRIVATE_CHANNEL_PREFIX } from "../private-chat.js";
import { CHAT_IMAGE_SCHEME, chatImageKey } from "../web-chat-images.js";

/** Lifetime of a web chat image link. Same as the link the web chat gives the model. */
const LINK_SECONDS = 900;

/** An attachment of a Discord message as Discord gives it now, with a fresh signed URL. */
export interface DiscordFile { name: string; url: string; contentType?: string }

/** Attachments of a Discord message now. Undefined when the message or its channel is gone. */
export type DiscordAttachments = (channelId: string, messageId: string) => Promise<DiscordFile[] | undefined>;

/** The attachment ID from a Discord CDN URL: /attachments/<channel>/<attachment>/<name>. */
const attachmentId = (url: string): string | undefined => /\/attachments\/\d+\/(\d+)\//.exec(url)?.[1];

/** Gives the model a link to a stored image: a fresh Discord CDN URL, or a storage link for a web chat image. */
export class DiscordImageSource implements ImageSource {
  constructor(private readonly deps: { attachments: DiscordAttachments; storage?: Pick<ObjectStorageProvider, "link"> }) {}
  async link(message: Message, attachment: Attachment): Promise<string | undefined> {
    try {
      if (attachment.url.startsWith(CHAT_IMAGE_SCHEME)) {
        if (!this.deps.storage || !message.channel.startsWith(PRIVATE_CHANNEL_PREFIX)) return undefined;
        const chat = message.channel.slice(PRIVATE_CHANNEL_PREFIX.length), imageId = attachment.url.slice(CHAT_IMAGE_SCHEME.length);
        return await this.deps.storage.link(chatImageKey(message.server, chat, imageId), attachment.name, LINK_SECONDS);
      }
      const id = attachmentId(attachment.url);
      const fresh = await this.deps.attachments(discordChannelId(message.channel), message.id);
      return (fresh?.find(item => id !== undefined && attachmentId(item.url) === id) ?? fresh?.find(item => item.name === attachment.name))?.url;
    } catch { return undefined; }
  }
}
