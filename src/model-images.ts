import type { Attachment, Message } from "./domain.js";
import { CHAT_IMAGE_SCHEME } from "./web-chat-images.js";

/** One image the model gets as image input. `url` is fetched and inlined by the chat adapter; never shown as text. */
export interface ModelImage { readonly url: string; readonly label: string }

/** Most images given to one run as image input (request, reply target, same author's recent messages). */
export const RUN_IMAGE_LIMIT = 4;
/** A message from the same author this close before the request counts as part of it. */
export const RUN_IMAGE_WINDOW_MS = 2 * 60_000;

const IMAGE_NAME = /\.(png|jpe?g|gif|webp)$/i;

/** An authored image: a web chat image, or a Discord attachment with an image type or name. Link previews are never images of the message. */
export function isImageAttachment(attachment: Attachment): boolean {
  if (attachment.preview) return false;
  if (attachment.url.startsWith(CHAT_IMAGE_SCHEME)) return true;
  return attachment.contentType ? attachment.contentType.startsWith("image/") : IMAGE_NAME.test(attachment.name);
}

/**
 * Gives a link the model adapter can fetch now, for one image of a stored message.
 * Discord: a freshly signed CDN URL (the stored URL may have expired). Web chats: a short-lived storage link.
 * Undefined when the message or the image is gone.
 */
export interface ImageSource {
  link(message: Message, attachment: Attachment): Promise<string | undefined>;
}
