import assert from "node:assert/strict";
import { test } from "node:test";
import { wireMessages } from "../src/adapters/chat-completions.js";
import { DiscordImageSource } from "../src/adapters/discord-image-source.js";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import type { Attachment, Message, Prompt } from "../src/domain.js";
import type { ImageSource } from "../src/model-images.js";
import { ToolError, ToolRegistry, decodeToolResult, encodeToolResult } from "../src/tools.js";
import { chatImageKey } from "../src/web-chat-images.js";
import { registerViewImage } from "../src/view-image.js";

const requester: Message = { id: "request", server: "s", channel: "c", author: "a", text: "show it" };
const target = "100000000000000001";
const cat = { name: "cat.png", url: "https://cdn.discordapp.com/attachments/1/2/cat.png", contentType: "image/png" };
const dog = { name: "dog.png", url: "https://cdn.discordapp.com/attachments/1/3/dog.png", contentType: "image/png" };
const stored = (attachments: readonly Attachment[]): Message => ({ id: target, server: "s", channel: "c", author: "b", text: "pictures", attachments });
const fakeStore = (...messages: Message[]) => ({ readHistory: async (_server: string, _channel: string, id: string, _radius: number) => messages.filter(item => item.id === id) });
const fixedImages = (url: string | undefined): ImageSource => ({ link: async () => url });

test("view_image_returns_image_input", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => false);
  registerViewImage(registry, { store: fakeStore(stored([cat, dog])), images: fixedImages("https://signed.example/dog.png?ex=1"), authorize: async () => {} });
  const result = await registry.invokeResult(requester, "view_image", { message_ref: target, index: 2 }, "op-1", "agent");
  assert.equal(result.status, undefined);
  assert.equal(result.text, "Image dog.png from the message.");
  assert.deepEqual(result.images, [{ url: "https://signed.example/dog.png?ex=1", label: "dog.png" }]);
});

test("view_image_wrong_index_lists_count", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => false);
  registerViewImage(registry, { store: fakeStore(stored([cat, dog])), images: fixedImages("https://signed.example/x"), authorize: async () => {} });
  const result = await registry.invokeResult(requester, "view_image", { message_ref: target, index: 3 }, "op-2", "agent");
  assert.equal(result.status, "rejected");
  assert.equal(result.text, `Message ${target} has 2 images. Use index 1 to 2.`);
  assert.equal(result.images, undefined);
});

test("view_image_no_channel_access_rejected", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => false);
  let reads = 0;
  const counted = { readHistory: async (...args: [string, string, string, number]) => { reads++; return fakeStore(stored([cat])).readHistory(...args); } };
  registerViewImage(registry, { store: counted, images: fixedImages("https://signed.example/cat.png"), authorize: async () => { throw new ToolError("You cannot read this channel."); } });
  await assert.rejects(registry.invokeResult(requester, "view_image", { message_ref: target }, "op-3", "agent"), /cannot read this channel/);
  assert.equal(reads, 0);
});

test("view_image_link_gone_fails_cleanly", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => false);
  registerViewImage(registry, { store: fakeStore(stored([cat])), images: fixedImages(undefined), authorize: async () => {} });
  const result = await registry.invokeResult(requester, "view_image", { message_ref: target }, "op-4", "agent");
  assert.equal(result.status, "failed");
  assert.equal(result.text, "The image is no longer available.");
  assert.equal(result.images, undefined);
});

test("tool_result_images_go_on_wire", () => {
  const prompt: Prompt = { prefixVersion: "v1", prefix: [{ role: "system", content: "fixed" }], history: [], inputs: [
    { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "view_image", arguments: { message_ref: target } }] },
    { role: "tool", toolCallId: "call_1", content: '{"tool":"view_image"}', images: [{ url: "data:image/png;base64,AAAA", label: "cat.png" }] },
  ] };
  const messages = wireMessages(prompt);
  assert.deepEqual(messages.at(-1), { role: "tool", tool_call_id: "call_1", content: [
    { type: "text", text: '{"tool":"view_image"}' },
    { type: "image_url", image_url: { url: "data:image/png;base64,AAAA" } },
  ] });
});

test("saved_tool_result_has_no_image_url", () => {
  const saved = encodeToolResult({ text: "Image cat.png from the message.", images: [{ url: "https://cdn.example/cat.png?ex=abc&hm=def", label: "cat.png" }] });
  assert.ok(!saved.includes("ex=abc"));
  assert.ok(!saved.includes("cdn.example"));
  assert.deepEqual(decodeToolResult(saved), { text: "Image cat.png from the message.", images_shown: 1 });
});

test("discord_source_returns_fresh_signed_url", async () => {
  const calls: [string, string][] = [];
  const source = new DiscordImageSource({ attachments: async (channel, id) => {
    calls.push([channel, id]);
    return [
      { name: "cat.png", url: "https://cdn.discordapp.com/attachments/111/222/cat.png?ex=65a&is=65b&hm=abc" },
      { name: "dog.png", url: "https://cdn.discordapp.com/attachments/111/333/dog.png?ex=65a&is=65b&hm=def" },
    ];
  } });
  const message: Message = { id: "999", server: "s", channel: "111", author: "a", text: "" };
  assert.equal(await source.link(message, { name: "cat.png", url: "https://cdn.discordapp.com/attachments/111/222/cat.png" }), "https://cdn.discordapp.com/attachments/111/222/cat.png?ex=65a&is=65b&hm=abc");
  assert.deepEqual(calls, [["111", "999"]]);
  const failing = new DiscordImageSource({ attachments: async () => { throw new Error("Unknown Message"); } });
  assert.equal(await failing.link(message, cat), undefined);
});

test("web_image_source_uses_storage_link", async () => {
  const id = "a".repeat(32) + ".png";
  const calls: [string, string, number][] = [];
  const source = new DiscordImageSource({ attachments: async () => [], storage: { link: async (key, name, seconds) => { calls.push([key, name, seconds]); return "https://storage.example/signed"; } } });
  const message: Message = { id: "chat-1", server: "srv", channel: "web:chat1", author: "u", text: "" };
  assert.equal(await source.link(message, { name: "a.png", url: `web-image:${id}` }), "https://storage.example/signed");
  assert.deepEqual(calls, [[chatImageKey("srv", "chat1", id), "a.png", 900]]);
  const noStorage = new DiscordImageSource({ attachments: async () => [] });
  assert.equal(await noStorage.link(message, { name: "a.png", url: `web-image:${id}` }), undefined);
});

test("split_tool_pair_has_no_image_url", () => {
  const url = "https://cdn.example/cat.png?ex=abc&hm=def";
  const prompt: Prompt = { prefixVersion: "v1", prefix: [{ role: "system", content: "fixed" }], history: [], inputs: [
    { role: "assistant", content: "", toolCalls: [{ id: "call_1", name: "view_image", arguments: { message_ref: target } }] },
    { role: "tool", toolCallId: "call_2", content: '{"tool":"view_image"}', images: [{ url, label: "cat.png" }] },
  ] };
  const wire = JSON.stringify(wireMessages(prompt));
  assert.ok(!wire.includes("ex=abc"));
  assert.ok(!wire.includes("cdn.example"));
  assert.ok(wire.includes('\\"images_shown\\":1'));
});
