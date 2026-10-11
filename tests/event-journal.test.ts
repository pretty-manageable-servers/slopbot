import assert from "node:assert/strict";
import { test } from "node:test";
import { EventJournal } from "../src/event-journal.js";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import type { ModelEvent } from "../src/domain.js";

const message = {
  server: "s",
  channel: "c",
  author: "a",
  id: "journal",
  text: "test",
};
test("batch journal preserves every raw event and sequence with far fewer writes", async (t) => {
  const store = new SQLiteStore();
  t.after(() => store.close());
  await store.startRun("run", message, {
    prefixVersion: "v1",
    prefix: [],
    history: [],
    inputs: [],
  });
  let writes = 0;
  const journal = new EventJournal(
    {
      appendEvent: store.appendEvent.bind(store),
      async appendEvents(run, sequence, events) {
        writes++;
        await store.appendEvents(run, sequence, events);
      },
    },
    "run",
    message,
    "model",
  );
  const expected: ModelEvent[] = Array.from({ length: 1046 }, (_, n) => ({
    kind: n % 2 ? "reasoning" : "opaque",
    payload: { index: n, text: "original 🙂" },
  }));
  for (const event of expected) await journal.append(event);
  await journal.close();
  assert.equal(writes, 33);
  assert.deepEqual(store.events("run"), expected);
});
test("journal flushes on stream failure and supports legacy stores", async () => {
  const events: ModelEvent[] = [],
    sequences: number[] = [];
  const journal = new EventJournal(
    {
      async appendEvent(_run, sequence, event) {
        sequences.push(sequence);
        events.push(event);
      },
    },
    "failed",
    message,
    "model",
  );
  try {
    await journal.append({
      kind: "reasoning",
      payload: { text: "partial reasoning" },
    });
    throw new Error("stream failed");
  } catch {
    await journal.close();
  }
  assert.deepEqual(sequences, [0]);
  assert.equal(events[0]?.kind, "reasoning");
});
test("journal flushes sparse streams on its interval and propagates write errors", async () => {
  let writes = 0;
  const journal = new EventJournal(
    {
      async appendEvent() {
        writes++;
      },
    },
    "sparse",
    message,
    "model",
  );
  await journal.append({ kind: "text", payload: { text: "hello" } });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(writes, 1);
  await journal.close();
  const failed = new EventJournal(
    {
      async appendEvent() {
        throw new Error("database failed");
      },
    },
    "bad",
    message,
    "model",
  );
  await failed.append({
    kind: "reasoning",
    payload: { text: "must not silently succeed" },
  });
  await assert.rejects(failed.close(), /database failed/);
});
