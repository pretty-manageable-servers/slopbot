import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { ToolRegistry, ToolError } from "../src/tools.js";
import { configuredChannels, registerServerTools } from "../src/server-tools.js";
import { loadConfig } from "../src/config.js";
import { HistoryImporter } from "../src/history.js";
import type { Message } from "../src/domain.js";
import type { ParticipationOptions } from '../src/participation.js';

const server = "12345678901234567", channel = "12345678901234568", other = "12345678901234569";
const config = loadConfig({ DISCORD_BOT_TOKEN: "test", DISCORD_GUILD_ID: server, DISCORD_CHANNEL_IDS: channel, LLM_MODE: "mock" });
const message: Message = { id: "1", server, channel, author: "alice", text: "request", timestamp: Date.now() };

test('memory tools save structured memes without sources, search, update and reject stale cached content', async t => {
  const f = setup(); t.after(() => f.store.close());
  const args = { text: 'Confused reaction', category: 'meme', tags: ['confusion'], details: { media_url: 'https://example.com/reaction.gif', media_type: 'gif', when_to_use: 'awkward silence' } };
  const saved = await f.registry.invokeResult(message, 'memory_remember', args, 'save-meme', 'agent');
  const note = saved.data as { id: string; revision: number; sourceIds: string[] };
  assert.deepEqual(note.sourceIds, []);
  await f.registry.invokeResult(message, 'memory_remember', args, 'save-meme', 'agent');
  assert.equal((await f.store.memories(server, channel)).length, 1);
  const found = await f.registry.invokeResult(message, 'memory', { category: 'meme', query: 'awkward', tags: ['confusion'], limit: 1 }, 'find-meme', 'agent');
  assert.match(found.text, /awkward silence/);
  assert.equal((found.data as { total: number }).total, 1);
  await assert.rejects(f.registry.invokeResult(message, 'memory_remember', { text: 'invalid', category: 'fact', details: { media_type: 'gif' } }, 'invalid', 'agent'), /Unsupported fact detail/);
  await assert.rejects(f.registry.invokeResult(message, 'memory_update', { id: note.id, expected_revision: 1 }, 'empty-patch', 'agent'), /at least one/);
  const updated = await f.registry.invokeResult(message, 'memory_update', { id: note.id, expected_revision: 1, text: 'Celebration', tags: [], details: {} }, 'edit-meme', 'agent');
  assert.equal((updated.data as { revision: number }).revision, 2);
  await f.registry.invokeResult(message, 'memory_update', { id: note.id, expected_revision: 1, text: 'Celebration', tags: [], details: {} }, 'edit-meme', 'agent');
  await assert.rejects(f.registry.invokeResult(message, 'memory_update', { id: note.id, expected_revision: 1, text: 'stale' }, 'stale-edit', 'agent'), /Memory changed/);
  await assert.rejects(f.registry.invokeResult(message, 'memory', { category: 'meme', query: 'awkward', tags: ['confusion'], limit: 1 }, 'find-meme', 'agent'), /Memory result changed/);
  await f.registry.invokeResult(message, 'memory_forget', { id: note.id }, 'forget-meme', 'agent');
  await assert.rejects(f.registry.invokeResult(message, 'memory_remember', args, 'save-meme', 'agent'), /Memory result changed/);
  assert.equal((await f.store.memories(server, channel)).length, 0);
});

test("timing footer setting persists and requires server management permission", async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.registry.invoke(message, "timing", { enabled: true }, "timing-on", "command");
  assert.equal(f.store.setting(server, "timing_footer"), true);
  f.setAdmin(false);
  await assert.rejects(f.registry.invoke(message, "timing", { enabled: false }, "timing-off", "agent"), /Manage Server/);
  assert.equal(f.store.setting(server, "timing_footer"), true);
});

function setup() {
  const store = new SQLiteStore();
  let channels = configuredChannels(config, store, server), admin = true;
  const history = new HistoryImporter(server, store, { async fetch() { return []; } });
  const registry = new ToolRegistry(store, async () => admin);
  const participation = { options: { enabled: true, contextMessages: 8, cooldownMs: 60000, maxUnsolicitedPerHour: 3 } as ParticipationOptions, diagnostics: new Map<string, string>() };
  registerServerTools(registry, { config, server, store, participation, history, channels: () => channels,
    setChannels(value) { channels = value; }, async validateChannel(_message, id) { if (![channel, other].includes(id)) throw new ToolError("Cannot view channel"); },
    async findChannels() { return "chat: " + channel; },
    accepts: id => channels.includes(id), setReplyContext() {}, originMessage: value => value,
    async startTask() { return other; }, async reconcileTask() { return undefined; }, wakeWorker() {}, async isTeamEditor() { return false; },
  });
  return { store, history, registry, participation, channels: () => channels, setAdmin(value: boolean) { admin = value; } };
}

test("channel changes persist and bot calls use the same handler and admin checks as commands", async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.registry.invoke(message, "channels", { action: "add", channel: other }, "add", "agent");
  assert.deepEqual(f.channels(), [channel, other]);
  assert.deepEqual(configuredChannels(config, f.store, server), [channel, other]);
  await f.registry.invoke(message, "channels", { action: "remove", channel: channel }, "remove", "command");
  assert.deepEqual(configuredChannels(config, f.store, server), [other]);
  f.setAdmin(false);
  await assert.rejects(f.registry.invoke(message, "cooldown", { seconds: 120, per_hour: 5 }, "cooldown", "agent"), /Manage Server/);
  assert.equal(f.participation.options.cooldownMs, 60000);
});

test('parent memory listings link accessible task scopes without exposing their contents', async t => {
  const f = setup(); t.after(() => f.store.close());
  const threadMessage = { ...message, channel: other, id: 'thread-memory-source' };
  await f.store.ingest(threadMessage); await f.store.registerTask(server, other, channel);
  await f.store.remember(threadMessage, 'thread-only content');
  const result = await f.registry.invoke(message, 'memory', {}, 'scoped-list', 'command');
  assert.match(result, new RegExp(`separate task-thread scope <#${other}>`)); assert.ok(!result.includes('thread-only content'));
  const hidden = { ...message, channel: 'hidden-thread', id: 'hidden-memory-source' };
  await f.store.ingest(hidden); await f.store.registerTask(server, hidden.channel, channel); await f.store.remember(hidden, 'private');
  const filtered = await f.registry.invoke(message, 'memory', {}, 'filtered-scoped-list', 'command');
  assert.ok(!filtered.includes('hidden-thread')); assert.ok(!filtered.includes('private'));
});

test("read-only index and channel actions do not require a task thread; memory ownership is enforced", async t => {
  const f = setup(); t.after(() => f.store.close());
  assert.equal(f.registry.effect("index", { action: "status" }), "read");
  assert.equal(f.registry.effect("index", { action: "more" }), "write");
  assert.equal(f.registry.effect("channels", { action: "list" }), "read");
  await f.store.ingest(message);
  const saved = await f.store.remember(message, "budget is 200");
  f.setAdmin(false);
  const result = await f.registry.invoke({ ...message, author: "bob" }, "memory_forget", { id: saved.id }, "forget", "agent");
  assert.ok(result.includes("owned by you"));
  assert.equal((await f.store.memories(server, channel)).length, 1);
});

test("removing a scope purges searchable content and cancels its queued jobs without deleting reasoning", async t => {
  const f = setup(); t.after(() => f.store.close());
  f.store.enqueueJob(message);
  await f.store.startRun("run", message, { prefixVersion: "v1", prefix: [], history: [], inputs: [] });
  await f.store.appendEvent("run", 0, { kind: "reasoning", payload: { delta: "retain" } });
  f.store.purgeUnconfigured(server, []);
  assert.equal(f.store.indexStats(server, channel).messages, 0);
  assert.equal(f.store.jobs(server, channel)[0]?.status, "cancelled");
  assert.deepEqual(f.store.events("run"), [{ kind: "reasoning", payload: { delta: "retain" } }]);
});

test("memory tools run inline and channel removal needs Confirm, other channel actions do not", t => {
  const f = setup(); t.after(() => f.store.close());
  for (const name of ["memory_remember", "memory_forget"]) assert.equal(f.registry.requiresThread(name, { text: "x", id: "x" }), false, name);
  const channelsTool = f.registry.definitions().find(tool => tool.name === "channels");
  assert.equal(channelsTool?.confirm?.({ action: "remove", channel }), true);
  assert.equal(channelsTool?.confirm?.({ action: "add", channel }), false);
  assert.equal(channelsTool?.confirm?.({ action: "list" }), false);
  assert.equal(channelsTool?.confirm?.({}), false);
});
