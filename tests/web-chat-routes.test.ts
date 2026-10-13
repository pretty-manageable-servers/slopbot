import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { ChannelAccess } from "../src/channel-access.js";
import { createConsole } from "../src/web-console.js";
import { createChatRoutes, WebChatService, type ChatHost, type PrivateChatHandle } from "../src/web-chats.js";
import { runEvents } from "../src/run-events.js";
import { createTranscripts } from "../src/web-transcripts.js";
import type { UserLimit } from "../src/user-limiter.js";
import type { Message } from "../src/domain.js";

const SERVER = "1528063444874432734";
const ALICE = "1514413259522838529", BOB = "1514413259522838530", CAROL = "1514413259522838531";
const ORIGIN = "http://localhost:3000";
const MISSING = "0".repeat(32);

interface Fixture {
  store: SQLiteStore;
  members: Set<string>;
  limit: { current: UserLimit };
  received: Message[];
  base: string;
  cookie(user: string): string;
  call(user: string | null, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: any }>;
}

/** Real SQLite store, real service and routes behind the console. The Discord side is a fake host. */
async function setup(t: TestContext): Promise<Fixture> {
  const store = new SQLiteStore(":memory:");
  t.after(() => store.close());
  // Live events are saved and sent only once the global bus has a store, as in production.
  runEvents.attach(store);
  const members = new Set([ALICE, BOB]);
  const limit: { current: UserLimit } = { current: { allowed: true } };
  const received: Message[] = [];
  const handle: PrivateChatHandle = { openChat() { /* no bot in these tests */ }, closeChat() { /* none */ }, async receiveChat(message) { received.push(message); } };
  let clock = 1_000;
  const host: ChatHost = {
    async member(user, server) { return server === SERVER && members.has(user); },
    async handle(server) { return server === SERVER ? handle : undefined; },
    limiter: { async check() { return limit.current; } },
    access: new ChannelAccess({ async facts() { return undefined; } }),
  };
  const service = new WebChatService(store, host, undefined, () => ++clock);
  const logins: Record<string, { cookie: string; csrf: string }> = {};
  for (const user of [ALICE, BOB, CAROL]) {
    const id = randomBytes(32).toString("hex"), csrf = `csrf-${user}`;
    await store.saveSession({ id_hash: createHash("sha256").update(id).digest("hex"), user_id: user, csrf, expires: Date.now() + 86_400_000, created: Date.now() });
    logins[user] = { cookie: `slopbot_session=${id}`, csrf };
  }
  const web = createConsole({ origin: ORIGIN, host: "127.0.0.1", port: 3000, clientId: "id", clientSecret: "secret" }, {
    sessions: store,
    async snapshot() { return {}; },
    async invoke() { return {}; },
    chats: createChatRoutes(service),
    conversations: createTranscripts({ store, access: host.access, configured: () => [], channelName: async () => undefined, ownsPrivateChat: (server, channel, user) => service.owns(user, server, channel) }),
  });
  web.listen(0, "127.0.0.1");
  await once(web, "listening");
  t.after(() => new Promise<void>(resolve => { web.closeAllConnections(); web.close(() => resolve()); }));
  const address = web.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const base = `http://127.0.0.1:${address.port}`;

  async function call(user: string | null, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) {
    const head: Record<string, string> = {};
    if (user) head.Cookie = logins[user]!.cookie;
    if (method !== "GET") { head.Origin = ORIGIN; if (user) head["X-CSRF-Token"] = logins[user]!.csrf; }
    if (body !== undefined) head["Content-Type"] = "application/json";
    const payload = body === undefined ? {} : { body: typeof body === "string" ? body : JSON.stringify(body) };
    const response = await fetch(base + path, { method, headers: { ...head, ...headers }, ...payload });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : undefined };
  }
  return { store, members, limit, received, base, cookie: user => logins[user]!.cookie, call };
}

async function newChat(f: Fixture, user = ALICE): Promise<string> {
  const created = await f.call(user, "POST", "/api/chats", { server: SERVER });
  assert.equal(created.status, 201);
  return created.json.id as string;
}

test("the list, create, rename and delete routes keep the shapes the UI reads", async t => {
  const f = await setup(t);
  const created = await f.call(ALICE, "POST", "/api/chats", { server: SERVER });
  assert.equal(created.status, 201);
  assert.deepEqual(Object.keys(created.json), ["id"]);
  assert.match(created.json.id, /^[0-9a-f]{32}$/);
  const id = created.json.id as string;

  let list = await f.call(ALICE, "GET", `/api/chats?server=${SERVER}`);
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.json), "the list is a bare array");
  assert.equal(list.json.length, 1);
  assert.deepEqual(Object.keys(list.json[0]).sort(), ["id", "title", "updated"]);
  assert.equal(list.json[0].id, id);
  assert.equal(list.json[0].title, "");
  assert.equal(typeof list.json[0].updated, "number");

  const sent = await f.call(ALICE, "POST", `/api/chats/${id}/messages`, { text: "  Plan   a trip to Lisbon  " });
  assert.equal(sent.status, 201);
  assert.deepEqual(Object.keys(sent.json), ["id"]);
  list = await f.call(ALICE, "GET", `/api/chats?server=${SERVER}`);
  assert.equal(list.json[0].title, "Plan a trip to Lisbon", "the first message gives the title");

  const renamed = await f.call(ALICE, "PATCH", `/api/chats/${id}`, { title: "Trips" });
  assert.equal(renamed.status, 200);
  list = await f.call(ALICE, "GET", `/api/chats?server=${SERVER}`);
  assert.equal(list.json[0].title, "Trips");

  const removed = await f.call(ALICE, "DELETE", `/api/chats/${id}`);
  assert.equal(removed.status, 200);
  assert.deepEqual((await f.call(ALICE, "GET", `/api/chats?server=${SERVER}`)).json, []);
  const gone = await f.call(ALICE, "GET", `/api/chats/${id}/messages`);
  assert.equal(gone.status, 404);
  assert.deepEqual(Object.keys(gone.json), ["error"]);
});

test("the messages route returns a page with hasMore and streamId, and pages back with before", async t => {
  const f = await setup(t);
  const id = await newChat(f);
  for (const text of ["one", "two", "three"]) assert.equal((await f.call(ALICE, "POST", `/api/chats/${id}/messages`, { text })).status, 201);

  const newest = await f.call(ALICE, "GET", `/api/chats/${id}/messages?limit=2`);
  assert.equal(newest.status, 200);
  assert.deepEqual(Object.keys(newest.json).sort(), ["hasMore", "messages", "streamId"]);
  assert.deepEqual(newest.json.messages.map((item: { text: string }) => item.text), ["two", "three"], "messages are oldest first within the page");
  assert.equal(newest.json.hasMore, true);
  assert.equal(typeof newest.json.streamId, "number");

  const older = await f.call(ALICE, "GET", `/api/chats/${id}/messages?limit=2&before=${newest.json.messages[0].id}`);
  assert.deepEqual(older.json.messages.map((item: { text: string }) => item.text), ["one"]);
  assert.equal(older.json.hasMore, false);

  const all = await f.call(ALICE, "GET", `/api/chats/${id}/messages?before=`);
  assert.equal(all.status, 200, "an empty before cursor is no cursor");
  assert.equal(all.json.messages.length, 3);
  assert.equal(all.json.hasMore, false);

  for (const query of ["limit=0", "limit=101", "limit=abc", "before=bad%21cursor", `before=${MISSING}`]) {
    const bad = await f.call(ALICE, "GET", `/api/chats/${id}/messages?${query}`);
    assert.equal(bad.status, 400, query);
    assert.equal(typeof bad.json.error, "string", query);
  }
});

test("the stream route sends the saved message as an event after the cursor", async t => {
  const f = await setup(t);
  const id = await newChat(f);
  const controller = new AbortController();
  t.after(() => controller.abort());
  const stream = await fetch(`${f.base}/api/chats/${id}/stream?after=0`, { headers: { Cookie: f.cookie(ALICE) }, signal: controller.signal });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type") ?? "", /^text\/event-stream/);
  const reader = stream.body!.getReader();
  const decoder = new TextDecoder();
  let seen = "";
  const until = async (pattern: RegExp) => {
    while (!pattern.test(seen)) {
      const chunk = await reader.read();
      if (chunk.done) throw new Error("stream ended early");
      seen += decoder.decode(chunk.value, { stream: true });
    }
  };
  await until(/retry: 3000/);
  assert.equal((await f.call(ALICE, "POST", `/api/chats/${id}/messages`, { text: "streamed hello" })).status, 201);
  await until(/event: message\ndata: .*streamed hello/);
  assert.match(seen, /id: \d+\nevent: message/, "events carry stream IDs");
  controller.abort();
});

test("only the owner can read, send, rename, delete or stream a chat; others get 404", async t => {
  const f = await setup(t);
  const id = await newChat(f);
  assert.equal((await f.call(ALICE, "POST", `/api/chats/${id}/messages`, { text: "private note" })).status, 201);

  assert.deepEqual((await f.call(BOB, "GET", `/api/chats?server=${SERVER}`)).json, [], "a member does not see another user's chats");
  assert.equal((await f.call(BOB, "GET", `/api/chats/${id}/messages`)).status, 404);
  assert.equal((await f.call(BOB, "POST", `/api/chats/${id}/messages`, { text: "intrude" })).status, 404);
  assert.equal((await f.call(BOB, "PATCH", `/api/chats/${id}`, { title: "Stolen" })).status, 404);
  assert.equal((await f.call(BOB, "DELETE", `/api/chats/${id}`)).status, 404);
  const blocked = await fetch(`${f.base}/api/chats/${id}/stream`, { headers: { Cookie: f.cookie(BOB) } });
  assert.equal(blocked.status, 404);
  assert.equal(f.received.length, 1, "only Alice's message reached the bot");

  assert.equal((await f.call(ALICE, "GET", `/api/chats/${MISSING}/messages`)).status, 404, "unknown chat");
  assert.equal((await f.call(ALICE, "GET", "/api/chats/not-a-chat/messages")).status, 404, "malformed chat ID");
  const kept = await f.call(ALICE, "GET", `/api/chats?server=${SERVER}`);
  assert.equal(kept.json[0].title, "private note", "the owner's chat is unchanged");
});

test("a user who is not in the server is refused, and loses a chat when they leave", async t => {
  const f = await setup(t);
  const id = await newChat(f);
  assert.equal((await f.call(CAROL, "GET", `/api/chats?server=${SERVER}`)).status, 404);
  assert.equal((await f.call(CAROL, "POST", "/api/chats", { server: SERVER })).status, 404);
  assert.equal((await f.call(CAROL, "POST", `/api/chats/${id}/messages`, { text: "hi" })).status, 404);
  assert.equal((await f.call(ALICE, "GET", `/api/chats?server=123`)).status, 404, "a server ID that is not a snowflake");

  f.members.delete(ALICE);
  assert.equal((await f.call(ALICE, "GET", `/api/chats/${id}/messages`)).status, 404, "a user who left the server gets 404");
  assert.equal((await f.call(ALICE, "POST", `/api/chats/${id}/messages`, { text: "still here?" })).status, 404);
});

test("a usage limit refuses the message before it is saved, with the reset time", async t => {
  const f = await setup(t);
  const id = await newChat(f);
  f.limit.current = { allowed: false, resetAt: 1_800_000_000_000 };
  const refused = await f.call(ALICE, "POST", `/api/chats/${id}/messages`, { text: "over the limit" });
  assert.equal(refused.status, 429);
  assert.equal(refused.json.resetAt, 1_800_000_000_000);
  assert.equal(typeof refused.json.error, "string");
  assert.equal(f.received.length, 0, "the bot never sees a refused message");
  const page = await f.call(ALICE, "GET", `/api/chats/${id}/messages`);
  assert.deepEqual(page.json.messages, [], "the refused message is not saved");

  f.limit.current = { allowed: true };
  assert.equal((await f.call(ALICE, "POST", `/api/chats/${id}/messages`, { text: "after the reset" })).status, 201);
});

test("a reply run of a private chat opens for its owner only", async t => {
  const f = await setup(t);
  const id = await newChat(f);
  const sent = await f.call(ALICE, "POST", `/api/chats/${id}/messages`, { text: "what is the plan?" });
  const request = await f.store.canonicalMessage(SERVER, sent.json.id);
  assert.ok(request);
  await f.store.startRun("run-private-1", request, { prefixVersion: "v1", prefix: [], history: [], inputs: [], purpose: "reply" });
  await f.store.appendEvent("run-private-1", 0, { kind: "text", payload: { text: "The plan is ready." } });
  await f.store.complete("run-private-1", undefined, [], "The plan is ready.");

  const own = await f.call(ALICE, "GET", "/api/runs/run-private-1");
  assert.equal(own.status, 200);
  assert.equal(own.json.channel, `web:${id}`);
  assert.deepEqual(own.json.steps, [{ type: "text", text: "The plan is ready." }]);
  assert.equal((await f.call(BOB, "GET", "/api/runs/run-private-1")).status, 403, "another member cannot read the run");
  assert.equal((await f.call(CAROL, "GET", "/api/runs/run-private-1")).status, 403, "a non-member cannot read the run");
  assert.equal((await f.call(null, "GET", "/api/runs/run-private-1")).status, 403, "no session");
  assert.equal((await f.call(ALICE, "GET", `/api/conversations/${id}/messages?server=${SERVER}`)).status, 400, "the transcript routes do not serve private chats");
});

test("a sent message is saved as a web message from the user and handed to the bot", async t => {
  const f = await setup(t);
  const id = await newChat(f);
  const sent = await f.call(ALICE, "POST", `/api/chats/${id}/messages`, { text: "hello bot" });
  const saved = await f.store.canonicalMessage(SERVER, sent.json.id);
  assert.ok(saved, "the message is saved");
  assert.equal(saved.author, ALICE);
  assert.equal(saved.source, "web");
  assert.equal(saved.addressed, true);
  assert.equal(f.received.length, 1);
  assert.equal(f.received[0]!.id, sent.json.id);
});

test("bad input gets a status and an {error} body; writes need the session, CSRF and a JSON body", async t => {
  const f = await setup(t);
  const id = await newChat(f);
  const messages = `/api/chats/${id}/messages`;
  assert.equal((await f.call(ALICE, "POST", messages, { text: "   " })).status, 400);
  assert.equal((await f.call(ALICE, "POST", messages, { text: 8001 })).status, 400);
  assert.equal((await f.call(ALICE, "POST", messages, { text: "x".repeat(8001) })).status, 400);
  assert.equal((await f.call(ALICE, "POST", messages, { text: "x".repeat(8000) })).status, 201, "8000 characters is allowed");
  assert.equal(typeof (await f.call(ALICE, "POST", messages, { text: "   " })).json.error, "string");
  assert.equal((await f.call(ALICE, "POST", messages, "{")).status, 400, "invalid JSON");
  assert.equal((await f.call(ALICE, "POST", messages, "{}", { "Content-Type": "text/plain" })).status, 415, "non-JSON body");
  assert.equal((await f.call(ALICE, "PATCH", `/api/chats/${id}`, { title: "   " })).status, 400);
  assert.equal((await f.call(ALICE, "PATCH", `/api/chats/${id}`, { title: "x".repeat(61) })).status, 400);
  assert.equal((await f.call(ALICE, "POST", "/api/chats", {})).status, 404, "a create without a server");

  assert.equal((await f.call(null, "GET", `/api/chats?server=${SERVER}`)).status, 401, "no session");
  assert.equal((await f.call(ALICE, "POST", messages, { text: "no csrf" }, { "X-CSRF-Token": "wrong" })).status, 403, "wrong CSRF token");
  assert.equal((await f.call(ALICE, "POST", messages, { text: "other origin" }, { Origin: "https://evil.example" })).status, 403, "wrong origin");
  assert.equal((await f.call(ALICE, "DELETE", `/api/chats/${id}`, undefined, { "X-CSRF-Token": "wrong" })).status, 403);
});
