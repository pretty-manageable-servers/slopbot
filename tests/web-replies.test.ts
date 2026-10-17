import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { ChannelType, PermissionFlagsBits, type Client, type Message as DiscordMessage } from "discord.js";
import { test, type TestContext } from "node:test";
import { DiscordServer } from "../src/adapters/discord.js";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { FakeLLM } from "../src/adapters/fake-llm.js";

import { ChannelAccess, type ChannelFacts } from "../src/channel-access.js";
import { loadConfig } from "../src/config.js";

import { botWebContent, escapeMarkdown, openToken, sealToken, stripBotWebPrefix, UnknownWebhookError, WebReplies, WebReplyError, webReplyKey, type WebAuthor, type WebHook, type WebReplyDiscord } from "../src/web-replies.js";
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
  await h.limiter.record(USER, 1000);
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

test("text must be 1 to 2000 characters", async t => {
  const h = harness(); t.after(() => h.store.close());
  await expectStatus(reply(h.service, PARENT, "   "), 400);
  await expectStatus(reply(h.service, PARENT, "x".repeat(2001)), 400);
  assert.equal(h.calls.send.length, 0);
  assert.equal((await reply(h.service, PARENT, "x".repeat(2000))).status, "posted");
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

test("an unknown webhook after the retry is a 502, with no third try", async t => {
  const h = harness({ send: async () => { throw new UnknownWebhookError("Unknown Webhook"); } });
  t.after(() => h.store.close());
  await expectStatus(reply(h.service), 502);
  assert.equal(h.calls.send.length, 2);
  assert.deepEqual(h.calls.createWebhook, [PARENT, PARENT]);
});

test("the bot prefix escapes the display name, and stripping removes it", () => {
  assert.equal(escapeMarkdown("*Bob_ @x\n[y]\\"), "\\*Bob\\_ \\@x \\[y\\]\\\\");
  const content = botWebContent("*Bob_ **x** (from web): ", "hi");
  assert.equal(stripBotWebPrefix(content), "hi");
  assert.equal(stripBotWebPrefix("**x** (from web): **y** (from web): hi"), "**y** (from web): hi", "only one prefix is removed");
  assert.equal(stripBotWebPrefix("no prefix here"), "no prefix here");
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
