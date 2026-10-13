import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { ToolRegistry, ToolError } from "../src/tools.js";
import { configuredChannels, registerServerTools } from "../src/server-tools.js";
import { loadConfig } from "../src/config.js";
import { HistoryImporter } from "../src/history.js";
import { buildToolCommands } from "../src/adapters/discord-commands.js";
import type { Message } from "../src/domain.js";

const server = "12345678901234567", channel = "12345678901234568", other = "12345678901234569";
const config = loadConfig({ DISCORD_BOT_TOKEN: "test", DISCORD_GUILD_ID: server, DISCORD_CHANNEL_IDS: channel, LLM_MODE: "mock" });
const message: Message = { id: "1", server, channel, author: "alice", text: "request", timestamp: Date.now() };

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
  let channels = configuredChannels(config, store), admin = true;
  const history = new HistoryImporter(server, store, { async fetch() { return []; } });
  const registry = new ToolRegistry(store, async () => admin);
  const participation = { options: { enabled: true, contextMessages: 8, cooldownMs: 60000, maxUnsolicitedPerHour: 3 }, diagnostics: new Map<string, string>() };
  registerServerTools(registry, { config, store, participation, history, channels: () => channels,
    setChannels(value) { channels = value; }, async validateChannel(_message, id) { if (![channel, other].includes(id)) throw new ToolError("Cannot view channel"); },
    async findChannels() { return "chat: " + channel; },
    accepts: id => channels.includes(id), setReplyContext() {}, originMessage: value => value,
    async startTask() { return other; }, async reconcileTask() { return undefined; }, wakeWorker() {},
  });
  return { store, history, registry, participation, channels: () => channels, setAdmin(value: boolean) { admin = value; } };
}

test("channel changes persist and bot calls use the same handler and admin checks as commands", async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.registry.invoke(message, "channels", { action: "add", channel: other }, "add", "agent");
  assert.deepEqual(f.channels(), [channel, other]);
  assert.deepEqual(configuredChannels(config, f.store), [channel, other]);
  await f.registry.invoke(message, "channels", { action: "remove", channel: channel }, "remove", "command");
  assert.deepEqual(configuredChannels(config, f.store), [other]);
  f.setAdmin(false);
  await assert.rejects(f.registry.invoke(message, "cooldown", { seconds: 120, per_hour: 5 }, "cooldown", "agent"), /Manage Server/);
  assert.equal(f.participation.options.cooldownMs, 60000);
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
