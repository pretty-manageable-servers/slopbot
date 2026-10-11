import { test } from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { registerHistoryTools } from "../src/search/history-search.js";
import { ToolRegistry } from "../src/tools.js";
const message = {
  server: "s",
  channel: "c",
  author: "u",
  id: "request",
  text: "search",
};
test("history search filters literal text, dates and authors and reads chronological backfill", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  for (const item of [
    { id: "3", text: "deploy 100% complete", timestamp: 300 },
    { id: "1", text: "deploy began", timestamp: 100 },
    { id: "2", text: "deploy running", timestamp: 200 },
    { id: "4", text: "deploy elsewhere", timestamp: 400, channel: "private" },
  ])
    await store.ingest({ ...message, ...item });
  const page = await store.searchHistory({
    server: "s",
    channel: "c",
    query: "100%",
    mode: "exact",
    limit: 10,
  });
  assert.deepEqual(
    page.messages.map((m) => m.id),
    ["3"],
  );
  assert.deepEqual(
    (await store.readHistory("s", "c", "2", 1)).map((m) => m.id),
    ["1", "2", "3"],
  );
  const filtered = await store.searchHistory({
    server: "s",
    channel: "c",
    query: "deploy",
    author: "other",
    mode: "keyword",
    limit: 10,
  });
  assert.equal(filtered.messages.length, 0);
  const range = await store.searchHistory({
    server: "s",
    channel: "c",
    query: "deploy",
    after: 150,
    before: 250,
    mode: "hybrid",
    limit: 10,
  });
  assert.deepEqual(
    range.messages.map((m) => m.id),
    ["2"],
  );
  assert.equal(range.degraded, true);
});
test("search cursors are scoped to the actor and recheck permissions on every page", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  for (let i = 1; i <= 3; i++)
    await store.ingest({
      ...message,
      id: String(i),
      text: "deploy",
      timestamp: i,
    });
  let allowed = true;
  const registry = new ToolRegistry(store, async () => false);
  registerHistoryTools(registry, {
    store,
    authorize: async () => {
      if (!allowed) throw Error("denied");
    },
  });
  const result = await registry.invokeResult(
    message,
    "history_search",
    { query: "deploy", mode: "keyword", limit: 1 },
    "first",
    "agent",
  );
  const cursor = result.text.match(/Next cursor: ([a-f0-9]+)/)![1]!;
  const next = await registry.invokeResult(
    message,
    "history_search",
    { cursor },
    "next",
    "agent",
  );
  assert.ok(!next.sources?.some((s) => s.kind === "message" && s.id === "3"));
  await assert.rejects(
    registry.invokeResult(
      { ...message, author: "other" },
      "history_search",
      { cursor },
      "wrong",
      "agent",
    ),
    /belongs/,
  );
  allowed = false;
  await assert.rejects(
    registry.invokeResult(
      message,
      "history_search",
      { query: "deploy", mode: "keyword", limit: 1 },
      "first",
      "agent",
    ),
    /denied/,
  );
  await assert.rejects(
    registry.invokeResult(
      message,
      "history_search",
      { cursor },
      "denied",
      "agent",
    ),
    /denied/,
  );
});
