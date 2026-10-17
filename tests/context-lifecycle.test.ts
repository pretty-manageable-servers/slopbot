import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { Application } from '../src/application.js';
import type { TestContext } from 'node:test';

const request = { server: 's', channel: 'c', id: 'request', author: 'person', text: 'Complete both reads', addressed: true };
const progress = { ...request, id: 'progress', author: 'bot', text: '**Working**\n1. `history_read`: running', isBot: true, transient: true };
function setup(t: TestContext) {
  const directory = mkdtempSync(join(tmpdir(), 'slopbot-context-test-')), filename = join(directory, 'store.sqlite3');
  const store = new SQLiteStore(filename);
  store.setSetting(request.server, "context_bot_author", "bot");
  t.after(() => { store.close(); rmSync(directory, { recursive: true, force: true }); });
  return { store, filename };
}

test('transient progress is excluded from indexed conversation while normal bot answers remain', async t => {
  const { store } = setup(t);
  assert.equal(await store.ingest(progress), false);
  const answer = { ...progress, id: 'answer', text: 'The source-linked report is complete.', transient: false };
  assert.equal(await store.ingest(answer), true);
  assert.equal(await store.canonicalMessage('s', 'progress'), undefined);
});

test('deleting the requester invalidates its saved plan even after the canonical row is gone', async t => {
  const { store } = setup(t); await store.ingest(request);
  const turn = store.addAgentTurn(request, '', [{ name: 'read_one', arguments: {} }]);
  store.agentResult(turn.id, 0, { text: 'Completed evidence remains journaled.' });
  await store.remove('s', 'c', request.id);
  assert.deepEqual(store.agentTurns(request), []);
});

test('a source edit after an action keeps its actual result and does not replay it', async t => {
  const { store, filename } = setup(t); let writes = 0, rounds = 0;
  const app = new Application(store, { async *stream() { if (++rounds === 1) yield { kind: 'tool_call', payload: [{ name: 'write', arguments: {} }] }; else yield { kind: 'text', payload: { text: 'Stopped after the correction.' } }; } },
    { allowedChannels: [{ server: 's', channel: 'c' }] }, undefined, {
      tools: { schemas: () => [], catalog: () => '', execute: async () => { writes++; if (writes === 1) await store.revise({ ...request, text: 'Stop the remaining actions.' }); return { text: `Action ${writes} completed.`, status: 'ok' }; } },
    });
  assert.equal((await app.handle(request))?.text, 'Stopped after the correction.');
  assert.equal(writes, 1); assert.equal(rounds, 2);
  const db = new DatabaseSync(filename);
  try { assert.match(String(db.prepare('SELECT results FROM agent_turns').get()?.results), /Action 1 completed/); } finally { db.close(); }
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

test('a source change invalidates saved turns, except an attachment URL signature refresh', async t => {
  const attachment = (url: string) => [{ name: 'evidence.png', url, size: 10 }];
  const cdn = 'https://cdn.discordapp.com/attachments/a/';
  const base = { ...request, attachments: attachment(cdn + 'file.png?ex=old&is=old&hm=old') };
  const cases: [string, typeof base, boolean][] = [
    ['text edit', { ...base, text: 'Corrected instructions.' }, true],
    ['new attachment file', { ...base, attachments: attachment(cdn + 'new.png') }, true],
    ['signature refresh', { ...base, attachments: attachment(cdn + 'file.png?ex=new&is=new&hm=new') }, false],
  ];
  for (const [name, revised, invalidated] of cases) {
    const { store } = setup(t);
    await store.ingest(base); store.addAgentTurn(base, '', [{ name: 'read', arguments: {} }]);
    await store.revise(revised);
    assert.equal(store.agentTurns(base).length === 0, invalidated, name);
  }
});

test('profile writes and remembered facts do not change the context version', async t => {
  const { store } = setup(t); await store.ingest(request);
  const before = await store.contextVersion('s', 'c');
  store.editProfile(request, 'person', 'city', 'Oslo', 'profile-op-1');
  await store.remember(request, 'The team uses Oslo time.');
  assert.equal(await store.contextVersion('s', 'c'), before);
});

test('an older source snapshot cannot roll back newer canonical content', async t => {
  const { store } = setup(t);
  const latest = { ...request, text: 'Newest instructions.', revisionTimestamp: 30 };
  await store.ingest(latest); const turn = store.addAgentTurn(latest, '', [{ name: 'read_one', arguments: {} }]);
  await store.revise({ ...latest, text: 'Older instructions.', revisionTimestamp: 20 });
  assert.equal((await store.canonicalMessage('s', request.id))?.text, latest.text);
  assert.equal(store.agentTurns(latest)[0]?.id, turn.id);
});
