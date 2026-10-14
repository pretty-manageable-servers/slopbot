import assert from "node:assert/strict";
import { test } from "node:test";
import { contextBlock } from "../src/context-block.js";
import { ContextBuilder } from "../src/context-builder.js";
import type { Message } from "../src/domain.js";
import type { Evidence } from "../src/memory.js";
import type { ToolExecutor } from "../src/tools.js";
import { VOICE_RULE } from "../src/voice-rules.js";

const tools = { catalog: () => "", execute: async () => { throw new Error("not used"); } } as ToolExecutor;

const evidence: Evidence = { content: "Alice said she likes tea.", sourceIds: ["src-1"], author: "bob", kind: "message", authorName: "Bob" };

const profiles = {
  profile: async (_server: string, user: string) => ({
    userId: user, name: user === "alice" ? "Alice Smith" : "Bob", identity: { discord_handle: user }, allowEdits: true,
    fields: user === "alice" ? [{ field: "github", value: "alice-gh", editor: "alice", sourceIds: ["src-2"], revision: "r1" }] : [],
  }),
};

function builder(recalled: Evidence[] = [evidence]) {
  return new ContextBuilder({
    store: { contextVersion: async () => "1", context: async () => [] } as never,
    recall: { retrieve: async () => recalled },
    profiles: profiles as never,
    tools,
    counter: { name: "test", count: () => 1 },
    inputLimit: 1e6,
    outputLimit: 1000,
    prefix: [],
  });
}

function message(source?: "web" | "voice"): Message {
  return { id: "m1", server: "s", channel: "100000000000000001", author: "alice", authorName: "Alice", text: "what do you know about me", timestamp: 1_000, addressed: true, ...(source ? { source } : {}) } as Message;
}

test("one context item", async () => {
  const built = await builder().build(message(), undefined, 0, async () => []);
  const context = built.inputs.filter(item => item.contextOnly);
  assert.equal(context.length, 1);
  assert.equal(context[0]!.role, "user");
  assert.equal(built.inputs.at(-1)!.contextOnly, undefined);
  assert.equal(built.inputs.indexOf(context[0]!), built.inputs.length - 2);
  assert.ok(context[0]!.content.startsWith("Request context:\n"));
  assert.ok(context[0]!.content.includes("\n\nPeople:\n"));
  assert.ok(context[0]!.content.includes("\n\nEvidence:\n"));
  assert.ok(!context[0]!.content.includes('"request_context"'));
  assert.ok(!context[0]!.content.includes('"public_profile"'));
});

test("profiles keep user id", async () => {
  const built = await builder().build(message(), undefined, 0, async () => []);
  const content = built.inputs.find(item => item.contextOnly)!.content;
  assert.ok(content.includes('- Alice Smith (user_id alice) discord={"discord_handle":"alice"}; github=alice-gh\n'));
  assert.ok(content.includes("- Bob (user_id bob) discord="));
});

test("evidence keeps source ids", async () => {
  const built = await builder().build(message(), undefined, 0, async () => []);
  const content = built.inputs.find(item => item.contextOnly)!.content;
  const line = content.split("\n").find(row => row.startsWith("- {\"content\":\"Alice said"));
  assert.ok(line, "evidence line present");
  assert.deepEqual(JSON.parse(line.slice(2)).sourceIds, ["src-1"]);
});

test("voice rule kept", async () => {
  const built = await builder().build(message("voice"), undefined, 0, async () => []);
  const content = built.inputs.find(item => item.contextOnly)!.content;
  assert.ok(content.includes("\nvoice_channel: true\n"));
  assert.ok(content.includes(`\nvoice_rule: ${VOICE_RULE}\n`));
});

test("block skips empty request fields and omits empty sections", () => {
  const block = contextBlock({ request: { server_id: "s", is_task: false, task_id: null, requester_id: "alice" }, people: [], evidence: [] });
  assert.equal(block.role, "user");
  assert.equal(block.contextOnly, true);
  assert.equal(block.content, "Request context:\nserver_id: s\nis_task: false\nrequester_id: alice");
});

test("is_task false is shown", () => {
  const block = contextBlock({ request: { server_id: "s", is_task: false, private_web_chat: false }, people: [], evidence: [] });
  assert.ok(block.content.split("\n").includes("is_task: false"));
  assert.equal(block.content.includes("private_web_chat"), false);
});
