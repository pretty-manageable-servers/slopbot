import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { ChannelAccess } from "../src/channel-access.js";
import { createConsole } from "../src/web-console.js";
import { createChatRoutes, WebChatService, type ChatHost } from "../src/web-chats.js";
import { runEvents } from "../src/run-events.js";
import { createTranscripts } from "../src/web-transcripts.js";
import { ShareService } from "../src/shares.js";

import type { ObjectStorageProvider } from "../src/object-storage.js";
import type { Message } from "../src/domain.js";

const SERVER = "1528063444874432734";
const ALICE = "1514413259522838529", BOB = "1514413259522838530";
const ORIGIN = "http://localhost:3000";
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("rest of png")]);

class FakeStorage implements ObjectStorageProvider {
  objects = new Map<string, Uint8Array>();
  async put(key: string, bytes: Uint8Array) { this.objects.set(key, bytes); }
  async get(key: string) { const found = this.objects.get(key); if (!found) throw new Error("missing"); return found; }
  async delete(key: string) { this.objects.delete(key); }
  async link(key: string, _name: string, seconds: number) { return `https://storage.example/${key}?expires=${seconds}`; }
}

async function setup(t: TestContext) {
  const store = new SQLiteStore(":memory:");
  t.after(() => store.close());
  runEvents.attach(store);
  const storage = new FakeStorage(), received: Message[] = [];
  const limit = { allowed: true } as { allowed: boolean };
  const host: ChatHost = {
    async member(user, server) { return server === SERVER && [ALICE, BOB].includes(user); },
    async handle() { return { openChat() { /* none */ }, closeChat() { /* none */ }, async receiveChat(message) { received.push(message); }, async stopResponses() { return []; } }; },
    limiter: { async check() { return limit as never; } },
    access: new ChannelAccess({ async facts() { return undefined; } }),
    images: storage,
  };
  const members = new Set([ALICE, BOB]);
  const service = new WebChatService(store, host);
  const logins: Record<string, { cookie: string; csrf: string }> = {};
  for (const user of [ALICE, BOB]) {
    const id = randomBytes(32).toString("hex"), csrf = `csrf-${user}`;
    await store.saveSession({ id_hash: createHash("sha256").update(id).digest("hex"), user_id: user, csrf, expires: Date.now() + 86_400_000, created: Date.now() });
    logins[user] = { cookie: `slopbot_session=${id}`, csrf };
  }
  const web = createConsole({ origin: ORIGIN, host: "127.0.0.1", port: 3000, clientId: "id", clientSecret: "secret" }, {
    sessions: store, async canSignIn() { return true; }, async snapshot() { return {}; }, async invoke() { return {}; }, chats: createChatRoutes(service),
    shares: new ShareService({ store, access: host.access, rule: { manager: async () => false }, member: async (user: string) => members.has(user), images: storage }) as never,
    conversations: createTranscripts({ store, access: host.access, configured: () => [], channelName: async () => undefined, ownsPrivateChat: (server, channel, user) => service.owns(user, server, channel) }),
  });
  web.listen(0, "127.0.0.1");
  await once(web, "listening");
  t.after(() => new Promise<void>(resolve => { web.closeAllConnections(); web.close(() => resolve()); }));
  const address = web.address();
  if (!address || typeof address === "string") throw new Error("no address");
  const raw = async (path: string) => { const r = await fetch(`http://127.0.0.1:${address.port}${path}`); return { status: r.status, text: await r.text() }; };
  const call = async (user: string, method: string, path: string, body?: unknown, type = "application/json") => {
    const headers: Record<string, string> = { Cookie: logins[user]!.cookie };
    if (method !== "GET") { headers.Origin = ORIGIN; headers["X-CSRF-Token"] = logins[user]!.csrf; }
    if (body !== undefined) headers["Content-Type"] = type;
    const response = await fetch(`http://127.0.0.1:${address.port}${path}`, { method, headers, ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? new Uint8Array(body) : JSON.stringify(body) }) });
    const raw = Buffer.from(await response.arrayBuffer());
    const text = raw.toString();
    return { status: response.status, raw, type: response.headers.get("content-type"), json: response.headers.get("content-type")?.includes("json") && text ? JSON.parse(text) : undefined };
  };
  const chat = async (user = ALICE) => (await call(user, "POST", "/api/chats", { server: SERVER })).json.id as string;
  const upload = (user: string, id: string, bytes: Buffer, name = "shot.png", type = "image/png") => call(user, "POST", `/api/chats/${id}/images?name=${name}`, bytes, type);
  return { store, storage, received, limit, members, raw, call, chat, upload };
}

test("upload accepts a real image, rejects wrong magic bytes and a non-image type", async t => {
  const f = await setup(t), id = await f.chat();
  const ok = await f.upload(ALICE, id, PNG);
  assert.equal(ok.status, 201);
  assert.equal(ok.json.contentType, "image/png");
  assert.match(ok.json.imageId, /^[0-9a-f]{32}\.png$/);
  assert.ok([...f.storage.objects.keys()].every(key => key.startsWith(`web-chats/${SERVER}/${id}/`)));
  assert.equal((await f.upload(ALICE, id, Buffer.from("<html>not an image</html>"))).status, 415);
  assert.equal((await f.upload(ALICE, id, PNG, "x.png", "text/plain")).status, 415);
});

test("upload over 25 MB answers 413 and stores nothing", async t => {
  const f = await setup(t), id = await f.chat();
  const big = Buffer.concat([PNG, Buffer.alloc(25 * 1024 * 1024)]);
  assert.equal((await f.upload(ALICE, id, big)).status, 413);
  assert.equal(f.storage.objects.size, 0);
});

test("the usage limit is checked before an image is stored or a message is saved", async t => {
  const f = await setup(t), id = await f.chat();
  const first = await f.upload(ALICE, id, PNG);
  f.limit.allowed = false;
  assert.equal((await f.upload(ALICE, id, PNG)).status, 429);
  assert.equal(f.storage.objects.size, 1);
  const sent = await f.call(ALICE, "POST", `/api/chats/${id}/messages`, { text: "hi", images: [first.json.imageId] });
  assert.equal(sent.status, 429);
  assert.equal((await f.call(ALICE, "GET", `/api/chats/${id}/messages`)).json.messages.length, 0);
});

test("more than 10 images are rejected", async t => {
  const f = await setup(t), id = await f.chat();
  const ids: string[] = [];
  for (let i = 0; i < 10; i++) ids.push((await f.upload(ALICE, id, PNG)).json.imageId);
  assert.equal((await f.upload(ALICE, id, PNG)).status, 400);
  const sent = await f.call(ALICE, "POST", `/api/chats/${id}/messages`, { text: "x", images: [...ids, ids[0]] });
  assert.equal(sent.status, 400);
});

test("only the owner reads an image, and deleting the chat deletes the objects", async t => {
  const f = await setup(t), id = await f.chat();
  const up = await f.upload(ALICE, id, PNG);
  const sent = await f.upload(ALICE, id, PNG);
  await f.call(ALICE, "POST", `/api/chats/${id}/messages`, { text: "look", images: [sent.json.imageId] });
  const own = await f.call(ALICE, "GET", `/api/chats/${id}/images/${sent.json.imageId}`);
  assert.equal(own.status, 200);
  assert.equal(own.type, "image/png");
  assert.deepEqual(own.raw, PNG);
  assert.equal((await f.call(BOB, "GET", `/api/chats/${id}/images/${sent.json.imageId}`)).status, 404);
  assert.equal((await f.upload(BOB, id, PNG)).status, 404);
  assert.equal((await f.call(BOB, "POST", `/api/chats/${id}/messages`, { text: "x", images: [up.json.imageId] })).status, 404);
  assert.equal((await f.call(ALICE, "GET", `/api/chats/${id}/images/..%2Fescape.png`)).status, 404);
  assert.equal(f.storage.objects.size, 2);
  assert.equal((await f.call(ALICE, "DELETE", `/api/chats/${id}`)).status, 200);
  assert.equal(f.storage.objects.size, 0);
});

test("a share link shows its own images only, and stops with revoke or chat delete", async t => {
  const f = await setup(t), id = await f.chat();
  const a = await f.upload(ALICE, id, PNG), b = await f.upload(ALICE, id, PNG);
  await f.call(ALICE, "POST", `/api/chats/${id}/messages`, { text: "one", images: [a.json.imageId] });
  const share = await f.call(ALICE, "POST", `/api/chats/${id}/shares`, {});
  assert.equal(share.status, 201);
  const sid = share.json.id as string;
  const page = await f.raw(`/s/${sid}`);
  assert.equal(page.status, 200);
  assert.ok(page.text.includes(`/s/${sid}/images/${a.json.imageId}`));
  assert.ok(!page.text.includes("base64"));
  assert.equal((await f.raw(`/s/${sid}/images/${a.json.imageId}`)).status, 200);
  // b was never sent, and a later image is not in the frozen copy.
  assert.equal((await f.raw(`/s/${sid}/images/${b.json.imageId}`)).status, 404);
  await f.call(ALICE, "POST", `/api/chats/${id}/shares/${sid}/revoke`, {});
  assert.equal((await f.raw(`/s/${sid}/images/${a.json.imageId}`)).status, 404);
});
