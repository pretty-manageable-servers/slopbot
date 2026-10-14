import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { Application } from "../src/application.js";
import { FakeLLM } from "../src/adapters/fake-llm.js";
import { Bot, type ChatGateway, type Incoming } from "../src/bot.js";
import { configuredChannels } from "../src/server-tools.js";
import type { Config } from "../src/config.js";
import { discordChannelAccessSource } from "../src/adapters/discord-channel-access.js";
import { ChannelAccess } from "../src/channel-access.js";
import { HistoryImporter } from "../src/history.js";
import { privateChannel } from "../src/private-chat.js";
import type { ParticipationGate } from "../src/participation.js";
import { registerReportTools } from "../src/search/reports.js";
import { ShareError, ShareService, buildMessages, renderSharePage } from "../src/shares.js";
import { fileLabel, transcriptMessage } from "../src/run-events.js";
import { fileUrl } from "../src/web-chat-files.js";
import { ChatError, WebChatService, type ChatHost } from "../src/web-chats.js";
import { ToolRegistry } from "../src/tools.js";
import { visibleConversations, type TranscriptHost } from "../src/web-transcripts.js";
import type { Message } from "../src/domain.js";
import type { Client } from "discord.js";

// Every test seeds one message in a web: (private) channel and one in a Discord channel, then checks
// that the private one never comes back through a path that other channels or other users can reach.

const server = "s";
const discord = "100000000000000001";
const ownerChat = privateChannel("0123456789abcdef0123456789abcdef");
const otherChat = privateChannel("fedcba9876543210fedcba9876543210");
const secret = "secret plan for the summer";

function webMessage(id: string, text = secret, channel = ownerChat, author = "alice"): Message {
  return { id, server, channel, author, authorName: author === "alice" ? "Alice" : "Carol Private", text, timestamp: 1_000, addressed: true, source: "web" } as Message;
}
function discordMessage(id: string, text: string, author = "bob", timestamp = 2_000): Message {
  return { id, server, channel: discord, author, authorName: "Bob", text, timestamp };
}

/** Seeds one private message and one Discord message that both mention the same words. */
async function seed(store: SQLiteStore): Promise<{ web: Message; plain: Message }> {
  const web = webMessage("web-secret");
  const plain = discordMessage("plain-1", "the team picked the beach");
  await store.insertWebChat({ id: "0123456789abcdef0123456789abcdef", server, owner: "alice", title: "", created: 1, updated: 1, deleted: false });
  await store.ingest(web);
  await store.ingest(plain);
  return { web, plain };
}

test("history search never returns a private chat message to a Discord channel", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  await seed(store);
  for (const mode of ["keyword", "exact"] as const) {
    const page = await store.searchHistory({ server, channel: discord, query: "secret", mode, limit: 10 });
    assert.deepEqual(page.messages, [], `${mode} search must not see the private chat`);
  }
  const owner = await store.searchHistory({ server, channel: ownerChat, query: "secret", mode: "keyword", limit: 10 });
  assert.deepEqual(owner.messages.map(item => item.id), ["web-secret"], "the owner's own chat is still searchable there");
});

test("history search cannot resolve a member who only chatted privately", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  await seed(store);
  await store.ingest(webMessage("web-carol", "hello", ownerChat, "carol"));
  assert.equal((await store.knownAuthors(server)).some(item => item.author === "carol"), false);
  assert.deepEqual(await store.findPeople(server, "Carol Private"), []);
  assert.deepEqual(await store.findPeople(server, "carol"), []);
  assert.ok((await store.findPeople(server, "bob")).some(item => item.id === "bob"), "members with Discord messages are still found");
});

test("a Discord context and recall never include a private chat message", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const { plain } = await seed(store);
  const asked = discordMessage("ask-1", "what is the secret plan", "bob", 3_000);
  await store.ingest(asked);
  const context = await store.context(asked, 20);
  assert.ok(context.every(item => item.channel === discord), "context is limited to the Discord channel");
  assert.ok(context.some(item => item.id === plain.id));
  const evidence = await store.retrieve(asked, 8);
  assert.ok(evidence.every(item => !item.content.includes(secret)), "recall must not quote the private chat");
});

test("saved memories from a private chat never reach another channel", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const { web } = await seed(store);
  await store.remember(web, "Alice plans the summer trip");
  assert.equal((await store.memories(server, ownerChat)).length, 1, "the owner's chat still lists its own memory");
  assert.deepEqual(await store.memories(server, discord), []);
  const asked = discordMessage("ask-2", "what is the summer trip plan", "bob", 3_000);
  await store.ingest(asked);
  const evidence = await store.retrieve(asked, 8);
  assert.ok(evidence.every(item => !item.content.includes("summer trip")), "recall must not use a private memory");
});

test("the memory index never queues a private chat memory", async t => {
  const embeddings = { model: "test-embedding", embed: async () => [1, 0] };
  const store = new SQLiteStore(":memory:", embeddings); t.after(() => store.close());
  const { web } = await seed(store);
  await store.remember(web, "Alice plans the summer trip");
  await store.finishIndexing();
  // Drop the vector that remember() just made, so only the reindex decision is tested.
  (store as unknown as { db: { prepare(sql: string): { run(...values: unknown[]): unknown } } }).db.prepare("DELETE FROM memory_embeddings").run();
  assert.equal(store.reindex(server, [ownerChat, discord]), 0, "private channels are never reindexed");
});

test("the history importer never imports a private chat", async () => {
  const calls: string[] = [];
  // Settings are kept, so the importer's job state survives between calls, as it does in the real store.
  const settings = new Map<string, unknown>();
  const importer = new HistoryImporter(server, {
    setting: (_server: string, key: string) => settings.get(key),
    setSetting: (_server: string, key: string, value: unknown) => { settings.set(key, value); },
    ingest: async () => { calls.push("ingest"); return true; },
    finishIndexing: async () => undefined,
    purgeChannelBefore: async () => null,
  }, { fetch: async channel => { calls.push(`fetch:${channel}`); return []; } });
  await importer.start(ownerChat, "window", 7);
  await importer.start(ownerChat, "more");
  await importer.idle();
  assert.deepEqual(calls, []);
  assert.equal(importer.busy(ownerChat), false);
});

test("reports read only the channel they are asked about", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  await seed(store);
  const tools = new ToolRegistry(store, async () => false);
  const llm = { stream: () => { throw new Error("no model call expected"); } };
  registerReportTools(tools, { store, llm, authorize: async () => undefined } as never);
  const result = await tools.invokeResult(discordMessage("ask-3", "summary please"), "conversation_summary", { query: "secret" }, "op-report-1", "agent");
  assert.equal(result.text, "No indexed evidence found for this request.");
});

test("transcript routes never open a private chat for anyone but its owner", async () => {
  // A private chat is not a Discord channel. The source answers before it touches the Discord client.
  const source = discordChannelAccessSource({} as Client);
  assert.equal(await source.facts(server, ownerChat, "alice"), undefined);
  const access = new ChannelAccess(source);
  assert.deepEqual(await access.check(server, ownerChat, "alice"), { view: false, send: false });
});

test("a channel list never shows a private chat, even when it is configured", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  await seed(store);
  await store.setSetting(server, `web_transcripts:${discord}`, true);
  const host: TranscriptHost = {
    store,
    access: { check: async () => ({ view: true, send: true }) },
    configured: () => [discord, ownerChat, otherChat],
    channelName: async (_server: string, channel: string) => channel === discord ? "general" : undefined,
  } as unknown as TranscriptHost;
  const list = await visibleConversations(host, server, "alice");
  assert.deepEqual(list.map(item => item.id), [discord]);
  const activity = await store.conversationActivity(server);
  assert.deepEqual(activity.map(item => item.channel), [discord], "the activity list is filtered in the store");
});

test("the admin channel list only ever holds Discord channel IDs", t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  store.setSetting(server, "channels", [ownerChat]);
  const config = { channelServer: server, channelIds: [discord] } as unknown as Config;
  assert.deepEqual(configuredChannels(config, store, server), [discord], "a saved private chat is not an admin channel");
});

test("a private chat is shared by its owner only, as a snapshot, and deleting it revokes the link", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  // Share routes need a real server ID. This test uses one for every row.
  const guild = "1528063444874432734";
  await store.insertWebChat({ id: "0123456789abcdef0123456789abcdef", server: guild, owner: "alice", title: "", created: 1, updated: 1, deleted: false });
  await store.ingest({ ...webMessage("web-secret"), server: guild });
  await store.ingest({ ...discordMessage("plain-1", "the team picked the beach"), server: guild });
  // A second private chat of Carol. Its text must never reach Alice's link.
  await store.insertWebChat({ id: "fedcba9876543210fedcba9876543210", server: guild, owner: "carol", title: "", created: 1, updated: 1, deleted: false });
  await store.ingest({ ...webMessage("web-other", "carol budget note", otherChat, "carol"), server: guild });
  const members = new Set(["alice", "bob", "carol", "manager"]);
  const host = {
    member: async (user: string, serverId: string) => serverId === guild && members.has(user),
    handle: async (serverId: string) => serverId === guild ? { openChat() { /* none */ }, closeChat() { /* none */ }, async receiveChat() { /* none */ } } : undefined,
    limiter: { check: async () => ({ allowed: true }) },
    access: new ChannelAccess({ async facts() { return undefined; } }),
  } as unknown as ChatHost;
  const chats = new WebChatService(store, host, { changed() { /* no live streams here */ } } as never, () => 2_000);
  const chat = "0123456789abcdef0123456789abcdef";
  const shares = new ShareService({ store, access: { check: async () => ({ view: true }) }, rule: { manager: async (user: string) => user === "manager" }, member: async (user: string, serverId: string) => serverId === guild && members.has(user) } as never);

  // Only the owner can create, list or revoke. Others get 404, as for other chat routes.
  for (const user of ["bob", "carol"]) {
    await assert.rejects(chats.shareCreate(user, chat), (error: unknown) => error instanceof ChatError && error.status === 404, `${user} cannot create`);
    await assert.rejects(chats.shareList(user, chat), (error: unknown) => error instanceof ChatError && error.status === 404, `${user} cannot list`);
    await assert.rejects(chats.shareRevoke(user, chat, "x".repeat(22)), (error: unknown) => error instanceof ChatError && error.status === 404, `${user} cannot revoke`);
  }
  // The channel route still refuses a private chat, even for a server manager.
  await assert.rejects(shares.create("manager", { server: guild, channel: ownerChat }), (error: unknown) => error instanceof ShareError && error.status === 400, "a private channel is not a valid channel for the channel route");

  // The owner shares. The link is a snapshot: a later message is not in it.
  const { id } = await chats.shareCreate("alice", chat);
  assert.deepEqual((await chats.shareList("alice", chat)).shares.map(share => share.id), [id]);
  await store.ingest({ ...webMessage("web-later", "later private line"), server: guild, timestamp: 3_000 });
  const snapshot = await shares.snapshot(id);
  const body = JSON.stringify(snapshot);
  assert.ok(body.includes(secret), "the snapshot has the messages up to the share");
  assert.ok(!body.includes("later private line"), "a later message is not in the link");
  assert.ok(!body.includes("carol budget note"), "another chat is not in the link");
  assert.ok(!body.includes("the team picked the beach"), "server data is not in the link");
  assert.ok(!(await shares.page(id))?.includes("later private line"), "the public page is the same snapshot");

  // Server managers do not list or revoke a private chat link.
  assert.deepEqual((await shares.list("manager", guild)).shares, [], "the server list has no chat link");
  await assert.rejects(shares.revoke("manager", id), (error: unknown) => error instanceof ShareError && error.status === 404);
  assert.deepEqual(await shares.revokeAll("manager", guild), { revoked: 0 });
  assert.ok(await shares.snapshot(id), "the owner's link is still live after the manager's calls");

  // Deleting the chat revokes the link and removes its frozen copy.
  await chats.remove("alice", chat);
  assert.equal(await shares.snapshot(id), undefined, "deleting the chat revokes the link");
  assert.equal(await shares.page(id), undefined);
  assert.equal(await store.getShare(id), undefined, "the frozen copy is removed");
});

test("a private chat never gets a JEV participation decision", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  await store.insertWebChat({ id: "0123456789abcdef0123456789abcdef", server, owner: "alice", title: "", created: 1, updated: 1, deleted: false });
  const app = new Application(store, new FakeLLM(), { allowedChannels: [{ server, channel: discord }] });
  const outputs: string[] = [];
  const gateway: ChatGateway = {
    async reply(_message, text) { outputs.push(text); return []; },
    async createTaskThread() { throw new Error("not used"); },
    typing: () => () => undefined,
  };
  let decided = 0;
  const gate = {
    options: { enabled: true, contextMessages: 5, cooldownMs: 0, maxUnsolicitedPerHour: 100, reactionFrequency: 0 },
    async decide() { decided++; return { respond: false, addressed: false }; },
  } as unknown as ParticipationGate;
  const bot = new Bot(app, store, store, gateway, server, [discord], { knowledge: store, participation: gate });
  bot.openPrivateChat(server, ownerChat);
  // No addressed flag: the bot must still answer without asking the gate.
  const incoming: Incoming = { ...webMessage("web-jev", "hello there"), addressed: undefined, botAuthor: false, mentionsBot: false, repliesToBot: false } as unknown as Incoming;
  await bot.receive(incoming);
  assert.equal(decided, 0, "the participation gate must not see a private chat");
  assert.equal(outputs.length, 1, "the private chat is still answered");
});

test("message view has files", () => {
  const fileId = "0123456789abcdef0123456789abcdef.txt";
  const message = { ...webMessage("web-file-msg", "see the notes"), attachments: [{ name: "notes.txt", url: fileUrl(server, "0123456789abcdef0123456789abcdef", fileId), contentType: "text/plain", size: 12 }] } as Message;
  assert.deepEqual(transcriptMessage(message, undefined).files, [{ fileId, name: "notes.txt", contentType: "text/plain", size: 12 }]);
  assert.equal("files" in transcriptMessage(webMessage("web-plain"), undefined), false, "a message without files has no files key");
});

test("share shows file names without file ids", () => {
  const fileId = "fedcba9876543210fedcba9876543210.pdf";
  const message = { ...webMessage("web-file-msg", "here is the report"), attachments: [{ name: "report.pdf", url: fileUrl(server, "0123456789abcdef0123456789abcdef", fileId), contentType: "application/pdf", size: 2048 }] } as Message;
  const [item] = buildMessages([message], [], { show_thinking: false });
  assert.deepEqual(item?.files, [{ name: "report.pdf", size: 2048 }], "the share keeps the name and size");
  assert.ok(!JSON.stringify(item).includes(fileId), "the share never holds the file ID");
});

test("live message hides file labels", () => {
  const chat = "0123456789abcdef0123456789abcdef", fileId = "fedcba9876543210fedcba9876543210.csv";
  const url = fileUrl(server, chat, fileId);
  const label = fileLabel("data.csv", "text/csv", url);
  const message = { ...webMessage("web-file-live", `look\n${label}`), attachments: [{ name: "data.csv", url, contentType: "text/csv", size: 4 }] } as Message;
  const view = transcriptMessage(message, undefined);
  assert.equal(view.text, "look", "the live view has no label");
  assert.deepEqual(view.files, [{ fileId, name: "data.csv", contentType: "text/csv", size: 4 }], "the file still shows");
  assert.equal(message.text, `look\n${label}`, "the stored text keeps the label for the model");
});

test("share snapshot hides file labels", () => {
  const url = fileUrl(server, "0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210.csv");
  const label = fileLabel("data.csv", "text/csv", url);
  const message = { ...webMessage("web-file-share", `look\n${label}`), attachments: [{ name: "data.csv", url, contentType: "text/csv", size: 4 }] } as Message;
  const [item] = buildMessages([message], [], { show_thinking: false });
  assert.equal(item?.text, "look", "the share text has no label");
  assert.ok(!JSON.stringify(item).includes("content not inspected"), "no label wording in the share");
});

test("continued share has no file labels", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const guild = "1528063444874432734";
  const url = fileUrl(guild, "0123456789abcdef0123456789abcdef", "fedcba9876543210fedcba9876543210.csv");
  const label = fileLabel("data.csv", "text/csv", url);
  // A share made before the fix keeps the label in its frozen text. Continuing it must not copy the label.
  const snapshot = { id: "share-old", created_at: 1, options: { show_avatars: false, show_thinking: false }, messages: [{ author: "Alice", bot: false, text: `look\n${label}`, attachments: 1, tools: [] }] };
  await store.insertShare({ id: "share-old", server: guild, channel: ownerChat, created_by: "alice", created_at: 1, revoked_at: null, body: JSON.stringify(snapshot) });
  const host = {
    member: async () => true,
    handle: async () => ({ openChat() { /* none */ }, closeChat() { /* none */ }, async receiveChat() { /* none */ } }),
    limiter: { check: async () => ({ allowed: true }) },
    access: new ChannelAccess({ async facts() { return undefined; } }),
  } as unknown as ChatHost;
  const chats = new WebChatService(store, host, { changed() { /* no live streams here */ } } as never, () => 2_000);
  const { id } = await chats.continueShare("alice", "share-old", { snapshot: async () => snapshot } as never);
  const saved = await store.conversationMessages(guild, privateChannel(id), undefined, 10);
  assert.deepEqual(saved.map(message => message.text), ["look"], "the copied text has no label");
});

test("share page data has files", () => {
  const page = renderSharePage({
    id: "share1", created_at: 1, options: { show_avatars: false, show_thinking: false },
    messages: [{ author: "Alice", bot: false, text: "report", attachments: 2, tools: [], files: [{ name: "report.pdf", size: 2048 }] }],
  });
  const match = /<script type="application\/json" id="share-data">([\s\S]*?)<\/script>/.exec(page);
  assert.ok(match, "the page has its data");
  const data = JSON.parse(match[1]!) as { messages: { files: unknown[]; other: number }[] };
  assert.deepEqual(data.messages[0]!.files, [{ name: "report.pdf", size: 2048 }], "the page gets the file name and size");
  assert.equal(data.messages[0]!.other, 1, "a file is not counted as an attachment not shown");
});

test("Postgres queries keep private chats out of the channel list, author lookup and memory index", () => {
  const source = readFileSync(new URL("../../src/adapters/postgres.ts", import.meta.url), "utf8");
  // These SQL strings cannot run without a database, so the filter is checked in the source.
  assert.match(source, /WHERE m\.server=\? AND m\.channel NOT LIKE 'web:%'`\)\.all\(server\)/, "knownAuthors");
  assert.match(source, /WHERE server=\? AND channel NOT LIKE 'web:%' GROUP BY channel/, "conversationActivity");
  assert.match(source, /AND m\.status='active' AND m\.channel NOT LIKE 'web:%' AND m\.channel IN/, "reindex");
});
