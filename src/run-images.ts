import type { Attachment, Message } from "./domain.js";
import { isImageAttachment, RUN_IMAGE_LIMIT, RUN_IMAGE_WINDOW_MS, type ImageSource, type ModelImage } from "./model-images.js";

/**
 * The images one run gets as image input, most relevant first:
 * all of the request's own links, then all of the request's own attachments (when it has no links),
 * then, up to RUN_IMAGE_LIMIT in total, the reply target's attachments and then the same author's
 * messages from the window before the request, newest first.
 * Stored attachments get a fresh link from the source. Missing or failing links are skipped.
 */
export async function selectRunImages(input: { request: Message; target?: Message | undefined; recent: readonly Message[]; source?: ImageSource | undefined }): Promise<ModelImage[]> {
  const { request, target, recent, source } = input;
  const images: ModelImage[] = [];
  const seen = new Set<string>();
  // Links the request already has (web chats) come first and cover its own attachments. They are never capped.
  for (const image of request.modelImages ?? []) images.push({ url: image.url, label: image.label });
  // The request's own attachments are never capped; other messages only fill up to RUN_IMAGE_LIMIT.
  const fromStored = async (message: Message, capped: boolean): Promise<void> => {
    for (const attachment of (message.attachments ?? []).filter(isImageAttachment)) {
      if (capped && images.length >= RUN_IMAGE_LIMIT) return;
      const key = `${message.id}\n${attachment.url}`;
      if (seen.has(key) || !source) continue;
      seen.add(key);
      const url = await linkOf(source, message, attachment);
      if (url) images.push({ url, label: attachment.name });
    }
  };
  if (!request.modelImages?.length) await fromStored(request, false);
  if (target) await fromStored(target, true);
  const sameAuthor = recent
    .filter(message => message.id !== request.id && message.author === request.author && message.isBot !== true && message.timestamp !== undefined && request.timestamp !== undefined)
    .filter(message => { const gap = request.timestamp! - message.timestamp!; return gap >= 0 && gap <= RUN_IMAGE_WINDOW_MS; })
    .sort((a, b) => b.timestamp! - a.timestamp!);
  for (const message of sameAuthor) await fromStored(message, true);
  return images;
}

/** The fresh link of one stored image. Undefined when the source has none or throws. */
async function linkOf(source: ImageSource, message: Message, attachment: Attachment): Promise<string | undefined> {
  try { return await source.link(message, attachment); } catch { return undefined; }
}
