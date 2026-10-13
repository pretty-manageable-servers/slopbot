import { test } from 'node:test';
import assert from 'node:assert/strict';
import { serializeStore } from '../src/adapters/postgres-database.js';

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

test('background embedding waits outside the queue while SQL operations remain serialized', async () => {
  const provider = deferred(), fetching = deferred(), transaction = deferred(), writing = deferred();
  const calls: string[] = [];
  const store = serializeStore({
    async indexMessage() {
      await this.read();
      fetching.resolve();
      await provider.promise;
      await this.write();
    },
    async read() { calls.push('read'); },
    async write() { calls.push('write-start'); writing.resolve(); await transaction.promise; calls.push('write-end'); },
    async status() { calls.push('status'); return 'ready'; },
  });
  const indexing = store.indexMessage();
  try {
    await fetching.promise;
    assert.equal(await store.status(), 'ready');
    provider.resolve();
    await writing.promise;
    const status = store.status();
    await Promise.resolve();
    assert.deepEqual(calls, ['read', 'status', 'write-start']);
    transaction.resolve();
    await Promise.all([indexing, status]);
    assert.deepEqual(calls, ['read', 'status', 'write-start', 'write-end', 'status']);
  } finally { provider.resolve(); transaction.resolve(); await indexing; }
});

test('failed queued operations release the queue and nested calls stay within their transaction', async () => {
  const calls: string[] = [];
  const store = serializeStore({
    async outer() { calls.push('begin'); await this.inner(); calls.push('rollback'); throw new Error('failure'); },
    async inner() { calls.push('inner'); },
    async next() { calls.push('next'); },
  });
  const failure = assert.rejects(store.outer(), /failure/);
  await Promise.all([failure, store.next()]);
  assert.deepEqual(calls, ['begin', 'inner', 'rollback', 'next']);
});
