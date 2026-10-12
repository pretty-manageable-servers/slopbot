import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { Application } from '../src/application.js';
import { parseMessage } from '../src/domain.js';
import { describeError } from '../src/errors.js';
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
    yield { kind: 'text', payload: { text: ++rounds === 1 ? '{"tool_calls":[{"name":"read_one","arguments":{}},{"name":"read_two","arguments":{}}]}' : 'Both reads finished.' } };
  } }, { allowedChannels: [{ server: 's', channel: 'c' }] }, undefined, {
    tools: { catalog: () => '', execute: async () => { calls++; return 'Read finished.'; } },
    onToolActivity: async (_message, activity) => {
      if (activity.status === 'running') await store.ingest(progress);
      else await store.revise({ ...progress, text: `**Working**\n1. \`${activity.name}\`: completed` });
    },
  });
  assert.equal((await app.handle(request))?.text, 'Both reads finished.'); assert.equal(calls, 2);
});

test('a genuine source correction produces a specific context error with its source ID', async t => {
  const { store } = setup(t); await store.ingest(request);
  store.addAgentTurn(request, '', [{ name: 'read_one', arguments: {} }]);
  await store.revise({ ...request, text: 'Corrected instructions.' });
  assert.throws(() => store.agentTurns(request), error => {
    const info = describeError(error); assert.equal(info.code, 'CONTEXT_CHANGED'); assert.equal(info.details?.sourceId, request.id); return true;
  });
});

test('attachment changes invalidate source context even when message text is unchanged', async t => {
  const { store } = setup(t);
  const source = { ...request, attachments: [{ name: 'evidence.png', url: 'https://cdn.discordapp.com/attachments/a/old.png', size: 10 }] };
  await store.ingest(source); store.addAgentTurn(source, '', [{ name: 'file_read', arguments: {} }]);
  await store.revise({ ...source, attachments: [{ ...source.attachments[0]!, url: 'https://cdn.discordapp.com/attachments/a/new.png' }] });
  assert.throws(() => store.agentTurns(source), error => describeError(error).code === 'CONTEXT_CHANGED');
});

test('deleting the requester invalidates its saved plan even after the canonical row is gone', async t => {
  const { store } = setup(t); await store.ingest(request);
  const turn = store.addAgentTurn(request, '', [{ name: 'read_one', arguments: {} }]);
  store.agentResult(turn.id, 0, { text: 'Completed evidence remains journaled.' });
  await store.remove('s', 'c', request.id);
  assert.throws(() => store.agentTurns(request), error => describeError(error).code === 'CONTEXT_CHANGED');
});

test('Discord attachment signature refresh preserves semantic context', async t => {
  const { store } = setup(t);
  const source = { ...request, attachments: [{ name: 'evidence.png', url: 'https://cdn.discordapp.com/attachments/a/file.png?ex=old&is=old&hm=old' }] };
  await store.ingest(source); const turn = store.addAgentTurn(source, '', [{ name: 'file_read', arguments: {} }]);
  await store.revise({ ...source, attachments: [{ ...source.attachments[0]!, url: 'https://cdn.discordapp.com/attachments/a/file.png?ex=new&is=new&hm=new' }] });
  assert.equal(store.agentTurns(source)[0]?.id, turn.id);
});

test('a source edit after an action preserves its actual result and prevents replay', async t => {
  const { store, filename } = setup(t); let writes = 0; const activity: string[] = [];
  const app = new Application(store, { async *stream() { yield { kind: 'text', payload: { text: '{"tool_calls":[{"name":"write","arguments":{}},{"name":"write","arguments":{}}]}' } }; } },
    { allowedChannels: [{ server: 's', channel: 'c' }] }, undefined, {
      tools: { catalog: () => '', execute: async () => { writes++; await store.revise({ ...request, text: 'Stop the remaining actions.' }); return { text: 'First action completed.', status: 'ok' }; } },
      onToolActivity: async (_message, event) => { activity.push(event.status); },
    });
  await assert.rejects(app.handle(request), error => describeError(error).code === 'CONTEXT_CHANGED');
  assert.equal(writes, 1); assert.deepEqual(activity, ['running', 'completed']);
  const db = new DatabaseSync(filename);
  try { assert.match(String(db.prepare('SELECT results FROM agent_turns').get()?.results), /First action completed/); } finally { db.close(); }
  await assert.rejects(app.handle(request, true), error => describeError(error).code === 'CONTEXT_CHANGED'); assert.equal(writes, 1);
});

test('another bot\'s status-like message remains semantic evidence', async t => {
  const { store } = setup(t); await store.ingest(request);
  const external = { ...progress, author: 'other-bot', transient: false };
  await store.ingest(external); store.addAgentTurn(request, '', [{ name: 'read_one', arguments: {} }]);
  await store.revise({ ...external, text: '**Working**\n1. `history_read`: completed' });
  assert.throws(() => store.agentTurns(request), error => describeError(error).code === 'CONTEXT_CHANGED');
});

test('history reimport refreshes an authoritative newer source edit missed by live events', async t => {
  const { store } = setup(t);
  const original = { ...request, revisionTimestamp: 10 };
  await store.ingest(original); store.addAgentTurn(original, '', [{ name: 'read_one', arguments: {} }]);
  const corrected = { ...original, text: 'Corrected source from history.', revisionTimestamp: 20 };
  await store.ingest(corrected);
  assert.equal((await store.canonicalMessage('s', request.id))?.text, 'Corrected source from history.');
  assert.throws(() => store.agentTurns(original), error => describeError(error).code === 'CONTEXT_CHANGED');
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
