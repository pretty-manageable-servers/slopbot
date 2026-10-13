import { test } from "node:test";
import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { Client } from "pg";
import { PostgresStore } from "../src/adapters/postgres.js";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import type { Message } from "../src/domain.js";
import type { UserLimitState, UserLimitWindow } from "../src/ports.js";
import type { WebReplyRow, WebWebhookRow } from "../src/web-replies.js";
import type { ShareRow } from "../src/shares.js";
import { UserLimiter } from "../src/user-limiter.js";

const WEB = "web-parity";
const SHARES = "share-parity";
const PRUNE = "prune-parity";

// Both adapters implement the same store methods. The cast lets one scenario drive both,
// and each call still runs the adapter's own SQL.
type Harness = SQLiteStore;
type Backend = { kind: "sqlite" } | { kind: "postgres"; url: string; schema: string };
type Steps = (store: Harness, log: Recorder, backend: Backend) => Promise<void>;

/** Records each call as {value} or {error}, so a failing call does not stop the scenario. */
class Recorder {
  readonly entries: Record<string, unknown> = {};
  async step(label: string, run: () => unknown): Promise<void> {
    try {
      this.entries[label] = { value: await run() };
    } catch (error) {
      this.entries[label] = { error: error instanceof Error ? error.message : String(error) };
    }
  }
}

/**
 * Each Postgres run uses its own fresh schema, dropped at the end. Truncating `public` here
 * deadlocked with postgres.integration.test.js, which runs in parallel on the same database.
 */
function freshSchema(): string {
  return `slopbot_parity_${randomBytes(6).toString("hex")}`;
}

async function dropSchema(url: string, schema: string): Promise<void> {
  const cleanup = new Client({ connectionString: url });
  await cleanup.connect();
  try {
    await cleanup.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await cleanup.end();
  }
}

/** Runs the same steps on a fresh SQLiteStore and on a fresh Postgres schema, then compares the logs. */
async function sameOnBoth(steps: Steps): Promise<Record<string, unknown>> {
  const url = process.env.TEST_DATABASE_URL!;
  const sqlite = new SQLiteStore();
  const sqliteLog = new Recorder();
  try {
    await steps(sqlite, sqliteLog, { kind: "sqlite" });
  } finally {
    sqlite.close();
  }
  const schema = freshSchema();
  const postgres = await PostgresStore.connect(url, undefined, schema) as unknown as Harness;
  const postgresLog = new Recorder();
  try {
    await steps(postgres, postgresLog, { kind: "postgres", url, schema });
  } finally {
    await postgres.close();
    await dropSchema(url, schema);
  }
  assert.deepEqual(postgresLog.entries, sqliteLog.entries);
  return sqliteLog.entries;
}

const byKind = (windows: readonly UserLimitWindow[]) => [...windows].sort((a, b) => a.kind.localeCompare(b.kind));
const usageOf = (state: UserLimitState) => ({ windows: byKind(state.windows), resets: state.resets });
const window = (kind: string, windowStart: number, spent: number): UserLimitWindow => ({ kind, windowStart, spent });

test("user limits match SQLite on Postgres", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const log = await sameOnBoth(async (store, step) => {
    await step.step("empty usage", async () => usageOf(await store.userUsage(WEB, "alice")));
    await step.step("first update sets two windows", () => store.updateUserLimits(WEB, "alice", () => ({ windows: [window("5h", 1000, 5), window("week", 500, 50)], result: "set" })));
    await step.step("second update adds spend", () => store.updateUserLimits(WEB, "alice", rows => ({ windows: rows.map(row => ({ ...row, spent: row.spent + 7 })), result: rows.length })));
    await step.step("usage after updates", async () => usageOf(await store.userUsage(WEB, "alice")));
    await step.step("throwing change rolls back", () => store.updateUserLimits(WEB, "alice", () => { throw new Error("refused by change"); }));
    await step.step("usage after rollback", async () => usageOf(await store.userUsage(WEB, "alice")));
    await step.step("grant 5h resets", () => store.grantResets(WEB, "alice", "5h", 2));
    await step.step("grant week reset", () => store.grantResets(WEB, "alice", "week", 1));
    await step.step("grant zero is refused", () => store.grantResets(WEB, "alice", "5h", 0));
    await step.step("use 5h reset", () => store.useReset(WEB, "alice", "5h"));
    await step.step("usage after 5h reset", async () => usageOf(await store.userUsage(WEB, "alice")));
    await step.step("respend 5h", () => store.updateUserLimits(WEB, "alice", rows => ({ windows: [...rows, window("5h", 3000, 3)], result: undefined })));
    await step.step("reset week clears both windows", () => store.resetUserUsage(WEB, "alice", "week"));
    await step.step("usage after kind reset", async () => usageOf(await store.userUsage(WEB, "alice")));
    await step.step("reset all windows", () => store.resetUserUsage(WEB, "alice"));
    await step.step("usage after full reset keeps banked resets", async () => usageOf(await store.userUsage(WEB, "alice")));
    await step.step("use week reset", () => store.useReset(WEB, "alice", "week"));
    await step.step("use week reset again", () => store.useReset(WEB, "alice", "week"));
    await step.step("use reset for unknown user", () => store.useReset(WEB, "nobody", "5h"));

    // Two concurrent useReset calls with one banked reset: exactly one may succeed.
    await step.step("bob grants one reset", () => store.grantResets(WEB, "bob", "5h", 1));
    await step.step("bob spends", () => store.updateUserLimits(WEB, "bob", () => ({ windows: [window("5h", 2000, 9)], result: undefined })));
    await step.step("two concurrent useReset", () => Promise.all([store.useReset(WEB, "bob", "5h"), store.useReset(WEB, "bob", "5h")]));
    await step.step("usage after concurrent reset", async () => usageOf(await store.userUsage(WEB, "bob")));

    // Setup for listing: spend levels and banked resets.
    await step.step("carol spends", () => store.updateUserLimits(WEB, "carol", () => ({ windows: [window("5h", 4000, 300), window("week", 1000, 1200)], result: undefined })));
    await step.step("two concurrent updates on carol", () => Promise.all([
      store.updateUserLimits(WEB, "carol", rows => ({ windows: rows.map(row => ({ ...row, spent: row.spent + 10 })), result: undefined })),
      store.updateUserLimits(WEB, "carol", rows => ({ windows: rows.map(row => ({ ...row, spent: row.spent + 10 })), result: undefined })),
    ]));
    await step.step("dave spends", () => store.updateUserLimits(WEB, "dave", () => ({ windows: [window("5h", 4000, 300)], result: undefined })));
    await step.step("erin spends", () => store.updateUserLimits(WEB, "erin", () => ({ windows: [window("5h", 4000, 100)], result: undefined })));
    await step.step("frank banks a reset", () => store.grantResets(WEB, "frank", "5h", 1));
    await step.step("gina spends only week", () => store.updateUserLimits(WEB, "gina", () => ({ windows: [window("week", 4000, 999)], result: undefined })));
    await step.step("list top four", () => store.listUserUsage(WEB, 4));
    await step.step("list all", () => store.listUserUsage(WEB, 100));
    await step.step("list other server", () => store.listUserUsage("other-server", 10));
  });

  assert.deepEqual(log["first update sets two windows"], { value: "set" });
  assert.deepEqual(log["throwing change rolls back"], { error: "refused by change" });
  assert.deepEqual(log["usage after rollback"], { value: { windows: [{ kind: "5h", windowStart: 1000, spent: 12 }, { kind: "week", windowStart: 500, spent: 57 }], resets: {} } });
  assert.deepEqual(log["grant zero is refused"], { error: "Reset count must be a positive integer" });
  assert.deepEqual(log["use 5h reset"], { value: true });
  assert.deepEqual(log["use week reset again"], { value: false });
  assert.deepEqual(log["two concurrent useReset"], { value: [true, false] });
  assert.deepEqual(log["usage after concurrent reset"], { value: { windows: [], resets: { "5h": 0 } } });
  assert.deepEqual(log["two concurrent updates on carol"], { value: [undefined, undefined] });
  assert.deepEqual((log["list top four"] as { value: { user: string }[] }).value.map(row => row.user), ["carol", "dave", "erin", "alice"]);
  assert.deepEqual((log["list all"] as { value: { user: string }[] }).value.map(row => row.user), ["carol", "dave", "erin", "alice", "bob", "frank", "gina"]);
  assert.deepEqual(log["list other server"], { value: [] });
  const carol = (log["list all"] as { value: { user: string; windows: UserLimitWindow[] }[] }).value.find(row => row.user === "carol");
  assert.deepEqual(carol?.windows.find(row => row.kind === "5h")?.spent, 320);
});

test("web webhooks and web reply rows match SQLite on Postgres", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const hook = (token: string): WebWebhookRow => ({ server: WEB, channel: "chan-1", webhook_id: "hook-1", token_encrypted: token });
  const reply = (id: string, patch: Partial<WebReplyRow> = {}): WebReplyRow => ({ id, server: WEB, channel: "chan-1", user_id: "user-1", status: "pending", message_id: null, created_at: 1000, via: "webhook", ...patch });
  const log = await sameOnBoth(async (store, step) => {
    await step.step("no webhook yet", () => store.webWebhook(WEB, "chan-1"));
    await step.step("save webhook", () => store.saveWebWebhook(hook("sealed-1")));
    await step.step("save webhook again replaces token", () => store.saveWebWebhook(hook("sealed-2")));
    await step.step("webhook by channel", () => store.webWebhook(WEB, "chan-1"));
    await step.step("webhook by hook id", () => store.webWebhookByHook(WEB, "hook-1"));
    await step.step("webhook by hook id on other server", () => store.webWebhookByHook("other-server", "hook-1"));
    await step.step("delete webhook", () => store.deleteWebWebhook(WEB, "chan-1"));
    await step.step("webhook by channel after delete", () => store.webWebhook(WEB, "chan-1"));
    await step.step("webhook by hook id after delete", () => store.webWebhookByHook(WEB, "hook-1"));

    await step.step("insert pending reply", () => store.insertWebReply(reply("reply-1")));
    await step.step("reply by message before finish", () => store.webReplyByMessage(WEB, "msg-1"));
    await step.step("finish reply as posted", () => store.finishWebReply("reply-1", "posted", "msg-1", "webhook"));
    await step.step("finish settled reply again", () => store.finishWebReply("reply-1", "failed"));
    await step.step("reply by message after finish", () => store.webReplyByMessage(WEB, "msg-1"));
    await step.step("reply by message on other server", () => store.webReplyByMessage("other-server", "msg-1"));

    await step.step("insert bot reply", () => store.insertWebReply(reply("reply-2", { via: "bot", created_at: 1001 })));
    await step.step("finish bot reply as failed", () => store.finishWebReply("reply-2", "failed"));

    await step.step("insert webhook reply", () => store.insertWebReply(reply("reply-3", { created_at: 1002 })));
    await step.step("finish reply on bot route", () => store.finishWebReply("reply-3", "posted", "msg-3", "bot"));
    await step.step("reply by message after route change", () => store.webReplyByMessage(WEB, "msg-3"));
  });
  assert.deepEqual(log["finish settled reply again"], { value: false });
  assert.deepEqual(log["reply by message after finish"], { value: { id: "reply-1", server: WEB, channel: "chan-1", user_id: "user-1", status: "posted", message_id: "msg-1", created_at: 1000, via: "webhook" } });
  assert.deepEqual(log["reply by message after route change"], { value: { id: "reply-3", server: WEB, channel: "chan-1", user_id: "user-1", status: "posted", message_id: "msg-3", created_at: 1002, via: "bot" } });
});

const message = (patch: Partial<Message> & Pick<Message, "id">): Message => ({ server: SHARES, channel: "c1", author: "alice", text: "x", addressed: false, ...patch });
const share = (id: string, patch: Partial<ShareRow> = {}): ShareRow => ({ id, server: SHARES, channel: "c1", created_by: "manager", created_at: 5000, revoked_at: null, body: JSON.stringify({ messages: [id] }), ...patch });

test("shares, transcripts and run events match SQLite on Postgres", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const log = await sameOnBoth(async (store, step) => {
    const messages: Message[] = [
      message({ id: "m1", text: "hello", timestamp: 100 }),
      message({ id: "q1", authorName: "Alice", text: "What is up?", timestamp: 150, addressed: true }),
      message({ id: "b1", author: "bot", isBot: true, authorName: "Slopbot", text: "Answer", timestamp: 200, replyTo: "q1" }),
      message({ id: "gone", author: "dave", text: "deleted", timestamp: 250 }),
      message({ id: "m3", author: "carol", text: "third", timestamp: 300 }),
      message({ id: "m3b", author: "carol", text: "third again", timestamp: 300 }),
      message({ id: "x1", channel: "c2", text: "other channel", timestamp: 999 }),
    ];
    for (const row of messages) await step.step(`ingest ${row.id}`, () => store.ingest(row));
    await step.step("remove message", () => store.remove(SHARES, "c1", "gone"));

    // Two reply runs answer q1. A purpose of inspection is not a reply and must not be linked.
    await step.step("start run 1", () => store.startRun("run-1", messages[1]!, { prefixVersion: "v1", prefix: [], history: [], inputs: [], purpose: "reply" }));
    await step.step("start run 2 inspection", () => store.startRun("run-2", messages[1]!, { prefixVersion: "v1", prefix: [], history: [], inputs: [], purpose: "inspection" }));
    await step.step("start run 3", () => store.startRun("run-3", messages[1]!, { prefixVersion: "v1", prefix: [], history: [], inputs: [], purpose: "reply" }));
    await step.step("record sources", () => store.recordSources("run-1", SHARES, ["q1"]));
    await step.step("run 1 reasoning", () => store.appendEvent("run-1", 0, { kind: "reasoning", payload: { text: "thinking" } }));
    await step.step("run 1 tool call", () => store.appendEvent("run-1", 1, { kind: "tool_call", payload: { name: "read", arguments: { path: "a" } } }));
    await step.step("run 1 text", () => store.appendEvent("run-1", 2, { kind: "text", payload: { text: "hi" } }));
    await step.step("run 2 tool call", () => store.appendEvent("run-2", 0, { kind: "tool_call", payload: { name: "hidden" } }));
    await step.step("run 3 tool call", () => store.appendEvent("run-3", 0, { kind: "tool_call", payload: { name: "search" } }));
    await step.step("complete run 1", () => store.complete("run-1", undefined, [], "Answer"));
    await step.step("complete run 3", () => store.complete("run-3", undefined, [], "Second"));
    await step.step("link bot reply to requests", () => store.linkOutput(messages[2]!, "run-1", "q1"));
    await step.step("link text without a run", () => store.linkOutput(message({ id: "b2", author: "bot", isBot: true, replyTo: "m1" }), undefined, "m1"));

    await step.step("reply runs of b1", () => store.replyRunIds(SHARES, "b1"));
    await step.step("reply runs of b2", () => store.replyRunIds(SHARES, "b2"));
    await step.step("request runs of q1", () => store.requestRunIds(SHARES, "q1"));
    await step.step("run record of run 2", () => store.runRecord("run-2"));

    // Snapshot reads.
    await step.step("shares: newest messages", () => store.shareMessages(SHARES, "c1", { limit: 10 }));
    await step.step("shares: range from m1 to b1", () => store.shareMessages(SHARES, "c1", { from: "m1", to: "b1", limit: 10 }));
    await step.step("shares: newest two from m1", () => store.shareMessages(SHARES, "c1", { from: "m1", limit: 2 }));
    await step.step("shares: removed start", () => store.shareMessages(SHARES, "c1", { from: "gone", limit: 10 }));
    await step.step("shares: request events", () => store.shareRequestEvents(SHARES, ["q1", "nope"]));
    await step.step("shares: no requests", () => store.shareRequestEvents(SHARES, []));

    // Transcript paging, newest first.
    await step.step("conversation page 1", () => store.conversationMessages(SHARES, "c1", undefined, 2));
    await step.step("conversation page 2", () => store.conversationMessages(SHARES, "c1", { time: 300, id: "m3" }, 2));
    await step.step("conversation page 3", () => store.conversationMessages(SHARES, "c1", { time: 150, id: "q1" }, 2));
    await step.step("conversation activity", async () => (await store.conversationActivity(SHARES)).sort((a, b) => a.channel.localeCompare(b.channel)));

    // Share links.
    await step.step("insert share 1", () => store.insertShare(share("share-1", { created_at: 5000 })));
    await step.step("insert share 2", () => store.insertShare(share("share-2", { created_at: 6000 })));
    await step.step("insert share on other server", () => store.insertShare(share("share-3", { server: "other-server", channel: "c9", created_at: 5500 })));
    await step.step("get share 1", () => store.getShare("share-1"));
    await step.step("get missing share", () => store.getShare("missing"));
    await step.step("list shares", () => store.listShares(SHARES, 10));
    await step.step("list one share", () => store.listShares(SHARES, 1));
    await step.step("revoke share 1", () => store.revokeShare(SHARES, "share-1", 7000));
    await step.step("revoke share 1 again", () => store.revokeShare(SHARES, "share-1", 8000));
    await step.step("share 1 after revoke", () => store.getShare("share-1"));
    await step.step("revoke on wrong server", () => store.revokeShare(SHARES, "share-3", 7000));
    await step.step("revoke all", () => store.revokeAllShares(SHARES, 9000));
    await step.step("revoke all again", () => store.revokeAllShares(SHARES, 9500));
    await step.step("list shares after revoke all", () => store.listShares(SHARES, 10));
    await step.step("other server share kept", () => store.getShare("share-3"));

    // Live events: stream IDs go up across channels.
    const event = (channel: string, kind: "message" | "run.start" | "run.delta" | "run.end", ref: string, data: Record<string, string>, createdAt: number) =>
      store.appendConversationEvent({ server: SHARES, channel, kind, ref, data, createdAt });
    await step.step("append event 1", () => event("c1", "message", "m1", {}, 1000));
    await step.step("append event 2", () => event("c2", "run.start", "run-1", {}, 1001));
    await step.step("append event 3", () => event("c1", "run.delta", "run-1", { text: "Hel" }, 1002));
    await step.step("append event 4", () => event("c2", "run.end", "run-1", {}, 1003));
    await step.step("append event 5", () => event("c1", "run.end", "run-1", {}, 1004));
    await step.step("latest stream id c1", () => store.latestStreamId(SHARES, "c1"));
    await step.step("latest stream id c2", () => store.latestStreamId(SHARES, "c2"));
    await step.step("latest stream id empty channel", () => store.latestStreamId(SHARES, "c3"));
    await step.step("events after 0 on c1", () => store.conversationEventsAfter(SHARES, "c1", 0, 10));
    await step.step("events after 1 on c1", () => store.conversationEventsAfter(SHARES, "c1", 1, 10));
    await step.step("events limit 1 on c1", () => store.conversationEventsAfter(SHARES, "c1", 0, 1));
    await step.step("oldest stream id c1", () => store.oldestStreamId(SHARES, "c1"));
    await step.step("oldest stream id c2", () => store.oldestStreamId(SHARES, "c2"));
    await step.step("oldest stream id empty channel", () => store.oldestStreamId(SHARES, "c3"));
  });

  assert.deepEqual(log["append event 1"], { value: 1 });
  assert.deepEqual(log["append event 5"], { value: 5 });
  assert.deepEqual((log["events after 0 on c1"] as { value: { streamId: number }[] }).value.map(row => row.streamId), [1, 3, 5]);
  assert.deepEqual(log["latest stream id c2"], { value: 4 });
  assert.deepEqual(log["reply runs of b1"], { value: ["run-1", "run-3"] });
  assert.deepEqual(log["reply runs of b2"], { value: [] });
  assert.deepEqual(log["shares: request events"], { value: [
    { request: "q1", kind: "reasoning", payload: { text: "thinking" } },
    { request: "q1", kind: "tool_call", payload: { name: "read", arguments: { path: "a" } } },
    { request: "q1", kind: "tool_call", payload: { name: "search" } },
  ] });
  assert.deepEqual((log["shares: newest two from m1"] as { value: { messages: Message[]; more: boolean } }).value.more, true);
  assert.deepEqual((log["shares: newest messages"] as { value: { messages: Message[] } }).value.messages.map(row => row.id), ["m1", "q1", "b1", "m3", "m3b"]);
  assert.deepEqual(log["shares: removed start"], { value: { messages: [], more: false } });
  assert.deepEqual((log["list shares after revoke all"] as { value: { id: string; revoked_at: number | null }[] }).value, [
    { id: "share-2", channel: "c1", created_at: 6000, revoked_at: 9000 },
    { id: "share-1", channel: "c1", created_at: 5000, revoked_at: 7000 },
  ]);
  assert.deepEqual(log["revoke all"], { value: 1 });
  assert.deepEqual(log["revoke all again"], { value: 0 });
  assert.deepEqual(log["revoke on wrong server"], { value: false });
  const page = (label: string) => (log[label] as { value: Message[] }).value.map(row => row.id);
  assert.deepEqual(page("conversation page 1"), ["m3b", "m3"]);
  assert.deepEqual(page("conversation page 2"), ["b1", "q1"]);
  assert.deepEqual(page("conversation page 3"), ["m1"]);
  assert.deepEqual(log["conversation activity"], { value: [{ channel: "c1", newest: 300 }, { channel: "c2", newest: 999 }] });
});

test("conversation event retention matches SQLite on Postgres", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const log = await sameOnBoth(async (store, step, backend) => {
    // Setup only: Postgres seeds rows in one statement, SQLite appends them one by one. Rows and stream IDs are the same.
    const seed = async (channel: string, count: number, createdAt: number) => {
      if (backend.kind === "sqlite") {
        for (let index = 0; index < count; index++) await store.appendConversationEvent({ server: PRUNE, channel, kind: "run.delta", ref: "run-1", data: {}, createdAt });
        return;
      }
      const client = new Client({ connectionString: backend.url, options: `-c search_path=${backend.schema},public` });
      await client.connect();
      try {
        await client.query("INSERT INTO conversation_events(server,channel,kind,ref,data,created_at) SELECT $1,$2,'run.delta','run-1','{}',$3 FROM generate_series(1,$4)", [PRUNE, channel, createdAt, count]);
      } finally {
        await client.end();
      }
    };
    // More than one delete batch (10000 rows) by age.
    await seed("old", 10500, 1000);
    await seed("new", 50, 9000);
    await step.step("prune by age", () => store.pruneConversationEvents(5000, 1_000_000_000));
    await step.step("old rows after age prune", () => store.conversationEventsAfter(PRUNE, "old", 0, 10));
    await step.step("recent rows after age prune", async () => (await store.conversationEventsAfter(PRUNE, "new", 0, 100_000)).length);
    // More than one delete batch by row cap.
    await seed("cap", 11500, 9000);
    await step.step("prune by row cap", () => store.pruneConversationEvents(0, 1000));
    await step.step("rows kept by cap", async () => (await store.conversationEventsAfter(PRUNE, "cap", 0, 100_000)).length);
    await step.step("oldest recent row after cap", () => store.oldestStreamId(PRUNE, "new"));
    await step.step("cap keeps newest stream ids", async () => {
      const latest = await store.latestStreamId(PRUNE, "cap");
      const oldest = await store.oldestStreamId(PRUNE, "cap");
      return { span: latest - (oldest ?? latest) + 1 };
    });
    await step.step("prune when nothing is over", () => store.pruneConversationEvents(0, 1000));
  });
  assert.deepEqual(log["prune by age"], { value: 10500 });
  assert.deepEqual(log["recent rows after age prune"], { value: 50 });
  assert.deepEqual(log["prune by row cap"], { value: 10550 });
  assert.deepEqual(log["rows kept by cap"], { value: 1000 });
  assert.deepEqual(log["oldest recent row after cap"], { value: undefined });
  assert.deepEqual(log["cap keeps newest stream ids"], { value: { span: 1000 } });
  assert.deepEqual(log["prune when nothing is over"], { value: 0 });
});

test("concurrent UserLimiter records from two Postgres instances add both charges", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const url = process.env.TEST_DATABASE_URL!;
  const schema = freshSchema();
  const first = await PostgresStore.connect(url, undefined, schema);
  const second = await PostgresStore.connect(url, undefined, schema);
  const cost = 2_500_000;
  const now = Date.now();
  const options = { fiveHourCostMicros: 1_000_000_000_000, weekCostMicros: 1_000_000_000_000, gracePercent: 0 };
  try {
    const limiterA = new UserLimiter(first, options);
    const limiterB = new UserLimiter(second, options);
    await Promise.all([limiterA.record(WEB, "racer", cost, now), limiterB.record(WEB, "racer", cost, now)]);
    const pair = await first.userUsage(WEB, "racer");
    assert.equal(pair.windows.find(row => row.kind === "5h")?.spent, 2 * cost);
    assert.equal(pair.windows.find(row => row.kind === "week")?.spent, 2 * cost);

    // A burst from both instances at once must not lose a charge.
    await Promise.all(Array.from({ length: 20 }, (_, index) => (index % 2 ? limiterA : limiterB).record(WEB, "racer", cost, now)));
    const burst = await second.userUsage(WEB, "racer");
    assert.equal(burst.windows.find(row => row.kind === "5h")?.spent, 22 * cost);
  } finally {
    await first.close();
    await second.close();
    await dropSchema(url, schema);
  }
});

test("conversation runs match SQLite on Postgres", { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const log = await sameOnBoth(async (store, step) => {
    const q1 = message({ id: "q1", authorName: "Alice", text: "What is up?", timestamp: 150 });
    const b1 = message({ id: "b1", author: "bot", isBot: true, authorName: "Slopbot", text: "Answer", timestamp: 200, replyTo: "q1" });
    const q2 = message({ id: "q2", authorName: "Alice", text: "And then?", timestamp: 300, replyTo: "b1" });
    const p1 = message({ id: "p1", authorName: "Carol", text: "Classified only", timestamp: 400 });
    const x1 = message({ id: "x1", channel: "c2", text: "Other channel", timestamp: 500 });
    for (const row of [q1, b1, q2, p1, x1]) await step.step(`ingest ${row.id}`, () => store.ingest(row));

    const reply = { prefixVersion: "v1", prefix: [], history: [], inputs: [], purpose: "reply" } as const;
    await step.step("start run 1", () => store.startRun("run-1", q1, reply));
    await step.step("sources run 1", () => store.recordSources("run-1", SHARES, ["q1"]));
    await step.step("link b1 to run 1", () => store.linkOutput(b1, "run-1", "q1"));
    // A participation classifier run has no purpose. It is not a conversation.
    await step.step("start classifier run", () => store.startRun("run-p", p1, { prefixVersion: "participation-v2", prefix: [], history: [], inputs: [] }));
    await step.step("sources classifier run", () => store.recordSources("run-p", SHARES, ["p1"]));
    await step.step("start run 2", () => store.startRun("run-2", q2, reply));
    await step.step("sources run 2", () => store.recordSources("run-2", SHARES, ["q2", "b1"]));
    await step.step("start other channel run", () => store.startRun("run-x", x1, reply));
    await step.step("sources other channel run", () => store.recordSources("run-x", SHARES, ["x1"]));

    await step.step("channel runs", () => store.channelRuns(SHARES, "c1"));
    await step.step("channel replies", async () => (await store.channelReplies(SHARES, "c1")).sort((a, b) => a.messageId.localeCompare(b.messageId) || a.runId.localeCompare(b.runId)));
    await step.step("channel sources", async () => (await store.channelSources(SHARES, "c1")).sort((a, b) => a.runId.localeCompare(b.runId) || a.messageId.localeCompare(b.messageId)));
    await step.step("messages by id", () => store.messagesById(SHARES, "c1", ["q2", "b1", "q1", "x1", "missing"]));
  });
  assert.deepEqual((log["channel runs"] as { value: { id: string }[] }).value.map(run => run.id), ["run-1", "run-2"]);
});
