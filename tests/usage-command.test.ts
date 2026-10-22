import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { usageReply } from "../src/adapters/discord-commands.js";

import { UserLimiter } from "../src/user-limiter.js";

const limiter = (store: SQLiteStore, fiveHour: number, week: number) => new UserLimiter(store, { fiveHourCostMicros: fiveHour, weekCostMicros: week, gracePercent: 10 });

test("a user over the limit can still run /usage and use a banked reset, and /usage charges nothing", async () => {
  const store = new SQLiteStore(":memory:"), limits = limiter(store, 100, 0);
  await limits.record("alice", 100);
  await store.grantResets("global", "alice", "5h", 1);
  assert.equal((await limits.check("alice")).allowed, false);
  const shown = await usageReply(limits, "alice", null);
  assert.equal(shown.content, undefined);
  assert.match(JSON.stringify(shown.embeds), /100% used/);
  assert.equal((await limits.usage("alice"))[0]!.spent, 100);
  assert.equal((await limits.check("alice")).allowed, false);
  const reset = await usageReply(limits, "alice", "5h");
  assert.equal(reset.content, "Used one 5-hour reset. That window is cleared.");
  assert.equal((await limits.check("alice")).allowed, true);
  store.close();
});

test("/usage reset uses one banked reset per window, then says none is left", async () => {
  const store = new SQLiteStore(":memory:"), limits = limiter(store, 100, 1000);
  await limits.record("alice", 100);
  await store.grantResets("global", "alice", "5h", 1);
  assert.equal((await usageReply(limits, "alice", "week")).content, "You have no banked weekly reset.");
  const first = await usageReply(limits, "alice", "5h");
  assert.equal(first.content, "Used one 5-hour reset. That window is cleared.");
  assert.match(JSON.stringify(first.embeds), /0% used/);
  // The weekly window keeps its spend and is not cleared.
  assert.match(JSON.stringify(first.embeds), /10% used/);
  assert.equal((await limits.usage("alice"))[1]!.spent, 100);
  const second = await usageReply(limits, "alice", "5h");
  assert.equal(second.content, "You have no banked 5-hour reset.");
  assert.deepEqual(second.embeds, []);
  store.close();
});

test("/usage rejects an unknown window without touching any banked reset", async () => {
  const store = new SQLiteStore(":memory:"), limits = limiter(store, 100, 0);
  await store.grantResets("global", "alice", "5h", 1);
  assert.equal((await usageReply(limits, "alice", "month")).content, "Choose 5-hour or weekly to reset.");
  assert.equal((await limits.usage("alice"))[0]!.banked, 1);
  store.close();
});
