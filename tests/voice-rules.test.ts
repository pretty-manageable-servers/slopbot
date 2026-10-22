import assert from "node:assert/strict";
import { test } from "node:test";
import { ContextBuilder } from "../src/context-builder.js";
import type { Message } from "../src/domain.js";
import type { ToolExecutor } from "../src/tools.js";
import { DEFAULT_VOICE_INSTRUCTIONS, plainSpoken, spokenText, splitSpeak, VOICE_ERROR_TEXT, VOICE_RULE, voiceInstructions } from "../src/voice-rules.js";

test("splitSpeak separates speak blocks from chat text", () => {
  const cases: [string, { spoken: string | undefined; chat: string }][] = [
    ["  Plain reply.  ", { spoken: undefined, chat: "Plain reply." }],
    ["Details here.\n<speak>It is sunny.</speak>", { spoken: "It is sunny.", chat: "Details here." }],
    ["<speak>One.</speak> Text.\n<speak>Two.</speak>", { spoken: "One. Two.", chat: "Text." }],
    ["Hi there.<speak>  </speak>", { spoken: undefined, chat: "Hi there." }],
  ];
  for (const [input, expected] of cases) assert.deepEqual(splitSpeak(input), expected);
});

test("spokenText cuts, strips markdown and hides raw errors", () => {
  const cases: [string, number | undefined, string][] = [
    ["First sentence here. Second sentence is much longer and goes on.", 30, "First sentence here."],
    ["😀😀😀. x", 4, "😀😀😀."],
    ["abcdefghijklmnopqrstuvwxyz", 10, "abcdefghij"],
    ["  Short reply.  ", undefined, "Short reply."],
    ["\\[ACTION\\_UNCERTAIN\\] Discord delivery: Job ID 123", undefined, VOICE_ERROR_TEXT],
    ["[PROVIDER_HTTP_404] AI provider returned HTTP 404", undefined, VOICE_ERROR_TEXT],
    ["**Paris** is the [capital](https://example.com) of `France`, <@123456789012345678>. See https://x.y/z", undefined, "Paris is the capital of France, . See"],
  ];
  for (const [input, limit, expected] of cases) assert.equal(spokenText(input, limit), expected);
});

test("plainSpoken replaces channel links", () => {
  const cases: [string, string][] = [
    ["Task started in <#123456789012345678>. Updates will appear there.", "Task started in the thread. Updates will appear there."],
    ["Joined <#123456789012345678>. Use /voice to leave.", "Joined the channel. Use /voice to leave."],
  ];
  for (const [input, expected] of cases) assert.equal(plainSpoken(input), expected);
});

const tools = { schemas: () => [], catalog: () => "", execute: async () => { throw new Error("not used"); } } as ToolExecutor;

function builder() {
  return new ContextBuilder({ store: { contextVersion: async () => "1", context: async () => [] } as never, tools, counter: { name: "test", count: () => 1 }, inputLimit: 1e6, outputLimit: 1000, prefix: [] });
}

function message(source?: "web" | "voice"): Message {
  return { id: "m1", server: "s", channel: "100000000000000001", author: "alice", authorName: "Alice", text: "what time is it?", timestamp: 1_000, addressed: true, ...(source ? { source } : {}) } as Message;
}

async function requestContext(source?: "web" | "voice") {
  const built = await builder().build(message(source), undefined, 0, async () => []);
  return built.metadata[0]!.content;
}

test("voice rule is added only to voice requests", async () => {
  const context = await requestContext("voice");
  assert.ok(context.split("\n").includes("voice_channel: true"));
  assert.ok(context.split("\n").includes(`voice_rule: ${VOICE_RULE}`));
  const web = await requestContext("web");
  assert.equal(web.includes("voice_rule"), false);
  assert.equal(web.includes("voice_channel"), false);
});

test("a voice preset sends no default instructions", () => {
  assert.equal(voiceInstructions(undefined, undefined, true), "");
  assert.equal(voiceInstructions("A pirate.", undefined, true), "A pirate.");
  assert.equal(voiceInstructions(undefined, "From env.", true), "From env.");
  assert.equal(voiceInstructions(undefined, undefined, false), DEFAULT_VOICE_INSTRUCTIONS);
});
