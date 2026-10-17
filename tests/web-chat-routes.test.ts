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
import { ShareService } from "../src/shares.js";
import type { UserLimit } from "../src/user-limiter.js";
import type { Message } from "../src/domain.js";
import type { ObjectStorageProvider } from "../src/object-storage.js";
import { chatFileKey } from "../src/web-chat-files.js";

const SERVER = "1528063444874432734";
const ALICE = "1514413259522838529", BOB = "1514413259522838530", CAROL = "1514413259522838531";
const ORIGIN = "http://localhost:3000";
const MISSING = "0".repeat(32);

/** Chat storage in memory, so the tests never write to disk. */
class MemoryStorage implements ObjectStorageProvider {
  objects = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) { this.objects.set(key, bytes); }
  async get(key: string) { const found = this.objects.get(key); if (!found) throw Object.assign(new Error("missing"), { code: "ENOENT" }); return found; }
  async delete(key: string) { this.objects.delete(key); }
  async link(key: string, _name: string, seconds: number) { return `https://storage.example/${key}?expires=${seconds}`; }
}

interface Fixture {
  store: SQLiteStore;
  storage: MemoryStorage;
  members: Set<string>;
  limit: { current: UserLimit };
  /** Set to true to make the Discord membership check fail, as a Discord outage would. */
  membership: { fail: boolean };
  /** The clock of the share service. Moving it past 60 seconds expires the membership cache. */
  shareNow: { now: number };
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
  const membership = { fail: false };
  const shareNow = { now: Date.now() };
  const limit: { current: UserLimit } = { current: { allowed: true } };
  const received: Message[] = [];
  const storage = new MemoryStorage();
  const handle: PrivateChatHandle = { openChat() { /* no bot in these tests */ }, closeChat() { /* none */ }, async receiveChat(message) { received.push(message); }, async stopResponses() { return []; } };
  let clock = 1_000;
  const host: ChatHost = {
    async member(user, server) { return server === SERVER && members.has(user); },
    async handle(server) { return server === SERVER ? handle : undefined; },
    limiter: { async check() { return limit.current; } },
    access: new ChannelAccess({ async facts() { return undefined; } }),
    images: storage,
  };
  const service = new WebChatService(store, host, undefined, () => ++clock);
  const logins: Record<string, { cookie: string; csrf: string }> = {};
  for (const user of [ALICE, BOB, CAROL]) {
    const id = randomBytes(32).toString("hex"), csrf = `csrf-${user}`;
    await store.saveSession({ id_hash: createHash("sha256").update(id).digest("hex"), user_id: user, csrf, expires: Date.now() + 86_400_000, created: Date.now() });
    logins[user] = { cookie: `slopbot_session=${id}`, csrf };
  }
const shareService = new ShareService({
    store, access: host.access, rule: { manager: async () => false }, now: () => shareNow.now,
    async member(user: string, server: string) {
      if (membership.fail) throw new Error("discord is down");
      return server === SERVER && members.has(user);
    },
} as never);
  const web = createConsole({ origin: ORIGIN, host: "127.0.0.1", port: 3000, clientId: "id", clientSecret: "secret" }, {
    sessions: store, async canSignIn() { return true; },
    async snapshot() { return {}; },
    async invoke() { return {}; },
    chats: createChatRoutes(service),
    // The public share pages read the same store. Channel share writes are not used in these tests.
    shares: shareService,
    continueShare: (user, id) => service.continueShare(user, id, shareService),
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
    // A Buffer is a raw body, sent as octet-stream unless the headers give another type.
    if (body !== undefined) head["Content-Type"] = Buffer.isBuffer(body) ? "application/octet-stream" : "application/json";
    const payload = body === undefined ? {} : { body: Buffer.isBuffer(body) ? new Uint8Array(body) : typeof body === "string" ? body : JSON.stringify(body) };
    const response = await fetch(base + path, { method, headers: { ...head, ...headers }, ...payload });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : undefined };
  }
  return { store, storage, members, limit, membership, shareNow, received, base, cookie: user => logins[user]!.cookie, call };
}

async function newChat(f: Fixture, user = ALICE): Promise<string> {
  const created = await f.call(user, "POST", "/api/chats", { server: SERVER });
  assert.equal(created.status, 201);
  return created.json.id as string;
}

/** Uploads one file as raw bytes. The name goes in the query and the type in the Content-Type header. */
const uploadFile = (f: Fixture, user: string, id: string, bytes: Buffer, name = "notes.txt", type = "text/plain") =>
  f.call(user, "POST", `/api/chats/${id}/files?name=${encodeURIComponent(name)}`, bytes, { "Content-Type": type });


async function download(f: Fixture, user: string | null, path: string) {
  const response = await fetch(f.base + path, { headers: user ? { Cookie: f.cookie(user) } : {} });
  return { status: response.status, headers: response.headers, bytes: Buffer.from(await response.arrayBuffer()) };
}

test("the list, create, rename and delete routes keep the shapes the UI reads", async t => {
  const f = await setup(t);
  const created = await f.call(ALICE, "POST", "/api/chats", { server: SERVER });
  assert.equal(created.status, 201);
  assert.deepEqual(Object.keys(created.json), ["id"]);
  assert.match(created.json.id, /^[0-9a-f]{32}$/);
  const id = created.json.id as string;

  let list = await f.call(ALICE, "GET", `/api/chats`);
  assert.equal(list.status, 200);
  assert.ok(Array.isArray(list.json), "the list is a bare array");
  assert.equal(list.json.length, 1);
  assert.deepEqual(Object.keys(list.json[0]).sort(), ["effort", "id", "title", "updated"]);
  assert.equal(list.json[0].id, id);
  assert.equal(list.json[0].title, "");
  assert.equal(typeof list.json[0].updated, "number");

  const sent = await f.call(ALICE, "POST", `/api/chats/${id}/messages`, { text: "  Plan   a trip to Lisbon  " });
  assert.equal(sent.status, 201);
  assert.deepEqual(Object.keys(sent.json), ["id"]);
  list = await f.call(ALICE, "GET", `/api/chats`);
  assert.equal(list.json[0].title, "Plan a trip to Lisbon", "the first message gives the title");

  const renamed = await f.call(ALICE, "PATCH", `/api/chats/${id}`, { title: "Trips" });
  assert.equal(renamed.status, 200);
  list = await f.call(ALICE, "GET", `/api/chats`);
  assert.equal(list.json[0].title, "Trips");

  const removed = await f.call(ALICE, "DELETE", `/api/chats/${id}`);
  assert.equal(removed.status, 200);
  assert.deepEqual((await f.call(ALICE, "GET", `/api/chats`)).json, []);
  const gone = await f.call(ALICE, "GET", `/api/chats/${id}/messages`);
  assert.equal(gone.status, 404);
  assert.deepEqual(Object.keys(gone.json), ["error"]);
});

test("only the owner can read, send, rename, delete or stream a chat; others get 404", async t => {
  const f = await setup(t);
  const id = await newChat(f);
  assert.equal((await f.call(ALICE, "POST", `/api/chats/${id}/messages`, { text: "private note" })).status, 201);

  assert.deepEqual((await f.call(BOB, "GET", `/api/chats`)).json, [], "a member does not see another user's chats");
  assert.equal((await f.call(BOB, "GET", `/api/chats/${id}/messages`)).status, 404);
  assert.equal((await f.call(BOB, "POST", `/api/chats/${id}/messages`, { text: "intrude" })).status, 404);
  assert.equal((await f.call(BOB, "PATCH", `/api/chats/${id}`, { title: "Stolen" })).status, 404);
  assert.equal((await f.call(BOB, "DELETE", `/api/chats/${id}`)).status, 404);
  const blocked = await fetch(`${f.base}/api/chats/${id}/stream`, { headers: { Cookie: f.cookie(BOB) } });
  assert.equal(blocked.status, 404);
  assert.equal(f.received.length, 1, "only Alice's message reached the bot");

  assert.equal((await f.call(ALICE, "GET", `/api/chats/${MISSING}/messages`)).status, 404, "unknown chat");
  assert.equal((await f.call(ALICE, "GET", "/api/chats/not-a-chat/messages")).status, 404, "malformed chat ID");
  const kept = await f.call(ALICE, "GET", `/api/chats`);
  assert.equal(kept.json[0].title, "private note", "the owner's chat is unchanged");
});

test("a user who is not in the server is refused, and loses a chat when they leave", async t => {
  const f = await setup(t);
  const id = await newChat(f);
  assert.deepEqual((await f.call(CAROL, "GET", `/api/chats`)).json, [], "a user with no chats gets an empty list");
  assert.equal((await f.call(CAROL, "POST", "/api/chats", { server: SERVER })).status, 404);
  assert.equal((await f.call(CAROL, "POST", `/api/chats/${id}/messages`, { text: "hi" })).status, 404);
  assert.equal((await f.call(ALICE, "GET", `/api/chats?server=123`)).json.length, 1, "the server parameter is ignored: chats are not per server");

  f.members.delete(ALICE);
  assert.deepEqual((await f.call(ALICE, "GET", `/api/chats`)).json, [], "a chat in a server the user left is not listed");
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

test("revoking a chat link stops it; a link of another chat is 404; deleting the chat removes its links", async t => {
  const f = await setup(t);
  const one = await newChat(f), two = await newChat(f);
  await f.call(ALICE, "POST", `/api/chats/${one}/messages`, { text: "one" });
  await f.call(ALICE, "POST", `/api/chats/${two}/messages`, { text: "two" });
  const first = (await f.call(ALICE, "POST", `/api/chats/${one}/shares`, {})).json.id as string;
  const second = (await f.call(ALICE, "POST", `/api/chats/${two}/shares`, {})).json.id as string;

  assert.equal((await f.call(ALICE, "POST", `/api/chats/${two}/shares/${first}/revoke`, {})).status, 404, "a link of another chat");
  assert.equal((await f.call(null, "GET", `/api/shares/${first}`)).status, 200);
  assert.deepEqual((await f.call(ALICE, "POST", `/api/chats/${one}/shares/${first}/revoke`, {})).json, { id: first, revoked: true });
  assert.equal((await f.call(null, "GET", `/api/shares/${first}`)).status, 404, "a revoked link is gone");
  assert.equal((await fetch(`${f.base}/s/${first}`)).status, 404);
  assert.equal((await f.call(null, "GET", `/api/shares/${second}`)).status, 200, "the other chat's link is unchanged");

  assert.equal((await f.call(ALICE, "DELETE", `/api/chats/${two}`)).status, 200);
  assert.equal((await f.call(null, "GET", `/api/shares/${second}`)).status, 404, "deleting the chat removes its link");
  assert.equal((await fetch(`${f.base}/s/${second}`)).status, 404);
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

  assert.equal((await f.call(null, "GET", `/api/chats`)).status, 401, "no session");
  assert.equal((await f.call(ALICE, "POST", messages, { text: "no csrf" }, { "X-CSRF-Token": "wrong" })).status, 403, "wrong CSRF token");
  assert.equal((await f.call(ALICE, "POST", messages, { text: "other origin" }, { Origin: "https://evil.example" })).status, 403, "wrong origin");
  assert.equal((await f.call(ALICE, "DELETE", `/api/chats/${id}`, undefined, { "X-CSRF-Token": "wrong" })).status, 403);
});

test("PATCH effort accepts low, medium, xhigh or null and refuses anything else", async t => {
  const f = await setup(t);
  const id = await newChat(f);
  for (const value of ["low", "medium", "xhigh"]) {
    assert.equal((await f.call(ALICE, "PATCH", `/api/chats/${id}`, { effort: value })).status, 200);
    assert.equal((await f.call(ALICE, "GET", `/api/chats`)).json[0].effort, value);
  }
  for (const bad of ["high", "", 3, true, "LOW"]) assert.equal((await f.call(ALICE, "PATCH", `/api/chats/${id}`, { effort: bad })).status, 400);
  assert.equal((await f.call(ALICE, "GET", `/api/chats`)).json[0].effort, "xhigh", "a refused value changes nothing");
  assert.equal((await f.call(ALICE, "PATCH", `/api/chats/${id}`, { effort: null })).status, 200);
  assert.equal((await f.call(ALICE, "GET", `/api/chats`)).json[0].effort, "medium", "no choice shows medium");
  assert.equal((await f.call(ALICE, "PATCH", `/api/chats/${id}`, { title: "Trips" })).status, 200, "a title change still works");
});

// Continue a shared chat: POST /api/shares/<id>/continue copies a live share into a new private chat of the viewer.
const SHARE_ID = "AAAAAAAAAAAAAAAAAAAAAA";
async function sharedChat(f: Fixture): Promise<{ shareId: string }> {
  const id = await newChat(f, ALICE);
  assert.equal((await f.call(ALICE, "POST", `/api/chats/${id}/messages`, { text: "first private line" })).status, 201);
  // A saved answer from Slopbot. It has no run here, so only its text is copied.
  f.store.setSetting(SERVER, "context_bot_author", "bot-1");
  await f.store.ingest({ id: "bot-answer-1", server: SERVER, channel: `web:${id}`, author: "bot-1", authorName: "Slopbot", isBot: true, text: "**Adapter** is ready.", timestamp: 2_000, addressed: false });
  const shared = await f.call(ALICE, "POST", `/api/chats/${id}/shares`, {});
  assert.equal(shared.status, 201);
  return { shareId: shared.json.id as string };
}

test("a revoked or unknown share cannot be continued", async t => {
  const f = await setup(t);
  const { shareId } = await sharedChat(f);
  assert.equal((await f.call(BOB, "POST", `/api/shares/${SHARE_ID}/continue`, {})).status, 404, "unknown");
  const chat = (await f.call(ALICE, "GET", `/api/chats`)).json[0].id as string;
  assert.equal((await f.call(ALICE, "POST", `/api/chats/${chat}/shares/${shareId}/revoke`, {})).status, 200);
  const before = (await f.call(BOB, "GET", `/api/chats`)).json.length;
  assert.equal((await f.call(BOB, "POST", `/api/shares/${shareId}/continue`, {})).status, 404, "revoked");
  assert.equal((await f.call(BOB, "GET", `/api/chats`)).json.length, before, "no chat is made");
});

test("a share of a chat whose owner left the server cannot be continued", async t => {
  const f = await setup(t);
  const { shareId } = await sharedChat(f);
  f.members.delete(ALICE);
  f.shareNow.now += 61_000;
  assert.equal((await f.call(BOB, "POST", `/api/shares/${shareId}/continue`, {})).status, 404);
});

test("continuing needs a sign-in, the same origin and the CSRF token", async t => {
  const f = await setup(t);
  const { shareId } = await sharedChat(f);
  assert.equal((await f.call(null, "POST", `/api/shares/${shareId}/continue`, {})).status, 401, "not signed in");
  assert.equal((await f.call(BOB, "POST", `/api/shares/${shareId}/continue`, {}, { "X-CSRF-Token": "wrong" })).status, 403, "wrong CSRF token");
  assert.equal((await f.call(BOB, "POST", `/api/shares/${shareId}/continue`, {}, { Origin: "https://evil.example" })).status, 403, "wrong origin");
  assert.equal((await f.call(BOB, "GET", `/api/chats`)).json.length, 0, "no chat is made by a refused request");
  assert.equal((await fetch(`${f.base}/api/shares/${shareId}/continue`, { method: "POST", headers: { Cookie: f.cookie(BOB), Origin: ORIGIN, "X-CSRF-Token": "csrf-" + BOB } })).status, 201, "the same request with the token works");
});

test("read file sets attachment disposition", async t => {
  const f = await setup(t);
  const id = await newChat(f);
  const name = "my report (final) é.csv";
  const up = await uploadFile(f, ALICE, id, Buffer.from("a,b\n1,2\n"), name, "text/csv");
  assert.equal(up.status, 201);
  const fileId = up.json.fileId as string;
  const path = `/api/chats/${id}/files/${fileId}`;
  const disposition = `attachment; filename*=UTF-8''${encodeURIComponent(name)}`;
  const check = (got: Awaited<ReturnType<typeof download>>) => {
    assert.equal(got.status, 200);
    assert.equal(got.headers.get("content-type"), "application/octet-stream");
    assert.equal(got.headers.get("content-disposition"), disposition);
    assert.equal(got.headers.get("x-content-type-options"), "nosniff");
    assert.equal(got.headers.get("cache-control"), "private, max-age=600");
    assert.deepEqual(got.bytes, Buffer.from("a,b\n1,2\n"));
  };
  // Before the send, the name comes from the pending upload.
  check(await download(f, ALICE, path));
  // After the send, the name comes from the message row.
  assert.equal((await f.call(ALICE, "POST", `/api/chats/${id}/messages`, { text: "look", files: [fileId] })).status, 201);
  check(await download(f, ALICE, path));
  // With no pending entry and no message row, the file ID is the name.
  const orphan = "f".repeat(32) + ".txt";
  f.storage.objects.set(chatFileKey(SERVER, id, orphan), Buffer.from("orphan"));
  const named = await download(f, ALICE, `/api/chats/${id}/files/${orphan}`);
  assert.equal(named.status, 200);
  assert.equal(named.headers.get("content-disposition"), `attachment; filename*=UTF-8''${orphan}`);
});

test("other user cannot read file", async t => {
  const f = await setup(t);
  const id = await newChat(f), bobChat = await newChat(f, BOB);
  const fileId = (await uploadFile(f, ALICE, id, Buffer.from("secret"), "secret.txt")).json.fileId as string;
  assert.equal((await f.call(ALICE, "POST", `/api/chats/${id}/messages`, { text: "secret", files: [fileId] })).status, 201);
  const path = `/api/chats/${id}/files/${fileId}`;
  assert.equal((await download(f, ALICE, path)).status, 200, "the owner reads it");
  assert.equal((await download(f, BOB, path)).status, 404, "another member cannot read it");
  assert.equal((await download(f, CAROL, path)).status, 404, "a non-member cannot read it");
  assert.equal((await download(f, null, path)).status, 401, "no session");
  assert.equal((await download(f, BOB, `/api/chats/${bobChat}/files/${fileId}`)).status, 404, "another chat cannot reach the file");
  assert.equal((await download(f, ALICE, `/api/chats/${id}/files/${MISSING}.txt`)).status, 404, "unknown file");
  assert.equal((await download(f, ALICE, `/api/chats/${id}/files/..%2Fescape.txt`)).status, 404, "a bad file ID");
  assert.equal((await f.call(BOB, "DELETE", `/api/chats/${id}/files/${fileId}`)).status, 404, "another user cannot delete it");
  assert.equal((await f.call(BOB, "POST", `/api/chats/${bobChat}/messages`, { text: "steal", files: [fileId] })).status, 400, "another user cannot send it");
  assert.equal(f.storage.objects.size, 1, "the file is kept");
});
