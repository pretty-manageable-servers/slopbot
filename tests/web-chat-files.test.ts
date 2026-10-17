import test from "node:test";
import assert from "node:assert/strict";
import { fileContentType, fileName, parseFileUrl } from "../src/web-chat-files.js";

const SERVER = "1528063444874432734", CHAT = "chat-1";
const FILE_ID = "0123456789abcdef0123456789abcdef.pdf";


test("parseFileUrl rejects ../ and extra slashes", () => {
  const fileId = FILE_ID;
  assert.equal(parseFileUrl(`web-file:../${CHAT}/${fileId}`), undefined);
  assert.equal(parseFileUrl(`web-file:${SERVER}/../${fileId}`), undefined);
  assert.equal(parseFileUrl(`web-file:${SERVER}/${CHAT}/${fileId}/x`), undefined);
  assert.equal(parseFileUrl(`web-file:${SERVER}//${fileId}`), undefined);
  assert.equal(parseFileUrl(`web-file:${SERVER}/${CHAT}`), undefined);
  assert.equal(parseFileUrl(`web-file:${SERVER}/${CHAT}/..%2F${fileId}`), undefined);
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
