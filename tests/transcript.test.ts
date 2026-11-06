import test from "node:test";
import assert from "node:assert/strict";
import { renderTranscript, resolveRefs } from "../src/transcript.js";
import type { Message } from "../src/domain.js";

const SELF = "bot-1";
const at = (hour: number, minute: number) => Date.UTC(2026, 9, 13, hour, minute);

/** A plain message from Alice. Tests override only the fields they need. */
function msg(id: string, extra: Partial<Message> = {}): Message {
  return { id, server: "srv-1", channel: "chan-1", author: "user-alice", authorName: "Alice", text: `text ${id}`, timestamp: at(14, 2), ...extra };
}
/** Slopbot's own message. */
function own(id: string, extra: Partial<Message> = {}): Message {
  return msg(id, { author: SELF, authorName: "Slopbot", isBot: true, ...extra });
}
function reply(runId: string, text: string): { runId: string; text: string } {
  return { runId, text };
}

test("joins user runs", () => {
  const messages = [
    msg("u1"),
    msg("u2", { author: "user-bob", authorName: "Bob" }),
    own("r"),
    msg("u3"),
  ];
  const { items } = renderTranscript(messages, SELF, new Map([["r", reply("run-1", "Hi")]]));
  assert.equal(items.length, 3);
  assert.equal(items[0]?.role, "user");
  assert.equal(items[0]?.contextOnly, true);
  assert.equal(items[0]?.content.split("\n").length, 2);
  assert.equal(items[2]?.content, "[14:02] #m3 Alice: text u3");
});

test("error message is notice not assistant", () => {
  const { items } = renderTranscript([
    msg("q"),
    own("err", { timestamp: at(14, 3), text: "Error: usage limit reached" }),
  ], SELF, new Map());
  assert.equal(items.length, 1);
  assert.equal(items[0]?.role, "user");
  assert.equal(items[0]?.content, "[14:02] #m1 Alice: text q\n[14:03] #m2 Slopbot notice: Error: usage limit reached");
});

test("split reply is one assistant turn", () => {
  const replies = new Map([["a", reply("run-1", "Full reply.")], ["b", reply("run-1", "Full reply.")]]);
  const { items } = renderTranscript([msg("q"), own("a"), own("b"), msg("u2")], SELF, replies);
  const assistant = items.filter(item => item.role === "assistant");
  assert.equal(assistant.length, 1);
  assert.equal(assistant[0]?.content, "Full reply.");
  assert.equal(items.length, 3);
});

test("assistant text is run result not Discord text", () => {
  const { items } = renderTranscript([msg("q"), own("r", { text: "**Slopbot** (from web): Discord copy" })], SELF, new Map([["r", reply("run-1", "Model answer.")]]));
  assert.deepEqual(items[1], { role: "assistant", content: "Model answer." });
  assert.doesNotMatch(JSON.stringify(items), /Discord copy/);
});

test("failed run is notice", () => {
  // A failed run has no completed row, so modelReplies has no entry for its message.
  const { items } = renderTranscript([msg("q"), own("r", { text: "Error: model failed" })], SELF, new Map());
  assert.equal(items.length, 1);
  assert.equal(items[0]?.content, "[14:02] #m1 Alice: text q\n[14:02] #m2 Slopbot notice: Error: model failed");
  assert.equal(items.some(item => item.role === "assistant"), false);
});

test("resolveRefs maps refs", () => {
  const refs = new Map([["m1", "id-111"], ["m2", "id-222"]]);
  const args = { reply_to: "#m1", ids: ["m2", "m9", "text m1"], nested: { n: 3, ok: true, nothing: null, t: "m1" } };
  assert.deepEqual(resolveRefs(args, refs), {
    reply_to: "id-111",
    ids: ["id-222", "m9", "text m1"],
    nested: { n: 3, ok: true, nothing: null, t: "id-111" },
  });
});
