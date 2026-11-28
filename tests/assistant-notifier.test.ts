import test from "node:test";
import assert from "node:assert/strict";
import { DiscordAssistantNotifier, type DmPayload } from "../src/clients/discord/assistant-notifier.js";
import type { AssistantStore } from "../src/assistant/store.js";
import type { ActivityItem, ApprovalRequest, AssistantSettings } from "../src/assistant/types.js";
import { ToolError } from "../src/errors.js";

const CONSOLE = "https://console.example";
const DAY = Date.UTC(2026, 10, 27, 10, 0);

const settings = (over: Partial<AssistantSettings> = {}): AssistantSettings => ({
  user: "u1", enabled: true, briefCron: null, timezone: "UTC", dmUpdates: true, quietStart: null, quietEnd: null, updated: 0, ...over,
});
const item = (over: Partial<ActivityItem> = {}): ActivityItem => ({
  id: "a1", owner: "u1", task: "t1", kind: "approval", text: "Wants to send a mail.", ref: null, createdAt: DAY, readAt: null, ...over,
});
const approvalFor = (over: Partial<ApprovalRequest> = {}): ApprovalRequest => ({
  id: "ap1", owner: "u1", task: "t1", run: "r1", tool: "mail_send", input: {}, summary: "Send a mail", status: "pending",
  result: null, createdAt: DAY, decidedAt: null, expiresAt: DAY + 86_400_000, ...over,
});

/** In-memory settings and approvals, plus a gate that decides each approval once, like the real one. */
function world(s: AssistantSettings, approvals: ApprovalRequest[] = []) {
  const byId = new Map(approvals.map(a => [a.id, { ...a }]));
  const ran: string[] = [];
  const decide = (id: string, status: ApprovalRequest["status"]) => {
    const a = byId.get(id);
    if (!a || a.status !== "pending") throw new ToolError("Already decided.");
    a.status = status;
    return a;
  };
  const store = { settings: async () => s, approval: async (id: string) => byId.get(id) } as Pick<AssistantStore, "settings" | "approval">;
  const gate = {
    execute: async (id: string) => { ran.push(decide(id, "approved").tool); return "ok"; },
    deny: async (id: string) => { decide(id, "denied"); },
  };
  return { store, gate, ran };
}

/** Records every DM sent. */
function outbox() {
  const sent: { user: string; payload: DmPayload }[] = [];
  const send = async (user: string, payload: DmPayload) => { sent.push({ user, payload }); };
  return { sent, send };
}

function clickReply() {
  const updates: string[] = [];
  const ephemerals: string[] = [];
  return {
    updates, ephemerals,
    reply: { update: async (c: string) => { updates.push(c); }, ephemeral: async (c: string) => { ephemerals.push(c); } },
  };
}

test("dm sent with buttons", async () => {
  const { store, gate } = world(settings(), [approvalFor()]);
  const box = outbox();
  const notifier = new DiscordAssistantNotifier({ store, send: box.send, consoleUrl: CONSOLE, gate, now: () => DAY });
  await notifier.notify(item(), approvalFor());

  assert.equal(box.sent.length, 1);
  assert.equal(box.sent[0]!.user, "u1");
  assert.equal(box.sent[0]!.payload.content, `Wants to send a mail.\n${CONSOLE}/assistant/task/t1`);
  assert.deepEqual(box.sent[0]!.payload.allowedMentions, { parse: [] });
  const rows = JSON.parse(JSON.stringify(box.sent[0]!.payload.components)) as { components: { custom_id: string; label: string }[] }[];
  assert.deepEqual(rows[0]!.components.map(b => [b.label, b.custom_id]), [
    ["Approve", "assistant:approve:ap1"],
    ["Deny", "assistant:deny:ap1"],
    ["Always allow", "assistant:always:ap1"],
  ]);
});

test("dm off no dm", async () => {
  const { store, gate } = world(settings({ dmUpdates: false }));
  const box = outbox();
  await new DiscordAssistantNotifier({ store, send: box.send, consoleUrl: CONSOLE, gate, now: () => DAY }).notify(item());
  assert.equal(box.sent.length, 0);
});

test("quiet hours no dm", async () => {
  // 23:30 in Berlin (22:30 UTC) is inside 22:00 to 07:00.
  const { store, gate } = world(settings({ timezone: "Europe/Berlin", quietStart: "22:00", quietEnd: "07:00" }));
  const box = outbox();
  await new DiscordAssistantNotifier({ store, send: box.send, consoleUrl: CONSOLE, gate, now: () => Date.UTC(2026, 10, 27, 22, 30) }).notify(item());
  assert.equal(box.sent.length, 0);
});

test("quiet hours wrap midnight", async () => {
  const s = settings({ quietStart: "22:00", quietEnd: "07:00" });
  const at = (hour: number, minute: number) => Date.UTC(2026, 10, 27, hour, minute);
  const sentAt = async (now: number) => {
    const { store, gate } = world(s);
    const box = outbox();
    await new DiscordAssistantNotifier({ store, send: box.send, consoleUrl: CONSOLE, gate, now: () => now }).notify(item());
    return box.sent.length;
  };
  assert.equal(await sentAt(at(21, 59)), 1);
  assert.equal(await sentAt(at(22, 0)), 0);
  assert.equal(await sentAt(at(6, 59)), 0);
  assert.equal(await sentAt(at(7, 0)), 1);
});

test("non-owner click refused", async () => {
  const { store, gate, ran } = world(settings(), [approvalFor()]);
  const clicks = clickReply();
  const notifier = new DiscordAssistantNotifier({ store, send: outbox().send, consoleUrl: CONSOLE, gate, now: () => DAY });
  assert.equal(await notifier.handleButton("assistant:approve:ap1", "u2", clicks.reply), true);
  assert.deepEqual(clicks.ephemerals, ["Only the owner can decide."]);
  assert.deepEqual(clicks.updates, []);
  assert.deepEqual(ran, []);
});

test("double click executes once", async () => {
  const { store, gate, ran } = world(settings(), [approvalFor()]);
  const notifier = new DiscordAssistantNotifier({ store, send: outbox().send, consoleUrl: CONSOLE, gate, now: () => DAY });
  const first = clickReply();
  const second = clickReply();
  await notifier.handleButton("assistant:always:ap1", "u1", first.reply);
  await notifier.handleButton("assistant:always:ap1", "u1", second.reply);
  assert.deepEqual(ran, ["mail_send"]);
  assert.deepEqual(first.updates, ["Approved"]);
  assert.deepEqual(second.updates, ["Already decided."]);
});

test("dm failure logged once", async () => {
  const { store, gate } = world(settings());
  const failing = async () => { throw new Error("Cannot send messages to this user"); };
  const logged: unknown[] = [];
  let now = DAY;
  const notifier = new DiscordAssistantNotifier({
    store, send: failing, consoleUrl: CONSOLE, gate, now: () => now, log: (_event, error) => { logged.push(error); },
  });
  await notifier.notify(item());
  await notifier.notify(item());
  assert.equal(logged.length, 1);

  now = DAY + 86_400_000;
  await notifier.notify(item());
  assert.equal(logged.length, 2);
});

test("other button ids are not handled", async () => {
  const { store, gate } = world(settings());
  const notifier = new DiscordAssistantNotifier({ store, send: outbox().send, consoleUrl: CONSOLE, gate, now: () => DAY });
  assert.equal(await notifier.handleButton("slopstop:job1", "u1", clickReply().reply), false);
});
