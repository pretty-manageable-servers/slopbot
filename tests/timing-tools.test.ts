import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { ToolRegistry, toolResult } from "../src/tools.js";
import { registerTimingTools, saveRequestTiming } from "../src/timing-tools.js";

test("timing lookup resolves reply outputs, survives recovery and rechecks channel access", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  const request = {
    server: "s",
    channel: "c",
    id: "request",
    author: "a",
    text: "private input",
  };
  const output = { ...request, id: "reply", text: "private output" };
  const timing = {
    totalMs: 14100,
    steps: { context: 4700, model: 5600, queue: 800, delivery: 500 },
    firstOutputMs: [1700],
    partial: false,
  };
  const calls = [
    {
      id: "tool-one",
      name: "web_search",
      status: "completed" as const,
      durationMs: 1300,
    },
  ];
  await saveRequestTiming(store, request, timing, "sent", [output], calls);
  await saveRequestTiming(
    store,
    request,
    { ...timing, totalMs: 2, partial: true },
    "sent",
    [output],
    [],
  );
  let allowed = true;
  const registry = new ToolRegistry(store, async () => false);
  registerTimingTools(registry, {
    store,
    async authorize() {
      if (!allowed) throw new Error("denied");
    },
  });
  const followup = {
    ...request,
    id: "followup",
    replyTo: "reply",
    text: "why so slow",
  };
  const result = await registry.invokeResult(
    followup,
    "timing_inspect",
    {},
    "inspect",
    "agent",
  );
  assert.ok(!result.text.includes("private"));
  assert.equal(result.sources?.[0]?.kind, "message");
  allowed = false;
  await assert.rejects(
    registry.invoke(followup, "timing_inspect", {}, "inspect", "agent"),
    /denied/,
  );
  allowed = true;
  await assert.rejects(
    registry.invoke(
      { ...followup, channel: "other" },
      "timing_inspect",
      {},
      "inspect",
      "agent",
    ),
    /original permitted channel/,
  );
  const foreign = toolResult(
    await registry.invoke(
      { ...followup, channel: "other" },
      "timing_inspect",
      {},
      "foreign",
      "agent",
    ),
  );
  assert.match(foreign.text, /No recorded timing/);
  const otherServer = toolResult(
    await registry.invoke(
      { ...followup, server: "other" },
      "timing_inspect",
      {},
      "foreign-server",
      "agent",
    ),
  );
  assert.match(otherServer.text, /No recorded timing/);
});
