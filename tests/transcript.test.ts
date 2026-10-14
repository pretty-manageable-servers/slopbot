import test from "node:test";
import assert from "node:assert/strict";
import { formatLine, renderTranscript, resolveRefs, toLine } from "../src/transcript.js";
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

test("formats one line", () => {
  const line = toLine(msg("a", {
    authorIdentity: { discord_handle: "alice" },
    replyTo: "p",
    attachments: [{ name: "a.png", url: "https://example.test/a.png" }],
    revisionTimestamp: at(14, 5),
  }), "m3", new Map([["p", "m1"]]));
  assert.equal(formatLine(line), "[14:02] #m3 Alice (@alice) ↩#m1 [edited] [files: a.png]: text a");
});

test("drops empty fields", () => {
  const line = toLine(msg("a", { attachments: [], authorIdentity: {} }), "m1", new Map());
  assert.deepEqual(Object.keys(line).sort(), ["name", "ref", "text", "time"]);
  assert.equal(formatLine(line), "[14:02] #m1 Alice: text a");
});

test("self reply is assistant", () => {
  const { items } = renderTranscript([msg("q"), own("r")], SELF, new Map([["r", reply("run-1", "Hello.")]]));
  assert.equal(items.length, 2);
  assert.equal(items[0]?.role, "user");
  assert.deepEqual(items[1], { role: "assistant", content: "Hello." });
});

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

test("drops leading assistant", () => {
  const { items } = renderTranscript([own("r"), msg("u1")], SELF, new Map([["r", reply("run-1", "Early.")]]));
  assert.equal(items.length, 1);
  assert.equal(items[0]?.role, "user");
  assert.equal(items[0]?.content, "[14:02] #m1 Alice: text u1");
});

test("joins two assistant replies", () => {
  const { items } = renderTranscript([msg("q"), own("r1"), own("r2")], SELF, new Map([
    ["r1", reply("run-1", "First.")],
    ["r2", reply("run-2", "Second.")],
  ]));
  assert.equal(items.length, 2);
  assert.deepEqual(items[1], { role: "assistant", content: "First.\n\nSecond." });
});

test("marks reply target", () => {
  const { items, refs } = renderTranscript([msg("q1"), msg("q2", { replyTo: "q1" })], SELF, new Map(), "q1");
  assert.equal(refs.get("m1"), "q1");
  assert.equal(items.length, 1);
  assert.equal(items[0]?.content, "[14:02] #m1 Alice [reply target]: text q1\n[14:02] #m2 Alice ↩#m1: text q2");
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

test("comma ref list resolves", () => {
  const refs = new Map([["m3", "id-333"], ["m5", "id-555"]]);
  assert.deepEqual(resolveRefs({ source_ids: "m3, #m5" }, refs), { source_ids: "id-333,id-555" });
  assert.equal(resolveRefs("m3,#m5", refs), "id-333,id-555");
});

test("mixed text with comma is unchanged", () => {
  const refs = new Map([["m3", "id-333"]]);
  assert.equal(resolveRefs("hello, m3", refs), "hello, m3");
  assert.deepEqual(resolveRefs({ text: "m3, see this" }, refs), { text: "m3, see this" });
});

test("no JSON braces in output", () => {
  const messages = [
    msg("q", { authorIdentity: { discord_handle: "alice", server_name: "Secret Server" }, attachments: [{ name: "notes.txt", url: "https://example.test/n" }] }),
    own("r"),
    msg("u2", { replyTo: "q", author: "user-bob", authorName: "Bob", isBot: true }),
  ];
  const { items } = renderTranscript(messages, SELF, new Map([["r", reply("run-1", "Plain answer.")]]));
  const text = items.map(item => item.content).join("\n");
  assert.doesNotMatch(text, /[{}]/);
  assert.doesNotMatch(text, /Secret Server|user-alice|user-bob|srv-1|chan-1/);
  assert.match(text, /\[files: notes\.txt\]/);
  assert.match(text, /\[bot\]/);
});
