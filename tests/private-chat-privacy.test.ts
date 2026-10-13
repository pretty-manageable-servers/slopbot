import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { Application } from "../src/application.js";
import { FakeLLM } from "../src/adapters/fake-llm.js";
import { Bot, type ChatGateway, type Incoming } from "../src/bot.js";
import { configuredChannels } from "../src/server-tools.js";
import type { Config } from "../src/config.js";
import { HistoryImporter } from "../src/history.js";
import { privateChannel } from "../src/private-chat.js";
import type { ParticipationGate } from "../src/participation.js";
import { registerReportTools } from "../src/search/reports.js";
import { ShareError, ShareService } from "../src/shares.js";
import { ToolRegistry } from "../src/tools.js";
import { visibleConversations, type TranscriptHost } from "../src/web-transcripts.js";
import type { Message } from "../src/domain.js";

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

test("a private chat cannot be shared", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  await seed(store);
  const shares = new ShareService({ store, access: { check: async () => ({ view: true }) }, rule: { manager: async () => true } } as never);
  await assert.rejects(shares.create("alice", { server, channel: ownerChat, from: "web-secret", to: "web-secret" }), (error: unknown) => error instanceof ShareError && error.status === 400);
  assert.deepEqual(await store.listShares(server, 10), []);
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

test("Postgres queries keep private chats out of the channel list, author lookup and memory index", () => {
  const source = readFileSync(new URL("../../src/adapters/postgres.ts", import.meta.url), "utf8");
  // These SQL strings cannot run without a database, so the filter is checked in the source.
  assert.match(source, /WHERE m\.server=\? AND m\.channel NOT LIKE 'web:%'`\)\.all\(server\)/, "knownAuthors");
  assert.match(source, /WHERE server=\? AND channel NOT LIKE 'web:%' GROUP BY channel/, "conversationActivity");
  assert.match(source, /AND m\.status='active' AND m\.channel NOT LIKE 'web:%' AND m\.channel IN/, "reindex");
});
