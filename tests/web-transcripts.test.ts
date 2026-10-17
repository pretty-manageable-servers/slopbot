import test from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { ChannelAccess, type ChannelFacts } from "../src/channel-access.js";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { RunEvents } from "../src/run-events.js";
import { webTranscriptKey, transcriptSwitchOn } from "../src/server-tools.js";
import { createTranscripts, openStream, type TranscriptHost } from "../src/web-transcripts.js";
import { createConsole } from "../src/web-console.js";
import type { Message, ModelEvent } from "../src/domain.js";
import { MemberDirectory } from "../src/member-directory.js";

const SERVER = "1528063444874432734", CHANNEL = "1528063444874432735", THREAD = "1528063444874432736", OTHER = "1528063444874432737";
const USER = "1514413259522838529", STRANGER = "1514413259522838530", BOT = "1528063444874432799";
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
const ids = (out: readonly string[]) => out.join("").match(/^id: (\d+)$/gm)?.map(line => Number(line.slice(4))) ?? [];
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
  assert.equal((await get(f, `/api/runs/run-1`, null)).status, 403);
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

test("a switched-off channel is listed as off, and its messages, stream and runs stay 403", async t => {
  const f = await fixture(t);
  assert.equal((await get(f, `/api/conversations/${OTHER}/messages?server=${SERVER}`)).status, 403);
  assert.equal((await get(f, `/api/conversations/${OTHER}/messages?server=${SERVER}`, STRANGER)).status, 403);
  const stream = await fetch(`${f.base}/api/conversations/${OTHER}/stream?server=${SERVER}`, { headers: { "x-user": USER } });
  assert.equal(stream.status, 403);
  await stream.body?.cancel();
  assert.equal((await get(f, `/api/runs/run-3`)).status, 403);
  const list = await get(f, `/api/conversations?server=${SERVER}`);
  const off = list.body.conversations.find((item: { id: string }) => item.id === OTHER);
  assert.equal(off.enabled, false);
  assert.equal(off.canSend, false);
});

test("search never reads messages of a switched-off channel", async t => {
  const f = await fixture(t);
  const found = await get(f, `/api/conversations/search?server=${SERVER}&q=secret`);
  assert.equal(found.status, 200);
  assert.deepEqual(found.body.messages, []);
  assert.ok(!found.body.channels.some((item: { id: string }) => item.id === OTHER));
});

test("a user without live View Channel gets 403 on reads, the stream and runs", async t => {
  const f = await fixture(t);
  f.hidden.add(`${CHANNEL}:${USER}`);
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/messages?server=${SERVER}`)).status, 403);
  assert.equal((await get(f, `/api/runs/run-1`)).status, 403);
  const stream = await fetch(`${f.base}/api/conversations/${CHANNEL}/stream?server=${SERVER}`, { headers: { "x-user": USER } });
  assert.equal(stream.status, 403);
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

test("a run route checks the run's own channel, not the user's other access", async t => {
  const f = await fixture(t);
  // The user can view CHANNEL, but run-3 is in a switched-off channel.
  assert.equal((await get(f, `/api/runs/run-3`)).status, 403);
  assert.equal((await get(f, `/api/runs/run-1`, STRANGER)).status, 403);
  assert.equal((await get(f, `/api/runs/unknown-run`)).status, 404);
  assert.equal((await get(f, `/api/runs/${encodeURIComponent("bad id")}`)).status, 400);
});

test("no cost fields appear in any transcript response", async t => {
  const f = await fixture(t);
  const responses = [
    await get(f, `/api/conversations?server=${SERVER}`),
    await get(f, `/api/conversations/${CHANNEL}/messages?server=${SERVER}`),
    await get(f, `/api/runs/run-1`),
    await get(f, `/api/runs/run-2`),
    await get(f, `/api/conversations/search?server=${SERVER}&q=lighthouse`),
  ];
  for (const response of responses) {
    assert.equal(response.status, 200);
    for (const key of keysOf(response.body)) assert.doesNotMatch(key, /cost|price|spend|usage|token|prompt/i, key);
    assert.doesNotMatch(JSON.stringify(response.body), /0\.42|Spent \$/);
  }
});

test("the used route rejects more than 200 IDs and IDs with spaces", async t => {
  const f = await fixture(t);
  const many = Array.from({ length: 201 }, (_, i) => `x${i}`).join(",");
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/used?server=${SERVER}&ids=${many}`)).status, 400);
  assert.equal((await get(f, `/api/conversations/${CHANNEL}/used?server=${SERVER}&ids=a%20b`)).status, 400);
});

test("reconnect after a cursor sends each later event once, then live events", async t => {
  const f = await fixture(t);
  const bus = new RunEvents();
  bus.attach(f.store);
  bus.publish(SERVER, CHANNEL, "message", "a", { action: "upsert" });
  bus.publish(SERVER, CHANNEL, "run.start", "r", { requestId: "a" });
  bus.publish(SERVER, CHANNEL, "run.delta", "r", { part: "text", text: "x" });
  await bus.idle();
  const saved = await f.store.conversationEventsAfter(SERVER, CHANNEL, 0, 10);
  const cursor = saved[1]!.streamId;
  const c = collect();
  const stop = openStream({ server: SERVER, channel: CHANNEL, user: USER, cursor, store: f.store, bus, access: f.access, allowed: async () => true, write: c.write, end: c.end, heartbeatMs: 100000, recheckMs: 100000 });
  // Published after the stream opens: it is buffered or sent live, never twice.
  bus.publish(SERVER, CHANNEL, "run.delta", "r", { part: "text", text: "y" });
  await settle();
  bus.publish(SERVER, CHANNEL, "message", "b", { action: "upsert" });
  await settle();
  assert.deepEqual(ids(c.out), [saved[2]!.streamId, saved[2]!.streamId + 1, saved[2]!.streamId + 2]);
  stop();
});

test("the stream closes with event closed when View Channel is cleared", async t => {
  const f = await fixture(t);
  const bus = new RunEvents();
  bus.attach(f.store);
  const c = collect();
  const stop = openStream({
    server: SERVER, channel: CHANNEL, user: USER, cursor: 0, store: f.store, bus, access: f.access,
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
  const bus = new RunEvents();
  bus.attach(f.store);
  const c = collect();
  const stop = openStream({
    server: SERVER, channel: CHANNEL, user: USER, cursor: 0, store: f.store, bus, access: f.access,
    allowed: async () => transcriptSwitchOn(f.store, SERVER, CHANNEL), write: c.write, end: c.end, heartbeatMs: 100000, recheckMs: 100000,
  });
  await settle();
  f.store.setSetting(SERVER, webTranscriptKey(CHANNEL), false);
  bus.changed(SERVER);
  await settle();
  assert.equal(c.state.ended, true);
  const size = c.out.length;
  stop();
  assert.equal(c.out.length, size);
});

test("a cursor older than the oldest kept event sends reset, then only live events", async t => {
  const f = await fixture(t);
  const bus = new RunEvents();
  bus.attach(f.store);
  for (const id of ["a", "b", "c"]) bus.publish(SERVER, CHANNEL, "message", id, { action: "upsert" });
  await bus.idle();
  const rows = await f.store.conversationEventsAfter(SERVER, CHANNEL, 0, 10);
  // Keep only the newest row. The cursor is the first row, which is now pruned.
  assert.equal(await f.store.pruneConversationEvents(0, 1), 2);
  const c = collect();
  const stop = openStream({ server: SERVER, channel: CHANNEL, user: USER, cursor: rows[0]!.streamId, store: f.store, bus, access: f.access, allowed: async () => true, write: c.write, end: c.end, heartbeatMs: 100000, recheckMs: 100000 });
  await settle();
  assert.match(c.out.join(""), /^event: reset\ndata: \{"reason":"pruned"\}\n\n/m);
  // The kept row was already before the reset, so it is not sent again. Only live events follow.
  assert.deepEqual(ids(c.out), []);
  bus.publish(SERVER, CHANNEL, "message", "d", { action: "upsert" });
  await settle();
  assert.deepEqual(ids(c.out), [rows[2]!.streamId + 1]);
  stop();
});
