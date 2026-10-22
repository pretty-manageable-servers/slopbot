import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ButtonInteraction } from 'discord.js';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { handleToolTrace } from '../src/adapters/discord-tool-trace.js';

import { TOOL_TRACE_KIND, TOOL_TRACE_CURSOR_KIND, saveToolTrace, pruneToolTraces, type ToolTrace } from '../src/tool-trace.js';
import { ToolRegistry } from '../src/tools.js';
import type { Json } from '../src/domain.js';
import type { ToolActivity } from '../src/tool-activity.js';

const request = { server: 's', channel: 'c', id: 'm', author: 'u', text: 'Do work' };
function click(customId: string, author = 'u', channel = 'c', server = 's') {
  const events: { method: string; payload?: any }[] = [];
  const interaction = {
    customId, guildId: server, channelId: channel, user: { id: author }, id: 'click',
    deferReply: async (payload: unknown) => { events.push({ method: 'deferReply', payload }); },
    deferUpdate: async () => { events.push({ method: 'deferUpdate' }); },
    editReply: async (payload: unknown) => { events.push({ method: 'editReply', payload }); },
  } as unknown as ButtonInteraction;
  return { interaction, events, last: () => events.at(-1)!.payload };
}
const allow = async () => {};
const sampleTrace = (): ToolTrace => ({ owner: 'u', channel: 'c', expires: Date.now() + 60000, steps: [
  { id: 'one', name: 'read', arguments: { path: 'a' }, status: 'completed', durationMs: 10, outcome: 'original' },
  { id: 'two', name: 'write', arguments: { path: 'a', text: 'new' }, status: 'rejected', durationMs: 20, outcome: 'Permission denied' },
  { id: 'three', name: 'read', arguments: { path: 'b' }, status: 'failed', durationMs: 30, outcome: 'Unavailable' },
] });

test('snapshot preserves chronological arguments and actual journal outcomes with redaction', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => false);
  registry.register({ name: 'read', description: 'Read', access: 'member', effect: 'read', retrySafe: true, fields: { password: { type: 'string', description: 'Password' } }, execute: async () => 'Result secret=github_pat_abcdefghijklmnop' });
  await registry.invokeResult(request, 'read', { password: 'private-input' }, 'early', 'agent');
  const activity: ToolActivity[] = [
    { id: 'late', name: 'write', status: 'rejected', arguments: { api_key: 'private-key' }, startedAt: 20, durationMs: 12, reason: 'Denied' },
    { id: 'early', name: 'read', status: 'completed', startedAt: 10, durationMs: 5 },
  ];
  const id = (await saveToolTrace(store, request, activity))!;
  const trace = (await store.record('s', TOOL_TRACE_KIND, id))!.value as unknown as ToolTrace;
  assert.deepEqual(trace.steps.map(step => step.id), ['early', 'late']);
  assert.deepEqual(trace.steps[0]!.arguments, { password: '[redacted]' });
  assert.match(trace.steps[0]!.outcome, /Result/);
  assert.doesNotMatch(JSON.stringify(trace), /private-input|private-key|github_pat_abcdefghijklmnop/);
  await saveToolTrace(store, request, [{ id: 'changed', name: 'read', status: 'completed' }]);
  assert.equal((await store.record('s', TOOL_TRACE_KIND, id))!.revision, 1);
});

test('pager rejects other readers, wrong channels, servers, revoked access and expired cursors', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  await store.putRecord('s', TOOL_TRACE_KIND, 'trace', sampleTrace() as unknown as Json, 0);
  for (const interaction of [click('sloptrace:trace', 'other'), click('sloptrace:trace', 'u', 'elsewhere'), click('sloptrace:trace', 'u', 'c', 'other-server')]) {
    await handleToolTrace(interaction.interaction, store, allow);
    assert.doesNotMatch(interaction.last().content, /original|Permission denied/);
    assert.deepEqual(interaction.last().components, []);
  }
  const denied = click('sloptrace:trace');
  await handleToolTrace(denied.interaction, store, async () => { throw new Error('Revoked'); });
  assert.match(denied.last().content, /no longer have access/);
  await store.putRecord('s', TOOL_TRACE_CURSOR_KIND, 'expired', { trace: 'trace', index: 1, actor: 'u', channel: 'c', expires: 1 }, 0);
  const expired = click('sloptracepage:expired');
  await handleToolTrace(expired.interaction, store, allow);
  assert.match(expired.last().content, /cursor expired/);
});

test('expired snapshots and cursors are scrubbed without reviving on delivery retry', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const id = (await saveToolTrace(store, request, [{ id: 'gone', name: 'read', status: 'completed', arguments: { path: 'private-path' } }]))!;
  await store.putRecord('s', TOOL_TRACE_CURSOR_KIND, 'old', { expires: 1, trace: id }, 0);
  await pruneToolTraces(store, 's', Date.now() + 15 * 86400000);
  assert.deepEqual((await store.record('s', TOOL_TRACE_KIND, id))!.value, { expired: true });
  assert.deepEqual((await store.record('s', TOOL_TRACE_CURSOR_KIND, 'old'))!.value, { expired: true });
  assert.equal(await saveToolTrace(store, request, [{ id: 'new', name: 'read', status: 'completed' }]), id);
  assert.deepEqual((await store.record('s', TOOL_TRACE_KIND, id))!.value, { expired: true });
});

test('DM tool traces use private scope and keep requester and channel checks', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const scope = { server: 's', channel: 'web:dm:123' };
  await store.putRecord('s', TOOL_TRACE_KIND, 'dm-trace', { ...sampleTrace(), channel: scope.channel } as unknown as Json, 0);
  const first = click('sloptrace:dm-trace', 'u', '123');
  Object.assign(first.interaction, { guildId: null });
  let authorized = '';
  await handleToolTrace(first.interaction, store, async message => { authorized = message.channel; }, scope);
  assert.equal(authorized, scope.channel);
  assert.match(first.last().content, /Tool run 1\/3/);
  const wrong = click('sloptrace:dm-trace', 'other', '123');
  Object.assign(wrong.interaction, { guildId: null });
  await handleToolTrace(wrong.interaction, store, allow, scope);
  assert.match(wrong.last().content, /belong to the requester/);
});
