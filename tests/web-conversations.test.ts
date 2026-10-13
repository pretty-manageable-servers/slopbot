import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { ChannelAccess, type ChannelFacts } from "../src/channel-access.js";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { webTranscriptKey } from "../src/server-tools.js";
import { createTranscripts, type TranscriptHost } from "../src/web-transcripts.js";
import { SOURCE_CHAIN_MS, conversationTitle, groupConversations, type ChannelReply, type ChannelRun, type RunSource } from "../src/conversation-groups.js";
import type { Message } from "../src/domain.js";

const SERVER = "1528063444874432734", CHANNEL = "1528063444874432735", OTHER = "1528063444874432737";
const USER = "1514413259522838529", STRANGER = "1514413259522838530", BOT = "1528063444874432799";
const base: ChannelFacts = { thread: false, privateThread: false, viewChannel: true, readMessageHistory: true, sendMessages: true, sendMessagesInThreads: true, threadMember: false };
const T0 = 1_700_000_000_000;
const at = (seconds: number) => T0 + seconds * 1000;

const message = (id: string, channel: string, seconds: number, text: string, author = USER, extra: Partial<Message> = {}): Message =>
  ({ id, server: SERVER, channel, author, authorName: author === BOT ? "Slopbot" : "Ada", text, timestamp: at(seconds), ...extra });
const reply = (id: string, seconds: number, text: string, extra: Partial<Message> = {}) => message(id, CHANNEL, seconds, text, BOT, { isBot: true, ...extra });
const replyRun = { prefixVersion: "v1", prefix: [], history: [], inputs: [], purpose: "reply" } as const;

interface Fixture { store: SQLiteStore; access: ChannelAccess; hidden: Set<string>; base: string }

/**
 * One channel with four conversations, a participation run and a run in a switched-off channel:
 *  - ask, "How do cats purr...": run-a, run-b and run-b2 (tool round). run-b replies to Slopbot's reply, so they join.
 *  - lighthouse: run-c, and run-d, which uses Slopbot's reply from run-c as a source 10 seconds later. They join.
 *  - later: run-e uses a reply from 2 hours before as a source, which is past SOURCE_CHAIN_MS. Alone.
 *  - run-c also used the human message h2, which run-b used too. A human source never joins runs.
 */
async function fixture(t: { after(fn: () => unknown): void }): Promise<Fixture> {
  const store = new SQLiteStore(":memory:");
  const hidden = new Set<string>();
  const source = {
    async facts(_server: string, channel: string, user: string): Promise<ChannelFacts | undefined> {
      if (user === STRANGER) return undefined;
      return { ...base, ...(hidden.has(`${channel}:${user}`) ? { viewChannel: false } : {}) };
    },
  };
  const access = new ChannelAccess(source);
  const names: Record<string, string> = { [CHANNEL]: "general", [OTHER]: "secret" };
  const host: TranscriptHost = { store, access, configured: () => [CHANNEL, OTHER], channelName: async (_server, channel) => names[channel] };
  const routes = createTranscripts(host);
  const http = createServer((req, res) => {
    const user = req.headers["x-user"] ? String(req.headers["x-user"]) : undefined;
    void routes.handle(req, res, new URL(req.url!, "http://localhost"), user);
  });
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  t.after(() => new Promise<void>(resolve => http.close(() => resolve())));
  t.after(() => store.close());
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("no address");

  store.setSetting(SERVER, "context_bot_author", BOT);
  store.setSetting(SERVER, webTranscriptKey(CHANNEL), true);
  store.setSetting(SERVER, webTranscriptKey(OTHER), false);

  const items: Record<string, Message> = {
    h1: message("h1", CHANNEL, 0, "how do cats purr"),
    h2: message("h2", CHANNEL, 10, "lighthouse talk"),
    r1: message("r1", CHANNEL, 100, "How do cats purr? Explain in detail please, thanks a lot for it"),
    "bot-a": reply("bot-a", 110, "Cats purr when content."),
    r2: message("r2", CHANNEL, 200, "and dogs?", USER, { replyTo: "bot-a" }),
    "bot-b": reply("bot-b", 210, "Dogs bark."),
    r3: message("r3", CHANNEL, 5000, "lighthouse again"),
    "bot-c": reply("bot-c", 5010, "Lighthouses shine."),
    r4: message("r4", CHANNEL, 5020, "and birds?"),
    r5: message("r5", CHANNEL, 9000, "unrelated"),
    r6: message("r6", CHANNEL, 9500, "classified only"),
    o1: message("o1", OTHER, 8000, "other channel"),
  };
  for (const item of Object.values(items)) await store.ingest(item);

  await store.startRun("run-a", items.r1!, replyRun);
  await store.recordSources("run-a", SERVER, ["h1", "r1"]);
  await store.linkOutput(items["bot-a"]!, "run-a", "r1");
  await store.complete("run-a", undefined, [], "Cats purr when content.");

  await store.startRun("run-b", items.r2!, replyRun);
  await store.recordSources("run-b", SERVER, ["r2", "bot-a", "h2"]);
  await store.linkOutput(items["bot-b"]!, "run-b", "r2");
  await store.complete("run-b", undefined, [], "Dogs bark.");

  // A tool round of the same request. It has the same trigger, so it is part of run-b's conversation.
  await store.startRun("run-b2", items.r2!, replyRun);
  await store.recordSources("run-b2", SERVER, ["r2", "bot-a"]);
  await store.complete("run-b2", undefined, [], "");

  await store.startRun("run-c", items.r3!, replyRun);
  await store.recordSources("run-c", SERVER, ["h2", "r3"]);
  await store.linkOutput(items["bot-c"]!, "run-c", "r3");
  await store.complete("run-c", undefined, [], "Lighthouses shine.");

  await store.startRun("run-d", items.r4!, replyRun);
  await store.recordSources("run-d", SERVER, ["bot-c", "r4"]);
  await store.fail("run-d", "model unavailable");

  await store.startRun("run-e", items.r5!, replyRun);
  await store.recordSources("run-e", SERVER, ["bot-b", "r5"]);
  await store.complete("run-e", undefined, [], "Unrelated answer.");

  // A participation classifier run has no purpose in its prompt. It is not a conversation.
  await store.startRun("run-p", items.r6!, { prefixVersion: "participation-v2", prefix: [], history: [], inputs: [] });
  await store.recordSources("run-p", SERVER, ["r6"]);
  await store.complete("run-p", undefined, [], "{}");

  await store.startRun("run-o", items.o1!, replyRun);
  await store.recordSources("run-o", SERVER, ["o1"]);
  await store.complete("run-o", undefined, [], "other");

  return { store, access, hidden, base: `http://127.0.0.1:${address.port}` };
}

async function get(f: Fixture, path: string, user: string | null = USER): Promise<{ status: number; body: any }> {
  const response = await fetch(f.base + path, { headers: user ? { "x-user": user } : {} });
  return { status: response.status, body: await response.json() };
}
const idsOf = (items: { id: string }[]) => items.map(item => item.id);

test("conversation titles are one line, trimmed to 60 characters", () => {
  assert.equal(conversationTitle("  hello \n\n  there  "), "hello there");
  assert.equal(conversationTitle("   "), "(no text)");
  const exact = "a".repeat(60);
  assert.equal(conversationTitle(exact), exact);
  const long = conversationTitle("b".repeat(61));
  assert.equal(Array.from(long).length, 60);
  assert.ok(long.endsWith("…"));
});

test("grouping joins runs that continue each other and keeps the rest apart", () => {
  const run = (id: string, trigger: string, seconds: number, extra: Partial<Message> = {}): ChannelRun =>
    ({ id, status: "completed", message: message(trigger, CHANNEL, seconds, trigger, USER, extra) });
  const runs = [
    run("A", "q1", 0),
    run("B", "q2", 100, { replyTo: "a1" }),          // replies to A's Slopbot reply
    run("C", "q3", 200),                              // uses A's reply as a source, 50 seconds later
    run("D", "q4", 400),                              // a different request with the same human source as E
    run("E", "q5", 401),
    run("F", "q6", 100 + SOURCE_CHAIN_MS / 1000 + 1000), // uses B's reply, but more than an hour after it
    run("G", "q2", 100),                              // a second run of request q2 (tool round)
  ];
  const replies: ChannelReply[] = [
    { messageId: "a1", runId: "A", timestamp: at(10) },
    { messageId: "b1", runId: "B", timestamp: at(110) },
  ];
  const sources: RunSource[] = [
    { runId: "B", messageId: "a1" },
    { runId: "C", messageId: "a1" },
    { runId: "D", messageId: "shared" },
    { runId: "E", messageId: "shared" },
    { runId: "F", messageId: "b1" },
  ];
  const groups = groupConversations(runs, replies, sources).map(group => group.runIds.slice().sort());
  assert.deepEqual(groups.sort(), [["A", "B", "C", "G"], ["D"], ["E"], ["F"]]);
});

test("grouping returns the newest conversation first", () => {
  const trigger = (id: string, seconds: number): ChannelRun => ({ id, status: "completed", message: message(id, CHANNEL, seconds, id) });
  const groups = groupConversations([trigger("old", 1), trigger("new", 50)], [], []);
  assert.deepEqual(groups.map(group => group.id), ["new", "old"]);
});

test("the store lists only reply runs of the channel, oldest first, and reads messages in time order", async t => {
  const f = await fixture(t);
  const runs = await f.store.channelRuns(SERVER, CHANNEL);
  assert.deepEqual(runs.map(run => run.id), ["run-a", "run-b", "run-b2", "run-c", "run-d", "run-e"]);
  assert.equal(runs[0]!.message.text.startsWith("How do cats purr"), true);
  const found = await f.store.messagesById(SERVER, CHANNEL, ["bot-b", "nope", "h1", "o1"]);
  assert.deepEqual(idsOf(found), ["h1", "bot-b"]);
  const replies = await f.store.channelReplies(SERVER, CHANNEL);
  assert.deepEqual(replies.map(item => [item.messageId, item.runId]), [["bot-a", "run-a"], ["bot-b", "run-b"], ["bot-c", "run-c"]]);
  const sources = await f.store.channelSources(SERVER, CHANNEL);
  assert.equal(sources.some(source => source.messageId === "o1"), false);
});

test("the list groups chained runs, puts the newest first and pages with limit and offset", async t => {
  const f = await fixture(t);
  const first = await get(f, `/api/conversations/${CHANNEL}/runs?server=${SERVER}&limit=2`);
  assert.equal(first.status, 200);
  assert.deepEqual(idsOf(first.body.conversations), ["run-e", "run-c"]);
  assert.equal(first.body.hasMore, true);
  assert.deepEqual(first.body.conversations.map((item: { messageCount: number }) => item.messageCount), [2, 4]);
  assert.equal(first.body.conversations[0].title, "unrelated");
  assert.equal(first.body.conversations[0].author, USER);
  assert.equal(first.body.conversations[0].authorName, "Ada");
  assert.equal(first.body.conversations[0].start, at(9000));
  assert.equal(first.body.conversations[0].end, at(9000));
  assert.equal(first.body.conversations[1].end, at(5020));

  const second = await get(f, `/api/conversations/${CHANNEL}/runs?server=${SERVER}&limit=2&offset=2`);
  assert.deepEqual(idsOf(second.body.conversations), ["run-a"]);
  assert.equal(second.body.hasMore, false);
  assert.equal(second.body.conversations[0].messageCount, 6);
  assert.equal(second.body.conversations[0].title.length, 60);
  assert.ok(second.body.conversations[0].title.endsWith("…"));
  assert.equal(second.body.conversations[0].end, at(210));

  const all = await get(f, `/api/conversations/${CHANNEL}/runs?server=${SERVER}`);
  assert.equal(all.body.conversations.length, 3);
  assert.equal(all.body.hasMore, false);
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/runs?server=${SERVER}&limit=0`)).status, 400);
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/runs?server=${SERVER}&limit=51`)).status, 400);
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/runs?server=${SERVER}&offset=-1`)).status, 400);
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/runs?server=${SERVER}&offset=abc`)).status, 400);
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/runs?server=nope`)).status, 400);
});

test("one conversation returns its triggers, sources and replies in time order, from any of its runs", async t => {
  const f = await fixture(t);
  const lighthouse = await get(f, `/api/conversations/${CHANNEL}/runs/run-c?server=${SERVER}`);
  assert.equal(lighthouse.status, 200);
  assert.deepEqual(idsOf(lighthouse.body.messages), ["h2", "r3", "bot-c", "r4"]);
  assert.deepEqual(lighthouse.body.conversation.runIds, ["run-c", "run-d"]);
  assert.equal(lighthouse.body.hasMore, false);
  assert.equal(lighthouse.body.channel.name, "general");
  assert.equal(lighthouse.body.canSend, true);
  const bot = lighthouse.body.messages.find((item: { id: string }) => item.id === "bot-c");
  assert.equal(bot.slopbot, true);
  assert.deepEqual(bot.runIds, ["run-c"]);
  assert.equal(bot.used, true);
  // The same conversation from run-d gives the same messages.
  const fromD = await get(f, `/api/conversations/${CHANNEL}/runs/run-d?server=${SERVER}`);
  assert.deepEqual(idsOf(fromD.body.messages), ["h2", "r3", "bot-c", "r4"]);
  // The tool round of run-b gives the whole ask conversation, including the replies to it.
  const ask = await get(f, `/api/conversations/${CHANNEL}/runs/run-b2?server=${SERVER}`);
  assert.deepEqual(idsOf(ask.body.messages), ["h1", "h2", "r1", "bot-a", "r2", "bot-b"]);
  assert.equal(ask.body.conversation.id, "run-a");
});

test("a conversation route refuses runs that are not conversations, runs of other channels and bad IDs", async t => {
  const f = await fixture(t);
  // A participation run is not a conversation. A run of the switched-off channel is not in this channel.
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/runs/run-p?server=${SERVER}`)).status, 404);
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/runs/run-o?server=${SERVER}`)).status, 404);
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/runs/bad%20id?server=${SERVER}`)).status, 400);
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/runs/run-c?server=nope`)).status, 400);
});

test("access: no session, no View Channel and a switched-off channel are refused on both routes", async t => {
  const f = await fixture(t);
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/runs?server=${SERVER}`, null)).status, 403);
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/runs/run-c?server=${SERVER}`, null)).status, 403);
  // A stranger is not in the server.
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/runs?server=${SERVER}`, STRANGER)).status, 403);
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/runs/run-c?server=${SERVER}`, STRANGER)).status, 403);
  // A user who lost View Channel for this channel.
  f.hidden.add(`${CHANNEL}:${USER}`);
  f.access.clearChannel(CHANNEL);
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/runs?server=${SERVER}`)).status, 403);
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/runs/run-c?server=${SERVER}`)).status, 403);
  f.hidden.clear();
  f.access.clearChannel(CHANNEL);
  // The switched-off channel refuses even for a user who can view it.
  assert.equal((await get(f, `/api/conversations/${OTHER}/runs?server=${SERVER}`)).status, 403);
  assert.equal((await get(f, `/api/conversations/${OTHER}/runs/run-o?server=${SERVER}`)).status, 403);
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/runs?server=${SERVER}`)).status, 200);
});
