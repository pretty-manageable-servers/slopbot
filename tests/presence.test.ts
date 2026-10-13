import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { PresenceUpdater, presenceText, utcMidnight } from "../src/presence.js";
import type { Message } from "../src/domain.js";

const DAY = 86_400_000;
const midnight = Date.UTC(2026, 9, 13);

function updater(options: { replies?: () => Promise<number>; servers?: () => number; now?: () => number; intervalMs?: number; sent?: string[]; since?: number[] } = {}) {
  const sent = options.sent ?? [];
  const since = options.since ?? [];
  const presence = new PresenceUpdater({
    setStatus: text => sent.push(text),
    countReplies: async value => { since.push(value); return options.replies ? options.replies() : 0; },
    guildCount: options.servers ?? (() => 1),
    now: options.now ?? (() => midnight + 12 * 3_600_000),
    ...(options.intervalMs !== undefined ? { intervalMs: options.intervalMs } : {}),
  });
  return { presence, sent, since };
}

test("the status text uses singular and plural forms", () => {
  assert.equal(presenceText(1, 1), "1 reply today · 1 server");
  assert.equal(presenceText(0, 0), "0 replies today · 0 servers");
  assert.equal(presenceText(2, 3), "2 replies today · 3 servers");
  assert.equal(presenceText(1, 2), "1 reply today · 2 servers");
});

test("the status text stays within 128 characters", () => {
  assert.ok(presenceText(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER).length <= 128);
});

test("the day starts at UTC midnight, not local midnight", () => {
  assert.equal(utcMidnight(midnight), midnight);
  assert.equal(utcMidnight(midnight + DAY - 1), midnight);
  assert.equal(utcMidnight(midnight + DAY), midnight + DAY);
});

test("the count starts at the UTC midnight of the current time", async () => {
  const at23 = midnight + DAY - 1;
  const first = updater({ now: () => at23 });
  await first.presence.refresh();
  assert.deepEqual(first.since, [midnight]);

  const at0 = midnight + DAY;
  const second = updater({ now: () => at0 });
  await second.presence.refresh();
  assert.deepEqual(second.since, [midnight + DAY]);
});

test("an unchanged text is not sent again", async () => {
  let replies = 2;
  const { presence, sent } = updater({ replies: async () => replies });
  await presence.refresh();
  await presence.refresh();
  assert.deepEqual(sent, ["2 replies today · 1 server"]);
  replies = 3;
  await presence.refresh();
  assert.deepEqual(sent, ["2 replies today · 1 server", "3 replies today · 1 server"]);
});

test("a server count change alone sends a new text", async () => {
  let servers = 1;
  const { presence, sent } = updater({ servers: () => servers });
  await presence.refresh();
  servers = 2;
  await presence.refresh();
  assert.deepEqual(sent, ["0 replies today · 1 server", "0 replies today · 2 servers"]);
});

test("a failed count is logged and the last text is kept", async t => {
  const errors: unknown[] = [];
  t.mock.method(console, "warn", (line: string) => errors.push(line));
  let replies = 1;
  let fail = false;
  const { presence, sent } = updater({ replies: async () => { if (fail) throw new Error("db down"); return replies; } });
  await presence.refresh();
  fail = true;
  await presence.refresh();
  assert.deepEqual(sent, ["1 reply today · 1 server"]);
  assert.equal(errors.length, 1);
  assert.match(String(errors[0]), /presence_count_failed/);
  fail = false;
  await presence.refresh();
  assert.deepEqual(sent, ["1 reply today · 1 server"], "same text after the error is not re-sent");
  replies = 4;
  await presence.refresh();
  assert.deepEqual(sent, ["1 reply today · 1 server", "4 replies today · 1 server"]);
});

test("start refreshes at once and then on each interval, and stop clears the timer", async () => {
  let calls = 0;
  const { presence } = updater({ replies: async () => ++calls, intervalMs: 5 });
  presence.start();
  await new Promise(resolve => setTimeout(resolve, 40));
  presence.stop();
  const atStop = calls;
  assert.ok(atStop >= 2, `expected at least two refreshes, got ${atStop}`);
  await new Promise(resolve => setTimeout(resolve, 40));
  assert.equal(calls, atStop, "no refresh runs after stop");
});

test("a refresh that finishes after stop does not send a status", async () => {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const { presence, sent } = updater({ replies: async () => { await gate; return 5; } });
  const pending = presence.refresh();
  presence.stop();
  release();
  await pending;
  assert.deepEqual(sent, []);
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
