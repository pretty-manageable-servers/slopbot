import assert from "node:assert/strict";
import { test } from "node:test";
import {
  RequestTimings,
  timingFooter,
} from "../src/request-timing.js";

const message = {
  server: "s",
  channel: "c",
  id: "timed",
  author: "a",
  text: "private message",
};
test("timings isolate concurrent requests, aggregate rounds and close failures", async () => {
  let now = 0;
  const timing = new RequestTimings(() => now);
  timing.begin(message);
  timing.start(message, "queue");
  now = 10;
  timing.end(message, "queue");
  const other = { ...message, id: "other" };
  timing.begin(other);
  await assert.rejects(
    timing.measure(message, "model", async () => {
      now = 25;
      throw new Error("fail");
    }),
  );
  await timing.measure(message, "model", async () => {
    now = 30;
  });
  timing.firstOutput(message, 4);
  const result = timing.finish(message)!;
  assert.deepEqual(
    {
      totalMs: result.totalMs,
      steps: result.steps,
      firstOutputMs: result.firstOutputMs,
      partial: result.partial,
    },
    {
      totalMs: 30,
      steps: { queue: 10, model: 20 },
      firstOutputMs: [4],
      partial: false,
    },
  );
  assert.equal(timing.snapshot(message), undefined);
  assert.equal(timing.finish(other)!.totalMs, 20);
  assert.ok(!JSON.stringify(result).includes("private"));
  assert.match(
    timingFooter(result),
    /Total time: .*before delivery.* \| application\/uninstrumented .* \| worker queue/,
  );
  const example = timingFooter({
    totalMs: 14100,
    steps: { model: 5600, context: 4700, queue: 800, references: 0 },
    firstOutputMs: [1700],
    partial: false,
  });
  assert.match(example, /other 3.0s/);
  assert.match(example, /first output \(within model\) 1.7s/);
  assert.match(
    timingFooter({
      totalMs: 6000,
      steps: { context: 4000, "checkpoint model": 3000, model: 1000 },
      firstOutputMs: [],
      partial: false,
    }),
    /other 1.0s/,
  );
});

test("wait ledger captures live overlapping awaits without double-counting elapsed time", async () => {
  let now = 0;
  const timings = new RequestTimings(() => now);
  timings.begin(message);
  await timings.withScope(message, async () => {
    let releaseDb!: () => void, releaseProvider!: () => void;
    now = 10;
    const db = timings.wait(
      "database",
      () =>
        new Promise<void>((resolve) => {
          releaseDb = resolve;
        }),
    );
    now = 20;
    const provider = timings.wait(
      "provider",
      () =>
        new Promise<void>((resolve) => {
          releaseProvider = resolve;
        }),
    );
    now = 30;
    const live = timings.snapshot(message)!;
    assert.deepEqual(live.activeWaits, [
      { name: "database", elapsedMs: 20 },
      { name: "provider", elapsedMs: 10 },
    ]);
    now = 40;
    releaseDb();
    await db;
    now = 50;
    releaseProvider();
    await provider;
    now = 60;
  });
  const final = timings.finish(message)!;
  assert.deepEqual(final.blockedMs, {
    "application/uninstrumented": 20,
    database: 10,
    "database + provider": 20,
    provider: 10,
  });
  assert.equal(
    Object.values(final.blockedMs!).reduce((a, b) => a + b, 0),
    final.totalMs,
  );
  assert.deepEqual(final.activeWaits, []);
});

