import { test } from "node:test";
import assert from "node:assert/strict";
import { ChannelAccess, type ChannelFacts } from "../src/channel-access.js";
import { Inbox, INBOX_MAX_SUMMARY, INBOX_SENDER_DAILY_LIMIT, type InboxItem, type InboxStore } from "../src/inbox.js";
import { registerServerTools, type ServerToolServices } from "../src/server-tools.js";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { ToolRegistry } from "../src/tools.js";
import type { Message } from "../src/domain.js";

const SERVER = "100000000000000001";
const CHANNEL = "200000000000000001";
const OTHER_CHANNEL = "200000000000000002";
const TARGET = "300000000000000001";
const SENDER = "300000000000000002";
const SOURCE = "400000000000000001";

class MemoryInboxStore implements InboxStore {
  readonly items: InboxItem[] = [];
  async addInboxItem(item: InboxItem): Promise<void> { this.items.push({ ...item, sourceIds: [...item.sourceIds] }); }
  async inboxItems(server: string, target: string, options: { includeDone: boolean; limit: number }): Promise<InboxItem[]> {
    return this.items
      .filter(item => item.server === server && item.target === target && (options.includeDone || item.done_at === null))
      .sort((a, b) => b.created_at - a.created_at)
      .slice(0, options.limit);
  }
  async markInboxDone(server: string, target: string, ids: string[] | "all", at: number): Promise<number> {
    let count = 0;
    for (const item of this.items) {
      if (item.server !== server || item.target !== target || item.done_at !== null) continue;
      if (ids !== "all" && !ids.includes(item.id)) continue;
      item.done_at = at;
      count++;
    }
    return count;
  }
  async countInboxSent(server: string, sender: string, since: number): Promise<number> {
    return this.items.filter(item => item.server === server && item.sender === sender && item.created_at >= since).length;
  }
  async deleteExpiredInbox(before: number): Promise<number> {
    const kept = this.items.filter(item => item.created_at >= before);
    const removed = this.items.length - kept.length;
    this.items.splice(0, this.items.length, ...kept);
    return removed;
  }
}

const visible: ChannelFacts = {
  thread: false, privateThread: false, viewChannel: true, readMessageHistory: true,
  sendMessages: true, sendMessagesInThreads: false, threadMember: false,
};

/** A fake channel access source. A user in `hidden` cannot view that channel. */
function fakeAccess(hidden: Set<string>, clock: { now: number }): ChannelAccess {
  return new ChannelAccess({
    async facts(_server, channel, user) { return hidden.has(`${user}:${channel}`) ? { ...visible, viewChannel: false } : visible; },
  }, () => clock.now);
}

function setup(hidden = new Set<string>()) {
  const store = new MemoryInboxStore();
  const clock = { now: Date.parse("2026-10-13T10:00:00Z") };
  const inbox = new Inbox(store, fakeAccess(hidden, clock), () => clock.now);
  return { store, clock, hidden, inbox };
}

const input = (overrides: Partial<Parameters<Inbox["add"]>[0]> = {}) => ({
  server: SERVER, target: TARGET, sender: SENDER, channel: CHANNEL, sourceIds: [SOURCE], summary: "Call the vendor back.", ...overrides,
});

test("add over daily limit fails", async () => {
  const { inbox, clock } = setup();
  for (let i = 0; i < INBOX_SENDER_DAILY_LIMIT; i++) await inbox.add(input({ summary: `Item ${i}` }));
  await assert.rejects(inbox.add(input()), { name: "ToolError", message: "You can add 20 inbox items a day." });
  // The window is 24 hours, so a day later the sender can add again.
  clock.now += 24 * 60 * 60_000 + 1;
  await inbox.add(input());
});

test("list hides channel the user cannot see", async () => {
  const { inbox, hidden, clock } = setup();
  await inbox.add(input({ channel: CHANNEL, summary: "Visible" }));
  await inbox.add(input({ channel: OTHER_CHANNEL, summary: "Hidden later" }));
  assert.equal((await inbox.list(SERVER, TARGET)).length, 2);
  // Permissions change. Move past the access cache so the new answer is used.
  hidden.add(`${TARGET}:${OTHER_CHANNEL}`);
  clock.now += 60_000;
  const items = await inbox.list(SERVER, TARGET);
  assert.deepEqual(items.map(item => item.summary), ["Visible"]);
});

test("done all", async () => {
  const { inbox, store } = setup();
  await inbox.add(input({ summary: "First" }));
  await inbox.add(input({ summary: "Second" }));
  assert.equal(await inbox.done(SERVER, TARGET, "all"), 2);
  assert.equal(await inbox.done(SERVER, TARGET, "all"), 0);
  assert.deepEqual(await inbox.list(SERVER, TARGET), []);
  assert.equal((await inbox.list(SERVER, TARGET, true)).length, 2);
  assert.ok(store.items.every(item => item.done_at !== null));
});

test("summary too long fails", async () => {
  const { inbox } = setup();
  await assert.rejects(inbox.add(input({ summary: "x".repeat(INBOX_MAX_SUMMARY + 1) })), /at most 1000 characters/);
  await assert.rejects(inbox.add(input({ summary: "   " })), /cannot be empty/);
  await inbox.add(input({ summary: "x".repeat(INBOX_MAX_SUMMARY) }));
});

test("target cannot see channel fails", async () => {
  const { inbox } = setup(new Set([`${TARGET}:${CHANNEL}`]));
  await assert.rejects(inbox.add(input()), { name: "ToolError", message: "That member cannot see this channel." });
});

test("inbox_add tool stores item for target", async (t) => {
  const journal = new SQLiteStore();
  t.after(() => journal.close());
  const { inbox, store } = setup();
  const registry = new ToolRegistry(journal, async () => false);
  registerServerTools(registry, { server: SERVER, inbox, originMessage: (message: Message) => message } as unknown as ServerToolServices);
  const message: Message = { id: "500000000000000001", server: SERVER, channel: CHANNEL, author: SENDER, text: `put this in <@${TARGET}>'s inbox` };
  const result = await registry.invokeResult(message, "inbox_add", { target: TARGET, summary: "Send the invoice.", source_ids: SOURCE }, "op-add", "agent");
  assert.match(result.text, new RegExp(`Added inbox item .+ for <@${TARGET}>`));
  assert.equal(store.items.length, 1);
  const [item] = store.items;
  assert.equal(item!.target, TARGET);
  assert.equal(item!.sender, SENDER);
  assert.equal(item!.channel, CHANNEL);
  assert.deepEqual(item!.sourceIds, [SOURCE]);
  assert.equal(item!.summary, "Send the invoice.");
});

test("inbox writes run inline without a task thread", async (t) => {
  const journal = new SQLiteStore();
  t.after(() => journal.close());
  const { inbox } = setup();
  const registry = new ToolRegistry(journal, async () => false);
  registerServerTools(registry, { server: SERVER, inbox, originMessage: (message: Message) => message } as unknown as ServerToolServices);
  assert.equal(registry.requiresThread("inbox_add", { target: TARGET, summary: "x", source_ids: SOURCE }), false);
  assert.equal(registry.requiresThread("inbox_done", { ids: "all" }), false);
});
