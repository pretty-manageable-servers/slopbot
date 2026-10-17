import assert from "node:assert/strict";
import { test } from "node:test";
import { ContextBuilder } from "../src/context-builder.js";
import { ByteTokenCounter } from "../src/context.js";
import type { Message, PromptItem } from "../src/domain.js";
import type { Store } from "../src/ports.js";
import type { ProfileStore } from "../src/profiles.js";
import { requestLine } from "../src/transcript.js";

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

test("error notice stays user side", async () => {
  const context = [msg("1001", "alice", "Can you fix the bike?", at(14, 2)), msg("1002", BOT, "Usage limit reached.", at(14, 3))];
  const request = msg("1003", "alice", "what about the chain", at(14, 6));
  const result = await builder(context).build(request, undefined, 12, noHistory);
  assert.ok(!result.inputs.some(item => item.role === "assistant"));
  assert.ok(result.inputs.some(item => item.role === "user" && item.content.includes("Slopbot notice: Usage limit reached.")));
});
