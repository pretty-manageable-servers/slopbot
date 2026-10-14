import { randomBytes } from "node:crypto";
import type { Attachment } from "./domain.js";
import type { ObjectStorageProvider } from "./object-storage.js";
import { DiscordFileFetcher, type FileFetcher } from "./files.js";
import { ToolError } from "./tools.js";

/** Largest file in bytes. */
export const CHAT_FILE_MAX_BYTES = 10 * 1024 * 1024;
/** Most attachments in one message, images and files together. Same value as CHAT_IMAGE_MAX_COUNT. */
export const CHAT_ATTACHMENT_MAX_COUNT = 10;
/** Attachment URL prefix. The rest is "<server>/<chat>/<fileId>", so the fetcher needs no message. */
export const CHAT_FILE_SCHEME = "web-file:";
/** 32 hex characters, then an optional extension of 1 to 10 lowercase letters or digits. */
export const CHAT_FILE_ID = /^[0-9a-f]{32}(\.[a-z0-9]{1,10})?$/;

const PART = /^[A-Za-z0-9_-]{1,64}$/;
const CONTENT_TYPE = /^[a-z0-9.+-]+\/[a-z0-9.+-]+$/;

export interface ChatFileView { fileId: string; name: string; contentType: string; size: number }

/** A new file ID. It keeps the lowercase extension of the clean name, when there is one. */
export function newChatFileId(name: string): string {
  const extension = fileName(name).toLowerCase().match(/\.([a-z0-9]{1,10})$/)?.[1];
  return `${randomBytes(16).toString("hex")}${extension ? `.${extension}` : ""}`;
}

export function chatFileKey(server: string, chat: string, fileId: string): string { return `web-chat-files/${server}/${chat}/${fileId}`; }

/** Clean file name for display: no path, no control characters, at most 100 characters. */
export function fileName(raw: string | null): string {
  const base = (raw ?? "").split(/[\\/]/).pop()!.replace(/[\u0000-\u001f\u007f]/g, "").trim().slice(0, 100);
  return base || "file";
}

/** The browser Content-Type when it has a plain type/subtype form, else application/octet-stream. */
export function fileContentType(raw: string | null | undefined): string {
  return raw && CONTENT_TYPE.test(raw) ? raw : "application/octet-stream";
}

export function fileUrl(server: string, chat: string, fileId: string): string { return `${CHAT_FILE_SCHEME}${server}/${chat}/${fileId}`; }

/** The parts of a web-file URL. Returns undefined for any other URL or any bad part. */
export function parseFileUrl(url: string): { server: string; chat: string; fileId: string } | undefined {
  if (!url.startsWith(CHAT_FILE_SCHEME)) return undefined;
  const parts = url.slice(CHAT_FILE_SCHEME.length).split("/");
  if (parts.length !== 3) return undefined;
  const [server, chat, fileId] = parts as [string, string, string];
  if (!PART.test(server) || !PART.test(chat) || !CHAT_FILE_ID.test(fileId)) return undefined;
  return { server, chat, fileId };
}

/** The file IDs a message keeps. The message row holds only this placeholder, never file bytes. */
export function fileAttachments(attachments: readonly Attachment[] | undefined): ChatFileView[] {
  return (attachments ?? []).flatMap(item => {
    const parsed = parseFileUrl(item.url);
    return parsed ? [{ fileId: parsed.fileId, name: item.name, contentType: fileContentType(item.contentType), size: item.size ?? 0 }] : [];
  });
}

/** Maps a storage read error to the chat file error. Other errors pass through, so a storage outage is not reported as a missing file. */
function readError(error: unknown): unknown {
  const message = error instanceof Error ? error.message : "";
  const code = error instanceof Error ? (error as { code?: unknown }).code : undefined;
  if (error instanceof Error && (error.name === "NoSuchKey" || code === "ENOENT" || message.startsWith("Stored object is missing"))) return new ToolError("File not found", "failed", { cause: error });
  if (message.includes("limited to 10 MiB")) return new ToolError("File exceeds 10 MiB", "failed", { cause: error });
  return error;
}

/** Reads web-file: URLs from chat storage. Hands every other URL to the inner fetcher. */
export class ChatFileFetcher implements FileFetcher {
  constructor(private readonly storage: ObjectStorageProvider, private readonly inner: FileFetcher = new DiscordFileFetcher()) {}
  async fetch(attachment: Attachment): Promise<Uint8Array> {
    if (!attachment.url.startsWith(CHAT_FILE_SCHEME)) return this.inner.fetch(attachment);
    const parsed = parseFileUrl(attachment.url);
    if (!parsed) throw new ToolError("File not found");
    if ((attachment.size ?? 0) > CHAT_FILE_MAX_BYTES) throw new ToolError("File exceeds 10 MiB");
    let bytes: Uint8Array;
    try { bytes = await this.storage.get(chatFileKey(parsed.server, parsed.chat, parsed.fileId), CHAT_FILE_MAX_BYTES); }
    catch (error) { throw readError(error); }
    if (bytes.length > CHAT_FILE_MAX_BYTES) throw new ToolError("File exceeds 10 MiB");
    return bytes;
  }
}
