import test from "node:test";
import assert from "node:assert/strict";
import { resolveRefs } from "../src/transcript.js";
import { unknownMessageRef } from "../src/agent-runner.js";
import type { Json } from "../src/domain.js";

const refs = new Map([["m1", "real-id-1"], ["m2", "real-id-2"], ["m3", "real-id-3"]]);

test("quote ref resolves", () => {
  const args = { messageId: "#m2", note: "keep m2 out of text" };
  assert.equal(unknownMessageRef(args, refs), undefined);
  assert.deepEqual(resolveRefs(args, refs), { messageId: "real-id-2", note: "keep m2 out of text" });
});

test("inbox source ref resolves", () => {
  const args = { target: "member-1", summary: "Follow up", sourceIds: ["m1", "#m3"] };
  assert.equal(unknownMessageRef(args, refs), undefined);
  assert.deepEqual(resolveRefs(args, refs), { target: "member-1", summary: "Follow up", sourceIds: ["real-id-1", "real-id-3"] });
});

test("unknown ref errors", () => {
  const args = { sourceIds: ["m1", "#m9"] };
  assert.equal(unknownMessageRef(args, refs), "#m9");
  assert.equal(unknownMessageRef({ messageId: "m7" }, refs), "m7");
  // Without a transcript (empty map) nothing is checked.
  assert.equal(unknownMessageRef(args, new Map()), undefined);
  // Non-ref strings are never flagged.
  assert.equal(unknownMessageRef({ text: "m9 is not a ref here", n: 3 }, refs), undefined);
});

test("unknown ref detection reads nested arguments", () => {
  const args: Json = { items: [{ id: "m1" }, { id: "#m8" }] };
  assert.equal(unknownMessageRef(args, refs), "#m8");
});
