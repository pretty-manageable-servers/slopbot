import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { once } from "node:events";
import { createHash, randomBytes } from "node:crypto";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import type { Issue, OperationsClient } from "../src/adapters/operations-client.js";
import { ChannelAccess } from "../src/channel-access.js";
import type { Message } from "../src/domain.js";
import type { ObjectStorageProvider } from "../src/object-storage.js";
import { issueDraftTools } from "../src/issue-drafts.js";
import { createConsole } from "../src/web-console.js";
import { createChatRoutes, WebChatGateway, WebChatService, type ChatHost, type PrivateChatHandle } from "../src/web-chats.js";
import { privateChannel } from "../src/private-chat.js";
import { runEvents } from "../src/run-events.js";
import { ToolRegistry } from "../src/tools.js";
import { UiRuntime } from "../src/ui/runtime.js";
import type { UiDocument } from "../src/ui/schema.js";

const SERVER = "1528063444874432734";
const OWNER = "1514413259522838529", OTHER = "1514413259522838530";
const ORIGIN = "http://localhost:3000";
const now = Date.parse("2026-10-22T12:00:00Z");

/** The GitHub side as a fake client. Filing records what it was asked to create or comment. */
class FakeClient {
  creates: { title: string; body: string }[] = [];
  async issue(number: number): Promise<Issue> { return { number, title: "Existing", body: "", state: "open", html_url: `https://github.com/o/r/issues/${number}` }; }
  async createIssue(title: string, body: string): Promise<Issue> { this.creates.push({ title, body }); return { number: this.creates.length, title, body, state: "open", html_url: `https://github.com/o/r/issues/${this.creates.length}` }; }
  async comment(number: number, body: string): Promise<Issue> { return { number, title: "Existing", body, state: "open", html_url: `https://github.com/o/r/issues/${number}#c` }; }
  async findIssue() { return undefined; }
  async findComment() { return undefined; }
}

/** Storage is not used by these tests. Any call fails, so a stray write shows up. */
class MemoryStorage implements ObjectStorageProvider {
  async put(): Promise<void> { throw new Error("storage is not used here"); }
  async get(): Promise<Uint8Array> { throw new Error("storage is not used here"); }
  async delete(): Promise<void> { throw new Error("storage is not used here"); }
  async link(key: string, _name: string, seconds: number) { return `https://storage.example/${key}?expires=${seconds}`; }
}

interface Fixture {
  store: SQLiteStore;
  client: FakeClient;
  chat: string;
  channel: string;
  /** The user's request that asked for the draft. */
  request: Message;
  /** Saves the draft card as a web reply, the way the bot does. Returns the card. */
  draftCard(): Promise<UiDocument>;
  base: string;
  call(user: string | null, method: string, path: string, body?: unknown, headers?: Record<string, string>): Promise<{ status: number; json: any }>;
}

async function setup(t: TestContext): Promise<Fixture> {
  const store = new SQLiteStore(":memory:");
  t.after(() => store.close());
  runEvents.attach(store);
  const client = new FakeClient();
  const tools = new ToolRegistry(store, async () => true);
  for (const tool of issueDraftTools({ store, client: client as unknown as OperationsClient, authorize: async () => {} })) tools.register(tool);
  const ui = new UiRuntime(store, tools, async () => {});

  const chat = randomBytes(16).toString("hex");
  const channel = privateChannel(chat);
  await store.insertWebChat({ id: chat, server: SERVER, owner: OWNER, title: "Bug", created: now, updated: now, deleted: false });
  // Two messages the draft cites. They are stored in the chat, as the web chat saves its messages.
  const cites: Message[] = [
    { server: SERVER, channel, id: "30000000000000001", author: OWNER, text: "The PNG upload fails", timestamp: now - 2000 },
    { server: SERVER, channel, id: "30000000000000002", author: OWNER, text: "It fails for every PNG", timestamp: now - 1000 },
  ];
  for (const message of cites) await store.ingest(message);
  const request: Message = { server: SERVER, channel, id: "30000000000000003", author: OWNER, text: "Please file a bug about PNG uploads", timestamp: now };
  await store.ingest(request);

  const handle: PrivateChatHandle = {
    openChat() { /* no bot in these tests */ },
    closeChat() { /* none */ },
    async receiveChat() { /* none */ },
    async stopResponses() { return []; },
    // The Discord side runs a card button through its UI runtime, as a command by the web user.
    act(channelId, user, id, revision, index, interactionId) {
      return ui.act({ server: SERVER, channel: channelId, author: user, id: `chat-ui:${interactionId}`, text: "UI action", timestamp: Date.now() }, id, revision, index, interactionId);
    },
  };
  let clock = now;
  const members = new Set([OWNER, OTHER]);
  const host: ChatHost = {
    async member(user, server) { return server === SERVER && members.has(user); },
    async handle(server) { return server === SERVER ? handle : undefined; },
    limiter: { async check() { return { allowed: true }; } },
    access: new ChannelAccess({ async facts() { return undefined; } }),
    images: new MemoryStorage(),
  };
  const service = new WebChatService(store, host, undefined, () => ++clock);
  const gateway = new WebChatGateway(store, SERVER);

  const logins: Record<string, { cookie: string; csrf: string }> = {};
  for (const user of [OWNER, OTHER]) {
    const id = randomBytes(32).toString("hex"), csrf = `csrf-${user}`;
    await store.saveSession({ id_hash: createHash("sha256").update(id).digest("hex"), user_id: user, csrf, expires: Date.now() + 86_400_000, created: Date.now() });
    logins[user] = { cookie: `slopbot_session=${id}`, csrf };
  }

  const web = createConsole({ origin: ORIGIN, host: "127.0.0.1", port: 3000, clientId: "id", clientSecret: "secret" }, {
    sessions: store,
    async canSignIn() { return true; },
    async snapshot() { return {}; },
    async invoke() { return {}; },
    chats: createChatRoutes(service),
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
    const response = await fetch(base + path, { method, headers: { ...head, ...headers }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const text = await response.text();
    return { status: response.status, json: text ? JSON.parse(text) : undefined };
  }

  const draftCard = async (): Promise<UiDocument> => {
    const result = await tools.invokeResult(request, "issue_draft", {
      title: "PNG uploads fail", expected: "The PNG is summarized", actual: "The bot reports a decode error",
      steps: "Upload a PNG and ask for a summary", acceptance: "The summary of the PNG succeeds", cites: [cites[0]!.id, cites[1]!.id],
    }, "draft-op", "agent");
    assert.ok(result.ui, "issue_draft returns a card");
    // The reply carries the card, so the card is saved with the web reply.
    for (const sent of await gateway.reply(request, "Draft saved.", "deliver-1", [], result.ui)) await store.ingest(sent);
    return result.ui!;
  };

  return { store, client, chat, channel, request, draftCard, base, call };
}

interface Card { id: string; revision: number; document: { type: string; title?: string; text: string; actions?: { label: string }[] } }

/** The saved card of the chat's latest bot reply, as the page reads it. */
async function savedCard(f: Fixture, user = OWNER) {
  const page = await f.call(user, "GET", `/api/chats/${f.chat}/messages`);
  assert.equal(page.status, 200);
  const bot = (page.json.messages as { ui?: Card }[]).find(message => message.ui);
  return bot?.ui;
}

test("web_draft_card_file_report_action", async t => {
  const f = await setup(t);
  await f.draftCard();

  // The reply saved the card with its File report button, and the page shows it on reload.
  const card = await savedCard(f);
  assert.ok(card, "the reply has a saved card");
  assert.equal(card.document.type, "card");
  assert.equal(card.document.title, "PNG uploads fail");
  assert.match(card.document.text, /\*\*Expected:\*\* The PNG is summarized/);
  assert.match(card.document.text, /\*\*Evidence:\*\* 2 messages, 0 tool runs/);
  // Web chats have no slash commands, so the footer names the button.
  assert.match(card.document.text, /-# Draft · File report button · expires in \d+ days?/);
  assert.equal(card.document.actions?.[0]?.label, "File report");

  // The button runs file_report as the web user, and the result shows the issue link in the same card.
  const acted = await f.call(OWNER, "POST", `/api/chats/${f.chat}/ui/${card.id}/act`, { revision: card.revision, index: 0 });
  assert.equal(acted.status, 200);
  assert.match(acted.json.document.text, /Issue created: https:\/\/github\.com\/o\/r\/issues\/1/);
  assert.equal(acted.json.document.actions, undefined);
  assert.equal(f.client.creates.length, 1);
  assert.equal(f.client.creates[0]!.title, "PNG uploads fail");
  assert.match(f.client.creates[0]!.body, /Reported by Discord user/);

  // A reload shows the result, not the button again.
  const after = await savedCard(f);
  assert.match(after!.document.text, /Issue created/);
  assert.equal(after!.document.actions, undefined);

  // The filed card has no button, so a repeat press is refused and no second issue is created.
  const again = await f.call(OWNER, "POST", `/api/chats/${f.chat}/ui/${card.id}/act`, { revision: after!.revision, index: 0 });
  assert.equal(again.status, 400);
  assert.equal(again.json.error, "Unknown UI action.");
  assert.equal(f.client.creates.length, 1);
});

test("web_action_requires_session_and_csrf", async t => {
  const f = await setup(t);
  await f.draftCard();
  const card = (await savedCard(f))!;
  const path = `/api/chats/${f.chat}/ui/${card.id}/act`;
  const body = { revision: card.revision, index: 0 };

  // No session: the console answers 401 before the chat routes run.
  assert.equal((await f.call(null, "POST", path, body)).status, 401);
  // A session without the CSRF token, or from another origin, is refused.
  assert.equal((await f.call(OWNER, "POST", path, body, { "X-CSRF-Token": "" })).status, 403);
  assert.equal((await f.call(OWNER, "POST", path, body, { "X-CSRF-Token": "wrong" })).status, 403);
  assert.equal((await f.call(OWNER, "POST", path, body, { Origin: "https://evil.example" })).status, 403);
  // Another signed-in user cannot run the owner's card.
  assert.equal((await f.call(OTHER, "POST", path, body)).status, 404);
  assert.equal(f.client.creates.length, 0);
  // The owner with the token can run it.
  assert.equal((await f.call(OWNER, "POST", path, body)).status, 200);
  assert.equal(f.client.creates.length, 1);
});
