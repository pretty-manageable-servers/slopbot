import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { transcriptServer } from "./transcript-server.js";
import { ChannelAccess, type ChannelFacts } from "../src/channel-access.js";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { engineEvents, EventLog } from "../src/engine/event-log.js";
import { webTranscriptKey, transcriptSwitchOn } from "../src/server-tools.js";
import { createTranscripts, openEngineStream, type TranscriptHost } from "../src/clients/web/web-transcripts.js";
import { createConsole } from "../src/clients/web/web-console.js";
import type { Message, ModelEvent } from "../src/domain.js";
import { MemberDirectory } from "../src/member-directory.js";
import { fakeSource } from "./member-fakes.js";

const SERVER = "1528063444874432734", CHANNEL = "1528063444874432735", THREAD = "1528063444874432736", OTHER = "1528063444874432737";
const USER = "1514413259522838529", STRANGER = "1514413259522838530", BOT = "1528063444874432799", VIEWER = "1514413259522838531";
const base: ChannelFacts = { thread: false, privateThread: false, viewChannel: true, readMessageHistory: true, sendMessages: true, sendMessagesInThreads: true, threadMember: false };
const settle = () => new Promise(resolve => setTimeout(resolve, 25));

interface Fixture {
  store: SQLiteStore;
  access: ChannelAccess;
  hidden: Set<string>;
  host: TranscriptHost;
  base: string;
}

/** A store with a channel, a thread, a switched-off channel and some runs. Discord facts are fake. */
async function fixture(t: { after(fn: () => unknown): void }, members?: MemberDirectory): Promise<Fixture> {
  const store = new SQLiteStore(":memory:");
  const hidden = new Set<string>();
  const source = {
    async facts(_server: string, channel: string, user: string): Promise<ChannelFacts | undefined> {
      if (user === STRANGER) return undefined;
      return { ...base, thread: channel === THREAD, ...(hidden.has(`${channel}:${user}`) ? { viewChannel: false } : {}) };
    },
  };
  const access = new ChannelAccess(source);
  const names: Record<string, string> = { [CHANNEL]: "general", [OTHER]: "secret", [THREAD]: "task-1" };
  const host: TranscriptHost = { store, access, configured: () => [CHANNEL, OTHER], channelName: async (_server, channel) => names[channel], shareRule: { manager: async () => false, teamAdmin: async user => user === USER }, ...(members ? { members } : {}) };
  const routes = createTranscripts(host);
  const http = transcriptServer(routes);
  http.listen(0, "127.0.0.1");
  await once(http, "listening");
  t.after(() => new Promise<void>(resolve => http.close(() => resolve())));
  t.after(() => store.close());
  const address = http.address();
  if (!address || typeof address === "string") throw new Error("no address");

  store.setSetting(SERVER, "context_bot_author", BOT);
  store.setSetting(SERVER, webTranscriptKey(CHANNEL), true);
  store.setSetting(SERVER, webTranscriptKey(OTHER), false);
  store.registerTask(SERVER, THREAD, CHANNEL, "m3");
  const message = (id: string, channel: string, timestamp: number, text: string, author = USER, extra: Partial<Message> = {}): Message =>
    ({ id, server: SERVER, channel, author, authorName: author === BOT ? "Slopbot" : "Ada", text, timestamp, ...extra });
  for (const item of [
    message("m1", CHANNEL, 1000, "first"),
    message("m2", CHANNEL, 2000, "second"),
    message("m3", CHANNEL, 3000, "third question"),
    message("bot-1", CHANNEL, 4000, "Answer: yes", BOT, { isBot: true, revisionTimestamp: 4500 }),
    message("m4", CHANNEL, 5000, "lighthouse talk"),
    message("t1", THREAD, 9000, "task thread note"),
    message("o1", OTHER, 8000, "lighthouse secret"),
  ]) await store.ingest(item);

  // Run 1 answers m3 with a tool call and a usage record that holds a cost.
  const request = message("m3", CHANNEL, 3000, "third question");
  await store.startRun("run-1", request, { prefixVersion: "v1", prefix: [], history: [], inputs: [], purpose: "reply" });
  const events: ModelEvent[] = [
    { kind: "reasoning", payload: { reasoning_content: "Thinking it through" } },
    { kind: "text", payload: { text: "Answer: " } },
    { kind: "text", payload: { text: "yes" } },
    { kind: "tool_call", payload: [{ name: "status", arguments: {}, id: "c1" }] },
    { kind: "usage", payload: { prompt_tokens: 12, completion_tokens: 3, cost: 0.42 } },
  ];
  for (const [index, event] of events.entries()) await store.appendEvent("run-1", index, event);
  const turn = store.addAgentTurn(request, "calling", [{ name: "status", arguments: {}, id: "c1" }]);
  store.agentResult(turn.id, 0, { text: "Status ok", status: "ok" });
  await store.complete("run-1", undefined, [], "Answer: yes");
  await store.linkOutput(message("bot-1", CHANNEL, 4000, "Answer: yes", BOT), "run-1", "m3");

  // Run 2 calls the usage tool, whose result shows spend. Only its status may be shown.
  const usageRequest = message("m4", CHANNEL, 5000, "lighthouse talk");
  await store.startRun("run-2", usageRequest, { prefixVersion: "v1", prefix: [], history: [], inputs: [], purpose: "reply" });
  await store.appendEvent("run-2", 0, { kind: "tool_call", payload: [{ name: "usage", arguments: {}, id: "u1" }] });
  const usageTurn = store.addAgentTurn(usageRequest, "usage", [{ name: "usage", arguments: {}, id: "u1" }]);
  store.agentResult(usageTurn.id, 0, { text: "Spent $0.42 this week", status: "ok" });
  await store.complete("run-2", undefined, [], "");

  // Run 3 belongs to the switched-off channel.
  const hiddenRequest = message("o1", OTHER, 8000, "lighthouse secret");
  await store.startRun("run-3", hiddenRequest, { prefixVersion: "v1", prefix: [], history: [], inputs: [], purpose: "reply" });
  await store.appendEvent("run-3", 0, { kind: "text", payload: { text: "secret answer" } });
  await store.complete("run-3", undefined, [], "secret answer");

  return { store, access, hidden, host, base: `http://127.0.0.1:${address.port}` };
}

async function get(f: Fixture, path: string, user: string | null = USER): Promise<{ status: number; body: any }> {
  const response = await fetch(f.base + path, { headers: user ? { "x-user": user } : {} });
  return { status: response.status, body: await response.json() };
}

function collect() {
  const out: string[] = [];
  const state = { ended: false };
  return { out, state, write: (text: string) => { if (!state.ended) out.push(text); }, end: () => { state.ended = true; } };
}
function keysOf(value: unknown, found: string[] = []): string[] {
  if (Array.isArray(value)) for (const item of value) keysOf(item, found);
  else if (value && typeof value === "object") for (const [key, item] of Object.entries(value)) { found.push(key); keysOf(item, found); }
  return found;
}

test("transcript routes answer 403 without a session", async t => {
  const f = await fixture(t);
  const web = createConsole({ origin: "http://localhost:3000", host: "127.0.0.1", port: 3000, clientId: "id", clientSecret: "secret" }, { sessions: new SQLiteStore(), async canSignIn() { return true; },
    async snapshot() { return {}; },
    async invoke() { return {}; },
    conversations: createTranscripts(f.host),
  });
  web.listen(0, "127.0.0.1");
  await once(web, "listening");
  t.after(() => new Promise<void>(resolve => web.close(() => resolve())));
  const address = web.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const response = await fetch(`http://127.0.0.1:${address.port}/api/conversations?server=${SERVER}`);
  assert.equal(response.status, 403);
  assert.equal((await get(f, `/api/conversations?server=${SERVER}`, null)).status, 403);
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/turns/m3/events?server=${SERVER}`, null)).status, 403);
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/messages?server=${SERVER}`, null)).status, 403);
});

test("the list has the channels and threads the user can view, newest first, with enabled marking the switch", async t => {
  const f = await fixture(t);
  const list = await get(f, `/api/conversations?server=${SERVER}`);
  assert.equal(list.status, 200);
  assert.deepEqual(list.body.conversations.map((item: { id: string }) => item.id), [THREAD, OTHER, CHANNEL]);
  assert.deepEqual(list.body.conversations.map((item: { kind: string }) => item.kind), ["thread", "channel", "channel"]);
  assert.deepEqual(list.body.conversations.map((item: { enabled: boolean }) => item.enabled), [true, false, true]);
  assert.equal(list.body.conversations[0].name, "task-1");
  assert.equal(list.body.conversations[2].canSend, true);
  // A switched-off channel never offers to send.
  assert.equal(list.body.conversations[1].canSend, false);
  // A stranger is not in the server, so the list is empty and reads are refused.
  assert.deepEqual((await get(f, `/api/conversations?server=${SERVER}`, STRANGER)).body.conversations, []);
});

test("the messages response says who may send and who may share", async t => {
  const f = await fixture(t);
  const editor = await get(f, `/api/conversations/${CHANNEL}/messages?server=${SERVER}`);
  assert.equal(editor.status, 200);
  assert.deepEqual([editor.body.canSend, editor.body.canShare], [true, true]);
  const viewer = await get(f, `/api/conversations/${CHANNEL}/messages?server=${SERVER}`, VIEWER);
  assert.equal(viewer.status, 200);
  assert.deepEqual([viewer.body.canSend, viewer.body.canShare], [true, false]);
});

test("a switched-off channel is listed as off, and its messages and turns stay 403", async t => {
  const f = await fixture(t);
  assert.equal((await get(f, `/api/conversations/${OTHER}/messages?server=${SERVER}`)).status, 403);
  assert.equal((await get(f, `/api/conversations/${OTHER}/messages?server=${SERVER}`, STRANGER)).status, 403);
  assert.equal((await get(f, `/api/conversations/${OTHER}/turns/o1/events?server=${SERVER}`)).status, 403);
  const list = await get(f, `/api/conversations?server=${SERVER}`);
  const off = list.body.conversations.find((item: { id: string }) => item.id === OTHER);
  assert.equal(off.enabled, false);
  assert.equal(off.canSend, false);
});

test("a switched-off channel the user cannot view is not listed", async t => {
  const f = await fixture(t);
  f.hidden.add(`${OTHER}:${USER}`);
  const list = await get(f, `/api/conversations?server=${SERVER}`);
  assert.ok(!list.body.conversations.some((item: { id: string }) => item.id === OTHER));
  assert.deepEqual(list.body.conversations.map((item: { id: string }) => item.id), [THREAD, CHANNEL]);
});

test("search never reads messages of a switched-off channel", async t => {
  const f = await fixture(t);
  const found = await get(f, `/api/conversations/search?server=${SERVER}&q=secret`);
  assert.equal(found.status, 200);
  assert.deepEqual(found.body.messages, []);
  assert.ok(!found.body.channels.some((item: { id: string }) => item.id === OTHER));
});

test("a user without live View Channel gets 403 on reads and turns", async t => {
  const f = await fixture(t);
  f.hidden.add(`${CHANNEL}:${USER}`);
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/messages?server=${SERVER}`)).status, 403);
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/turns/m3/events?server=${SERVER}`)).status, 403);
  const list = await get(f, `/api/conversations?server=${SERVER}`);
  assert.deepEqual(list.body.conversations.map((item: { id: string }) => item.id), [THREAD, OTHER]);
});

test("a thread uses its parent channel's switch", async t => {
  const f = await fixture(t);
  assert.equal((await get(f, `/api/conversations/${THREAD}/messages?server=${SERVER}`)).status, 200);
  f.store.setSetting(SERVER, webTranscriptKey(CHANNEL), false);
  assert.equal((await get(f, `/api/conversations/${THREAD}/messages?server=${SERVER}`)).status, 403);
  assert.equal(transcriptSwitchOn(f.store, SERVER, THREAD), false);
  // A switched-off thread is not listed. Its parent channel is listed as off.
  const list = await get(f, `/api/conversations?server=${SERVER}`);
  assert.deepEqual(list.body.conversations.map((item: { id: string; enabled: boolean }) => [item.id, item.enabled]), [[OTHER, false], [CHANNEL, false]]);
  f.store.setSetting(SERVER, webTranscriptKey(CHANNEL), true);
  assert.equal((await get(f, `/api/conversations/${THREAD}/messages?server=${SERVER}`)).status, 200);
});

test("messages show the member's name, @username and avatar, and Slopbot's own avatar", async t => {
  const people = fakeSource({
    [USER]: { username: "ada", nickname: "Ada L", serverAvatar: "https://cdn.discordapp.com/guilds/1/users/ada.png", inServer: true, email: "ada@example.com" },
    [BOT]: { username: "slopbot", avatar: "https://cdn.discordapp.com/avatars/slop.png", inServer: true },
  });
  const f = await fixture(t, new MemberDirectory(people));
  const page = await get(f, `/api/conversations/${CHANNEL}/messages?server=${SERVER}&limit=2`);
  const [bot, human] = page.body.messages as { id: string; authorName: string; username: string | null; avatarUrl: string | null }[];
  assert.deepEqual([bot!.id, bot!.username, bot!.avatarUrl], ["bot-1", "slopbot", "https://cdn.discordapp.com/avatars/slop.png"]);
  assert.deepEqual([human!.id, human!.authorName, human!.username, human!.avatarUrl], ["m4", "Ada L", "ada", "https://cdn.discordapp.com/guilds/1/users/ada.png"]);
  assert.doesNotMatch(JSON.stringify(page.body), /example\.com|"email"/);
  // Without a directory the fields are null, as before.
  const plain = await get(await fixture(t), `/api/conversations/${CHANNEL}/messages?server=${SERVER}&limit=2`);
  assert.deepEqual(plain.body.messages.map((item: { username: unknown; avatarUrl: unknown }) => [item.username, item.avatarUrl]), [[null, null], [null, null]]);
});

test("messages page backwards in chronological order, with Slopbot run IDs", async t => {
  const f = await fixture(t);
  const first = await get(f, `/api/conversations/${CHANNEL}/messages?server=${SERVER}&limit=2`);
  assert.deepEqual(first.body.messages.map((item: { id: string }) => item.id), ["bot-1", "m4"]);
  assert.equal(first.body.hasMore, true);
  const bot = first.body.messages[0];
  assert.equal(bot.slopbot, true);
  assert.deepEqual(bot.runIds, ["run-1"]);
  assert.equal(bot.turn, "m3");
  assert.equal(bot.editedAt, 4500);
  assert.equal(bot.avatarUrl, null);
  assert.equal(bot.authorName, "Slopbot");
  const second = await get(f, `/api/conversations/${CHANNEL}/messages?server=${SERVER}&limit=2&before=bot-1`);
  assert.deepEqual(second.body.messages.map((item: { id: string }) => item.id), ["m2", "m3"]);
  const third = await get(f, `/api/conversations/${CHANNEL}/messages?server=${SERVER}&limit=2&before=m2`);
  assert.deepEqual(third.body.messages.map((item: { id: string }) => item.id), ["m1"]);
  assert.equal(third.body.hasMore, false);
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/messages?server=${SERVER}&before=nope`)).status, 400);
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/messages?server=${SERVER}&before=t1`)).status, 400);
});

test("the messages page streamId is the newest saved engine seq, so /events can continue after it", async t => {
  const f = await fixture(t);
  const log = new EventLog();
  log.attach(f.store);
  f.host.events = log;
  const conversation = { server: SERVER, channel: CHANNEL };
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/messages?server=${SERVER}`)).body.streamId, 0);
  log.publish(conversation, { type: "turn.start", turn: "m9" });
  log.publish(conversation, { type: "turn.end", turn: "m9", status: "done" });
  await log.idle();
  const saved = await log.after(conversation, 0, 10);
  const page = await get(f, `/api/conversations/${CHANNEL}/messages?server=${SERVER}`);
  assert.equal(page.body.streamId, saved.at(-1)!.seq);
  assert.deepEqual(await log.after(conversation, page.body.streamId, 10), []);
});

test("an old reply names its turn, and the turn shows text, thinking and tool calls in order, with usage results kept back", async t => {
  const f = await fixture(t);
  const page = await get(f, `/api/conversations/${CHANNEL}/messages?server=${SERVER}`);
  const turn = page.body.messages.find((item: { id: string }) => item.id === "bot-1").turn;
  assert.equal(turn, "m3");
  const run = await get(f, `/api/conversations/${CHANNEL}/turns/m3/events?server=${SERVER}`);
  assert.equal(run.status, 200);
  assert.deepEqual(run.body.events.filter((event: { type: string }) => /delta|tool/.test(event.type)), [
    { type: "thinking.delta", turn: "m3", run: "run-1", text: "Thinking it through" },
    { type: "text.delta", turn: "m3", run: "run-1", text: "Answer: yes" },
    { type: "tool.status", turn: "m3", call: "run-1:2", name: "status", status: "completed", input: {}, result: "Status ok" },
  ]);
  const usage = await get(f, `/api/conversations/${CHANNEL}/turns/m4/events?server=${SERVER}`);
  assert.equal(usage.status, 200);
  assert.equal(JSON.stringify(usage.body).includes("0.42"), false);
});

test("a turn route checks the turn's own channel, not the user's other access", async t => {
  const f = await fixture(t);
  // The user can view CHANNEL, but o1 is in a switched-off channel.
  assert.equal((await get(f, `/api/conversations/${OTHER}/turns/o1/events?server=${SERVER}`)).status, 403);
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/turns/m3/events?server=${SERVER}`, STRANGER)).status, 403);
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/turns/unknown-turn/events?server=${SERVER}`)).status, 404);
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/turns/${encodeURIComponent("bad id")}/events?server=${SERVER}`)).status, 400);
});

test("no cost fields appear in any transcript response", async t => {
  const f = await fixture(t);
  const responses = [
    await get(f, `/api/conversations?server=${SERVER}`),
    await get(f, `/api/conversations/${CHANNEL}/messages?server=${SERVER}`),
    await get(f, `/api/conversations/${CHANNEL}/turns/m3/events?server=${SERVER}`),
    await get(f, `/api/conversations/${CHANNEL}/turns/m4/events?server=${SERVER}`),
    await get(f, `/api/conversations/search?server=${SERVER}&q=lighthouse`),
  ];
  for (const response of responses) {
    assert.equal(response.status, 200);
    for (const key of keysOf(response.body)) assert.doesNotMatch(key, /cost|price|spend|usage|token|prompt/i, key);
    assert.doesNotMatch(JSON.stringify(response.body), /0\.42|Spent \$/);
  }
});

test("search covers only conversations the user can view and that are switched on", async t => {
  const f = await fixture(t);
  const found = await get(f, `/api/conversations/search?server=${SERVER}&q=lighthouse`);
  assert.equal(found.status, 200);
  assert.deepEqual(found.body.messages.map((item: { id: string }) => item.id), ["m4"]);
  assert.equal(found.body.messages[0].channel, CHANNEL);
  assert.equal((await get(f, `/api/conversations/search?server=${SERVER}&q=x`)).status, 400);
});

test("search is fuzzy: typos, partial words, any word order and case", async t => {
  const f = await fixture(t);
  const hits = async (q: string, user = USER) => (await get(f, `/api/conversations/search?server=${SERVER}&q=${encodeURIComponent(q)}`, user)).body.messages.map((item: { id: string }) => item.id);
  assert.deepEqual(await hits("ligthouse"), ["m4"]);
  assert.deepEqual(await hits("LIGHTHOU"), ["m4"]);
  assert.deepEqual(await hits("talk lighthouse"), ["m4"]);
  assert.deepEqual(await hits("third queston"), ["m3"]);
  assert.deepEqual(await hits("zebra"), []);
  // A stranger sees no conversation, so no message either.
  assert.deepEqual(await hits("ligthouse", STRANGER), []);
});

test("used is true only for messages a reply run used, not for participation sources", async t => {
  const f = await fixture(t);
  // run-1 is a reply run (linked to Slopbot's reply). run-part has no reply link, like a participation run.
  await f.store.recordSources("run-1", SERVER, ["m1"]);
  await f.store.recordSources("run-part", SERVER, ["m2"]);
  const page = await get(f, `/api/conversations/${CHANNEL}/messages?server=${SERVER}`);
  const used = Object.fromEntries(page.body.messages.map((item: { id: string; used: boolean }) => [item.id, item.used]));
  assert.equal(used.m1, true);
  assert.equal(used.m2, false);
  assert.equal(used.m4, false);
  // Slopbot's own messages are always used.
  assert.equal(used["bot-1"], true);
  const route = await get(f, `/api/conversations/${CHANNEL}/used?server=${SERVER}&ids=m1,m2,m4`);
  assert.equal(route.status, 200);
  assert.deepEqual(route.body.used, ["m1"]);
});

test("the used route refuses users and channels the messages route refuses", async t => {
  const f = await fixture(t);
  await f.store.recordSources("run-1", SERVER, ["m1"]);
  const path = `/api/conversations/${CHANNEL}/used?server=${SERVER}&ids=m1`;
  assert.equal((await get(f, path, null)).status, 403);
  assert.equal((await get(f, path, STRANGER)).status, 403);
  assert.equal((await get(f, `/api/conversations/${OTHER}/used?server=${SERVER}&ids=o1`)).status, 403);
  assert.equal((await get(f, `/api/conversations/${OTHER}/messages?server=${SERVER}`)).status, 403);
  assert.equal((await get(f, path)).status, 200);
});

test("the used route refuses a user without live View Channel, and bad IDs", async t => {
  const f = await fixture(t);
  f.hidden.add(`${CHANNEL}:${USER}`);
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/used?server=${SERVER}&ids=m1`)).status, 403);
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/messages?server=${SERVER}`)).status, 403);
});

test("the used route rejects more than 200 IDs and IDs with spaces", async t => {
  const f = await fixture(t);
  const many = Array.from({ length: 201 }, (_, i) => `x${i}`).join(",");
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/used?server=${SERVER}&ids=${many}`)).status, 400);
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/used?server=${SERVER}&ids=a%20b`)).status, 400);
});

test("the stream closes with event closed when View Channel is cleared", async t => {
  const f = await fixture(t);
  const c = collect();
  const stop = openEngineStream({
    server: SERVER, channel: CHANNEL, user: USER, cursor: undefined, events: engineEvents, access: f.access,
    allowed: async () => (await f.access.check(SERVER, CHANNEL, USER)).view && transcriptSwitchOn(f.store, SERVER, CHANNEL),
    write: c.write, end: c.end, heartbeatMs: 100000, recheckMs: 100000,
  });
  await settle();
  assert.equal(c.state.ended, false);
  f.hidden.add(`${CHANNEL}:${USER}`);
  f.access.clearChannel(CHANNEL);
  await settle();
  assert.equal(c.state.ended, true);
  assert.match(c.out.join(""), /event: closed\ndata: \{"reason":"access"\}/);
  stop();
});

test("the stream closes when the switch is turned off, and sends no more events after that", async t => {
  const f = await fixture(t);
  const c = collect();
  const stop = openEngineStream({
    server: SERVER, channel: CHANNEL, user: USER, cursor: undefined, events: engineEvents, access: f.access,
    allowed: async () => transcriptSwitchOn(f.store, SERVER, CHANNEL), write: c.write, end: c.end, heartbeatMs: 100000, recheckMs: 100000,
  });
  await settle();
  f.store.setSetting(SERVER, webTranscriptKey(CHANNEL), false);
  f.access.clearServer(SERVER);
  await settle();
  assert.equal(c.state.ended, true);
  const size = c.out.length;
  stop();
  assert.equal(c.out.length, size);
});

