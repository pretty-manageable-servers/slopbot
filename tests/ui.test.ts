import { test } from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { ToolRegistry } from "../src/tools.js";
import { UiRuntime } from "../src/ui/runtime.js";
import { validateUi } from "../src/ui/schema.js";
import { discordUi } from "../src/adapters/discord-ui.js";
const message = { server: "s", channel: "c", author: "u", id: "m", text: "UI" };

test("UI rejects executable content and invalid poll specifications", () => {
  assert.throws(
    () => validateUi({ version: 1, type: "card", text: "Hi", script: "evil" }),
    /Unsupported/,
  );
  assert.throws(
    () =>
      validateUi({
        version: 1,
        type: "card",
        text: "Hi",
        actions: [{ label: "Run", action: "eval", arguments: {} }],
      }),
    /registered/,
  );
  assert.throws(
    () =>
      validateUi({
        version: 1,
        type: "poll",
        question: "Choose",
        answers: ["A", "A"],
        durationHours: 24,
      }),
    /distinct/,
  );
  const poll = discordUi(
    validateUi({
      version: 1,
      type: "poll",
      question: "Choose",
      answers: ["A", "B"],
      durationHours: 24,
    }),
    "id",
    1,
  );
  assert.ok("poll" in poll);
  assert.equal(poll.flags, undefined);
});

test("UI revisions prevent concurrent duplicate actions and durable state survives runtime recreation", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  let count = 0;
  const registry = new ToolRegistry(store, async () => false);
  registry.register({
    name: "task_manage",
    description: "task",
    fields: { action: { type: "string", description: "Action" } },
    access: "member",
    effect: "write",
    retrySafe: true,
    execute: async () => {
      count++;
      return "Done";
    },
  });
  const runtime = new UiRuntime(store, registry, async () => {});
  const spec = validateUi({
    version: 1,
    type: "card",
    text: "Task",
    actions: [{ label: "Complete", action: "task.complete", arguments: {} }],
  });
  const saved = await runtime.prepare(message, spec, "seed");
  const restored = new UiRuntime(store, registry, async () => {});
  const results = await Promise.allSettled([
    runtime.act(message, saved.id, 1, 0, "one"),
    restored.act(message, saved.id, 1, 0, "two"),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.equal(count, 1);
  assert.equal((await store.record("s", "ui", saved.id))?.revision, 3);
});

test("UI checks current channel access before claiming a control", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => false);
  const runtime = new UiRuntime(store, registry, async () => {
    throw Error("no access");
  });
  const saved = await runtime.prepare(
    message,
    validateUi({
      version: 1,
      type: "card",
      text: "Results",
      actions: [
        { label: "More", action: "history.next", arguments: { cursor: "x" } },
      ],
    }),
    "seed",
  );
  await assert.rejects(
    runtime.act(message, saved.id, 1, 0, "click"),
    /no access/,
  );
  assert.equal((await store.record("s", "ui", saved.id))?.revision, 1);
});

test("a UI recovers a completed action after a crash before the UI update", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  let executed = 0;
  const registry = new ToolRegistry(store, async () => false);
  registry.register({
    name: "task_manage",
    description: "Task",
    fields: { action: { type: "string", description: "Action" } },
    access: "member",
    effect: "write",
    retrySafe: true,
    execute: async () => {
      executed++;
      return "Completed";
    },
  });
  const runtime = new UiRuntime(store, registry, async () => {});
  const saved = await runtime.prepare(
    message,
    validateUi({
      version: 1,
      type: "card",
      text: "Task",
      actions: [{ label: "Complete", action: "task.complete", arguments: {} }],
    }),
    "recovery",
  );
  await store.putRecord(
    "s",
    "ui",
    saved.id,
    {
      ...saved.state,
      pending: true,
      pendingOperation: "ui:crash",
    } as unknown as import("../src/domain.js").Json,
    1,
  );
  await registry.invokeResult(
    message,
    "task_manage",
    { action: "complete" },
    "ui:crash",
    "command",
  );
  const restored = new UiRuntime(store, registry, async () => {});
  const recovered = await restored.current(message, saved.id);
  assert.equal(recovered.pending, false);
  assert.equal(recovered.revision, 3);
  assert.equal(executed, 1);
  assert.ok(
    recovered.document.type !== "poll" &&
      recovered.document.text === "Completed",
  );
});
