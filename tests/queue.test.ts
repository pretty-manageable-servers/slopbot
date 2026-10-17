import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { Application } from "../src/application.js";
import { FakeLLM } from "../src/adapters/fake-llm.js";
import { TaskWorker } from "../src/queue.js";
import { UserLimiter } from "../src/user-limiter.js";
import { UncertainActionError } from "../src/tools.js";
import type { Message } from "../src/domain.js";

const message = (id: string, channel = "t"): Message => ({ id, server: "s", channel, taskId: channel, author: id === "1" ? "alice" : "bob", text: `request ${id}` });
const scopes = [{ server: "s", channel: "t" }, { server: "s", channel: "other" }];

test("restart publishes an already committed answer without running the model or appending history twice", async () => {
  const dir = mkdtempSync(join(tmpdir(), "slopbot-queue-")), path = join(dir, "store.sqlite3");
  const store = new SQLiteStore(path);
  const job = store.enqueueJob(message("1"));
  store.claimJob("s");
  const app = new Application(store, new FakeLLM(), { allowedChannels: scopes });
  await app.handle(message("1"), true);
  assert.equal(store.jobs("s", "t")[0]?.status, "sending");
  store.close();
  const reopened = new SQLiteStore(path);
  let generations = 0, deliveries = 0;
  const worker = new TaskWorker("s", reopened, new UserLimiter(reopened, { fiveHourCostMicros: 0, weekCostMicros: 0, gracePercent: 10 }), async () => { generations++; throw new Error("must reuse answer"); }, async (_message, reply, id) => {
    assert.equal(id, job.id); assert.ok(reply.text.includes("request 1")); deliveries++;
  }, () => true);
  try {
    worker.start(); await worker.idle();
    assert.equal(generations, 0); assert.equal(deliveries, 1);
    assert.equal(reopened.jobs("s", "t")[0]?.status, "done");
    assert.equal(reopened.historyArchive(JSON.stringify(["s", "t", "t"])).length, 2);
    worker.enqueue(message("1")); await worker.idle();
    assert.equal(deliveries, 1);
  } finally { await worker.stop(); reopened.close(); rmSync(dir, { recursive: true, force: true }); }
});

test("task order includes publication, while other channels can run independently", async t => {
  const store = new SQLiteStore(), llm = new FakeLLM();
  const app = new Application(store, llm, { allowedChannels: scopes });
  let release!: () => void, deliveryStarted!: () => void;
  const wait = new Promise<void>(resolve => { release = resolve; });
  const started = new Promise<void>(resolve => { deliveryStarted = resolve; });
  const delivered: string[] = [];
  const worker = new TaskWorker("s", store, new UserLimiter(store, { fiveHourCostMicros: 0, weekCostMicros: 0, gracePercent: 10 }), message => app.handle(message, true), async message => {
    if (message.id === "1") { deliveryStarted(); await wait; }
    delivered.push(message.id);
  }, () => true);
  t.after(async () => { release(); await worker.stop(); store.close(); });
  worker.start();
  worker.enqueue(message("1")); worker.enqueue(message("2")); worker.enqueue(message("3", "other"));
  await started;
  assert.ok(!llm.prompts.some(prompt => prompt.inputs.at(-1)?.content.endsWith("[current request]: request 2")));
  release(); await worker.idle();
  assert.ok(delivered.indexOf("1") < delivered.indexOf("2"));
  const second = llm.prompts.find(prompt => prompt.inputs.at(-1)?.content.endsWith("[current request]: request 2"))!;
  assert.equal(second.history[0]?.author, "alice");
  const other = llm.prompts.find(prompt => prompt.inputs.at(-1)?.content.endsWith("[current request]: request 3"))!;
  assert.deepEqual(other.history, []);
});

test("uncertain delivery is blocked and a retry reuses the saved answer", async t => {
  const store = new SQLiteStore(), llm = new FakeLLM();
  const app = new Application(store, llm, { allowedChannels: scopes });
  let attempts = 0, actualWrites = 0;
  const worker = new TaskWorker("s", store, new UserLimiter(store, { fiveHourCostMicros: 0, weekCostMicros: 0, gracePercent: 10 }), message => app.handle(message, true), async () => {
    if (++attempts === 1) actualWrites++;
    throw new UncertainActionError("send result cannot be verified");
  }, () => true);
  t.after(async () => { await worker.stop(); store.close(); });
  worker.start(); const job = await worker.enqueue(message("1")); await worker.idle();
  assert.equal(store.jobs("s", "t")[0]?.status, "blocked");
  store.retryJob("s", "t", job.id); worker.wake(); await worker.idle();
  assert.equal(actualWrites, 1); assert.equal(llm.prompts.length, 1);
  assert.equal(store.historyArchive(JSON.stringify(["s", "t", "t"])).length, 2);
});

test("leases reject a second worker owner until expiration; interrupted jobs recover", t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  assert.equal(store.acquireWorker("s", "first", Date.now() + 60000), true);
  assert.equal(store.acquireWorker("s", "second", Date.now() + 60000), false);
  store.enqueueJob(message("1")); store.claimJob("s");
  store.releaseWorker("s", "first");
  assert.equal(store.acquireWorker("s", "second", Date.now() + 60000), true);
  store.recoverJobs("s");
  assert.equal(store.jobs("s", "t")[0]?.status, "pending");
});

test("a cancelled job is not claimed and does not finish later", () => {
  const store = new SQLiteStore();
  const job = store.enqueueJob(message("1"));
  assert.equal(store.cancelJob(job.id), true);
  assert.equal(store.cancelJob(job.id), false);
  assert.equal(store.claimJob("s"), undefined);
  store.finishJob(job.id);
  assert.equal(store.jobs("s", "t")[0]?.status, "cancelled");
  store.close();
});
