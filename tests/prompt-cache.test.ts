import assert from "node:assert/strict";
import { test } from "node:test";
import {
  stableJson,
  PromptCacheDiagnostics,
  appendToolEvidence,
} from "../src/prompt-cache.js";
import { ByteTokenCounter } from "../src/context.js";
import type { Prompt, PromptItem } from "../src/domain.js";

test("canonical structural keys preserve literal text and array order", () => {
  assert.equal(
    stableJson({ z: { b: 2, a: 1 }, a: ["b", "a"] }),
    stableJson({ a: ["b", "a"], z: { a: 1, b: 2 } }),
  );
  assert.notEqual(stableJson({ text: "a b" }), stableJson({ text: "a  b" }));
  assert.notEqual(stableJson(["a", "b"]), stableJson(["b", "a"]));
});
test("cache diagnostics distinguish append from an edit in the middle without storing text", () => {
  const diagnostics = new PromptCacheDiagnostics();
  const prompt: Prompt = {
    prefixVersion: "v1",
    cacheScope: "task",
    prefix: [{ role: "system", content: "fixed" }],
    history: [],
    inputs: [],
  };
  const messages = ["a", "b", "c", "d", "e", "f"].map((content) => ({
    role: "user",
    content,
  }));
  assert.equal(
    (diagnostics.compare(prompt, messages) as any).relation,
    "first",
  );
  assert.equal(
    (
      diagnostics.compare(prompt, [
        ...messages,
        { role: "user", content: "g" },
      ]) as any
    ).relation,
    "append",
  );
  const edited = messages.map((message, index) =>
    index === 3 ? { ...message, content: "private edit" } : message,
  );
  const result = diagnostics.compare(prompt, edited) as any;
  assert.equal(result.relation, "branch");
  assert.equal(result.changed_at_message, 3);
  assert.ok(!JSON.stringify(result).includes("private edit"));
  assert.equal((diagnostics.compare(prompt, edited) as any).relation, "repeat");
});
test("large tool results fit by truncating only new evidence, retaining originals", () => {
  const base: PromptItem[] = [
    { role: "system", content: "fixed" },
    { role: "user", content: "original request" },
  ];
  const original = structuredClone(base),
    counter = new ByteTokenCounter();
  const output = { text: "🙂".repeat(5000), status: "ok" as const };
  const item = appendToolEvidence("search", output, base, counter, 600);
  assert.ok(counter.count([...base, item]) <= 600);
  assert.deepEqual(base, original);
  assert.equal(output.text.length, 10000);
  assert.match(item.content, /full result is in the action log/);
  assert.throws(
    () => appendToolEvidence("search", output, base, counter, 20),
    /budget boundary/,
  );
});
