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

test("self reply is assistant", () => {
  const { items } = renderTranscript([msg("q"), own("r")], SELF, new Map([["r", reply("run-1", "Hello.")]]));
  assert.equal(items.length, 2);
  assert.equal(items[0]?.role, "user");
  assert.deepEqual(items[1], { role: "assistant", content: "Hello." });
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

test("assistant text is run result not Discord text", () => {
  const { items } = renderTranscript([msg("q"), own("r", { text: "**Slopbot** (from web): Discord copy" })], SELF, new Map([["r", reply("run-1", "Model answer.")]]));
  assert.deepEqual(items[1], { role: "assistant", content: "Model answer." });
  assert.doesNotMatch(JSON.stringify(items), /Discord copy/);
});

test("resolveRefs maps refs in objects, arrays and comma lists, and leaves prose alone", () => {
  const refs = new Map([["m1", "id-111"], ["m2", "id-222"], ["m3", "id-333"], ["m5", "id-555"]]);
  const cases: [unknown, unknown][] = [
    [{ reply_to: "#m1", ids: ["m2", "m9", "text m1"], nested: { n: 3, ok: true, nothing: null, t: "m1" } },
      { reply_to: "id-111", ids: ["id-222", "m9", "text m1"], nested: { n: 3, ok: true, nothing: null, t: "id-111" } }],
    [{ source_ids: "m3, #m5" }, { source_ids: "id-333,id-555" }],
    ["m3,#m5", "id-333,id-555"],
    ["hello, m3", "hello, m3"],
    [{ text: "m3, see this" }, { text: "m3, see this" }],
  ];
  for (const [input, expected] of cases) assert.deepEqual(resolveRefs(input as never, refs), expected);
});
