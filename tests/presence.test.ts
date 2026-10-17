import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { utcMidnight } from "../src/presence.js";
import type { Message } from "../src/domain.js";

const DAY = 86_400_000;
const midnight = Date.UTC(2026, 9, 13);


test("the day starts at UTC midnight, not local midnight", () => {
  assert.equal(utcMidnight(midnight), midnight);
  assert.equal(utcMidnight(midnight + DAY - 1), midnight);
  assert.equal(utcMidnight(midnight + DAY), midnight + DAY);
});

test("SQLiteStore counts each replied message once, from the given time on", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const message = (id: string, server = "s"): Message => ({ id, server, channel: "c", author: "a", authorName: "A", text: "hi", timestamp: 1 }) as Message;
  let clock = 0;
  t.mock.method(Date, "now", () => clock);
  const sentAt = async (id: string, at: number, server = "s") => {
    clock = at;
    const deliveryId = `d-${id}-${server}-${at}`;
    await store.prepareDelivery(deliveryId, message(id, server), "reply");
    await store.finishDelivery(deliveryId, message(id, server));
  };
  // Two parts of one reply, one reply on another server, one older reply, one unsent delivery.
  await sentAt("m1", 2000);
  await sentAt("m1", 2001);
  await sentAt("m2", 2002, "t");
  await sentAt("old", 500);
  clock = 2003;
  await store.prepareDelivery("unsent", message("m3"), "reply");
  assert.equal(await store.countRepliesSince(1000), 2);
  assert.equal(await store.countRepliesSince(0), 3);
  assert.equal(await store.countRepliesSince(3000), 0);
});
