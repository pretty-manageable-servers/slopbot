import { randomBytes } from "node:crypto";
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { Attachment } from "./domain.js";
import type { ObjectStorageProvider } from "./object-storage.js";

/** Most images in one message. */
export const CHAT_IMAGE_MAX_COUNT = 10;
/** Largest image in bytes. */
export const CHAT_IMAGE_MAX_BYTES = 25 * 1024 * 1024;
/** Prefix of the attachment URL that marks a stored chat image. The rest is the image ID. */
export const CHAT_IMAGE_SCHEME = "web-image:";
/** The image IDs are 32 hex characters and the extension of the real type. */
export const CHAT_IMAGE_ID = /^[0-9a-f]{32}\.(png|jpg|gif|webp)$/;

const TYPES = { png: "image/png", jpg: "image/jpeg", gif: "image/gif", webp: "image/webp" } as const;
type Extension = keyof typeof TYPES;

/** The image type from the first bytes, or undefined when it is not an allowed image. The declared type is never trusted. */
export function sniffImage(bytes: Uint8Array): { extension: Extension; contentType: string } | undefined {
  const at = (offset: number, text: string) => [...text].every((char, index) => bytes[offset + index] === char.charCodeAt(0));
  let extension: Extension | undefined;
  if (bytes.length >= 8 && bytes[0] === 0x89 && at(1, "PNG") && bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) extension = "png";
  else if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) extension = "jpg";
  else if (bytes.length >= 6 && (at(0, "GIF87a") || at(0, "GIF89a"))) extension = "gif";
  else if (bytes.length >= 12 && at(0, "RIFF") && at(8, "WEBP")) extension = "webp";
  return extension ? { extension, contentType: TYPES[extension] } : undefined;
}

export function newChatImageId(extension: string): string { return `${randomBytes(16).toString("hex")}.${extension}`; }
export function chatImageKey(server: string, chat: string, imageId: string): string { return `web-chats/${server}/${chat}/${imageId}`; }
export function chatImageContentType(imageId: string): string { return TYPES[imageId.slice(imageId.lastIndexOf(".") + 1) as Extension]; }

/** The image IDs a message keeps. The message row holds only this placeholder, never image bytes. */
export function imageAttachments(attachments: readonly Attachment[] | undefined): { imageId: string; name: string; contentType: string; size: number }[] {
  return (attachments ?? []).filter(item => item.url.startsWith(CHAT_IMAGE_SCHEME) && CHAT_IMAGE_ID.test(item.url.slice(CHAT_IMAGE_SCHEME.length)))
    .map(item => ({ imageId: item.url.slice(CHAT_IMAGE_SCHEME.length), name: item.name, contentType: item.contentType ?? "image/png", size: item.size ?? 0 }));
}

/** Clean file name for display: no path, no control characters, at most 100 characters. */
export function imageName(raw: string | null, extension: string): string {
  const base = (raw ?? "").split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100);
  return base || `image.${extension}`;
}

/** Disk storage for local development, when no object storage is set. Its link is a data URL, so it is for development only. */
export class LocalDiskStorage implements ObjectStorageProvider {
  private readonly root: string;
  constructor(root = "./data/web-chat-images") { this.root = resolve(root); }
  private path(key: string): string {
    const path = resolve(join(this.root, key));
    if (!path.startsWith(this.root + "/")) throw new Error("Invalid storage key");
    return path;
  }
  async put(key: string, bytes: Uint8Array): Promise<void> { const path = this.path(key); await mkdir(dirname(path), { recursive: true }); await writeFile(path, bytes); }
  async get(key: string): Promise<Uint8Array> { return readFile(this.path(key)); }
  async delete(key: string): Promise<void> { await rm(this.path(key), { force: true }); }
  async link(key: string): Promise<string> {
    const bytes = await this.get(key);
    return `data:${chatImageContentType(key)};base64,${Buffer.from(bytes).toString("base64")}`;
  }
}
