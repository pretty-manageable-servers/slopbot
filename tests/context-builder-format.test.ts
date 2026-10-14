import assert from "node:assert/strict";
import { test } from "node:test";
import { ContextBuilder } from "../src/context-builder.js";
import { ByteTokenCounter } from "../src/context.js";
import type { Message, PromptItem } from "../src/domain.js";
import type { Store } from "../src/ports.js";
import type { ProfileStore } from "../src/profiles.js";
import { requestLine } from "../src/transcript.js";
import { wireMessages } from "../src/adapters/chat-completions.js";

const BOT = "bot";
const at = (hour: number, minute: number) => Date.UTC(2026, 9, 13, hour, minute);
const msg = (id: string, author: string, text: string, timestamp: number, extra: Partial<Message> = {}): Message => ({
  id, server: "s", channel: "c", author, text, timestamp, authorName: author === BOT ? "Slopbot" : author === "alice" ? "Alice" : "Bob", ...extra,
});
const replies = (entries: Record<string, string>) => new Map(Object.entries(entries).map(([id, text]) => [id, { runId: `run-${id}`, text }]));
const noHistory = async (): Promise<readonly PromptItem[]> => [];
const counter = new ByteTokenCounter();

function builder(context: readonly Message[], modelReplies = new Map<string, { runId: string; text: string }>(), inputLimit = 100_000, profiles?: ProfileStore) {
  const store = {
    setting: (_server: string, key: string) => key === "context_bot_author" ? BOT : undefined,
    contextVersion: async () => 1,
    context: async () => context,
    modelReplies: async (_server: string, ids: readonly string[]) => new Map([...modelReplies].filter(([id]) => ids.includes(id))),
  } as unknown as Store;
  return new ContextBuilder({ store, counter, inputLimit, outputLimit: 100, prefix: [], ...(profiles ? { profiles } : {}) });
}

test("history has assistant turns", async () => {
  const context = [msg("1001", "alice", "Can you fix the bike?", at(14, 2)), msg("1002", BOT, "Discord copy", at(14, 3)), msg("1003", "bob", "thanks", at(14, 5))];
  const request = msg("1004", "alice", "what about the chain", at(14, 6));
  const result = await builder(context, replies({ "1002": "Model answer one." })).build(request, undefined, 12, noHistory);
  assert.ok(result.inputs.some(item => item.role === "assistant" && item.content === "Model answer one."));
  assert.ok(!result.inputs.some(item => item.content.includes("Discord copy")));
});

test("no raw message JSON", async () => {
  const context = [msg("1001", "alice", "Can you fix the bike?", at(14, 2), { authorIdentity: { discord_handle: "alice" } }), msg("1002", "bob", "thanks", at(14, 5))];
  const request = msg("1003", "alice", "what about the chain", at(14, 6));
  const result = await builder(context).build(request, undefined, 12, noHistory);
  assert.deepEqual(result.inputs.filter(item => item.contextOnly).map(item => item.content), [
    "[14:02] #m1 Alice (@alice): Can you fix the bike?\n[14:05] #m2 Bob: thanks",
  ]);
  assert.equal(result.refs.get("m1"), "1001");
  assert.equal(result.refs.get("m2"), "1002");
});

test("budget fits", async () => {
  const context = Array.from({ length: 30 }, (_, index) => msg(String(2000 + index), "bob", `message ${index + 1} ${"x".repeat(200)}`, at(14, index)));
  const request = msg("3000", "alice", "what next", at(15, 0));
  const inputLimit = counter.count([{ role: "user", content: requestLine(request) }]) + 800;
  const result = await builder(context, new Map(), inputLimit).build(request, undefined, 40, noHistory);
  const history = result.inputs.filter(item => item.contextOnly);
  assert.ok(history.length > 0);
  assert.ok(counter.count(history) <= inputLimit - counter.count([{ role: "user", content: requestLine(request) }]));
  assert.ok(history.at(-1)!.content.includes("message 30 "));
  assert.ok(result.sources.has("2029"));
  assert.ok(!result.sources.has("2000"));
});

test("reply target kept", async () => {
  const context = Array.from({ length: 30 }, (_, index) => msg(String(2000 + index), "bob", `step ${index + 1} ${"y".repeat(200)}`, at(14, index), index > 0 ? { replyTo: String(1999 + index) } : {}));
  const request = msg("3000", "alice", "and then", at(15, 0), { replyTo: "2029" });
  const inputLimit = counter.count([{ role: "user", content: requestLine(request) }]) + 900;
  const result = await builder(context, new Map(), inputLimit).build(request, undefined, 40, noHistory);
  const target = result.inputs.find(item => item.content.includes("[reply target]"));
  assert.ok(target?.content.includes("step 30 "));
  assert.ok(!result.inputs.some(item => item.content.includes("step 1 ")));
});

test("request is plain text", async () => {
  const context = [msg("1001", "alice", "Can you fix the bike?", at(14, 2)), msg("1002", BOT, "Discord copy", at(14, 3))];
  const request = msg("1003", "alice", "what about the chain", at(14, 6));
  const result = await builder(context, replies({ "1002": "Model answer one." })).build(request, undefined, 12, noHistory);
  const wire = wireMessages({ prefixVersion: "v1", prefix: [], history: [], inputs: result.inputs });
  assert.equal(wire.at(-1)?.content, "[14:06] Alice [current request]: what about the chain");
  assert.equal(wire.find(item => item.role === "assistant")?.content, "Model answer one.");
});

test("request names the requester", async () => {
  const context = [msg("1001", "bob", "Can you fix the bike?", at(14, 2))];
  const request = msg("1002", "alice", "what about the chain", at(14, 6), { authorIdentity: { discord_handle: "alice" } });
  const result = await builder(context).build(request, undefined, 12, noHistory);
  const wire = wireMessages({ prefixVersion: "v1", prefix: [], history: [], inputs: result.inputs });
  assert.equal(wire.at(-1)?.content, "[14:06] Alice (@alice) [current request]: what about the chain");
  assert.equal(result.inputs.at(-1)?.author, "alice");
});

test("voice request keeps header", async () => {
  const request = msg("1002", "alice", "turn the lights on", at(14, 6), { source: "voice" });
  const result = await builder([]).build(request, undefined, 12, noHistory);
  const last = result.inputs.at(-1)!;
  assert.equal(last.content, "[14:06] Alice [current request]: turn the lights on");
  assert.equal(last.role, "user");
});

test("reply subject keeps the header", async () => {
  const profiles = {
    findPeople: async () => [{ id: "555", name: "Bob" }],
    profile: async () => ({ name: "Bob", identity: {}, fields: [] }),
  } as unknown as ProfileStore;
  const context = [msg("1001", "bob", "I fixed <@12345678901234567>'s bike", at(14, 2))];
  const request = msg("1002", "alice", "what did he say about it", at(14, 6), { replyTo: "1001" });
  const result = await builder(context, new Map(), 100_000, profiles).build(request, undefined, 12, noHistory);
  assert.equal(result.inputs.at(-1)?.content, "[14:06] Alice [current request]: About Bob (<@555>), the person in your reply target:\nwhat did he say about it");
});

test("error notice stays user side", async () => {
  const context = [msg("1001", "alice", "Can you fix the bike?", at(14, 2)), msg("1002", BOT, "Usage limit reached.", at(14, 3))];
  const request = msg("1003", "alice", "what about the chain", at(14, 6));
  const result = await builder(context).build(request, undefined, 12, noHistory);
  assert.ok(!result.inputs.some(item => item.role === "assistant"));
  assert.ok(result.inputs.some(item => item.role === "user" && item.content.includes("Slopbot notice: Usage limit reached.")));
});

test("slopbot not in people", async () => {
  const profiles = {
    profile: async (_server: string, user: string) => ({ name: user === "alice" ? "Alice" : "Bob", identity: {}, fields: [] }),
  } as unknown as ProfileStore;
  const context = [msg("1001", "alice", "Can you fix the bike?", at(14, 2)), msg("1002", BOT, "Usage limit reached.", at(14, 3)), msg("1003", "bob", "thanks", at(14, 5))];
  const request = msg("1004", "alice", "what about the chain", at(14, 6));
  const result = await builder(context, new Map(), 100_000, profiles).build(request, undefined, 12, noHistory);
  const content = result.inputs.find(item => item.contextOnly && item.content.includes("People:"))!.content;
  assert.ok(!content.includes(`(user_id ${BOT})`));
  assert.ok(content.includes("- Alice (user_id alice) [requester]"));
  assert.ok(content.includes("- Bob (user_id bob)"));
  assert.ok(result.inputs.some(item => item.role === "user" && item.content.includes("Slopbot notice: Usage limit reached.")));
});
