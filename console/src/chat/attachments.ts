// Chat attachments: which route a file goes to, the limits the composer checks before it uploads, and the ids a
// message sends. The bot checks the same limits (src/web-chat-images.ts, src/web-chats.ts) and reads only these images.
import type { DraftAttachment } from "agentic-ui-kit";

export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
export const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
export const FILE_MAX_BYTES = 10 * 1024 * 1024;
export const ATTACHMENT_MAX_COUNT = 10;

export type AttachmentKind = "image" | "file";

/** Images go to the images route, where the model reads them. Other files go to the files route. */
export function attachmentKind(mime: string): AttachmentKind {
  return IMAGE_TYPES.includes(mime) ? "image" : "file";
}

/** Why a file cannot be attached, or null when it can. `count` is how many are already in the composer. */
export function attachmentProblem(file: { name: string; size: number; type: string }, count: number): string | null {
  const kind = attachmentKind(file.type);
  if (kind === "image" && file.size > IMAGE_MAX_BYTES) return `${file.name || "This image"} is larger than 25 MB.`;
  if (kind === "file" && file.size > FILE_MAX_BYTES) return `${file.name || "This file"} is larger than 10 MB.`;
  if (count >= ATTACHMENT_MAX_COUNT) return `Attach ${ATTACHMENT_MAX_COUNT} files or images or fewer.`;
  return null;
}

/** The ids a message sends: the ready drafts, images and files apart, in the order they were added. */
export function attachmentIds(drafts: Pick<DraftAttachment, "mime" | "status" | "fileId">[]): { images: string[]; files: string[] } {
  const ready = drafts.filter((d) => d.status === "ready" && d.fileId).map((d) => ({ id: d.fileId!, kind: attachmentKind(d.mime) }));
  return {
    images: ready.filter((d) => d.kind === "image").map((d) => d.id),
    files: ready.filter((d) => d.kind === "file").map((d) => d.id),
  };
}
