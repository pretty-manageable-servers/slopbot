import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { Application } from '../src/application.js';
import { parseMessage } from '../src/domain.js';
import type { TestContext } from 'node:test';

const request = { server: 's', channel: 'c', id: 'request', author: 'person', text: 'Complete both reads', addressed: true };
const progress = { ...request, id: 'progress', author: 'bot', text: '**Working**\n1. `history_read`: running', isBot: true, transient: true };
function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'slopbot-context-test-')), filename = join(directory, 'store.sqlite3');
  const store = new SQLiteStore(filename);
  store.setSetting(request.server, "context_bot_author", "bot");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  const seedLegacyProgress = () => {
    const db = new DatabaseSync(filename);
    try { db.prepare('INSERT INTO messages(server,id,channel,body) VALUES(?,?,?,?)').run(progress.server, progress.id, progress.channel, JSON.stringify(progress, (key, value) => key === 'transient' ? undefined : value)); }
    finally { db.close(); }
  };
  return { store, seedLegacyProgress, filename };
}

test('transient progress is excluded from indexed conversation while normal bot answers remain', async t => {
  const { store } = setup(t);
  assert.equal(await store.ingest(progress), false);
  const answer = { ...progress, id: 'answer', text: 'The source-linked report is complete.', transient: false };
  assert.equal(await store.ingest(answer), true);
  assert.equal(await store.canonicalMessage('s', 'progress'), undefined);
});

test('message parsing retains the explicit transient-context boundary', () => {
  const parsed = parseMessage(progress);
  assert.ok('transient' in parsed && parsed.transient === true);
});

for (const action of ['edit', 'delete', 'reimport'] as const) test(`legacy progress ${action} preserves active tool rounds and context version`, async t => {
  const { store, seedLegacyProgress } = setup(t);
  await store.ingest(request); seedLegacyProgress();
  const turn = store.addAgentTurn(request, '', [{ name: 'history_read', arguments: {} }]);
  store.agentResult(turn.id, 0, { text: 'Original source evidence retained.' });
  const version = await store.contextVersion('s', 'c');
  if (action === 'edit') await store.revise({ ...progress, text: '**Working**\n1. `history_read`: completed' });
  if (action === 'delete') await store.remove('s', 'c', 'progress');
  if (action === 'reimport') await store.ingest(progress);
  assert.equal(await store.contextVersion('s', 'c'), version);
  assert.equal(store.agentTurns(request)[0]?.results['0'] !== undefined, true);
  assert.equal(await store.canonicalMessage('s', 'progress'), undefined);
});

test('a multi-tool batch survives background progress import and edits', async t => {
  const { store } = setup(t); let rounds = 0, calls = 0;
  const app = new Application(store, { async *stream() {
    yield ++rounds === 1 ? { kind: 'tool_call', payload: [{ name: 'read_one', arguments: {} }, { name: 'read_two', arguments: {} }] } : { kind: 'text', payload: { text: 'Both reads finished.' } };
  } }, { allowedChannels: [{ server: 's', channel: 'c' }] }, undefined, {
    tools: { catalog: () => '', execute: async () => { calls++; return 'Read finished.'; } },
    onToolActivity: async (_message, activity) => {
      if (activity.status === 'running') await store.ingest(progress);
      else await store.revise({ ...progress, text: `**Working**\n1. \`${activity.name}\`: completed` });
    },
  });
  assert.equal((await app.handle(request))?.text, 'Both reads finished.'); assert.equal(calls, 2);
});

test('a genuine source correction hides the stale turns and records its source ID', async t => {
  const { store } = setup(t); await store.ingest(request);
  store.addAgentTurn(request, '', [{ name: 'read_one', arguments: {} }]);
  await store.revise({ ...request, text: 'Corrected instructions.' });
  assert.deepEqual(store.agentTurns(request), []);
  assert.equal((store.lastContextChange('s', 'c') as { sourceId?: string }).sourceId, request.id);
});

test('attachment changes invalidate source context even when message text is unchanged', async t => {
  const { store } = setup(t);
  const source = { ...request, attachments: [{ name: 'evidence.png', url: 'https://cdn.discordapp.com/attachments/a/old.png', size: 10 }] };
  await store.ingest(source); store.addAgentTurn(source, '', [{ name: 'file_read', arguments: {} }]);
  await store.revise({ ...source, attachments: [{ ...source.attachments[0]!, url: 'https://cdn.discordapp.com/attachments/a/new.png' }] });
  assert.deepEqual(store.agentTurns(source), []);
});

test('deleting the requester invalidates its saved plan even after the canonical row is gone', async t => {
  const { store } = setup(t); await store.ingest(request);
  const turn = store.addAgentTurn(request, '', [{ name: 'read_one', arguments: {} }]);
  store.agentResult(turn.id, 0, { text: 'Completed evidence remains journaled.' });
  await store.remove('s', 'c', request.id);
  assert.deepEqual(store.agentTurns(request), []);
});

test('Discord attachment signature refresh preserves semantic context', async t => {
  const { store } = setup(t);
  const source = { ...request, attachments: [{ name: 'evidence.png', url: 'https://cdn.discordapp.com/attachments/a/file.png?ex=old&is=old&hm=old' }] };
  await store.ingest(source); const turn = store.addAgentTurn(source, '', [{ name: 'file_read', arguments: {} }]);
  await store.revise({ ...source, attachments: [{ ...source.attachments[0]!, url: 'https://cdn.discordapp.com/attachments/a/file.png?ex=new&is=new&hm=new' }] });
  assert.equal(store.agentTurns(source)[0]?.id, turn.id);
});

test('a source edit after an action keeps its actual result and does not replay it', async t => {
  const { store, filename } = setup(t); let writes = 0, rounds = 0;
  const app = new Application(store, { async *stream() { if (++rounds === 1) yield { kind: 'tool_call', payload: [{ name: 'write', arguments: {} }] }; else yield { kind: 'text', payload: { text: 'Stopped after the correction.' } }; } },
    { allowedChannels: [{ server: 's', channel: 'c' }] }, undefined, {
      tools: { catalog: () => '', execute: async () => { writes++; if (writes === 1) await store.revise({ ...request, text: 'Stop the remaining actions.' }); return { text: `Action ${writes} completed.`, status: 'ok' }; } },
    });
  assert.equal((await app.handle(request))?.text, 'Stopped after the correction.');
  assert.equal(writes, 1); assert.equal(rounds, 2);
  const db = new DatabaseSync(filename);
  try { assert.match(String(db.prepare('SELECT results FROM agent_turns').get()?.results), /Action 1 completed/); } finally { db.close(); }
});

test('an edit during a run rebuilds the context and still answers', async t => {
  const { store } = setup(t); let rounds = 0, calls = 0;
  const app = new Application(store, { async *stream() { if (++rounds === 1) yield { kind: 'tool_call', payload: [{ name: 'read_one', arguments: {} }] }; else yield { kind: 'text', payload: { text: 'Answer after the edit.' } }; } },
    { allowedChannels: [{ server: 's', channel: 'c' }] }, undefined, {
      tools: { catalog: () => '', execute: async () => { if (++calls === 1) await store.revise({ ...request, text: 'Edited request.' }); return { text: 'Read finished.', status: 'ok' }; } },
    });
  assert.equal((await app.handle(request))?.text, 'Answer after the edit.'); assert.equal(calls, 1);
});

test('three changes during a run end it with the latest answer, not an error', async t => {
  const { store } = setup(t); let rounds = 0, calls = 0;
  const app = new Application(store, { async *stream() { if (++rounds <= 3) yield { kind: 'tool_call', payload: [{ name: 'read_one', arguments: {} }] }; else yield { kind: 'text', payload: { text: 'Here is my answer.' } }; } },
    { allowedChannels: [{ server: 's', channel: 'c' }] }, undefined, {
      tools: { catalog: () => '', execute: async () => { await store.revise({ ...request, text: `Edit ${++calls}.` }); return { text: 'Read finished.', status: 'ok' }; } },
    });
  assert.equal((await app.handle(request))?.text, 'Here is my answer.'); assert.equal(calls, 3);
});

test('a profile write does not change the context version', async t => {
  const { store } = setup(t); await store.ingest(request);
  const before = await store.contextVersion('s', 'c');
  store.editProfile(request, 'person', 'city', 'Oslo', 'profile-op-1');
  assert.equal(await store.contextVersion('s', 'c'), before);
});

test('remembering a fact does not change the context version', async t => {
  const { store } = setup(t); await store.ingest(request);
  const before = await store.contextVersion('s', 'c');
  await store.remember(request, 'The team uses Oslo time.');
  assert.equal(await store.contextVersion('s', 'c'), before);
});

test('another bot\'s status-like message remains semantic evidence', async t => {
  const { store } = setup(t); await store.ingest(request);
  const external = { ...progress, author: 'other-bot', transient: false };
  await store.ingest(external); store.addAgentTurn(request, '', [{ name: 'read_one', arguments: {} }]);
  await store.revise({ ...external, text: '**Working**\n1. `history_read`: completed' });
  assert.deepEqual(store.agentTurns(request), []);
});

test('history reimport refreshes an authoritative newer source edit missed by live events', async t => {
  const { store } = setup(t);
  const original = { ...request, revisionTimestamp: 10 };
  await store.ingest(original); store.addAgentTurn(original, '', [{ name: 'read_one', arguments: {} }]);
  const corrected = { ...original, text: 'Corrected source from history.', revisionTimestamp: 20 };
  await store.ingest(corrected);
  assert.equal((await store.canonicalMessage('s', request.id))?.text, 'Corrected source from history.');
  assert.deepEqual(store.agentTurns(original), []);
});

test('an older source snapshot cannot roll back newer canonical content', async t => {
  const { store } = setup(t);
  const latest = { ...request, text: 'Newest instructions.', revisionTimestamp: 30 };
  await store.ingest(latest); const turn = store.addAgentTurn(latest, '', [{ name: 'read_one', arguments: {} }]);
  const older = { ...latest, text: 'Older instructions.', revisionTimestamp: 20 };
  await store.revise(older);
  assert.equal((await store.canonicalMessage('s', request.id))?.text, latest.text);
  assert.equal(store.agentTurns(latest)[0]?.id, turn.id);
});

test('a chat change during a working checkpoint drops the checkpoint and the run still finishes', async t => {
  const { store } = setup(t);
  const lookup: import('../src/domain.js').ModelTool = { type: 'function', function: { name: 'lookup', description: 'Read state', parameters: { type: 'object', properties: { step: { type: 'integer' } }, required: ['step'] } } };
  const checkpoint = '{"goal":"finish the task","constraints":[],"decisions":[],"disagreements":[],"progress":["Earlier reads completed."],"artifacts":[],"pending_actions":[]}';
  let reads = 0, checkpoints = 0;
  const llm: import('../src/ports.js').LLM = { async *stream(prompt) {
    if (prompt.purpose === 'checkpoint') {
      // The chat changes while the checkpoint is being made. Only the first checkpoint sees this change.
      if (++checkpoints === 1) await store.revise({ ...request, text: 'Edited while checkpointing.' });
      yield { kind: 'text', payload: { text: checkpoint } }; return;
    }
    if (reads < 8) yield { kind: 'tool_call', payload: [{ id: `call_${reads + 1}`, name: 'lookup', arguments: { step: reads + 1 } }] };
    else yield { kind: 'text', payload: { text: 'Finished all eight reads.' } };
  } };
  const policy = { allowedChannels: [{ server: 's', channel: 'c' }], maxInputChars: 8000, maxOutputTokens: 1024, checkpointTokens: 1024 };
  const services = { harness: store, tools: { catalog: () => '', schemas: () => [lookup], execute: async () => { reads++; return { text: `Read ${reads} completed. ` + 'x'.repeat(4000) }; } } };
  const reply = await new Application(store, llm, policy, undefined, services).handle(request);
  assert.equal(reply?.text, 'Finished all eight reads.'); assert.equal(reads, 8); assert.ok(checkpoints >= 1);
});
