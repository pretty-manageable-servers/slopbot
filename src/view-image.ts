import type { Message } from "./domain.js";
import type { ToolRegistry } from "./tools.js";
import { isImageAttachment, type ImageSource } from "./model-images.js";
import type { SearchServices } from "./search/history-search.js";
import type { Store } from "./ports.js";

/** Messages listed in a miss, and how far back the list looks. */
const LIST_LIMIT = 5, LIST_WINDOW = 50;

const imagesOf = (message: Message) => (message.attachments ?? []).filter(isImageAttachment);
const clock = (ms?: number) => ms === undefined ? "unknown time" : new Date(ms).toISOString().slice(11, 16);
const authorOf = (message: Message) => message.authorName && !/^\d{17,20}$/.test(message.authorName) ? message.authorName : "a member";

/** view_image: shows an image of a message in this chat again. The link is fresh and only goes into this one tool result. */
export function registerViewImage(registry: ToolRegistry, deps: { store: Pick<SearchServices["store"], "readHistory"> & Pick<Store, "context">; images: ImageSource; authorize: SearchServices["authorize"] }): void {
  registry.register({ name: "view_image", surface: "top", access: "member", effect: "read", retrySafe: true,
    description: "Look at an image from a message in this chat. Use it when you need to see an earlier image again. Returns the image.",
    fields: {
      message_ref: { type: "message_ref", required: true, description: "Ref (like m7) or ID of the message with the image. Transcript lines with images show [images: …]." },
      index: { type: "integer", min: 1, max: 10, description: "Which image of the message, counting from 1. Default 1." },
    },
    execute: async (context, args) => {
      const channel = context.message.channel, server = context.message.server, id = String(args.message_ref);
      // Same channel check as history_read: an image is shown only when the requester can read the channel.
      await deps.authorize(context.message, channel);
      const load = async (ref: string) => (await deps.store.readHistory(server, channel, ref, 0)).find(item => item.id === ref);
      const found = await load(id);
      if (!found) return { text: "Message not found in this chat.", status: "rejected" };
      // A reply that points at the image message (the bot's own reply, for example) uses the replied-to message's images.
      let source = found, images = imagesOf(found), reply = false;
      if (!images.length && found.replyTo) {
        const target = await load(found.replyTo);
        if (target && imagesOf(target).length) { source = target; images = imagesOf(target); reply = true; }
      }
      if (!images.length) {
        // Newest first, from the messages before this request. A failed read lists nothing.
        const recent = await deps.store.context(context.message, LIST_WINDOW).catch(() => [] as readonly Message[]);
        const listed = recent.filter(item => imagesOf(item).length).slice(-LIST_LIMIT).reverse()
          .map(item => `${item.id} (${imagesOf(item).map(image => image.name).join(", ")}, by ${authorOf(item)} at ${clock(item.timestamp)})`).join(", ");
        return { text: listed ? `That message has no images. Messages with images in this chat: ${listed}. Call view_image with one of these IDs.` : "No message in this chat has images.", status: "rejected" };
      }
      const index = Number(args.index ?? 1);
      if (index > images.length) return { text: `Message ${source.id} has ${images.length} image${images.length === 1 ? "" : "s"}. Use index 1 to ${images.length}.`, status: "rejected" };
      const image = images[index - 1]!;
      const url = await deps.images.link(source, image);
      if (!url) return { text: "The image is no longer available.", status: "failed" };
      return { text: `Image ${image.name} from the message${reply ? " it replies to" : ""}.`, images: [{ url, label: image.name }] };
    },
  });
}
