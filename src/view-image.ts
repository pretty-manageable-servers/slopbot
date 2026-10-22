import type { ToolRegistry } from "./tools.js";
import { isImageAttachment, type ImageSource } from "./model-images.js";
import type { SearchServices } from "./search/history-search.js";

/** view_image: shows an image of a message in this chat again. The link is fresh and only goes into this one tool result. */
export function registerViewImage(registry: ToolRegistry, deps: { store: Pick<SearchServices["store"], "readHistory">; images: ImageSource; authorize: SearchServices["authorize"] }): void {
  registry.register({ name: "view_image", surface: "top", access: "member", effect: "read", retrySafe: true,
    description: "Look at an image from a message in this chat. Use it when you need to see an earlier image again. Returns the image.",
    fields: {
      message_ref: { type: "message_ref", required: true, description: "Message ID of the message in this chat that holds the image." },
      index: { type: "integer", min: 1, max: 10, description: "Which image of the message, counting from 1. Default 1." },
    },
    execute: async (context, args) => {
      const channel = context.message.channel, id = String(args.message_ref);
      // Same channel check as history_read: an image is shown only when the requester can read the channel.
      await deps.authorize(context.message, channel);
      const found = (await deps.store.readHistory(context.message.server, channel, id, 0)).find(item => item.id === id);
      if (!found) return { text: "Message not found in this chat.", status: "rejected" };
      const images = (found.attachments ?? []).filter(isImageAttachment);
      if (!images.length) return { text: "That message has no images.", status: "rejected" };
      const index = Number(args.index ?? 1);
      if (index > images.length) return { text: `Message ${id} has ${images.length} image${images.length === 1 ? "" : "s"}. Use index 1 to ${images.length}.`, status: "rejected" };
      const image = images[index - 1]!;
      const url = await deps.images.link(found, image);
      if (!url) return { text: "The image is no longer available.", status: "failed" };
      return { text: `Image ${image.name} from the message.`, images: [{ url, label: image.name }] };
    },
  });
}
