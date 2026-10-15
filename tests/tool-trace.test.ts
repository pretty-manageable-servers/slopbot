import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { ButtonInteraction } from 'discord.js';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { handleToolTrace } from '../src/adapters/discord-tool-trace.js';
import { showCodeRows } from '../src/adapters/discord-code.js';
import { TOOL_TRACE_KIND, TOOL_TRACE_CURSOR_KIND, saveToolTrace, pruneToolTraces, tracePage, type ToolTrace } from '../src/tool-trace.js';
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

test('one entry point covers eleven programs and their children without repeated inline code', () => {
  const activity: ToolActivity[] = Array.from({ length: 11 }, (_, index) => ({ id: `program${index}`, name: 'run_tools_code', status: 'completed', code: 'return 1' }));
  activity.push({ id: 'child', parentId: 'program0', name: 'read', status: 'completed' });
  for (const mode of ['summary', 'full'] as const) {
    const rows = showCodeRows(activity, mode, 'trace');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.toJSON().components.length, 1);
    assert.equal((rows[0]!.toJSON().components[0] as { custom_id: string }).custom_id, 'sloptrace:trace');
  }
  assert.deepEqual(showCodeRows(activity, 'none'), []);
});

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

test('pager updates the same ephemeral response forwards and backwards using saved cursors', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  await store.putRecord('s', TOOL_TRACE_KIND, 'trace', sampleTrace() as unknown as Json, 0);
  const first = click('sloptrace:trace');
  let checks = 0;
  const authorize = async () => { checks++; };
  await handleToolTrace(first.interaction, store, authorize);
  assert.equal(first.events[0]!.payload.flags, 64);
  assert.match(first.last().content, /Tool run 1\/3: read · completed · 10 ms/);
  let buttons = first.last().components[0].toJSON().components;
  assert.equal(buttons[0].disabled, true);
  const second = click(buttons[1].custom_id);
  await handleToolTrace(second.interaction, store, authorize);
  assert.equal(second.events[0]!.method, 'deferUpdate');
  assert.match(second.last().content, /Tool run 2\/3: write · rejected · 20 ms/);
  assert.match(second.last().content, /- tool: read\n\+ tool: write/);
  assert.match(second.last().content, /- outcome: original\n\+ outcome: Permission denied/);
  assert.match(second.last().content, /\+ arguments: .*new/);
  buttons = second.last().components[0].toJSON().components;
  const back = click(buttons[0].custom_id);
  await handleToolTrace(back.interaction, store, authorize);
  assert.equal(back.last().content, first.last().content);
  const last = click(buttons[1].custom_id);
  await handleToolTrace(last.interaction, store, authorize);
  assert.match(last.last().content, /Tool run 3\/3: read · failed · 30 ms/);
  assert.equal(last.last().components[0].toJSON().components[1].disabled, true);
  assert.equal(checks, 4);
  assert.ok([first, second, back, last].every(page => page.events.every(event => event.method !== 'followUp')));
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

test('diff pages stay within Discord limits and show explicit truncation with inert fences', () => {
  const trace = sampleTrace();
  trace.steps[0]!.arguments = { code: '`'.repeat(5000) };
  trace.steps[0]!.outcome = 'x'.repeat(5000);
  trace.steps[1]!.arguments = { code: 'a'.repeat(5000) };
  trace.steps[1]!.outcome = 'y'.repeat(5000);
  for (const index of [0, 1]) {
    const page = tracePage(trace, index);
    assert.ok(page.length < 2000);
    assert.equal((page.match(/```/g) ?? []).length, 2);
    assert.match(page, /truncated/);
    assert.match(page, /\+ outcome:/);
  }
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


test('changes beyond the displayed excerpt still produce argument and outcome diffs', () => {
  const trace = sampleTrace();
  trace.steps[0]!.arguments = { text: 'a'.repeat(500) + 'old' };
  trace.steps[1]!.arguments = { text: 'a'.repeat(500) + 'new' };
  trace.steps[0]!.outcome = 'x'.repeat(500) + 'old';
  trace.steps[1]!.outcome = 'x'.repeat(500) + 'new';
  const page = tracePage(trace, 1);
  assert.match(page, /- arguments:/);
  assert.match(page, /\+ arguments:/);
  assert.match(page, /- outcome:/);
  assert.match(page, /\+ outcome:/);
});
