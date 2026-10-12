import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { sandboxTool, type SandboxProvider, type SandboxSession, type SandboxAttachments } from '../src/sandbox.js';
import { ToolRegistry, ToolError, UncertainActionError } from '../src/tools.js';

function setup(attachments?: SandboxAttachments) {
  const store = new SQLiteStore();
  const sessions = new Map<string, SandboxSession>();
  let created = 0, runs = 0, closed = 0;
  const provider: SandboxProvider = {
    async create(_metadata, lifetime) {
      assert.equal(lifetime, 600000);
      const files = new Map<string, string | Uint8Array>();
      const session: SandboxSession = {
        id: `workspace-${++created}`,
        async run(command, timeout) { runs++; assert.ok(timeout <= 60000); return { stdout: command, stderr: '', exitCode: command === 'false' ? 1 : 0 }; },
        async write(path, text) { files.set(path, text); },
        async read(path) { const data = files.get(path); return typeof data === 'string' ? data : Buffer.from(data ?? []).toString('utf8'); },
        async renew() {}, async close() { closed++; sessions.delete(session.id); },
      };
      sessions.set(session.id, session); return session;
    },
    async connect(id) { const session = sessions.get(id); if (!session) throw new ToolError('expired'); return session; },
  };
  const registry = new ToolRegistry(store, async () => false);
  registry.register(sandboxTool(store, provider, attachments));
  const message = { id: 'm', server: 's', channel: 'task', author: 'a', text: 'run code' };
  return { store, registry, provider, sessions, message, counts: () => ({ created, runs, closed }) };
}

test('sandbox keeps task files, isolates other tasks, journals runs and closes', async t => {
  const f = setup(); t.after(() => f.store.close());
  const invoke = (args: object, id: string) => f.registry.invoke(f.message, 'sandbox', args, id, 'agent');
  await invoke({ action: 'write', path: '/tmp/a.txt', text: 'hello' }, 'write');
  assert.equal(await invoke({ action: 'read', path: '/tmp/a.txt' }, 'read'), 'hello');
  const run = { action: 'run', command: 'false', seconds: 10 };
  assert.match(await invoke(run, 'run'), /Exit code: 1/);
  await invoke(run, 'run');
  assert.deepEqual(f.counts(), { created: 1, runs: 1, closed: 0 });
  await f.registry.invoke({ ...f.message, channel: 'other-task' }, 'sandbox', { action: 'run', command: 'ok' }, 'other', 'agent');
  assert.equal(f.counts().created, 2);
  await invoke({ action: 'close' }, 'close');
  assert.equal(f.counts().closed, 1);
  assert.match(await invoke({ action: 'status' }, 'status'), /No active/);
});

test('sandbox rejects malformed arguments and unconfigured providers without executing', async t => {
  const f = setup(); t.after(() => f.store.close());
  for (const args of [{ action: 'run' }, { action: 'run', command: 'hi', seconds: 61 }, { action: 'write', path: '../../env', text: 'x' }, { action: 'write', path: '/tmp/x' }]) {
    await assert.rejects(f.registry.invoke(f.message, 'sandbox', args, `invalid:${JSON.stringify(args)}`, 'command'), ToolError);
  }
  const registry = new ToolRegistry(f.store, async () => false); registry.register(sandboxTool(f.store));
  await assert.rejects(registry.invoke(f.message, 'sandbox', { action: 'run', command: 'hi' }, 'disabled', 'command'), /not configured/);
  assert.equal(f.counts().created, 0);
});

test('sandbox reuses recorded workspaces after reconstructing tools and recreates expired leases', async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.registry.invoke(f.message, 'sandbox', { action: 'write', path: '/tmp/x', text: 'retained' }, 'first', 'command');
  const fresh = new ToolRegistry(f.store, async () => false); fresh.register(sandboxTool(f.store, f.provider));
  assert.equal(await fresh.invoke(f.message, 'sandbox', { action: 'read', path: '/tmp/x' }, 'second', 'command'), 'retained');
  const record = (await f.store.record('s', 'sandbox', 'task'))!;
  await f.store.putRecord('s', 'sandbox', 'task', { id: 'workspace-1', expiresAt: 0 }, record.revision);
  await fresh.invoke(f.message, 'sandbox', { action: 'run', command: 'new' }, 'third', 'command');
  assert.equal(f.counts().created, 2);
});

test('lost command results remain uncertain and are not automatically replayed', async t => {
  const f = setup(); t.after(() => f.store.close());
  const provider: SandboxProvider = { ...f.provider, async create(meta, lease) {
    const session = await f.provider.create(meta, lease);
    session.run = async () => { throw new Error('connection lost'); };
    return session;
  } };
  const registry = new ToolRegistry(f.store, async () => false); registry.register(sandboxTool(f.store, provider));
  const args = { action: 'run', command: 'side effect' };
  await assert.rejects(registry.invoke(f.message, 'sandbox', args, 'lost', 'agent'), UncertainActionError);
  await assert.rejects(registry.invoke(f.message, 'sandbox', args, 'lost', 'agent'), UncertainActionError);
  assert.equal((await f.store.operation('lost'))?.status, 'started');
});

test('sandbox SDK busy responses are known failures; unknown create errors remain uncertain', async t => {
  const { Sandbox, ServiceBusyError } = await import('e2b');
  const { E2BSandboxProvider } = await import('../src/adapters/e2b-sandbox.js');
  const provider = new E2BSandboxProvider({ apiKey: 'test-only', apiUrl: 'https://api.pmservers.org/sandboxes', sandboxUrl: 'https://sandbox.pmservers.org' });
  const mock = t.mock.method(Sandbox, 'create', async () => { throw new ServiceBusyError('provider busy'); });
  await assert.rejects(provider.create({}, 600000), error => error instanceof ToolError && /capacity/.test(error.message));
  mock.mock.mockImplementation(async () => { throw new Error('private provider response'); });
  await assert.rejects(provider.create({}, 600000), error => error instanceof UncertainActionError && !error.message.includes('private'));
});


test('attachment import preserves binary bytes, reuses the workspace and journals source metadata', async t => {
  const bytes = new Uint8Array([0, 255, 128, 13, 10]);
  const source = { id: 'file-message', server: 's', channel: 'task', author: 'a', text: 'file', attachments: [{ name: 'data.bin', url: 'https://cdn.discordapp.com/file' }] };
  let downloads = 0;
  const f = setup({ resolve: async (_message, id) => { assert.equal(id, 'file-message'); return source; }, fetcher: { fetch: async attachment => { assert.equal(attachment.name, 'data.bin'); downloads++; return bytes; } } });
  t.after(() => f.store.close());
  let uploaded: string | Uint8Array | undefined;
  await f.registry.invoke(f.message, 'sandbox', { action: 'write', path: '/tmp/existing', text: 'retained' }, 'create', 'agent');
  const session = f.sessions.get('workspace-1')!;
  session.write = async (path, data) => { assert.equal(path, '/tmp/data.bin'); uploaded = data; };
  const args = { action: 'import_attachment', message_id: source.id, path: '/tmp/data.bin' };
  const result = await f.registry.invokeResult(f.message, 'sandbox', args, 'import', 'agent');
  assert.deepEqual(uploaded, bytes);
  assert.match(result.text, /5 bytes.*\/tmp\/data.bin/);
  assert.deepEqual(result.sources, [{ kind: 'message', server: 's', channel: 'task', id: source.id }]);
  await f.registry.invokeResult(f.message, 'sandbox', args, 'import', 'agent');
  assert.equal(downloads, 1);
  assert.equal(f.counts().created, 1);
  assert.equal(await session.read('/tmp/existing'), 'retained');
});

test('attachment import creates a workspace and defaults to the current or reply attachment', async t => {
  const source = { id: 'reply', server: 's', channel: 'task', author: 'a', text: 'file', attachments: [{ name: 'first', url: 'https://cdn.discordapp.com/first' }, { name: 'second', url: 'https://cdn.discordapp.com/second' }] };
  const f = setup({ resolve: async (_message, id) => { assert.ok(id === undefined || id === source.id); return source; }, fetcher: { fetch: async attachment => { assert.equal(attachment.name, 'second'); return Buffer.from('hello'); } } });
  t.after(() => f.store.close());
  await f.registry.invoke(f.message, 'sandbox', { action: 'import_attachment', attachment: 1, path: '/tmp/file' }, 'import', 'agent');
  assert.equal(await f.sessions.get('workspace-1')!.read('/tmp/file'), 'hello');
  assert.equal(f.counts().created, 1);
});

for (const failure of ['missing', 'download', 'changed', 'unauthorized']) test(`attachment import rejects ${failure} sources before creating a sandbox`, async t => {
  let resolves = 0;
  const source = { id: 'file', server: 's', channel: 'task', author: 'a', text: 'file', attachments: [{ name: 'file', url: 'https://cdn.discordapp.com/file' }] };
  const f = setup({ resolve: async () => {
    resolves++;
    if (failure === 'unauthorized') throw new ToolError('File source must be in this permitted channel.');
    return failure === 'missing' ? { ...source, attachments: [] } : failure === 'changed' && resolves > 1 ? { ...source, text: 'edited' } : source;
  }, fetcher: { fetch: async () => { if (failure === 'download') throw new ToolError('File exceeds 10 MiB'); return new Uint8Array([1]); } } });
  t.after(() => f.store.close());
  await assert.rejects(f.registry.invoke(f.message, 'sandbox', { action: 'import_attachment', path: '/tmp/file' }, 'import', 'agent'));
  assert.equal(f.counts().created, 0);
});

test('attachment import validates its path and index before downloading', async t => {
  const f = setup({ resolve: async () => { throw Error('must not resolve'); } });
  t.after(() => f.store.close());
  for (const args of [{ action: 'import_attachment' }, { action: 'import_attachment', path: '../file' }, { action: 'import_attachment', path: '/tmp/file', attachment: 20 }]) {
    await assert.rejects(f.registry.invoke(f.message, 'sandbox', args, JSON.stringify(args), 'agent'), ToolError);
  }
});

test('the SDK adapter uploads binary data as an ArrayBuffer with exact bytes', async t => {
  const { Sandbox } = await import('e2b');
  const { E2BSandboxProvider } = await import('../src/adapters/e2b-sandbox.js');
  const expected = new Uint8Array([0, 255, 128]);
  let writes = 0;
  t.mock.method(Sandbox, 'create', async () => ({ sandboxId: 'binary', files: { write: async (path: string, data: ArrayBuffer) => {
    assert.equal(path, '/tmp/file'); assert.ok(data instanceof ArrayBuffer); assert.deepEqual(new Uint8Array(data), expected); writes++;
  } } }));
  const session = await new E2BSandboxProvider({ apiKey: 'test', apiUrl: 'https://example.com', sandboxUrl: 'https://example.com' }).create({}, 600000);
  await session.write('/tmp/file', new Uint8Array([99, ...expected, 99]).subarray(1, 4));
  assert.equal(writes, 1);
});
