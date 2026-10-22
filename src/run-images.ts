import type { Attachment, Message } from "./domain.js";
import { isImageAttachment, RUN_IMAGE_LIMIT, RUN_IMAGE_WINDOW_MS, type ImageSource, type ModelImage } from "./model-images.js";

/**
 * The images one run gets as image input, most relevant first, at most RUN_IMAGE_LIMIT:
 * the request's own links, the request's attachments, the reply target's attachments,
 * then the same author's messages from the window before the request, newest first.
 * Stored attachments get a fresh link from the source. Missing or failing links are skipped.
 */
export async function selectRunImages(input: { request: Message; target?: Message | undefined; recent: readonly Message[]; source?: ImageSource | undefined }): Promise<ModelImage[]> {
  const { request, target, recent, source } = input;
  const images: ModelImage[] = [];
  const seen = new Set<string>();
  const full = () => images.length >= RUN_IMAGE_LIMIT;
  // Links the request already has (web chats) come first and cover its own attachments.
  for (const image of request.modelImages ?? []) if (!full()) images.push({ url: image.url, label: image.label });
  const fromStored = async (message: Message): Promise<void> => {
    for (const attachment of (message.attachments ?? []).filter(isImageAttachment)) {
      if (full()) return;
      const key = `${message.id}\n${attachment.url}`;
      if (seen.has(key) || !source) continue;
      seen.add(key);
      const url = await linkOf(source, message, attachment);
      if (url) images.push({ url, label: attachment.name });
    }
  };
  if (!request.modelImages?.length) await fromStored(request);
  if (target) await fromStored(target);
  const sameAuthor = recent
    .filter(message => message.id !== request.id && message.author === request.author && message.isBot !== true && message.timestamp !== undefined && request.timestamp !== undefined)
    .filter(message => { const gap = request.timestamp! - message.timestamp!; return gap >= 0 && gap <= RUN_IMAGE_WINDOW_MS; })
    .sort((a, b) => b.timestamp! - a.timestamp!);
  for (const message of sameAuthor) await fromStored(message);
  return images;
}

/** The fresh link of one stored image. Undefined when the source has none or throws. */
async function linkOf(source: ImageSource, message: Message, attachment: Attachment): Promise<string | undefined> {
  try { return await source.link(message, attachment); } catch { return undefined; }
}
