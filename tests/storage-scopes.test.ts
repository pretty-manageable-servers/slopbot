import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { objectStorageTool, UserFileStorage, type ObjectStorageProvider, type StorageScope } from '../src/object-storage.js';
import { ToolRegistry, ToolError, type ToolArgs } from '../src/tools.js';
import { sandboxTool, type SandboxProvider } from '../src/sandbox.js';
const alice = '111111111111111111', bob = '222222222222222222', admin = '333333333333333333';
const message = { server: 'guild-a', channel: 'task', taskId: 'task', id: 'request', author: alice, text: 'store file' };
function setup() {
  const store = new SQLiteStore(), blobs = new Map<string, Uint8Array>();
  const provider: ObjectStorageProvider = {
    put: async (key, bytes) => { blobs.set(key, Uint8Array.from(bytes)); },
    get: async key => { const bytes = blobs.get(key); if (!bytes) throw new ToolError('missing'); return bytes; },
    delete: async key => { blobs.delete(key); },
    link: async (key, _name, seconds) => `https://s3.pmservers.org/bucket/${key}?seconds=${seconds}`,
  };
  const storage = new UserFileStorage(store, provider), registry = new ToolRegistry(store, async request => request.author === admin);
  const inspected: string[] = [], sent: string[] = [], loaded: StorageScope[] = [];
  registry.register(objectStorageTool({ storage, authorize: async () => {}, resolveAttachment: async () => ({ ...message, attachments: [{ name: 'file', url: 'https://cdn.discordapp.com/file' }] }), fetcher: { fetch: async () => Buffer.from('attachment') }, inspect: async (_context, file, bytes) => { inspected.push(file.storageScope!); return Buffer.from(bytes).toString(); }, send: async (context, file) => { sent.push(`${context.message.author}:${file.storageScope}`); }, sandbox: { read: async () => Buffer.from('sandbox'), write: async context => { loaded.push(context.arguments.storage_scope as StorageScope); } } }));
  let operation = 0;
  const call = (args: ToolArgs, author = alice, server = 'guild-a', id = `op-${++operation}`) => registry.invokeResult({ ...message, author, server }, 'file_store', args, id, 'agent');
  return { store, storage, registry, blobs, call, inspected, sent, loaded };
}

test('user files follow their owner across servers and stay separate from user_server and server paths', async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.call({ action: 'write', storage_scope: 'user', path: 'same.txt', text: 'global Alice' });
  await f.call({ action: 'write', storage_scope: 'user_server', path: 'same.txt', text: 'Alice guild A' });
  await f.call({ action: 'write', storage_scope: 'server', path: 'same.txt', text: 'shared guild A' });
  await f.call({ action: 'write', path: 'same.txt', text: 'Alice guild B' }, alice, 'guild-b');
  const global = await f.storage.read('guild-b', alice, alice, 'same.txt', 'user');
  assert.equal(Buffer.from(global.bytes).toString(), 'global Alice'); assert.ok(global.file.key.startsWith(`users/${alice}/`));
  assert.equal((await f.call({ action: 'read', path: 'same.txt' })).text, 'Alice guild A');
  assert.equal((await f.call({ action: 'read', path: 'same.txt' }, alice, 'guild-b')).text, 'Alice guild B');
  const shared = await f.storage.read('guild-a', bob, bob, 'same.txt', 'server');
  assert.equal(Buffer.from(shared.bytes).toString(), 'shared guild A'); assert.ok(shared.file.key.startsWith('servers/guild-a/shared/'));
  await assert.rejects(f.call({ action: 'info', storage_scope: 'server', path: 'same.txt' }, alice, 'guild-b'), /not found/);
  assert.equal(f.blobs.size, 4);
});

test('global personal files are private even from admins, and publishing makes them available across servers', async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.call({ action: 'write', storage_scope: 'user', path: 'global.txt', text: 'global' });
  for (const actor of [bob, admin]) await assert.rejects(f.call({ action: 'info', storage_scope: 'user', path: 'global.txt', owner: alice }, actor, 'guild-b'), /not shared/);
  assert.equal((await f.call({ action: 'list', storage_scope: 'user', scope: 'public' }, bob, 'guild-b')).text, 'No matching stored files.');
  await f.call({ action: 'publish', storage_scope: 'user', path: 'global.txt' });
  assert.match((await f.call({ action: 'list', storage_scope: 'user', scope: 'public' }, bob, 'guild-b')).text, /global.txt/);
  const args = { action: 'info', storage_scope: 'user', path: 'global.txt', owner: alice };
  await f.call(args, bob, 'guild-b', 'cached-global');
  await f.call({ action: 'send', storage_scope: 'user', path: 'global.txt', owner: alice }, bob, 'guild-b');
  assert.deepEqual(f.sent, [`${bob}:user`]);
  await f.call({ action: 'unpublish', storage_scope: 'user', path: 'global.txt' });
  await assert.rejects(f.call(args, bob, 'guild-b', 'cached-global'), /not shared/);
});

test('server files allow member uploads and reads, but only creator or admin can mutate an existing path', async t => {
  const f = setup(); t.after(() => f.store.close());
  const base = { storage_scope: 'server', path: 'handbook.txt' };
  await f.call({ ...base, action: 'write', text: 'original' });
  assert.match((await f.call({ action: 'list', storage_scope: 'server' }, bob)).text, /handbook/);
  assert.equal((await f.call({ ...base, action: 'read' }, bob)).text, 'original');
  for (const args of [{ ...base, action: 'write', text: 'attack', overwrite: true }, { ...base, action: 'delete' }, { ...base, action: 'unpublish' }, { ...base, action: 'publish' }]) await assert.rejects(f.call(args, bob), /creator or a server admin/);
  await f.call({ ...base, action: 'write', text: 'admin revised', overwrite: true }, admin);
  assert.equal((await f.call({ ...base, action: 'read' }, bob)).text, 'admin revised');
  const file = (await f.storage.entry('guild-a', bob, bob, 'handbook.txt', false, 'server')).file;
  assert.equal(file.createdBy, alice);
  await f.call({ ...base, action: 'unpublish' }, admin);
  await assert.rejects(f.call({ ...base, action: 'info' }, bob), /not shared/);
  await assert.rejects(f.call({ ...base, action: 'write', text: 'squat', overwrite: true }, bob), /not shared/);
  assert.equal((await f.call({ ...base, action: 'list' }, bob)).text, 'No matching stored files.');
  assert.equal((await f.call({ ...base, action: 'read' }, alice)).text, 'admin revised');
  assert.equal((await f.call({ ...base, action: 'read' }, admin)).text, 'admin revised');
  await f.call({ ...base, action: 'delete' }, alice);
  await assert.rejects(f.call({ ...base, action: 'info' }, admin), /not found/);
});

test('all three scopes support attachment saves, inspection, links, DM and sandbox transfers', async t => {
  const f = setup(); t.after(() => f.store.close());
  for (const storage_scope of ['user', 'server', 'user_server'] as const) {
    const base = { storage_scope, path: 'file.bin' };
    await f.call({ ...base, action: 'save_attachment' });
    assert.equal((await f.call({ ...base, action: 'read' })).text, 'attachment');
    assert.equal((await f.call({ ...base, action: 'link' })).artifacts?.length, 1);
    await f.call({ ...base, action: 'send' });
    await f.call({ storage_scope, action: 'save_sandbox', path: 'output.bin', sandbox_path: '/tmp/output' });
    assert.equal((await f.call({ storage_scope, action: 'read', path: 'output.bin' })).text, 'sandbox');
  }
  assert.equal(f.sent.length, 3);
});

test('copy explicitly transfers between every scope and enforces destination permissions', async t => {
  const f = setup(); t.after(() => f.store.close());
  for (const storage_scope of ['user', 'server', 'user_server'] as const) {
    await f.call({ action: 'write', storage_scope, path: 'source', text: storage_scope });
    for (const destination_scope of ['user', 'server', 'user_server'] as const) {
      const destination = `${storage_scope}-to-${destination_scope}`;
      await f.call({ action: 'copy', storage_scope, path: 'source', destination_scope, destination });
      const copied = await f.storage.read('guild-a', alice, alice, destination, destination_scope);
      assert.equal(Buffer.from(copied.bytes).toString(), storage_scope); assert.equal(copied.file.public, destination_scope === 'server');
    }
  }
  await f.call({ action: 'write', storage_scope: 'server', path: 'protected', text: 'Alice server' });
  await f.call({ action: 'write', storage_scope: 'user', path: 'bob', text: 'Bob personal' }, bob);
  await assert.rejects(f.call({ action: 'copy', storage_scope: 'user', path: 'bob', destination_scope: 'server', destination: 'protected', overwrite: true }, bob), /creator or a server admin/);
});

test('scope validation prevents directory impersonation and resource locks reflect the target scope', async t => {
  const f = setup(); t.after(() => f.store.close()); const definition = f.registry.definitions()[0]!;
  await assert.rejects(f.call({ action: 'write', storage_scope: 'invalid', path: 'x', text: 'x' }), ToolError);
  await assert.rejects(f.call({ action: 'info', storage_scope: 'server', owner: bob, path: 'x' }), /Omit owner/);
  await assert.rejects(f.call({ action: 'write', storage_scope: 'user', owner: bob, path: 'x', text: 'x' }), /Omit owner/);
  await assert.rejects(f.call({ action: 'write', destination_scope: 'server', path: 'x', text: 'x' }), /only valid for copy/);
  const resource = definition.resource!;
  assert.equal(resource(message, { storage_scope: 'user' }), resource({ ...message, server: 'guild-b' }, { storage_scope: 'user' }));
  assert.equal(resource(message, { storage_scope: 'server' }), resource({ ...message, author: bob }, { storage_scope: 'server' }));
  assert.notEqual(resource(message, { storage_scope: 'user_server' }), resource({ ...message, author: bob }, { storage_scope: 'user_server' }));
  assert.equal(resource(message, { action: 'copy', storage_scope: 'user', destination_scope: 'server' }), resource(message, { storage_scope: 'server' }));
});

test('old personal-within-server files keep their paths, ownership and visibility without migration', async t => {
  const f = setup(); t.after(() => f.store.close());
  const file = { owner: alice, path: 'legacy', key: 'old-key', size: 3, contentType: 'text/plain', public: false, updatedAt: 0 };
  f.blobs.set(file.key, Buffer.from('old'));
  await f.store.putRecord('guild-a', 'stored_file', JSON.stringify([alice, file.path]), file, 0);
  assert.equal((await f.call({ action: 'read', path: 'legacy' })).text, 'old');
  const info = JSON.parse((await f.call({ action: 'info', path: 'legacy' })).text);
  assert.equal(info.storage_scope, 'user_server'); assert.equal(info.server, 'guild-a'); assert.equal(info.creator, alice);
  await assert.rejects(f.call({ action: 'info', storage_scope: 'user', path: 'legacy' }), /not found/);
  await f.call({ action: 'publish', path: 'legacy' });
  assert.equal((await f.call({ action: 'read', path: 'legacy', owner: alice }, bob)).text, 'old');
});

test('sandbox import_storage uses the selected scope and requester admin status', async t => {
  const f = setup(); t.after(() => f.store.close()); let uploaded = '';
  const session = { id: 'sandbox', run: async () => ({ stdout: '', stderr: '', exitCode: 0 }), read: async () => '', readBytes: async () => Buffer.from(''), write: async (_path: string, data: string | Uint8Array) => { uploaded = typeof data === 'string' ? data : Buffer.from(data).toString(); }, renew: async () => {}, close: async () => {} };
  const provider: SandboxProvider = { create: async () => session, connect: async () => session };
  f.registry.register(sandboxTool(f.store, provider, undefined, f.storage));
  await f.call({ action: 'write', storage_scope: 'user', path: 'global', text: 'portable' });
  await f.registry.invokeResult({ ...message, server: 'guild-b' }, 'sandbox', { action: 'import_storage', storage_scope: 'user', storage_path: 'global', path: '/tmp/file' }, 'import-global', 'agent');
  assert.equal(uploaded, 'portable');
  await f.call({ action: 'write', storage_scope: 'server', path: 'private', text: 'admin access' });
  await f.call({ action: 'unpublish', storage_scope: 'server', path: 'private' });
  const args = { action: 'import_storage', storage_scope: 'server', storage_path: 'private', path: '/tmp/file' };
  await assert.rejects(f.registry.invokeResult({ ...message, author: bob }, 'sandbox', args, 'import-denied', 'agent'), /not shared/);
  await f.registry.invokeResult({ ...message, author: admin }, 'sandbox', args, 'import-admin', 'agent'); assert.equal(uploaded, 'admin access');
});
