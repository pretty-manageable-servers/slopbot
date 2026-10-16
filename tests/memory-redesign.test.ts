import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Client } from 'pg';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { PostgresStore } from '../src/adapters/postgres.js';
import { newMemory, patchMemory, memorySearchText } from '../src/memory.js';
import type { Message } from '../src/domain.js';

const source: Message = { server: 'memory-redesign', channel: 'chat', author: 'alice', id: 'source', text: 'a source statement' };
for (const backend of ['sqlite', 'postgres'] as const) {
  test(`${backend}: categorized memory, independent sources, search, revisions and forgetting`, { skip: backend === 'postgres' && !process.env.TEST_DATABASE_URL }, async t => {
    const schema = 'slopbot_test_memory_redesign';
    const embedded: string[] = [];
    const embeddings = { model: 'memory-test', async embed(text: string) { embedded.push(text); return text.includes('awkward') ? [1, 0, 0] : [0, 1, 0]; } };
    const store = backend === 'sqlite' ? new SQLiteStore(':memory:', embeddings) : await PostgresStore.connect(process.env.TEST_DATABASE_URL!, embeddings, schema);
    t.after(async () => {
      await store.finishIndexing(); await store.close();
      if (backend === 'postgres') { const cleanup = new Client({ connectionString: process.env.TEST_DATABASE_URL }); await cleanup.connect(); await cleanup.query(`DROP SCHEMA ${schema} CASCADE`); await cleanup.end(); }
    });
    await store.ingest(source);
    const fact = await store.remember(source, 'The budget is 200');
    assert.equal(fact.category, 'fact'); assert.equal(fact.sourcePolicy, 'source_bound'); assert.deepEqual(fact.sourceIds, [source.id]);
    const meme = await store.remember({ ...source, id: 'not-in-history' }, 'Confused reaction', { category: 'meme', tags: ['reaction', 'confusion'], details: { media_url: 'https://example.com/reaction.gif', media_type: 'gif', aliases: ['huh'], when_to_use: 'awkward silence', humor_notes: 'Alice says it fits bad predictions', interpretation: 'The expression conveys disbelief' } });
    assert.equal(meme.sourcePolicy, 'independent'); assert.deepEqual(meme.sourceIds, []);
    await store.finishIndexing();
    assert.ok(embedded.some(text => text.includes('awkward silence') && text.includes('huh')));
    assert.equal((await store.searchMemories(source, { query: 'huh', category: 'meme', tags: ['confusion'] }))[0]?.id, meme.id);
    assert.equal((await store.searchMemories(source, { query: 'awkward', category: 'meme' }))[0]?.id, meme.id);
    assert.equal((await store.searchMemories(source, { category: 'meme', tags: ['missing'] })).length, 0);
    assert.equal((await store.searchMemories({ ...source, channel: 'other' })).length, 0);
    assert.equal((await store.searchMemories({ ...source, server: 'other' })).length, 0);
    const evidence = (await store.retrieve({ ...source, text: 'awkward' }, 8)).find(item => item.memoryId === meme.id);
    assert.equal(evidence?.details?.media_url, meme.details.media_url); assert.equal(evidence?.category, 'meme');
    await store.revise({ ...source, text: 'changed statement' });
    assert.ok(!(await store.memories(source.server, source.channel)).some(note => note.id === fact.id));
    assert.ok((await store.memories(source.server, source.channel)).some(note => note.id === meme.id));
    await store.remove(source.server, source.channel, source.id);
    assert.equal((await store.memories(source.server, source.channel))[0]?.id, meme.id);
    assert.equal(await store.updateMemory({ ...source, author: 'bob' }, meme.id, { content: 'stolen' }, 1), undefined);
    assert.equal(await store.updateMemory({ ...source, channel: 'other' }, meme.id, { content: 'stolen' }, 1), undefined);
    const version = await store.contextVersion(source.server, source.channel);
    const updated = await store.updateMemory(source, meme.id, { content: 'Celebration', tags: ['joy'], details: { when_to_use: 'after a win' } }, 1, 'edit');
    assert.equal(updated?.revision, 2); assert.equal(updated?.lastOperationId, 'edit'); assert.equal(updated?.sourcePolicy, 'independent');
    assert.ok(await store.contextVersion(source.server, source.channel) > version);
    await assert.rejects(store.updateMemory(source, meme.id, { content: 'lost update' }, 1), /Memory changed/);
    await store.finishIndexing();
    assert.ok(embedded.some(text => text.includes('after a win')));
    assert.equal((await store.searchMemories(source, { query: 'awkward' })).length, 0);
    assert.equal((await store.searchMemories(source, { tags: ['joy'] }))[0]?.id, meme.id);
    const second = { ...source, id: 'second', text: 'another statement' }; await store.ingest(second);
    const one = await store.remember(second, 'First lesson'), two = await store.remember(second, 'Second lesson');
    assert.equal(await store.forget(source.server, source.channel, one.id, 'bob'), false);
    assert.equal(await store.forget(source.server, source.channel, one.id, source.author), true);
    assert.equal((await store.canonicalMessage(source.server, second.id))?.text, second.text);
    assert.ok((await store.memories(source.server, source.channel)).some(note => note.id === two.id));
    assert.equal(await store.forget(source.server, source.channel, meme.id, source.author), true);
    await store.finishIndexing();
    assert.ok(!(await store.retrieve({ ...source, text: 'Celebration' }, 8)).some(item => item.memoryId === meme.id));
    await assert.rejects(store.remember(source, 'missing source', { sourceIds: ['not-in-history'] }), /source is unavailable/);
    const foreign = { ...second, channel: 'other', id: 'foreign' }; await store.ingest(foreign);
    await assert.rejects(store.remember(second, 'wrong channel source', { sourceIds: [foreign.id] }), /source is unavailable/);
    const third = { ...second, id: 'third' }; await store.ingest(third);
    const multi = await store.remember(second, 'multiple sources', { sourceIds: [second.id, third.id] });
    await store.remove(source.server, source.channel, third.id);
    assert.ok(!(await store.memories(source.server, source.channel)).some(note => note.id === multi.id));
    assert.equal((await store.searchMemories(source, { limit: 1 })).length, 1);
    assert.equal((await store.searchMemories(source, { limit: 1, offset: 100 })).length, 0);
  });
}

test('memory validation rejects wrong category fields and invalid structures', () => {
  for (const options of [
    { category: 'fact', details: { media_type: 'gif' } },
    { category: 'meme', details: { media_type: 'audio' } },
    { category: 'meme', details: { media_url: 'javascript:alert(1)' } },
    { category: 'meme', details: { media_url: 'https://user:secret@example.com/a.gif' } },
    { category: 'meme', details: { aliases: [1] } },
    { tags: [''] }, { details: [] }, { sourcePolicy: 'independent', sourceIds: ['source'] }, { sourceIds: [] },
  ]) assert.throws(() => newMemory(source, 'valid text', options as never));
  const note = newMemory(source, 'text', { category: 'note', details: { subject: 'topic' }, sourcePolicy: 'independent' });
  assert.equal(patchMemory(note, { tags: [], details: {} }).revision, 2);
  assert.equal(memorySearchText(newMemory(source, 'old fact')), 'old fact');
});

test('SQLite upgrades legacy memory rows without losing content, sources or vectors', async t => {
  const { DatabaseSync } = await import('node:sqlite');
  const { mkdtempSync, rmSync } = await import('node:fs');
  const { join } = await import('node:path'); const { tmpdir } = await import('node:os');
  const dir = mkdtempSync(join(tmpdir(), 'slop-memory-upgrade-')), path = join(dir, 'db.sqlite');
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  let store = new SQLiteStore(path, { model: 'test', async embed() { return [1, 0]; } });
  await store.ingest(source); const old = await store.remember(source, 'legacy fact'); await store.finishIndexing(); await store.close();
  const db = new DatabaseSync(path); db.exec('ALTER TABLE memories DROP COLUMN metadata'); db.close();
  store = new SQLiteStore(path); t.after(() => store.close());
  const note = (await store.memories(source.server, source.channel))[0]!;
  assert.equal(note.id, old.id); assert.equal(note.content, 'legacy fact'); assert.equal(note.category, 'fact'); assert.equal(note.sourcePolicy, 'source_bound'); assert.deepEqual(note.sourceIds, [source.id]); assert.equal(note.revision, 1);
  const upgraded = new DatabaseSync(path); assert.equal(upgraded.prepare('SELECT count(*) AS n FROM memory_embeddings').get()!.n, 1); upgraded.close();
});

test('an embedding started before an edit cannot overwrite the updated memory index', async t => {
  let release!: (vector: number[]) => void, started!: () => void, first = true;
  const pending = new Promise<number[]>(resolve => { release = resolve; }), begun = new Promise<void>(resolve => { started = resolve; });
  const indexed: string[] = [];
  const store = new SQLiteStore(':memory:', { model: 'test', async embed(text) { indexed.push(text); if (first) { first = false; started(); return pending; } return [0, 1]; } }); t.after(() => store.close());
  const meme = await store.remember(source, 'reaction', { category: 'meme', details: { when_to_use: 'awkward silence' } });
  await begun;
  await store.updateMemory(source, meme.id, { details: { when_to_use: 'celebration' } }, 1);
  release([1, 0]); await store.finishIndexing();
  assert.ok(indexed.some(text => text.includes('celebration'))); assert.equal(store.indexStats(source.server, source.channel).vectors, 1);
});
