import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ButtonInteraction } from 'discord.js';
import { handleConfirm, handleShowCode, postConfirmation, showCodeRows, type CodeStore } from '../src/adapters/discord-code.js';
import { codeBlock, codeFitsInline, PROGRAM_CODE_KEEP_MS, SHOW_CODE_INLINE_LINES, SHOW_CODE_MESSAGE_CHARS } from '../src/code-display.js';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import type { ToolContext, ConfirmationRequired } from '../src/tools.js';
import type { Json } from '../src/domain.js';

interface Saved { value: Json; revision: number }

function fakeStore(operations: Record<string, { name: string; args: Record<string, Json> }> = {}) {
  const records = new Map<string, Saved>();
  const store = {
    records,
    async record(server: string, kind: string, id: string) {
      const saved = records.get(`${server}:${kind}:${id}`);
      return saved ? { id, ...saved } : undefined;
    },
    async putRecord(server: string, kind: string, id: string, value: Json, expectedRevision: number) {
      const key = `${server}:${kind}:${id}`, current = records.get(key);
      if ((current?.revision ?? 0) !== expectedRevision) return false;
      records.set(key, { value, revision: (current?.revision ?? 0) + 1 });
      return true;
    },
    async operation(id: string) {
      const found = operations[id];
      return found ? { id, name: found.name, args: found.args, resource: null, status: 'done' as const, result: null } : undefined;
    },
    async pruneOperations() { return 0; },
  };
  return store;
}

function fakeInteraction(customId: string, userId = 'requester', channelId = 'channel') {
  const log: { method: string; payload?: unknown }[] = [];
  const interaction = {
    customId, id: 'interaction-1', guildId: 'server', channelId, user: { id: userId },
    reply: async (payload: unknown) => { log.push({ method: 'reply', payload }); },
    deferUpdate: async () => { log.push({ method: 'deferUpdate' }); },
    update: async (payload: unknown) => { log.push({ method: 'update', payload }); },
    editReply: async (payload: unknown) => { log.push({ method: 'editReply', payload }); },
    followUp: async (payload: unknown) => { log.push({ method: 'followUp', payload }); },
  };
  return { interaction: interaction as unknown as ButtonInteraction, log };
}

const pendingRecord = { name: 'channels', arguments: { action: 'remove', channel: '12345678901234567' }, parentOperationId: 'parent', channel: 'channel', author: 'requester', createdAt: 1 };

test('show code replies ephemerally with the program code in a js block', async () => {
  const store = fakeStore({ parent: { name: 'run_tools_code', args: { code: 'text("hi")' } } });
  const { interaction, log } = fakeInteraction('slopcode:parent');
  await handleShowCode(interaction, store as unknown as CodeStore);
  const reply = log[0]!.payload as { content: string; flags: number };
  assert.equal(reply.content, '```js\ntext("hi")\n```');
  assert.equal(reply.flags, 64);
});

test('long program code is attached as program.js', async () => {
  const code = 'x'.repeat(SHOW_CODE_MESSAGE_CHARS + 1);
  const store = fakeStore({ parent: { name: 'run_tools_code', args: { code } } });
  const { interaction, log } = fakeInteraction('slopcode:parent');
  await handleShowCode(interaction, store as unknown as CodeStore);
  const reply = log[0]!.payload as { files: { name: string; attachment: Buffer }[] };
  assert.equal(reply.files[0]!.name, 'program.js');
  assert.equal(reply.files[0]!.attachment.toString('utf8'), code);
});

test('show code says the code is gone when the operation is missing or not a code run', async () => {
  const store = fakeStore({ other: { name: 'web_search', args: { query: 'x' } } });
  for (const id of ['missing', 'other']) {
    const { interaction, log } = fakeInteraction(`slopcode:${id}`);
    await handleShowCode(interaction, store as unknown as CodeStore);
    assert.equal((log[0]!.payload as { content: string }).content, 'This code is no longer kept.');
  }
});

test('confirm rejects a click from anyone but the requester and keeps the record pending', async () => {
  const store = fakeStore();
  store.records.set('server:tool-confirm:op1', { value: pendingRecord, revision: 1 });
  let ran = false;
  const tools = { invokeResult: async () => { ran = true; return { text: 'done' }; } };
  const { interaction, log } = fakeInteraction('slopconfirm:op1:yes', 'someone-else');
  await handleConfirm(interaction, store as unknown as CodeStore, tools as never);
  assert.equal(ran, false);
  assert.equal(log[1]!.method, 'followUp');
  assert.equal(store.records.get('server:tool-confirm:op1')!.revision, 1);
});

test('confirm runs the saved call once with its operation ID, and a second click does nothing', async () => {
  const store = fakeStore();
  store.records.set('server:tool-confirm:op1', { value: pendingRecord, revision: 1 });
  const calls: unknown[][] = [];
  const tools = { invokeResult: async (...args: unknown[]) => { calls.push(args); return { text: 'Channel removed.' }; } };
  const first = fakeInteraction('slopconfirm:op1:yes');
  await handleConfirm(first.interaction, store as unknown as CodeStore, tools as never);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]![1], 'channels');
  assert.deepEqual(calls[0]![2], pendingRecord.arguments);
  assert.equal(calls[0]![3], 'op1');
  assert.match((first.log.at(-1)!.payload as { content: string }).content, /Confirmed channels\.\nChannel removed\./);
  const second = fakeInteraction('slopconfirm:op1:yes');
  await handleConfirm(second.interaction, store as unknown as CodeStore, tools as never);
  assert.equal(calls.length, 1);
  assert.equal(second.log[1]!.method, 'followUp');
});

test('cancel ends the record and never runs the call', async () => {
  const store = fakeStore();
  store.records.set('server:tool-confirm:op1', { value: pendingRecord, revision: 1 });
  let ran = false;
  const tools = { invokeResult: async () => { ran = true; return { text: 'x' }; } };
  const { interaction, log } = fakeInteraction('slopconfirm:op1:no');
  await handleConfirm(interaction, store as unknown as CodeStore, tools as never);
  assert.equal(ran, false);
  assert.deepEqual(store.records.get('server:tool-confirm:op1')!.value, { done: true });
  assert.equal((log.at(-1)!.payload as { content: string }).content, 'Cancelled.');
});

test('confirm message shows the call, arguments in a json block, and Confirm and Cancel buttons', async () => {
  const sent: any[] = [];
  const call: ConfirmationRequired['call'] = { name: 'usage', arguments: { action: 'reset', user: 'x'.repeat(2000) }, operationId: 'op2', parentOperationId: 'parent' };
  await postConfirmation({ send: async payload => { sent.push(payload); return {}; } }, call, 'requester');
  const row = sent[0].components[0].toJSON();
  assert.deepEqual(row.components.map((button: { custom_id: string }) => button.custom_id), ['slopconfirm:op2:yes', 'slopconfirm:op2:no']);
  assert.match(sent[0].content, /\*\*usage\*\*/);
  assert.ok(sent[0].content.length <= 2000);
  assert.deepEqual(sent[0].allowedMentions, { users: ['requester'] });
});

test('show code buttons appear for summary runs and for full runs with long code only', () => {
  const short = { id: 'a', name: 'run_tools_code', status: 'completed' as const, code: 'text(1)' };
  const long = { id: 'b', name: 'run_tools_code', status: 'completed' as const, code: 'x\n'.repeat(SHOW_CODE_INLINE_LINES + 1) };
  assert.equal(showCodeRows([short], 'full').length, 0);
  assert.equal(showCodeRows([short], 'summary').length, 1);
  assert.equal(showCodeRows([short, long], 'full').length, 1);
  assert.equal(showCodeRows([short, long], 'none').length, 0);
});

test('code fits inline by line count and length, and the fence grows past backtick runs in the code', () => {
  assert.equal(codeFitsInline('a\n'.repeat(SHOW_CODE_INLINE_LINES - 1)), true);
  assert.equal(codeFitsInline('a\n'.repeat(SHOW_CODE_INLINE_LINES)), false);
  assert.equal(codeFitsInline('x'.repeat(SHOW_CODE_MESSAGE_CHARS + 1)), false);
  assert.equal(codeBlock('a ``` b').startsWith('````js\n'), true);
});

test('program code keeps 14 days', () => {
  assert.equal(PROGRAM_CODE_KEEP_MS, 14 * 24 * 60 * 60 * 1000);
});

test('prune deletes finished run_tools_code operations older than the cutoff and keeps started ones', async () => {
  const store = new SQLiteStore();
  const context = (id: string, name: string): ToolContext => ({
    message: { server: 's', channel: 'c', id: 'm', author: 'a', text: 't' }, operationId: id, isAdmin: false, source: 'agent', toolName: name, arguments: {}, resource: null, assertActive: async () => {},
  });
  store.beginOperation(context('old-done', 'run_tools_code'), 'run_tools_code', { code: 'a' });
  store.endOperation('old-done', '{}');
  store.beginOperation(context('old-started', 'run_tools_code'), 'run_tools_code', { code: 'b' });
  store.beginOperation(context('other', 'web_search'), 'web_search', { query: 'q' });
  store.endOperation('other', '{}');
  const deleted = await store.pruneOperations('run_tools_code', Date.now() + 1000);
  assert.equal(deleted, 1);
  assert.equal(store.operation('old-done'), undefined);
  assert.ok(store.operation('old-started'));
  assert.ok(store.operation('other'));
});
