import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { objectStorageTool, UserFileStorage, MAX_STORED_FILE_BYTES, type ObjectStorageProvider } from '../src/object-storage.js';
import { ToolRegistry, ToolError, UncertainActionError, type ToolArgs, type ToolContext } from '../src/tools.js';
import type { SandboxProvider } from '../src/sandbox.js';
const alice = '111111111111111111', bob = '222222222222222222';
const message = { server: 's', channel: 'task', taskId: 'task', id: 'request', author: alice, text: 'store a file' };
function setup() {
  const store = new SQLiteStore(), objects = new Map<string, Uint8Array>();
  const provider: ObjectStorageProvider = {
    async put(key, bytes) { objects.set(key, Uint8Array.from(bytes)); },
    async get(key) { const data = objects.get(key); if (!data) throw new ToolError('Object missing', 'failed'); return data; },
    async delete(key) { objects.delete(key); },
    async link(key, _name, seconds) { return `https://s3.pmservers.org/bucket/${key}?expires=${seconds}`; },
  };
  const storage = new UserFileStorage(store, provider), registry = new ToolRegistry(store, async () => true);
  let inspections = 0, sends = 0, allowed = true, downloads = 0, invocation = 0;
  const source = { ...message, id: 'attachment', attachments: [{ name: 'image.bin', url: 'https://cdn.discordapp.com/attachment', contentType: 'application/octet-stream' }] };
  const binary = new Uint8Array([0, 255, 128, 10]);
  const services = {
    storage, authorize: async () => { if (!allowed) throw new ToolError('Channel disabled'); },
    resolveAttachment: async () => source,
    fetcher: { fetch: async () => { downloads++; return binary; } },
    inspect: async (_context: unknown, _file: unknown, bytes: Uint8Array, question: string) => { inspections++; assert.deepEqual(bytes, binary); return `Inspected: ${question}`; },
    send: async (context: ToolContext, _file: unknown, bytes: Uint8Array) => { sends++; assert.equal(context.message.author, bob); assert.deepEqual(bytes, binary); },
  };
  registry.register(objectStorageTool(services));
  const call = (args: ToolArgs, user = alice, server = 's', op = `op-${++invocation}`) => registry.invokeResult({ ...message, author: user, server }, 'file_store', args, op, 'agent');
  return { store, objects, provider, storage, registry, services, source, binary, call, counts: () => ({ inspections, sends, downloads }), disable: () => { allowed = false; } };
}

test('files persist in isolated user directories and writes cannot impersonate owners, even admins', async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.call({ action: 'write', path: 'notes/file.txt', text: 'Alice private' });
  await f.call({ action: 'write', path: 'notes/file.txt', text: 'Bob private' }, bob);
  const a = await f.storage.read('s', alice, alice, 'notes/file.txt'), b = await f.storage.read('s', bob, bob, 'notes/file.txt');
  assert.equal(Buffer.from(a.bytes).toString(), 'Alice private'); assert.equal(Buffer.from(b.bytes).toString(), 'Bob private');
  assert.ok(a.file.key.startsWith(`servers/s/users/${alice}/`));
  assert.notEqual(a.file.key, b.file.key);
  for (const action of ['info', 'read', 'link', 'send', 'copy', 'to_sandbox']) {
    await assert.rejects(f.call({ action, path: 'notes/file.txt', owner: alice, destination: 'copy', sandbox_path: '/tmp/file' }, bob), /not found or not shared/);
  }
  for (const action of ['write', 'save_attachment', 'save_sandbox', 'publish', 'unpublish', 'delete']) {
    await assert.rejects(f.call({ action, path: 'notes/file.txt', owner: alice, text: 'attack', sandbox_path: '/tmp/file' }, bob), /Omit owner/);
  }
  await assert.rejects(f.call({ action: 'info', path: 'notes/file.txt', owner: alice }, alice, 'other-server'), /not found/);
  const restored = new UserFileStorage(f.store, f.provider);
  assert.equal(Buffer.from((await restored.read('s', alice, alice, 'notes/file.txt')).bytes).toString(), 'Alice private');
});

test('publish enables discovery, inspection, DM retrieval and copying, then unpublish revokes bot access', async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.call({ action: 'save_attachment', path: 'images/input.bin' });
  assert.equal((await f.call({ action: 'list', scope: 'public' }, bob)).text, 'No matching stored files.');
  const published = await f.call({ action: 'publish', path: 'images/input.bin' });
  assert.equal(published.artifacts?.length, 1);
  const listed = await f.call({ action: 'list', scope: 'public', prefix: 'images/' }, bob);
  assert.match(listed.text, new RegExp(alice));
  const info = await f.call({ action: 'info', path: 'images/input.bin', owner: alice }, bob, 's', 'cached-public-info');
  assert.ok(!info.text.includes('servers/'));
  assert.match((await f.call({ action: 'read', path: 'images/input.bin', owner: alice, question: 'What is this?' }, bob)).text, /Inspected: What is this/);
  await f.call({ action: 'send', path: 'images/input.bin', owner: alice }, bob);
  await f.call({ action: 'send', path: 'images/input.bin', owner: alice }, bob, 's', 'saved-send');
  await f.call({ action: 'send', path: 'images/input.bin', owner: alice }, bob, 's', 'saved-send');
  assert.equal(f.counts().sends, 2);
  await f.call({ action: 'copy', path: 'images/input.bin', owner: alice, destination: 'copied.bin' }, bob);
  assert.deepEqual((await f.storage.read('s', bob, bob, 'copied.bin')).bytes, f.binary);
  assert.equal((await f.storage.entry('s', bob, bob, 'copied.bin')).file.public, false);
  assert.match((await f.call({ action: 'unpublish', path: 'images/input.bin' })).text, /until they expire/);
  await assert.rejects(f.call({ action: 'info', path: 'images/input.bin', owner: alice }, bob, 's', 'cached-public-info'), /not shared/);
  assert.equal((await f.call({ action: 'list', scope: 'public' }, bob)).text, 'No matching stored files.');
  assert.equal(f.counts().inspections, 1);
});

test('overwrite is explicit, replaces bytes with a new private object, and delete removes it', async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.call({ action: 'write', path: 'file.txt', text: 'old' });
  await f.call({ action: 'publish', path: 'file.txt' });
  const old = (await f.storage.entry('s', alice, alice, 'file.txt')).file;
  await assert.rejects(f.call({ action: 'write', path: 'file.txt', text: 'new' }), /overwrite:true/);
  assert.equal(f.objects.size, 1);
  await f.call({ action: 'write', path: 'file.txt', text: 'new', overwrite: true });
  const latest = await f.storage.read('s', alice, alice, 'file.txt');
  assert.equal(Buffer.from(latest.bytes).toString(), 'new');
  assert.notEqual(latest.file.key, old.key); assert.equal(latest.file.public, false); assert.equal(f.objects.has(old.key), false);
  await f.call({ action: 'delete', path: 'file.txt' });
  assert.equal(f.objects.size, 0);
  await assert.rejects(f.storage.read('s', alice, alice, 'file.txt'), /not found/);
  await f.call({ action: 'write', path: 'file.txt', text: 'recreated' });
});

test('paths, MIME types, upload size and signing lifetimes are bounded', async t => {
  const f = setup(); t.after(() => f.store.close());
  for (const path of ['/absolute', '../escape', 'x/../y', 'x//y', 'x\\y', 'x\0y', 'a/./b']) await assert.rejects(f.call({ action: 'write', path, text: 'x' }), ToolError);
  await assert.rejects(f.call({ action: 'write', path: 'x', text: 'x', content_type: 'text/plain\r\nInjected: value' }), /MIME/);
  f.services.fetcher.fetch = async () => new Uint8Array(MAX_STORED_FILE_BYTES + 1);
  // Register a separate definition to capture the injected oversized fetcher.
  const registry = new ToolRegistry(f.store, async () => true); registry.register(objectStorageTool(f.services));
  await assert.rejects(registry.invokeResult(message, 'file_store', { action: 'save_attachment', path: 'huge' }, 'huge', 'agent'), /10 MiB/);
  assert.equal(f.objects.size, 0);
  await f.call({ action: 'write', path: 'x', text: 'x' });
  for (const seconds of ['soon', null]) await assert.rejects(f.call({ action: 'link', path: 'x', seconds: seconds as never }), /Invalid integer/);
  assert.match((await f.call({ action: 'link', path: 'x', seconds: 60 })).artifacts![0]!.url, /expires=60/);
});

test('paginated lists reveal only the requester files or public files in this server', async t => {
  const f = setup(); t.after(() => f.store.close());
  for (const path of ['docs/a', 'docs/b', 'other']) await f.call({ action: 'write', path, text: path });
  await f.call({ action: 'write', path: 'hidden', text: 'Bob only' }, bob);
  const page = await f.call({ action: 'list', prefix: 'docs/', limit: 1 });
  assert.match(page.text, /docs\/a/); assert.ok(!page.text.includes('docs/b'));
  assert.deepEqual((page.data as { next_offset: number }).next_offset, 1);
  assert.match((await f.call({ action: 'list', prefix: 'docs/', limit: 1, offset: 1 })).text, /docs\/b/);
  assert.ok(!(await f.call({ action: 'list' })).text.includes('hidden'));
});

test('disabled channels reject cached results, and uncertain uploads are never replayed', async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.call({ action: 'write', path: 'existing', text: 'x' });
  await f.call({ action: 'info', path: 'existing' }, alice, 's', 'info');
  f.disable(); await assert.rejects(f.call({ action: 'info', path: 'existing' }, alice, 's', 'info'), /disabled/);
  const g = setup(); t.after(() => g.store.close()); let uploads = 0;
  g.provider.put = async () => { uploads++; throw new UncertainActionError('upload result lost'); };
  await assert.rejects(g.call({ action: 'write', path: 'x', text: 'x' }, alice, 's', 'uncertain'), UncertainActionError);
  await assert.rejects(g.call({ action: 'write', path: 'x', text: 'x' }, alice, 's', 'uncertain'), UncertainActionError);
  assert.equal(uploads, 1);
});

test('changed attachment sources abort before uploading, and failed metadata commits clean uploaded blobs', async t => {
  const f = setup(); t.after(() => f.store.close()); let resolves = 0;
  f.services.resolveAttachment = async () => ({ ...f.source, text: ++resolves > 1 ? 'edited' : f.source.text });
  const registry = new ToolRegistry(f.store, async () => true); registry.register(objectStorageTool(f.services));
  await assert.rejects(registry.invokeResult(message, 'file_store', { action: 'save_attachment', path: 'changed' }, 'changed', 'agent'), /file_source_changed/);
  assert.equal(f.objects.size, 0);
  t.mock.method(f.store, 'putRecord', async () => false);
  await assert.rejects(f.call({ action: 'write', path: 'collision', text: 'x' }), /changed concurrently/);
  assert.equal(f.objects.size, 0);
});

test('stored public binary files copy into a task sandbox with permission checks on replay', async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.call({ action: 'save_attachment', path: 'input.bin' });
  await f.call({ action: 'publish', path: 'input.bin' });
  let bytes: string | Uint8Array | undefined, created = 0;
  const session = { id: 'sandbox', run: async () => ({ stdout: '', stderr: '', exitCode: 0 }), read: async () => '', readBytes: async () => f.binary, write: async (_path: string, data: string | Uint8Array) => { bytes = data; }, renew: async () => {}, close: async () => {} };
  const provider: SandboxProvider = { create: async () => { created++; return session; }, connect: async () => session };
  const registry = new ToolRegistry(f.store, async () => true);
  registry.register(objectStorageTool({ ...f.services, store: f.store, provider }));
  const args = { action: 'to_sandbox', path: 'input.bin', owner: alice, sandbox_path: '/tmp/input.bin' };
  await registry.invokeResult({ ...message, author: bob }, 'file_store', args, 'sandbox-copy', 'agent');
  assert.deepEqual(bytes, f.binary); assert.equal(created, 1);
  await f.call({ action: 'unpublish', path: 'input.bin' });
  await assert.rejects(registry.invokeResult({ ...message, author: bob }, 'file_store', args, 'sandbox-copy-denied', 'agent'), /not shared/);
});

test('unconfigured storage explains setup instead of pretending to save files', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  await assert.rejects(new UserFileStorage(store).list('s', alice, 'mine', ''), /OBJECT_STORAGE_BUCKET/);
});

test('sandbox outputs can be saved persistently and copied back into a sandbox with their binary content', async t => {
  const f = setup(); t.after(() => f.store.close());
  const written: { path: string; bytes: unknown }[] = [];
  const session = { id: 'sandbox-1', run: async () => ({ stdout: '', stderr: '', exitCode: 0 }), read: async () => '', readBytes: async () => new Uint8Array(), write: async (path: string, bytes: unknown) => { written.push({ path, bytes }); }, renew: async () => {}, close: async () => {} };
  const provider = { defaultTemplate: 'base', create: async () => session, connect: async () => session } as unknown as SandboxProvider;
  const registry = new ToolRegistry(f.store, async () => true);
  registry.register(objectStorageTool({ ...f.services, store: f.store, provider, sandbox: {
    read: async (_context, path) => { assert.equal(path, '/tmp/generated.bin'); return f.binary; },
  } }));
  await registry.invokeResult(message, 'file_store', { action: 'save_sandbox', path: 'outputs/generated.bin', sandbox_path: '/tmp/generated.bin' }, 'save-sandbox', 'agent');
  await registry.invokeResult(message, 'file_store', { action: 'to_sandbox', path: 'outputs/generated.bin', sandbox_path: '/tmp/loaded.bin' }, 'to-sandbox', 'agent');
  assert.equal(written.length, 1); assert.equal(written[0]!.path, '/tmp/loaded.bin'); assert.deepEqual(written[0]!.bytes, f.binary);
  assert.deepEqual((await f.storage.read('s', alice, alice, 'outputs/generated.bin')).bytes, f.binary);
});
