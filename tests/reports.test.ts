import { test } from "node:test";
import assert from "node:assert/strict";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { ToolRegistry } from "../src/tools.js";
import { registerReportTools } from "../src/search/reports.js";
const message = {
  server: "s",
  channel: "c",
  author: "u",
  id: "request",
  text: "Summarize",
};
test("reports record source links, preserve reasoning events and reject stale evidence", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  await store.ingest({
    ...message,
    id: "source",
    text: "We decided to ship Friday",
    timestamp: 1,
  });
  let generated = 0;
  const registry = new ToolRegistry(store, async () => false);
  registerReportTools(registry, {
    store,
    authorize: async () => {},
    llm: {
      async *stream() {
        generated++;
        yield { kind: "reasoning", payload: { text: "Keep this delta" } };
        yield {
          kind: "text",
          payload: {
            text: "Ship Friday. [source](https://discord.com/channels/s/c/source)",
          },
        };
      },
    },
  });
  const result = await registry.invokeResult(
    message,
    "decision_lookup",
    { query: "ship" },
    "report",
    "agent",
  );
  assert.equal(result.sources?.length, 1);
  const report = (await store.record("s", "report", "report"))!;
  const runId = (report.value as { runId: string }).runId;
  assert.equal(store.events(runId)[0]?.kind, "reasoning");
  assert.match(result.text, /bounded sample/);
  const saved = await registry.invokeResult(
    message,
    "decision_lookup",
    { id: "report" },
    "read",
    "agent",
  );
  assert.match(saved.text, /Ship Friday/);
  assert.equal(generated, 1);
  await store.revise({
    ...message,
    id: "source",
    text: "Friday was cancelled",
    timestamp: 1,
  });
  await assert.rejects(
    registry.invokeResult(
      message,
      "decision_lookup",
      { id: "report" },
      "read",
      "agent",
    ),
    /changed or were deleted/,
  );
  await assert.rejects(
    registry.invokeResult(
      message,
      "decision_lookup",
      { id: "report" },
      "stale",
      "agent",
    ),
    /changed or were deleted/,
  );
});
