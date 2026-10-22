import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ButtonInteraction } from 'discord.js';
import { handleConfirm, CONFIRM_RECORD, CONFIRM_TTL_MS, type CodeRunner, type CodeStore } from '../src/adapters/discord-code.js';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import type { Json, Message } from '../src/domain.js';
import { loadConfig } from '../src/config.js';
import { HistoryImporter } from '../src/history.js';
import { objectStorageTool } from '../src/object-storage.js';
import { runToolsCodeTool } from '../src/run-tools-code.js';
import { configuredChannels, registerServerTools } from '../src/server-tools.js';
import { registerUsageTool } from '../src/usage-tools.js';
import type { UserLimiter } from '../src/user-limiter.js';
import { ToolError, ToolRegistry, UncertainActionError, type ToolDefinition, type ToolJournal, type ToolOperation, type ToolResult } from '../src/tools.js';
import type { ParticipationOptions } from '../src/participation.js';

const server = '12345678901234567', channel = '12345678901234568';
const request: Message = { server, channel, id: 'm1', author: 'alice', text: 'Tidy the channels.' };
const writeTool = (name: string, extra: Partial<ToolDefinition>): ToolDefinition =>
  ({ name, description: 'Write.', fields: {}, access: 'member', effect: 'write', retrySafe: false, execute: async () => ({ text: 'ok' }), ...extra });

/** An in-memory journal with the ToolJournal shape. Operations keep their start time, so a test can move the clock. */
function memoryJournal() {
  const rows = new Map<string, ToolOperation & { createdAt: number }>();
  const journal: ToolJournal = {
    operation: id => rows.get(id),
    blockingOperation: (resource, except) => {
      const row = [...rows.values()].find(item => item.resource === resource && item.id !== except && item.status === 'started');
      return row ? { id: row.id, startedAt: row.createdAt } : undefined;
    },
    expireOperations: (resource, before, except, result) => {
      for (const row of rows.values()) if (row.resource === resource && row.id !== except && row.status === 'started' && row.createdAt < before) Object.assign(row, { status: 'failed', result });
    },
    beginOperation: (context, name, args) => { rows.set(context.operationId, { id: context.operationId, name, args, resource: context.resource, status: 'started', result: null, createdAt: Date.now() }); },
    endOperation: (id, result, failed) => { Object.assign(rows.get(id)!, { status: failed ? 'failed' : 'done', result }); },
  };
  return { rows, journal };
}

function fakeStore() {
  const records = new Map<string, { value: Json; revision: number }>();
  return {
    records,
    async record(serverId: string, kind: string, id: string) { const saved = records.get(`${serverId}:${kind}:${id}`); return saved ? { id, ...saved } : undefined; },
    async putRecord(serverId: string, kind: string, id: string, value: Json, expectedRevision: number) {
      const key = `${serverId}:${kind}:${id}`, current = records.get(key);
      if ((current?.revision ?? 0) !== expectedRevision) return false;
      records.set(key, { value, revision: (current?.revision ?? 0) + 1 });
      return true;
    },
    async operation() { return undefined; },
    async pruneOperations() { return 0; },
  };
}

function clickFixture(createdAt: number, customId = 'slopconfirm:op1:yes') {
  const store = fakeStore();
  store.records.set(`${server}:${CONFIRM_RECORD}:op1`, { revision: 1, value: { name: 'channels', arguments: { action: 'remove', channel: '12345678901234567' }, parentOperationId: 'parent', channel, author: 'alice', requestId: 'm1', createdAt } });
  const payloads: { method: string; payload: { content?: string; components?: { toJSON(): { components: { disabled?: boolean }[] } }[] } }[] = [];
  const interaction = {
    customId, id: 'click-1', guildId: server, channelId: channel, user: { id: 'alice' },
    deferUpdate: async () => {},
    editReply: async (payload: unknown) => { payloads.push({ method: 'editReply', payload: payload as never }); },
    followUp: async (payload: unknown) => { payloads.push({ method: 'followUp', payload: payload as never }); },
  } as unknown as ButtonInteraction;
  return { store, interaction, payloads };
}

test('confirm_only_for_channels_remove', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  const config = loadConfig({ DISCORD_BOT_TOKEN: 'test', DISCORD_GUILD_ID: server, DISCORD_CHANNEL_IDS: channel, LLM_MODE: 'mock' });
  let channels = configuredChannels(config, store, server);
  const participation = { options: { enabled: true, contextMessages: 8, cooldownMs: 60000, maxUnsolicitedPerHour: 3 } as ParticipationOptions, diagnostics: new Map<string, string>() };
  registerServerTools(registry, { config, server, store, participation, history: new HistoryImporter(server, store, { async fetch() { return []; } }), channels: () => channels,
    setChannels(value: string[]) { channels = value; }, async validateChannel() {}, async findChannels() { return ''; }, accepts: () => true, setReplyContext() {}, originMessage: (value: Message) => value,
    async startTask() { return channel; }, async reconcileTask() { return undefined; }, wakeWorker() {}, async isTeamEditor() { return false; } } as never);
  registerUsageTool(registry, {} as UserLimiter);
  registry.register(objectStorageTool({ storage: {} as never, authorize: async () => {}, resolveAttachment: async () => { throw new Error('unused'); }, inspect: async () => '', send: async () => {} }));
  assert.deepEqual(registry.definitions().filter(tool => tool.confirm).map(tool => tool.name), ['channels']);
  const channelsTool = registry.definitions().find(tool => tool.name === 'channels')!;
  assert.equal(channelsTool.confirm!({ action: 'remove', channel }), true);
  assert.equal(channelsTool.confirm!({ action: 'list' }), false);
});

test('failed_check_returns_before_confirm', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const saved = new Map<string, Json>(); let executed = 0;
  const registry = new ToolRegistry(store, async () => true);
  registry.register(writeTool('remove', { retrySafe: true, fields: { id: { type: 'string', description: 'Id', required: true } }, confirm: () => true,
    authorize: async () => { throw new ToolError('Channel is not monitored.'); }, execute: async () => { executed++; return { text: 'removed' }; } }));
  registry.register(runToolsCodeTool(registry, { confirmations: { record: async (_server, id) => saved.get(id), save: async (_server, id, value) => { saved.set(id, value); } } }));
  const result = await registry.invokeResult(request, 'run_tools_code', { code: 'try { await tools.remove({ id: "c1" }); } catch (error) { text("caught"); } return "done";' }, 'check-run', 'agent');
  assert.equal(saved.size, 0);
  assert.equal(executed, 0);
  const data = result.data as { confirmation?: unknown; failures: { name: string; error: string }[] };
  assert.equal(data.confirmation, undefined);
  assert.equal(data.failures[0]?.name, 'remove');
  assert.match(data.failures[0]!.error, /not monitored/);
});

test('confirmed_failure_starts_model_turn', async () => {
  const { store, interaction, payloads } = clickFixture(Date.now());
  const resumed: Message[] = [];
  const tools = { invokeResult: async () => { throw new ToolError('Channel access denied'); } } as unknown as CodeRunner;
  await handleConfirm(interaction, store as unknown as CodeStore, tools, undefined, async note => { resumed.push(note); });
  assert.equal(resumed.length, 1);
  assert.equal(resumed[0]!.text, 'Confirmed channels failed: Channel access denied');
  assert.equal(resumed[0]!.channel, channel);
  assert.equal(resumed[0]!.author, 'alice');
  assert.equal(resumed[0]!.addressed, true);
  // The channel shows no error text and no "still pending".
  assert.equal(payloads.at(-1)!.payload.content, 'Confirmed.');
});

test('program_keeps_work_when_confirm_needed', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const saved = new Map<string, Json>(); let removed = 0;
  const registry = new ToolRegistry(store, async () => true);
  registry.register(writeTool('other', { retrySafe: true, effect: 'read', execute: async () => ({ text: 'other' }) }));
  registry.register(writeTool('remove', { retrySafe: true, fields: { id: { type: 'string', description: 'Id', required: true } }, confirm: () => true, execute: async () => { removed++; return { text: 'removed' }; } }));
  registry.register(runToolsCodeTool(registry, { confirmations: { record: async (_server, id) => saved.get(id), save: async (_server, id, value) => { saved.set(id, value); } } }));
  const result: ToolResult = await registry.invokeResult(request, 'run_tools_code', { code: 'const first = await tools.other({}); text("first:" + first.text); await tools.remove({ id: "c1" }); text("after");' }, 'keep-run', 'agent');
  assert.match(result.text, /first:other/);
  assert.match(result.text, /Waiting for Confirm on remove\./);
  assert.doesNotMatch(result.text, /after/);
  const data = result.data as { outputs: Json[]; confirmation: { name: string; operationId: string } };
  assert.deepEqual(data.outputs, ['first:other']);
  assert.equal(data.confirmation.name, 'remove');
  assert.equal(removed, 0);
});

test('confirm_expires_after_24h', async () => {
  const expired = clickFixture(Date.now() - CONFIRM_TTL_MS - 60_000);
  let invoked = 0;
  const tools = { invokeResult: async () => { invoked++; return { text: 'removed' }; } } as unknown as CodeRunner;
  await handleConfirm(expired.interaction, expired.store as unknown as CodeStore, tools);
  assert.equal(invoked, 0);
  const shown = expired.payloads.at(-1)!.payload;
  assert.match(shown.content!, /Expired/);
  assert.ok(shown.components![0]!.toJSON().components.every(button => button.disabled === true));
  // A record inside 24 hours still runs.
  const fresh = clickFixture(Date.now());
  await handleConfirm(fresh.interaction, fresh.store as unknown as CodeStore, tools);
  assert.equal(invoked, 1);
});

test('error_before_send_is_failed_not_uncertain', async () => {
  const { rows, journal } = memoryJournal();
  const registry = new ToolRegistry(journal, async () => true);
  registry.register(writeTool('upload', { resource: () => 'files:r1', execute: async () => { throw Object.assign(new Error('body must be a FormData created by this undici package instance'), { code: 'UND_ERR_INVALID_ARG' }); } }));
  registry.register(writeTool('send', { resource: () => 'files:r2', execute: async () => { throw new Error('socket hang up after the request was sent'); } }));
  await assert.rejects(registry.invokeResult(request, 'upload', {}, 'early', 'agent'), error => error instanceof ToolError && error.status === 'failed' && !(error instanceof UncertainActionError));
  assert.equal(rows.get('early')!.status, 'failed');
  // Nothing is left to block the resource, so the next call runs.
  await assert.rejects(registry.invokeResult(request, 'upload', {}, 'retry', 'agent'), error => error instanceof ToolError && error.status === 'failed');
  await assert.rejects(registry.invokeResult(request, 'send', {}, 'late', 'agent'), UncertainActionError);
  assert.equal(rows.get('late')!.status, 'started');
});

test('uncertain_lock_scoped_to_resource_and_expires', async t => {
  let now = 1_000_000_000;
  t.mock.method(Date, 'now', () => now);
  const { journal } = memoryJournal();
  const registry = new ToolRegistry(journal, async () => true);
  let attempts = 0, others = 0;
  registry.register(writeTool('file_write', { resource: () => 'files:r1', execute: async () => { attempts++; if (attempts === 1) throw new Error('connection reset'); return { text: 'written' }; } }));
  registry.register(writeTool('other_write', { resource: () => 'files:r2', execute: async () => { others++; return { text: 'other' }; } }));
  await assert.rejects(registry.invokeResult(request, 'file_write', {}, 'w1', 'agent'), error => error instanceof UncertainActionError && /This may have happened\. Check before you retry\. file_write operation w1 on files:r1/.test(error.message));
  // The same resource is blocked, and the notice names the operation and resource.
  await assert.rejects(registry.invokeResult(request, 'file_write', {}, 'w2', 'agent'), error => error instanceof ToolError && /Operation w1 on files:r1 started/.test(error.message));
  // Another resource is not blocked.
  assert.equal((await registry.invokeResult(request, 'other_write', {}, 'o1', 'agent')).text, 'other');
  assert.equal(others, 1);
  // After 10 minutes the lock expires, and the same resource can write again.
  now += 10 * 60 * 1000 + 1;
  assert.equal((await registry.invokeResult(request, 'file_write', {}, 'w3', 'agent')).text, 'written');
});

test('uncertain_job_does_not_block_shell', async () => {
  const { journal } = memoryJournal();
  const registry = new ToolRegistry(journal, async () => true);
  registry.register(writeTool('file_write', { resource: () => 'files:r1', execute: async () => { throw new Error('connection reset'); } }));
  registry.register(writeTool('shell', { resource: () => 'sandbox:s1', retrySafe: true, execute: async () => ({ text: 'exit 0' }) }));
  await assert.rejects(registry.invokeResult(request, 'file_write', {}, 'w1', 'agent'), UncertainActionError);
  // A channel-wide block would stop this. The uncertain action only blocks its own resource.
  assert.equal((await registry.invokeResult(request, 'shell', {}, 's1', 'agent')).text, 'exit 0');
  assert.equal((await registry.invokeResult(request, 'shell', {}, 's2', 'agent')).text, 'exit 0');
});
