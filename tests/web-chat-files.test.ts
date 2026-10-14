import test from "node:test";
import assert from "node:assert/strict";
import { CHAT_FILE_ID, CHAT_FILE_MAX_BYTES, chatFileKey, ChatFileFetcher, fileAttachments, fileContentType, fileName, fileUrl, newChatFileId, parseFileUrl } from "../src/web-chat-files.js";
import type { ObjectStorageProvider } from "../src/object-storage.js";
import type { Attachment } from "../src/domain.js";
import { ToolError } from "../src/tools.js";

const SERVER = "1528063444874432734", CHAT = "chat-1";
const FILE_ID = "0123456789abcdef0123456789abcdef.pdf";

class FakeStorage implements ObjectStorageProvider {
  objects = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) { this.objects.set(key, bytes); }
  async get(key: string) { const found = this.objects.get(key); if (!found) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return found; }
  async delete(key: string) { this.objects.delete(key); }
  async link(key: string) { return `https://storage.example/${key}`; }
}

test("fileUrl round trip", () => {
  const url = fileUrl(SERVER, CHAT, FILE_ID);
  assert.equal(url, `web-file:${SERVER}/${CHAT}/${FILE_ID}`);
  assert.deepEqual(parseFileUrl(url), { server: SERVER, chat: CHAT, fileId: FILE_ID });
  assert.equal(CHAT_FILE_ID.test(FILE_ID), true);
  assert.equal(parseFileUrl(`web-image:${SERVER}/${CHAT}/${FILE_ID}`), undefined);
});

test("parseFileUrl rejects ../ and extra slashes", () => {
  const fileId = FILE_ID;
  assert.equal(parseFileUrl(`web-file:../${CHAT}/${fileId}`), undefined);
  assert.equal(parseFileUrl(`web-file:${SERVER}/../${fileId}`), undefined);
  assert.equal(parseFileUrl(`web-file:${SERVER}/${CHAT}/${fileId}/x`), undefined);
  assert.equal(parseFileUrl(`web-file:${SERVER}//${fileId}`), undefined);
  assert.equal(parseFileUrl(`web-file:${SERVER}/${CHAT}`), undefined);
  assert.equal(parseFileUrl(`web-file:${SERVER}/${CHAT}/..%2F${fileId}`), undefined);
});

test("newChatFileId keeps extension", () => {
  assert.match(newChatFileId("Report.PDF"), /^[0-9a-f]{32}\.pdf$/);
  assert.match(newChatFileId("archive.tar.gz"), /^[0-9a-f]{32}\.gz$/);
  assert.match(newChatFileId("../dir/data.csv"), /^[0-9a-f]{32}\.csv$/);
});

test("newChatFileId no extension", () => {
  assert.match(newChatFileId("README"), /^[0-9a-f]{32}$/);
  assert.match(newChatFileId(""), /^[0-9a-f]{32}$/);
  assert.match(newChatFileId("name.with-dash"), /^[0-9a-f]{32}$/);
  assert.match(newChatFileId("name.toolongextension"), /^[0-9a-f]{32}$/);
});

test("fileName strips path and control chars", () => {
  assert.equal(fileName("../../etc/passwd\u0000"), "passwd");
  assert.equal(fileName("C:\\Users\\x\\note\u0001.txt"), "note.txt");
  assert.equal(fileName("a\u0007\u007fb.txt"), "ab.txt");
  assert.equal(fileName(null), "file");
  assert.equal(fileName("dir/"), "file");
  assert.equal(fileName("x".repeat(150)).length, 100);
});

test("fileContentType accepts only a plain type", () => {
  assert.equal(fileContentType("application/pdf"), "application/pdf");
  assert.equal(fileContentType("text/plain; charset=utf-8"), "application/octet-stream");
  assert.equal(fileContentType("text/html\n"), "application/octet-stream");
  assert.equal(fileContentType(""), "application/octet-stream");
  assert.equal(fileContentType(undefined), "application/octet-stream");
});

test("fetcher reads web-file from storage", async () => {
  const storage = new FakeStorage();
  const bytes = new Uint8Array([1, 2, 3]);
  storage.objects.set(chatFileKey(SERVER, CHAT, FILE_ID), bytes);
  const attachment: Attachment = { name: "a.pdf", url: fileUrl(SERVER, CHAT, FILE_ID), size: 3 };
  assert.deepEqual(await new ChatFileFetcher(storage, { fetch: async () => { throw new Error("inner used"); } }).fetch(attachment), bytes);
  await assert.rejects(new ChatFileFetcher(storage).fetch({ name: "b.pdf", url: fileUrl(SERVER, CHAT, "f".repeat(32) + ".pdf") }), (error: unknown) => error instanceof ToolError && error.message === "File not found");
  await assert.rejects(new ChatFileFetcher(storage).fetch({ name: "c.pdf", url: fileUrl(SERVER, CHAT, FILE_ID), size: CHAT_FILE_MAX_BYTES + 1 }), (error: unknown) => error instanceof ToolError && error.message === "File exceeds 10 MiB");
  storage.objects.set(chatFileKey(SERVER, CHAT, FILE_ID), new Uint8Array(CHAT_FILE_MAX_BYTES + 1));
  await assert.rejects(new ChatFileFetcher(storage).fetch({ name: "d.pdf", url: fileUrl(SERVER, CHAT, FILE_ID) }), (error: unknown) => error instanceof ToolError && error.message === "File exceeds 10 MiB");
});

test("fetcher passes other urls to inner", async () => {
  const calls: Attachment[] = [];
  const inner = { fetch: async (attachment: Attachment) => { calls.push(attachment); return new Uint8Array([9]); } };
  const other: Attachment = { name: "x.txt", url: "https://cdn.discordapp.com/x.txt" };
  assert.deepEqual(await new ChatFileFetcher(new FakeStorage(), inner).fetch(other), new Uint8Array([9]));
  assert.deepEqual(calls, [other]);
});

test("fileAttachments ignores images", () => {
  const attachments: Attachment[] = [
    { name: "shot.png", url: `web-image:${"a".repeat(32)}.png`, contentType: "image/png", size: 5 },
    { name: "notes.txt", url: fileUrl(SERVER, CHAT, FILE_ID), contentType: "text/plain", size: 12 },
  ];
  assert.deepEqual(fileAttachments(attachments), [{ fileId: FILE_ID, name: "notes.txt", contentType: "text/plain", size: 12 }]);
  assert.deepEqual(fileAttachments(undefined), []);
});
