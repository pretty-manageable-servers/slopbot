import assert from "node:assert/strict";
import { EventEmitter, once } from "node:events";
import { ChannelType, PermissionFlagsBits, WebhookClient, type Client, type Message as DiscordMessage } from "discord.js";
import { test, type TestContext } from "node:test";
import { DiscordServer } from "../src/adapters/discord.js";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { FakeLLM } from "../src/adapters/fake-llm.js";
import { Application } from "../src/application.js";
import { Bot, type ChatGateway, type Incoming } from "../src/bot.js";
import { ChannelAccess, type ChannelFacts } from "../src/channel-access.js";
import { loadConfig } from "../src/config.js";
import { parseMessage } from "../src/domain.js";
import type { ParticipationGate } from "../src/participation.js";
import { createConsole } from "../src/web-console.js";
import { asWebUser, botWebContent, escapeMarkdown, MANAGE_WEBHOOKS_TTL_MS, MissingWebhookPermissionError, openToken, sealToken, stripBotWebPrefix, UnknownWebhookError, WEB_REPLY_WAIT_MS, WebReplies, WebReplyError, webReplyKey, type WebAuthor, type WebHook, type WebOrigin, type WebReplyDiscord } from "../src/web-replies.js";
import { UserLimiter } from "../src/user-limiter.js";

const SERVER = "1528063444874432734", PARENT = "1528063444874432735", THREAD = "1528063444874432736", USER = "1514413259522838529";
const KEY = Buffer.alloc(32, 7);
const AUTHOR: WebAuthor = { name: "Alice Display", avatarURL: "https://cdn.example/alice.png", aliases: ["alice"], identity: { discord_handle: "alice" } };
const base: ChannelFacts = { thread: false, privateThread: false, viewChannel: true, readMessageHistory: true, sendMessages: true, sendMessagesInThreads: true, threadMember: false };
type Post = Parameters<WebReplyDiscord["send"]>[1];

interface HarnessOptions {
  on?: boolean;
  facts?: Partial<ChannelFacts> | null;
  send?: (hook: WebHook, post: Post) => Promise<string>;
  sendAsBot?: (channel: string, content: string) => Promise<string>;
  secret?: ReturnType<typeof webReplyKey>;
  waitMs?: number;
  accepts?: boolean;
  /** The bot's Manage Webhooks permission. Tests change it through `state`. */
  manage?: boolean;
  /** Makes every webhook create fail with this error. */
  createError?: Error;
  now?: () => number;
}

/** Real SQLite and limiter; fake Discord that records every webhook and bot call. */
function harness(options: HarnessOptions = {}) {
  const store = new SQLiteStore(":memory:");
  const limiter = new UserLimiter(store, { fiveHourCostMicros: 1000, weekCostMicros: 100000, gracePercent: 10 });
  const calls = { createWebhook: [] as string[], deleteWebhook: [] as string[], send: [] as { hook: WebHook; post: Post }[], sendAsBot: [] as { channel: string; content: string }[] };
  const state = { manage: options.manage ?? true };
  let hooks = 0, messages = 0;
  const discord: WebReplyDiscord = {
    async channel(_server, channel) {
      if (channel === THREAD) return { parent: PARENT, thread: true };
      return channel === PARENT ? { parent: PARENT, thread: false } : undefined;
    },
    async member(_server, user) { return user === USER ? AUTHOR : undefined; },
    async canManageWebhooks() { return state.manage; },
    async createWebhook(parent) { calls.createWebhook.push(parent); if (options.createError) throw options.createError; hooks++; return { id: `hook-${hooks}`, token: `token-${hooks}-secret` }; },
    async deleteWebhook(_parent, id) { calls.deleteWebhook.push(id); },
    async send(hook, post) { calls.send.push({ hook, post }); return options.send ? options.send(hook, post) : `msg-${++messages}`; },
    async sendAsBot(channel, content) { calls.sendAsBot.push({ channel, content }); return options.sendAsBot ? options.sendAsBot(channel, content) : `bot-${++messages}`; },
  };
  const facts = options.facts === null ? undefined : { ...base, ...options.facts };
  const access = new ChannelAccess({ async facts() { return facts; } });
  const service = new WebReplies({
    store, discord, access, limiter,
    secret: options.secret ?? webReplyKey({ WEB_REPLY_KEY: KEY.toString("base64") }),
    enabled: () => options.on ?? true,
    accepts: () => options.accepts ?? true,
    waitMs: options.waitMs ?? 1000,
    ...(options.now ? { now: options.now } : {}),
  });
  return { store, limiter, calls, service, state };
}
const reply = (service: WebReplies, channel = PARENT, text = "hello from the web") => service.reply({ user: USER, server: SERVER, channel, text });
const expectStatus = (promise: Promise<unknown>, status: number) => assert.rejects(promise, (error: unknown) => error instanceof WebReplyError && error.status === status);
const event = (id: string, webhookId: string | undefined, channel = PARENT) => ({ server: SERVER, channel, id, webhookId });

test("the wait for a web reply post is 10 seconds", () => assert.equal(WEB_REPLY_WAIT_MS, 10000));

test("a web reply posts through the channel webhook and stores the returned message ID", async t => {
  const h = harness(); t.after(() => h.store.close());
  const result = await reply(h.service, PARENT, "  hi there  ");
  assert.equal(result.status, "posted");
  assert.equal(result.messageId, "msg-1");
  assert.deepEqual(h.calls.createWebhook, [PARENT]);
  const post = h.calls.send[0]!.post;
  assert.equal(post.text, "hi there");
  assert.equal(post.username, AUTHOR.name);
  assert.equal(post.avatarURL, AUTHOR.avatarURL);
  assert.equal(post.threadId, undefined);
  const row = await h.store.webReplyByMessage(SERVER, "msg-1");
  assert.deepEqual([row?.user_id, row?.status], [USER, "posted"]);
  // The second reply reuses the stored webhook.
  await reply(h.service);
  assert.equal(h.calls.createWebhook.length, 1);
});

test("over the usage limit: 429 with the reset time and nothing posted", async t => {
  const h = harness(); t.after(() => h.store.close());
  await h.limiter.record(SERVER, USER, 1000);
  const error = await reply(h.service).then(() => undefined, (failure: unknown) => failure);
  assert.ok(error instanceof WebReplyError);
  assert.equal(error.status, 429);
  assert.ok(typeof error.resetAt === "number" && error.resetAt > Date.now());
  assert.equal(h.calls.send.length, 0);
  assert.equal(h.calls.createWebhook.length, 0);
});

test("no Send Messages permission: 403 and nothing posted", async t => {
  const h = harness({ facts: { sendMessages: false } }); t.after(() => h.store.close());
  await expectStatus(reply(h.service), 403);
  assert.equal(h.calls.send.length, 0);
  assert.equal(h.calls.createWebhook.length, 0);
});

test("no View Channel access: 403 and nothing posted", async t => {
  const h = harness({ facts: null }); t.after(() => h.store.close());
  await expectStatus(reply(h.service), 403);
  assert.equal(h.calls.send.length, 0);
});

test("switch off: 403 and nothing posted", async t => {
  const h = harness({ on: false }); t.after(() => h.store.close());
  await expectStatus(reply(h.service, THREAD), 403);
  assert.equal(h.calls.send.length, 0);
});

test("a channel Slopbot does not answer in: 403 and nothing posted", async t => {
  const h = harness({ accepts: false }); t.after(() => h.store.close());
  await expectStatus(reply(h.service), 403);
  assert.equal(h.calls.send.length, 0);
});

test("text must be 1 to 2000 characters", async t => {
  const h = harness(); t.after(() => h.store.close());
  await expectStatus(reply(h.service, PARENT, "   "), 400);
  await expectStatus(reply(h.service, PARENT, "x".repeat(2001)), 400);
  assert.equal(h.calls.send.length, 0);
  assert.equal((await reply(h.service, PARENT, "x".repeat(2000))).status, "posted");
});

test("a thread reply uses the parent webhook with thread_id", async t => {
  const h = harness(); t.after(() => h.store.close());
  await reply(h.service, THREAD);
  assert.deepEqual(h.calls.createWebhook, [PARENT]);
  assert.equal(h.calls.send[0]!.post.threadId, THREAD);
  assert.equal(h.calls.send[0]!.hook.id, "hook-1");
});

test("missing or short WEB_REPLY_KEY disables web replies with a clear error", async t => {
  const missing = webReplyKey({});
  assert.ok("error" in missing && /WEB_REPLY_KEY/.test(missing.error));
  assert.ok("error" in webReplyKey({ WEB_REPLY_KEY: Buffer.alloc(16).toString("base64") }));
  const h = harness({ secret: missing }); t.after(() => h.store.close());
  const error = await reply(h.service).then(() => undefined, (failure: unknown) => failure);
  assert.ok(error instanceof WebReplyError && error.status === 503 && /WEB_REPLY_KEY/.test(error.message));
  assert.equal(h.calls.createWebhook.length, 0);
  assert.equal(h.calls.send.length, 0);
});

test("the webhook token is encrypted at rest and opens with the key", async t => {
  const h = harness(); t.after(() => h.store.close());
  await reply(h.service);
  const row = await h.store.webWebhook(SERVER, PARENT);
  assert.ok(row);
  assert.equal(row.webhook_id, "hook-1");
  assert.notEqual(row.token_encrypted, "token-1-secret");
  assert.ok(!row.token_encrypted.includes("token-1-secret"));
  assert.equal(openToken(KEY, row.token_encrypted), "token-1-secret");
  assert.equal(h.calls.send[0]!.hook.token, "token-1-secret");
  assert.notEqual(sealToken(KEY, "same"), sealToken(KEY, "same"), "each seal uses a new IV");
  assert.throws(() => openToken(Buffer.alloc(32, 9), row.token_encrypted));
});

test("a message posted with the returned ID is matched while the post is in flight", async t => {
  let pending: Promise<unknown> | undefined;
  const h = harness({ send: async (hook) => { pending = h.service.origin(event("real-1", hook.id)); return "real-1"; } });
  t.after(() => h.store.close());
  await reply(h.service);
  const origin = await pending as WebOrigin | undefined;
  assert.equal(origin?.user, USER);
  assert.equal(origin?.author.name, AUTHOR.name);
  assert.equal(origin?.via, "webhook");
  const incoming: Incoming = { id: "real-1", server: SERVER, channel: PARENT, author: "webhook", text: "hello from the web", botAuthor: true, mentionsBot: false, repliesToBot: false, isBot: true };
  const user = asWebUser(incoming, origin!);
  assert.equal(user.author, USER);
  assert.equal(user.isBot, false);
  assert.equal(user.botAuthor, false);
  assert.equal(user.addressed, true);
  assert.equal(user.source, "web");
  assert.equal(user.authorName, AUTHOR.name);
});

test("a leaked webhook post with the same text stays a bot message", async t => {
  let leaked: Promise<unknown> | undefined;
  const h = harness({ send: async (hook) => { leaked = h.service.origin(event("leak-1", hook.id)); return "real-1"; } });
  t.after(() => h.store.close());
  await reply(h.service, PARENT, "same text");
  assert.equal(await leaked, undefined);
  // The real post still counts when its own event comes later.
  assert.equal((await h.service.origin(event("real-1", "hook-1")))?.user, USER);
  assert.equal(await h.service.origin(event("leak-1", "hook-1")), undefined);
});

test("a webhook message that is not one of Slopbot's web webhooks stays a bot message", async t => {
  const h = harness(); t.after(() => h.store.close());
  await reply(h.service);
  assert.equal(await h.service.origin(event("msg-1", "some-other-webhook")), undefined);
});

test("an event that arrives after the post returned is matched through message_id", async t => {
  const h = harness(); t.after(() => h.store.close());
  await reply(h.service);
  assert.equal((await h.service.origin(event("msg-1", "hook-1")))?.user, USER);
  assert.equal(await h.service.origin(event("msg-99", "hook-1")), undefined);
});

test("no matching event within the wait: bot message, row failed", async t => {
  let seen: unknown = "unset";
  const h = harness({ waitMs: 30, send: async (hook) => { seen = await h.service.origin(event("late-1", hook.id)); return "late-1"; } });
  t.after(() => h.store.close());
  const result = await reply(h.service);
  assert.equal(seen, undefined, "the buffered event is handled as a bot message after the wait");
  assert.equal(result.status, "failed", "the row stays failed when Discord returns late");
  assert.equal(await h.service.origin(event("late-1", "hook-1")), undefined);
});

test("a post that fails is marked failed and its event is a bot message", async t => {
  const h = harness({ send: async () => { throw new Error("Discord is down"); } }); t.after(() => h.store.close());
  await expectStatus(reply(h.service), 502);
  assert.equal(await h.service.origin(event("msg-1", "hook-1")), undefined);
});

test("rotate deletes the old webhook and stores a new one", async t => {
  const h = harness(); t.after(() => h.store.close());
  await reply(h.service);
  assert.deepEqual(await h.service.rotateWebhook(SERVER, PARENT), { webhookId: "hook-2" });
  assert.deepEqual(h.calls.deleteWebhook, ["hook-1"]);
  assert.equal((await h.store.webWebhook(SERVER, PARENT))?.webhook_id, "hook-2");
  await reply(h.service);
  assert.equal(h.calls.send[1]!.hook.id, "hook-2");
});

test("an unknown webhook is replaced once, and the retried post is matched by its exact ID", async t => {
  let gone = false, pending: Promise<unknown> | undefined;
  const h = harness({ send: async hook => {
    if (gone && hook.id === "hook-1") throw new UnknownWebhookError("Unknown Webhook");
    if (hook.id === "hook-2") pending = h.service.origin(event("retried-1", "hook-2"));
    return hook.id === "hook-2" ? "retried-1" : "msg-first";
  } });
  t.after(() => h.store.close());
  await reply(h.service);
  gone = true;
  const result = await reply(h.service, PARENT, "after the webhook was deleted");
  assert.deepEqual([result.status, result.messageId, result.via], ["posted", "retried-1", "webhook"]);
  assert.deepEqual(h.calls.createWebhook, [PARENT, PARENT], "one create at first, one replacement");
  assert.deepEqual(h.calls.send.map(call => call.hook.id), ["hook-1", "hook-1", "hook-2"], "one retry only");
  assert.equal((await h.store.webWebhook(SERVER, PARENT))?.webhook_id, "hook-2");
  const origin = await pending as WebOrigin | undefined;
  assert.deepEqual([origin?.user, origin?.via], [USER, "webhook"]);
  const row = await h.store.webReplyByMessage(SERVER, "retried-1");
  assert.deepEqual([row?.status, row?.via, row?.user_id], ["posted", "webhook", USER]);
});

test("an unknown webhook after the retry is a 502, with no third try", async t => {
  const h = harness({ send: async () => { throw new UnknownWebhookError("Unknown Webhook"); } });
  t.after(() => h.store.close());
  await expectStatus(reply(h.service), 502);
  assert.equal(h.calls.send.length, 2);
  assert.deepEqual(h.calls.createWebhook, [PARENT, PARENT]);
});

test("an unknown webhook that cannot be replaced falls back to the bot, and the row says bot", async t => {
  let clock = 1_000_000, gone = false;
  const h = harness({
    now: () => clock,
    send: async hook => { if (gone && hook.id === "hook-1") throw new UnknownWebhookError("Unknown Webhook"); return "msg-first"; },
    sendAsBot: async () => "bot-after-unknown",
  });
  t.after(() => h.store.close());
  await reply(h.service);
  gone = true;
  h.state.manage = false;
  clock += MANAGE_WEBHOOKS_TTL_MS;
  const result = await reply(h.service, PARENT, "lost the permission");
  assert.deepEqual([result.via, result.messageId, result.status], ["bot", "bot-after-unknown", "posted"]);
  assert.equal(h.calls.createWebhook.length, 1, "no replacement without Manage Webhooks");
  assert.equal(await h.store.webWebhook(SERVER, PARENT), undefined);
  const row = await h.store.webReplyByMessage(SERVER, "bot-after-unknown");
  assert.deepEqual([row?.via, row?.status], ["bot", "posted"]);
  // An event that arrives after the post returned is matched through the row, so the row must say bot.
  assert.equal((await h.service.origin(event("bot-after-unknown", undefined)))?.via, "bot");
});

test("without Manage Webhooks the bot posts, the echo matches as the user, and the model sees the text only", async t => {
  let pending: Promise<unknown> | undefined;
  const h = harness({ manage: false, sendAsBot: async (channel) => { pending = h.service.origin(event("bot-1", undefined, channel)); return "bot-1"; } });
  t.after(() => h.store.close());
  const result = await reply(h.service, PARENT, "  hi there  ");
  assert.deepEqual([result.status, result.messageId, result.via], ["posted", "bot-1", "bot"]);
  assert.deepEqual(h.calls.createWebhook, []);
  assert.deepEqual(h.calls.send, []);
  assert.deepEqual(h.calls.sendAsBot, [{ channel: PARENT, content: "**Alice Display** (from web): hi there" }]);
  const origin = await pending as WebOrigin | undefined;
  assert.deepEqual([origin?.user, origin?.via], [USER, "bot"]);
  const incoming: Incoming = { id: "bot-1", server: SERVER, channel: PARENT, author: "bot", text: "**Alice Display** (from web): hi there", botAuthor: true, mentionsBot: false, repliesToBot: false, isBot: true };
  const user = asWebUser(incoming, origin!);
  assert.equal(user.author, USER);
  assert.equal(user.isBot, false);
  assert.equal(user.botAuthor, false);
  assert.equal(user.addressed, true);
  assert.equal(user.source, "web");
  assert.equal(user.text, "hi there");
  const row = await h.store.webReplyByMessage(SERVER, "bot-1");
  assert.deepEqual([row?.status, row?.via, row?.user_id], ["posted", "bot", USER]);
  // A thread reply goes to the thread itself, with no webhook thread_id.
  await reply(h.service, THREAD, "in a thread");
  assert.equal(h.calls.sendAsBot.at(-1)?.channel, THREAD);
});

test("the bot prefix escapes the display name, and stripping removes it", () => {
  assert.equal(escapeMarkdown("*Bob_ @x\n[y]\\"), "\\*Bob\\_ \\@x \\[y\\]\\\\");
  const content = botWebContent("*Bob_ **x** (from web): ", "hi");
  assert.equal(stripBotWebPrefix(content), "hi");
  assert.equal(stripBotWebPrefix("**x** (from web): **y** (from web): hi"), "**y** (from web): hi", "only one prefix is removed");
  assert.equal(stripBotWebPrefix("no prefix here"), "no prefix here");
});

test("a bot reply that cannot fit the name is refused before anything is posted", async t => {
  const h = harness({ manage: false }); t.after(() => h.store.close());
  await expectStatus(reply(h.service, PARENT, "x".repeat(1980)), 400);
  assert.equal(h.calls.sendAsBot.length, 0);
  assert.equal((await reply(h.service, PARENT, "x".repeat(1960))).via, "bot");
});

test("no Manage Webhooks is not kept for good: the check runs again after 30 seconds", async t => {
  let clock = 1_000_000;
  const h = harness({ manage: false, now: () => clock }); t.after(() => h.store.close());
  await reply(h.service);
  h.state.manage = true;
  assert.equal((await reply(h.service)).via, "bot", "the no is reused for 30 seconds");
  clock += MANAGE_WEBHOOKS_TTL_MS;
  assert.equal((await reply(h.service)).via, "webhook");
  assert.deepEqual(h.calls.createWebhook, [PARENT]);
  assert.equal(h.calls.sendAsBot.length, 2);
});

test("a create that Discord refuses with Missing Permissions falls back to the bot", async t => {
  const h = harness({ createError: new MissingWebhookPermissionError("Missing Permissions") }); t.after(() => h.store.close());
  const result = await reply(h.service, PARENT, "hi");
  assert.equal(result.via, "bot");
  assert.deepEqual(h.calls.createWebhook, [PARENT]);
  assert.equal(h.calls.send.length, 0);
  assert.equal(h.calls.sendAsBot.length, 1);
  assert.equal(await h.store.webWebhook(SERVER, PARENT), undefined, "no webhook row is saved");
});

test("web replies skip JEV and reach the answer path; the source flag survives parsing", async t => {
  const store = new SQLiteStore(":memory:"); t.after(() => store.close());
  const llm = new FakeLLM();
  const app = new Application(store, llm, { allowedChannels: [{ server: SERVER, channel: PARENT }] });
  const outputs: string[] = [];
  const gateway: ChatGateway = {
    async reply(_message, text) { outputs.push(text); return [{ id: `out:${outputs.length}`, server: SERVER, channel: PARENT, author: "bot", text }]; },
    async createTaskThread() { return "thread"; },
    typing() { return () => undefined; },
  };
  let judged = 0;
  const gate = { options: { contextMessages: 0 }, async decide() { judged++; return { respond: false, addressed: false, reason: "test" }; } } as unknown as ParticipationGate;
  const bot = new Bot(app, store, store, gateway, SERVER, [PARENT], { participation: gate });
  const web: Incoming = { id: "real-1", server: SERVER, channel: PARENT, author: USER, text: "question", botAuthor: false, mentionsBot: false, repliesToBot: false, addressed: true, source: "web" };
  await bot.receive(web);
  assert.equal(judged, 0, "JEV does not judge a web reply");
  assert.equal(outputs.length, 1);
  await bot.receive({ id: "other", server: SERVER, channel: PARENT, author: USER, text: "question", botAuthor: false, mentionsBot: false, repliesToBot: false });
  assert.equal(judged, 1, "an ordinary message still goes through JEV");
  assert.equal(parseMessage({ id: "1", server: SERVER, channel: PARENT, author: USER, text: "x", source: "web" }).source, "web");
  assert.throws(() => parseMessage({ id: "1", server: SERVER, channel: PARENT, author: USER, text: "x", source: "email" }));
});

test("the console reply route returns 429 with resetAt and posts nothing", async t => {
  const h = harness(); t.after(() => h.store.close());
  await h.limiter.record(SERVER, USER, 1000);
  const options = { origin: "http://localhost:3000", host: "127.0.0.1", port: 3000, clientId: "id", clientSecret: "secret" };
  const server = createConsole(options, { sessions: new SQLiteStore(), async canSignIn() { return true; },
    async snapshot() { return {}; }, async invoke() { return {}; },
    async reply(user, _server, channel, text) { return h.service.reply({ user, server: SERVER, channel, text }); },
  });
  server.listen(0, "127.0.0.1"); await once(server, "listening");
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const address = server.address();
  assert.ok(address && typeof address !== "string");
  const base = `http://127.0.0.1:${address.port}`, originalFetch = globalThis.fetch;
  t.mock.method(globalThis, "fetch", async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url) === "https://discord.com/api/oauth2/token") return Response.json({ access_token: "oauth" });
    if (String(url) === "https://discord.com/api/users/@me") return Response.json({ id: USER });
    return originalFetch(url, init);
  });
  const login = await fetch(`${base}/auth/login`, { redirect: "manual" });
  const state = new URL(login.headers.get("location")!).searchParams.get("state")!;
  const callback = await fetch(`${base}/auth/callback?state=${state}&code=x`, { redirect: "manual", headers: { Cookie: `slopbot_state=${state}` } });
  const cookie = callback.headers.getSetCookie()[0]!.split(";")[0]!;
  const csrf = (await (await fetch(`${base}/api/settings`, { headers: { Cookie: cookie } })).json() as { csrf: string }).csrf;
  const headers = { Cookie: cookie, "Content-Type": "application/json", Origin: "http://localhost:3000", "X-CSRF-Token": csrf };
  const route = `${base}/api/conversations/${PARENT}/reply`;
  const limited = await fetch(route, { method: "POST", headers, body: JSON.stringify({ server: SERVER, text: "hi" }) });
  assert.equal(limited.status, 429);
  assert.ok(typeof (await limited.json() as { resetAt?: number }).resetAt === "number");
  assert.equal(h.calls.send.length, 0);
  assert.equal((await fetch(route, { method: "POST", headers: { ...headers, "X-CSRF-Token": "bad" }, body: "{}" })).status, 403);
});

test("the Discord adapter queues only the exact returned message as the user", async t => {
  const guild = "1528063444874432734", channel = "1528064977913647236", bot = "1514413259522838528", hook = "1528064977913647999", member = "1514413259522838530";
  const previousKey = process.env.WEB_REPLY_KEY;
  process.env.WEB_REPLY_KEY = KEY.toString("base64");
  t.after(() => { if (previousKey === undefined) delete process.env.WEB_REPLY_KEY; else process.env.WEB_REPLY_KEY = previousKey; });
  const permissions = { has: () => true };
  const target = {
    id: channel, type: ChannelType.GuildText, guildId: guild, name: "general", isDMBased: () => false, isThread: () => false, isTextBased: () => true, isSendable: () => true,
    permissionsFor: () => permissions, createWebhook: async () => ({ id: hook, token: "adapter-token" }),
  };
  const displayName = "Alice Display";
  const memberObject = { displayName, user: { id: member, username: "alice", globalName: null, bot: false }, displayAvatarURL: () => AUTHOR.avatarURL, permissions };
  const client = Object.assign(new EventEmitter(), {
    user: { id: bot, tag: "Slopbot" },
    channels: { fetch: async () => target },
    guilds: { fetch: async () => ({ id: guild, name: "Server", members: { fetch: async () => memberObject, fetchMe: async () => ({ permissions }) } }) },
    fetchWebhook: async () => undefined,
  });
  const config = loadConfig({ DISCORD_BOT_TOKEN: "test-only", DISCORD_GUILD_ID: guild, DISCORD_CHANNEL_IDS: channel, LLM_MODE: "mock" });
  const store = new SQLiteStore(":memory:"); t.after(() => store.close());
  await store.setSetting(guild, `web_transcripts:${channel}`, true);
  const server = new DiscordServer(config, store, new FakeLLM(), client as unknown as Client, guild, undefined);
  const hookEvent = (id: string, content: string) => ({
    id, guildId: guild, channelId: channel, content, webhookId: hook, attachments: new Map(), embeds: [], reference: null,
    mentions: { users: new Map() }, member: null, guild: { name: "Server" }, createdTimestamp: 1, editedTimestamp: null,
    author: { id: hook, username: "Alice Display", globalName: null, bot: true },
  });
  // Both the leaked copy and the real post reach Slopbot before the post returns.
  t.mock.method(WebhookClient.prototype, "send", async function (this: WebhookClient, payload: { content?: string }) {
    server.messageCreate(hookEvent("leak-1", payload.content ?? "") as unknown as DiscordMessage);
    server.messageCreate(hookEvent("msg-real", payload.content ?? "") as unknown as DiscordMessage);
    return { id: "msg-real" } as never;
  });
  const result = await server.consoleReply(USER, channel, "same text");
  assert.equal((result as { messageId: string; status: string }).messageId, "msg-real");
  assert.equal((result as { status: string }).status, "posted");
  await new Promise(resolve => setTimeout(resolve, 100));
  const jobs = store.jobs(guild, channel);
  assert.equal(jobs.length, 1, "only the real message becomes a request");
  assert.equal(jobs[0]!.message.id, "msg-real");
  assert.equal(jobs[0]!.message.author, USER);
  assert.equal(jobs[0]!.message.isBot, false);
  assert.equal(jobs[0]!.message.addressed, true);
  assert.equal(jobs[0]!.message.authorName, displayName);
});

/** A Discord adapter over a fake client. The test feeds in Slopbot's and users' messages as Discord would send them. */
async function adapterFixture(t: TestContext, options: { manage?: boolean; createError?: unknown } = {}) {
  const guild = "1528063444874432734", channel = "1528064977913647236", bot = "1514413259522838528", hook = "1528064977913647999", member = "1514413259522838530", typer = "1514413259522838531";
  const previousKey = process.env.WEB_REPLY_KEY;
  process.env.WEB_REPLY_KEY = KEY.toString("base64");
  t.after(() => { if (previousKey === undefined) delete process.env.WEB_REPLY_KEY; else process.env.WEB_REPLY_KEY = previousKey; });
  let onBotSend: (content: string) => string = () => { throw new Error("unexpected bot post"); };
  const permissions = { has: (flag: unknown) => flag !== PermissionFlagsBits.ManageWebhooks || options.manage !== false };
  const target = {
    id: channel, type: ChannelType.GuildText, guildId: guild, name: "general", isDMBased: () => false, isThread: () => false, isTextBased: () => true, isSendable: () => true,
    permissionsFor: () => permissions,
    async createWebhook() { if (options.createError) throw options.createError; return { id: hook, token: "adapter-token" }; },
    async send(payload: { content?: string }) { return { id: onBotSend(payload.content ?? "") }; },
  };
  const memberObject = { displayName: "Alice Display", user: { id: member, username: "alice", globalName: null, bot: false }, displayAvatarURL: () => AUTHOR.avatarURL, permissions };
  const client = Object.assign(new EventEmitter(), {
    user: { id: bot, tag: "Slopbot" },
    channels: { fetch: async () => target },
    guilds: { fetch: async () => ({ id: guild, name: "Server", members: { fetch: async () => memberObject, fetchMe: async () => ({ permissions }) } }) },
    fetchWebhook: async () => undefined,
  });
  const config = loadConfig({ DISCORD_BOT_TOKEN: "test-only", DISCORD_GUILD_ID: guild, DISCORD_CHANNEL_IDS: channel, LLM_MODE: "mock" });
  const store = new SQLiteStore(":memory:"); t.after(() => store.close());
  await store.setSetting(guild, `web_transcripts:${channel}`, true);
  const server = new DiscordServer(config, store, new FakeLLM(), client as unknown as Client, guild, undefined);
  const event = (id: string, content: string, author: string, flags: { webhook?: boolean; bot?: boolean; mentionsBot?: boolean } = {}) => ({
    id, guildId: guild, channelId: channel, content, webhookId: flags.webhook ? author : null, attachments: new Map(), embeds: [], reference: null,
    mentions: { users: new Map<string, { id: string }>(flags.mentionsBot ? [[bot, { id: bot }]] : []) }, member: null, guild: { name: "Server" }, createdTimestamp: 1, editedTimestamp: null,
    author: { id: author, username: "alice", globalName: null, bot: Boolean(flags.bot || flags.webhook) },
  }) as unknown as DiscordMessage;
  return { server, store, guild, channel, bot, hook, typer, event, setBotSend: (fn: (content: string) => string) => { onBotSend = fn; } };
}
const settle = () => new Promise(resolve => setTimeout(resolve, 100));

test("a bot web reply is answered as the user, and its prefix is removed for the model", async t => {
  const f = await adapterFixture(t, { manage: false });
  f.setBotSend(content => { f.server.messageCreate(f.event("bot-real", content, f.bot, { bot: true })); return "bot-real"; });
  const result = await f.server.consoleReply(USER, f.channel, "hi there") as { messageId: string; status: string; via: string };
  assert.deepEqual([result.messageId, result.status, result.via], ["bot-real", "posted", "bot"]);
  await settle();
  const jobs = f.store.jobs(f.guild, f.channel);
  assert.equal(jobs.length, 1, "only the matched bot message becomes a request");
  assert.equal(jobs[0]!.message.id, "bot-real");
  assert.equal(jobs[0]!.message.author, USER);
  assert.equal(jobs[0]!.message.isBot, false);
  assert.equal(jobs[0]!.message.addressed, true);
  assert.equal(jobs[0]!.message.source, "web");
  assert.equal(jobs[0]!.message.text, "hi there");
  assert.equal(jobs[0]!.message.authorName, "Alice Display");
});

test("other Slopbot messages are ignored, and a typed prefix is never a web reply", async t => {
  const f = await adapterFixture(t, { manage: false });
  f.server.messageCreate(f.event("bot-other", "Slopbot's own answer", f.bot, { bot: true }));
  f.server.messageCreate(f.event("typed", "**Alice Display** (from web): hi", f.typer, { mentionsBot: true }));
  await settle();
  const jobs = f.store.jobs(f.guild, f.channel);
  assert.deepEqual(jobs.map(job => job.message.id), ["typed"]);
  assert.equal(jobs[0]!.message.author, f.typer);
  assert.equal(jobs[0]!.message.source, undefined);
  assert.equal(jobs[0]!.message.text, "**Alice Display** (from web): hi");
});

test("a user who types the prefix while a bot web post is in flight is not matched", async t => {
  const f = await adapterFixture(t, { manage: false });
  f.setBotSend(content => {
    f.server.messageCreate(f.event("typed-during", content, f.typer, { mentionsBot: true }));
    f.server.messageCreate(f.event("bot-real", content, f.bot, { bot: true }));
    return "bot-real";
  });
  await f.server.consoleReply(USER, f.channel, "hi");
  await settle();
  const jobs = f.store.jobs(f.guild, f.channel);
  const typed = jobs.find(job => job.message.id === "typed-during"), real = jobs.find(job => job.message.id === "bot-real");
  assert.equal(typed?.message.author, f.typer);
  assert.equal(typed?.message.source, undefined);
  assert.equal(real?.message.author, USER);
  assert.equal(real?.message.source, "web");
});

test("the Discord adapter replaces a webhook that Discord reports as unknown, then posts again", async t => {
  const f = await adapterFixture(t);
  let sends = 0;
  t.mock.method(WebhookClient.prototype, "send", async function (this: WebhookClient, payload: { content?: string }) {
    sends++;
    if (sends === 1) throw Object.assign(new Error("Unknown Webhook"), { code: 10015, status: 404 });
    f.server.messageCreate(f.event("retry-1", payload.content ?? "", f.hook, { webhook: true }));
    return { id: "retry-1" } as never;
  });
  const result = await f.server.consoleReply(USER, f.channel, "hello") as { messageId: string; via: string };
  assert.deepEqual([sends, result.messageId, result.via], [2, "retry-1", "webhook"]);
  await settle();
  const jobs = f.store.jobs(f.guild, f.channel);
  assert.deepEqual(jobs.map(job => [job.message.id, job.message.author, job.message.source]), [["retry-1", USER, "web"]]);
});

test("the Discord adapter falls back to the bot when Discord refuses the webhook create", async t => {
  const f = await adapterFixture(t, { createError: Object.assign(new Error("Missing Permissions"), { code: 50013 }) });
  f.setBotSend(content => { f.server.messageCreate(f.event("bot-fallback", content, f.bot, { bot: true })); return "bot-fallback"; });
  const result = await f.server.consoleReply(USER, f.channel, "hello") as { messageId: string; via: string };
  assert.deepEqual([result.messageId, result.via], ["bot-fallback", "bot"]);
  await settle();
  const jobs = f.store.jobs(f.guild, f.channel);
  assert.deepEqual(jobs.map(job => [job.message.id, job.message.author, job.message.source]), [["bot-fallback", USER, "web"]]);
});
