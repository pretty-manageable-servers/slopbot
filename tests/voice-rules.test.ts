import assert from "node:assert/strict";
import { test } from "node:test";
import { ContextBuilder } from "../src/context-builder.js";
import type { Message } from "../src/domain.js";
import type { ToolExecutor } from "../src/tools.js";
import { spokenText, VOICE_RULE } from "../src/voice-rules.js";

test("spokenText cuts at sentence end", () => {
  assert.equal(spokenText("First sentence here. Second sentence is much longer and goes on.", 30), "First sentence here.");
  assert.equal(spokenText("Is it? Yes it is, and more words here", 12), "Is it?");
  assert.equal(spokenText("Wow! Then more text follows after", 10), "Wow!");
  // Length counts code points, not UTF-16 units.
  assert.equal(spokenText("😀😀😀. x", 4), "😀😀😀.");
});

test("spokenText hard cut with no sentence end", () => {
  assert.equal(spokenText("abcdefghijklmnopqrstuvwxyz", 10), "abcdefghij");
  assert.equal(spokenText("  no marks here at all  ", 8), "no marks");
});

test("spokenText keeps short text", () => {
  assert.equal(spokenText("  Short reply.  "), "Short reply.");
  assert.equal(spokenText("abc.", 4), "abc.");
  assert.equal(spokenText("abc", 3), "abc");
});

const tools = { catalog: () => "", execute: async () => { throw new Error("not used"); } } as ToolExecutor;

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

test("voice request has voice_rule", async () => {
  const context = await requestContext("voice");
  assert.ok(context.split("\n").includes("voice_channel: true"));
  assert.ok(context.split("\n").includes(`voice_rule: ${VOICE_RULE}`));
});

test("web request has no voice_rule", async () => {
  const context = await requestContext("web");
  assert.equal(context.includes("voice_rule"), false);
  assert.equal(context.includes("voice_channel"), false);
});

test("spokenText speaks a short sentence for an error reply", async () => {
  const { spokenText, VOICE_ERROR_TEXT } = await import("../src/voice-rules.js");
  assert.equal(spokenText("\\[ACTION\\_UNCERTAIN\\] Discord delivery: Job ID 123"), VOICE_ERROR_TEXT);
  assert.equal(spokenText("[PROVIDER_HTTP_404] AI provider returned HTTP 404"), VOICE_ERROR_TEXT);
});

test("spokenText drops markdown, links and mentions", async () => {
  const { spokenText } = await import("../src/voice-rules.js");
  assert.equal(spokenText("**Paris** is the [capital](https://example.com) of `France`, <@123456789012345678>. See https://x.y/z"), "Paris is the capital of France, . See");
});

test("a voice preset sends no default instructions", async () => {
  const { voiceInstructions, DEFAULT_VOICE_INSTRUCTIONS } = await import("../src/voice-rules.js");
  assert.equal(voiceInstructions(undefined, undefined, true), "");
  assert.equal(voiceInstructions("A pirate.", undefined, true), "A pirate.");
  assert.equal(voiceInstructions(undefined, "From env.", true), "From env.");
  assert.equal(voiceInstructions(undefined, undefined, false), DEFAULT_VOICE_INSTRUCTIONS);
});
