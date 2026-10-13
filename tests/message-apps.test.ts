import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { ChannelAccess } from "../src/channel-access.js";
import { ChatError, WebChatService, type ChatHost } from "../src/web-chats.js";
import { buildMessageApps, CONTINUE_IN_WEB, messageAppText } from "../src/adapters/discord-commands.js";

test("the Apps menu has Summarize, Explain and Continue in Slopbot web", () => {
  const apps = buildMessageApps().map(app => app.toJSON());
  assert.deepEqual(apps.map(app => app.name), ["Summarize", "Explain", CONTINUE_IN_WEB]);
  assert.ok(apps.every(app => app.type === 3), "each is a message command");
});

test("a message command request quotes the target message", () => {
  const text = messageAppText("Summarize", "bob", "line one\nline two");
  assert.match(text, /^Summarize this message/);
  assert.match(text, /Message from bob:\n> line one\n> line two$/);
  assert.match(messageAppText("Explain", "bob", "  "), /> \(no text\)$/);
});

test("Continue in Slopbot web makes a private chat that starts with the message", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const guild = "1528063444874432734";
  const opened: string[] = [];
  const host = {
    member: async (user: string, server: string) => server === guild && user === "alice",
    handle: async (server: string) => server === guild ? { openChat(channel: string) { opened.push(channel); }, closeChat() { /* none */ }, async receiveChat() { /* none */ } } : undefined,
    limiter: { check: async () => ({ allowed: true }) },
    access: new ChannelAccess({ async facts() { return undefined; } }),
  } as unknown as ChatHost;
  const chats = new WebChatService(store, host, { changed() { /* none */ } } as never, () => 2_000);
  const source = { id: "900", server: guild, channel: "100000000000000001", author: "bob", authorName: "Bob", text: "the build is broken", timestamp: 1_000 };

  await assert.rejects(chats.continueMessage("carol", guild, source), (error: unknown) => error instanceof ChatError, "a non-member gets no chat");
  const { id } = await chats.continueMessage("alice", guild, source);
  assert.deepEqual((await chats.list("alice")).map(chat => [chat.id, chat.title]), [[id, "the build is broken"]]);
  assert.equal(opened.length, 1);
  assert.match(JSON.stringify((await chats.messages("alice", id, 50, null)).messages), /the build is broken/);
  await assert.rejects(chats.messages("bob", id, 50, null), (error: unknown) => error instanceof ChatError && error.status === 404, "only the owner sees the chat");
});
