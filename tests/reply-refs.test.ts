import assert from "node:assert/strict";
import { test } from "node:test";
import { linkRefs } from "../src/reply-refs.js";
import { ContextBuilder } from "../src/context-builder.js";
import { ByteTokenCounter } from "../src/context.js";
import type { Message, PromptItem } from "../src/domain.js";
import type { Store } from "../src/ports.js";
import type { ProfileStore } from "../src/profiles.js";
import { RequestError } from "../src/errors.js";
import { loadTaskSeed, saveTaskRefs, type SettingsPort } from "../src/transcript.js";
import { Application } from "../src/application.js";
import { Bot, type ChatGateway, type Incoming } from "../src/bot.js";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import type { LLM } from "../src/ports.js";

const place = { server: "s", channel: "c" };
const refs = new Map([["m3", "100000000000000001"], ["m5", "100000000000000005"]]);
const users = new Set(["123456789012345678"]);
const linkOf = (channel: string, id: string) => `https://discord.com/channels/s/${channel}/${id}`;

test("ref becomes discord link", () => {
  assert.equal(linkRefs("See m3 for details.", refs, place, users), `See [↗](${linkOf("c", "100000000000000001")}) for details.`);
  assert.equal(linkRefs("Also #m5.", refs, place, users), `Also [↗](${linkOf("c", "100000000000000005")}).`);
});

test("bracket ref becomes link", () => {
  const link = `[↗](${linkOf("c", "100000000000000001")})`;
  assert.equal(linkRefs("Quote [m3] here.", refs, place, users), `Quote ${link} here.`);
  assert.equal(linkRefs("Quote (m3) here.", refs, place, users), `Quote ${link} here.`);
  assert.equal(linkRefs("Quote [#m3] here.", refs, place, users), `Quote ${link} here.`);
});

test("fake discord link loses url", () => {
  const text = linkRefs("See [the post](https://discord.com/channels/s/c/999) and https://discord.com/channels/s/c/888.", refs, place, users);
  assert.equal(text, "See the post and .");
  assert.ok(!text.includes("discord.com"));
  // A real message ID keeps a link, pointed at this channel.
  assert.equal(linkRefs("[the post](https://discord.com/channels/x/y/100000000000000001)", refs, place, users), `[the post](${linkOf("c", "100000000000000001")})`);
});

test("user id becomes mention", () => {
  assert.equal(linkRefs("Thanks 123456789012345678.", refs, place, users), "Thanks <@123456789012345678>.");
  // Already a mention, or not a known user: unchanged.
  assert.equal(linkRefs("Thanks <@123456789012345678>.", refs, place, users), "Thanks <@123456789012345678>.");
  assert.equal(linkRefs("Thanks 223456789012345678.", refs, place, users), "Thanks 223456789012345678.");
});

test("unknown ref unchanged", () => {
  assert.equal(linkRefs("See m9 and s4.", refs, place, users), "See m9 and s4.");
});

test("code block unchanged", () => {
  const text = "Code:\n```\nm3 and 123456789012345678\n```\nInline `m3` too, but m3 is a ref.";
  assert.equal(linkRefs(text, refs, place, users), `Code:\n\`\`\`\nm3 and 123456789012345678\n\`\`\`\nInline \`m3\` too, but [↗](${linkOf("c", "100000000000000001")}) is a ref.`);
});

test("word with m3 unchanged", () => {
  assert.equal(linkRefs("gm3x and m3u8 are words.", refs, place, users), "gm3x and m3u8 are words.");
});

test("task s ref links to source channel", async () => {
  const values = new Map<string, unknown>();
  const settings: SettingsPort = { setting: (_server, key) => values.get(key), setSetting: (_server, key, value) => { values.set(key, value); } };
  await saveTaskRefs(settings, "s", "thread", new Map([["s1", "200000000000000002"]]), "source");
  const seed = await loadTaskSeed(settings, "s", "thread");
  assert.equal(seed.channel, "source");
  assert.equal(linkRefs("Per s1 in the thread.", seed.refs, { server: "s", channel: "thread" }, users, { server: "s", channel: seed.channel! }),
    `Per [↗](${linkOf("source", "200000000000000002")}) in the thread.`);
  // A seed saved in the old plain-map form has no channel and still loads its refs.
  values.set("task_refs:old", { s1: "200000000000000002" });
  const old = await loadTaskSeed(settings, "s", "old");
  assert.equal(old.channel, undefined);
  assert.equal(old.refs.get("s1"), "200000000000000002");
});

test("run result keeps model text", async t => {
  const modelText = "Answer from m1 at https://discord.com/channels/s/c/999 for 123456789012345678.";
  const llm: LLM = { async *stream() { yield { kind: "text", payload: { text: modelText } }; } };
  const store = new SQLiteStore(":memory:"); t.after(() => store.close());
  const app = new Application(store, llm, { allowedChannels: [{ server: "s", channel: "c" }] });
  const gateway: ChatGateway = {
    async reply(message, text) { return [{ id: "out-1", server: "s", channel: message.channel, author: "bot", text }]; },
    async createTaskThread() { return "thread"; },
    typing() { return () => undefined; },
  };
  const sent: string[] = [];
  gateway.reply = async (message, text) => { sent.push(text); return [{ id: "out-1", server: "s", channel: message.channel, author: "bot", text }]; };
  const bot = new Bot(app, store, store, gateway, "s", ["c"]);
  await store.ingest({ id: "a1", server: "s", channel: "c", author: "alice", text: "hello", botAuthor: false, mentionsBot: false, repliesToBot: false } as Incoming);
  await bot.receive({ id: "q1", server: "s", channel: "c", author: "alice", text: "question", botAuthor: false, mentionsBot: true, repliesToBot: false } as Incoming);
  // The stored run result is the model text. The text sent to Discord has the made-up link removed.
  assert.equal((await store.modelReplies("s", ["out-1"])).get("out-1")?.text, modelText);
  assert.equal(sent.length, 1);
  assert.ok(!sent[0]!.includes("discord.com/channels/s/c/999"), sent[0]);
  assert.ok(sent[0]!.startsWith("Answer from [↗]("), sent[0]);
});

// Budget tests use the context builder with a fake store, like the context builder format tests.
const BOT = "bot";
const at = (hour: number, minute: number) => Date.UTC(2026, 9, 13, hour, minute);
const msg = (id: string, author: string, text: string, timestamp: number): Message => ({
  id, server: "s", channel: "c", author, text, timestamp, authorName: author === "alice" ? "Alice" : "Bob",
});
const noHistory = async (): Promise<readonly PromptItem[]> => [];

test("requester kept when budget tight", async () => {
  const context = [msg("1001", "bob", "Long background text. ".repeat(12), at(14, 2)), msg("1002", "bob", "More background.", at(14, 3))];
  const request = msg("1003", "alice", "What about the chain?", at(14, 6));
  const profiles = {
    profile: async (_server: string, user: string) => ({
      name: user === "alice" ? "Alice" : "Bob", identity: {},
      fields: [{ field: "bio", value: `${user} notes `.repeat(20), editor: user, sourceIds: [`src-${user}`] }],
    }),
  } as unknown as ProfileStore;
  const store = {
    setting: (_server: string, key: string) => key === "context_bot_author" ? BOT : undefined,
    contextVersion: async () => 1,
    context: async () => context,
    modelReplies: async () => new Map(),
  } as unknown as Store;
  let kept = 0, dropped = 0;
  for (let limit = 2400; limit >= 300; limit -= 50) {
    const builder = new ContextBuilder({ store, counter: new ByteTokenCounter(), inputLimit: limit, outputLimit: 100, prefix: [], profiles });
    try {
      const result = await builder.build(request, undefined, 12, noHistory);
      const people = result.inputs.find(item => item.content.includes("People:"))?.content ?? "";
      assert.ok(people.includes("(user_id alice) [requester]"), `limit ${limit}: ${people}`);
      kept++;
      if (!people.includes("(user_id bob)")) dropped++;
    } catch (error) {
      assert.ok(error instanceof RequestError, `limit ${limit}: ${String(error)}`);
    }
  }
  assert.ok(kept > 0, "some limit fits the request");
  assert.ok(dropped > 0, "a tight limit drops the other person, not the requester");
});
