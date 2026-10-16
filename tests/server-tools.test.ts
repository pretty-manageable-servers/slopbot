import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { ToolRegistry, ToolError } from "../src/tools.js";
import { configuredChannels, registerServerTools } from "../src/server-tools.js";
import { loadConfig } from "../src/config.js";
import { HistoryImporter } from "../src/history.js";
import { buildToolCommands } from "../src/adapters/discord-commands.js";
import type { Message } from "../src/domain.js";
import type { ParticipationOptions } from '../src/participation.js';
import { ParticipationGate } from '../src/participation.js';

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

test("slash command schemas come directly from the registry and include an unlimited generic runner", t => {
  const f = setup(); t.after(() => f.store.close());
  const command = buildToolCommands(f.registry).toJSON();
  const names = command.options?.map(option => option.name) ?? [];
  for (const tool of f.registry.definitions()) assert.ok(names.includes(tool.name));
  assert.ok(names.includes("run"));
  for (let i = 0; i < 30; i++) f.registry.register({ name: `connector_${i}`, description: "Connector action", fields: { payload: { type: "json", description: "Structured payload", required: true } }, access: "admin", effect: "write", retrySafe: true, async execute() { return "done"; } });
  assert.equal(buildToolCommands(f.registry).toJSON().options?.length, 25);
  assert.ok(f.registry.catalog().includes("connector_29"));
  assert.deepEqual(f.registry.validate("connector_29", { payload: { items: [1, "a"], enabled: true } }), { payload: { items: [1, "a"], enabled: true } });
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

test("indexing status requests select the indexing read handler", t => {
  const f = setup(); t.after(() => f.store.close());
  assert.deepEqual(f.registry.suggest({ ...message, text: "hello slopbot check the status of the indexing" }), { name: "index", arguments: { action: "status" } });
  assert.deepEqual(f.registry.suggest({ ...message, text: `indexing progress in <#${other}>` }), { name: "index", arguments: { action: "status", channel: other } });
  assert.equal(f.registry.suggest({ ...message, text: "index the last 150 days" }), undefined);
});

test('large tool enums still produce valid slash commands without losing validation', t => {
 const f=setup();t.after(()=>f.store.close());const choices=Array.from({length:26},(_,i)=>'topic_'+i);
 f.registry.register({name:'large_enum',description:'Large enum',fields:{topic:{type:'string',description:'Topic',choices,required:true}},access:'member',effect:'read',retrySafe:true,async execute(){return 'done';}});
 assert.doesNotThrow(()=>buildToolCommands(f.registry).toJSON());
 assert.deepEqual(f.registry.validate('large_enum',{topic:'topic_25'}),{topic:'topic_25'});
 assert.throws(()=>f.registry.validate('large_enum',{topic:'unknown'}));
});


test('tool display modes persist, validate choices, and require server management', async t => {
  const f = setup(); t.after(() => f.store.close());
  for (const mode of ['none', 'summary', 'full']) {
    await f.registry.invoke(message, 'tool_display', {mode}, `display-${mode}`, 'command');
    assert.equal(f.store.setting(server, 'tool_display'), mode);
  }
  await assert.rejects(f.registry.invoke(message, 'tool_display', {mode:'invalid'}, 'invalid-display', 'command'));
  f.setAdmin(false);
  await assert.rejects(f.registry.invoke(message, 'tool_display', {mode:'none'}, 'denied-display', 'command'), /Manage Server/);
  assert.equal(f.store.setting(server, 'tool_display'), 'full');
});

test('calibration persists partial changes and requires server management permission', async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.registry.invoke(message, 'calibration', { action: 'set', addressed: 50, funny: 70 }, 'calibrate', 'command');
  assert.equal(f.participation.options.thresholds?.addressed, 0.5);
  assert.equal(f.participation.options.thresholds?.unsolicited, 0.9);
  assert.equal((f.store.setting(server, 'participation_thresholds') as { funny: number }).funny, 0.7);
  await assert.rejects(f.registry.invoke(message, 'calibration', { funny: 70 }, 'bad-calibration', 'command'), /action:set/);
  f.setAdmin(false);
  await assert.rejects(f.registry.invoke(message, 'calibration', { action: 'set', funny: 0 }, 'denied-calibration', 'command'), /Manage Server/);
});

test('why returns member-visible history with scores, cutoff snapshots and complex filters', async t => {
  const f = setup(); t.after(() => f.store.close());
  const gate = new ParticipationGate({ async classify() { return { respond: false, addressed: false, reason: 'scores', scores: { addressed: 0.591, respond: 0.822, funny: 0.772 } }; } }, { ...f.participation.options }, () => 0, f.store);
  for (let n = 0; n < 12; n++) { const item = { ...message, id: String(n), text: `hi slopbot ${n}`, timestamp: Date.parse('2026-10-13T18:00:00Z') + n * 1000 }; await f.store.ingest(item); await gate.decide(item, []); }
  f.setAdmin(false);
  const text = await f.registry.invoke(message, 'why', {}, 'why-last10', 'command');
  assert.match(text, /10 matching/); assert.match(text, /0.591 < 0.650/); assert.match(text, /0.822 < 0.900/);
  const filtered = await f.registry.invoke(message, 'why', { count: 100, after: '2026-10-13T18:00:02Z', before: '2026-10-13T18:00:06Z', query: 'Slopbot', author: 'alice' }, 'why-range', 'command');
  assert.match(filtered, /4 matching/);
  const exact = await f.registry.invoke(message, 'why', { message_id: '11' }, 'why-exact', 'command'); assert.match(exact, /1 matching/);
  await assert.rejects(f.registry.invoke(message, 'why', { after: 'yesterday' }, 'why-bad-date', 'command'), /ISO timestamps/);
  await assert.rejects(f.registry.invoke(message, 'why', { after: '2026-10-13T18:00:00Z', since_minutes: 10 }, 'why-conflict', 'command'), /not both/);
  await assert.rejects(f.registry.invoke(message, 'why', { channel: other }, 'why-denied', 'command'), /not configured/);
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
