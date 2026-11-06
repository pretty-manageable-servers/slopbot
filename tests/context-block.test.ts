import assert from "node:assert/strict";
import { test } from "node:test";
import { ContextBuilder } from "../src/context-builder.js";
import type { Message } from "../src/domain.js";
import type { Evidence } from "../src/memory.js";
import type { ToolExecutor } from "../src/tools.js";

const tools = { schemas: () => [], catalog: () => "", execute: async () => { throw new Error("not used"); } } as ToolExecutor;

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

test("profiles keep user id", async () => {
  const built = await builder().build(message(), undefined, 0, async () => []);
  const content = built.inputs.find(item => item.contextOnly)!.content;
  assert.ok(content.includes('- Alice Smith (user_id alice) [requester] discord={"discord_handle":"alice"}; github=alice-gh\n'));
  assert.ok(content.includes("- Bob (user_id bob) discord="));
});

test("requester marked in people", async () => {
  const built = await builder().build(message(), undefined, 0, async () => []);
  const people = built.inputs.find(item => item.contextOnly)!.content.split("\n").filter(row => row.startsWith("- ") && row.includes("(user_id "));
  assert.equal(people.filter(row => row.includes("[requester]")).length, 1);
  assert.ok(people.some(row => row.startsWith("- Alice Smith (user_id alice) [requester]")));
  assert.ok(people.some(row => row.startsWith("- Bob (user_id bob) discord=") && !row.includes("[requester]")));
});

test("request context has channel id only", async () => {
  const built = await builder().build(message(), undefined, 0, async () => []);
  const content = built.inputs.find(item => item.contextOnly)!.content;
  const request = content.slice(0, content.indexOf("\n\n"));
  assert.ok(request.startsWith("Request context:\n"));
  // Channel tools need the current channel ID. Server and requester IDs stay hidden.
  assert.ok(request.includes("channel_id: "));
  assert.ok(!/server_id|requester_id/.test(request));
  assert.ok(request.split("\n").includes("is_task: false"));
});

test("evidence keeps source ids", async () => {
  const built = await builder().build(message(), undefined, 0, async () => []);
  const content = built.inputs.find(item => item.contextOnly)!.content;
  const line = content.split("\n").find(row => row.startsWith("- {\"content\":\"Alice said"));
  assert.ok(line, "evidence line present");
  assert.deepEqual(JSON.parse(line.slice(2)).sourceIds, ["src-1"]);
});
