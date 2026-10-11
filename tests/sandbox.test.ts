import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { sandboxTool, type SandboxProvider, type SandboxSession } from '../src/sandbox.js';
import { ToolRegistry, ToolError, UncertainActionError } from '../src/tools.js';

function setup() {
  const store = new SQLiteStore();
  const sessions = new Map<string, SandboxSession>();
  let created = 0, runs = 0, closed = 0;
  const provider: SandboxProvider = {
    async create(_metadata, lifetime) {
      assert.equal(lifetime, 600000);
      const files = new Map<string, string>();
      const session: SandboxSession = {
        id: `workspace-${++created}`,
        async run(command, timeout) { runs++; assert.ok(timeout <= 60000); return { stdout: command, stderr: '', exitCode: command === 'false' ? 1 : 0 }; },
        async write(path, text) { files.set(path, text); },
        async read(path) { return files.get(path) ?? ''; },
        async renew() {}, async close() { closed++; sessions.delete(session.id); },
      };
      sessions.set(session.id, session); return session;
    },
    async connect(id) { const session = sessions.get(id); if (!session) throw new ToolError('expired'); return session; },
  };
  const registry = new ToolRegistry(store, async () => false);
  registry.register(sandboxTool(store, provider));
  const message = { id: 'm', server: 's', channel: 'task', author: 'a', text: 'run code' };
  return { store, registry, provider, message, counts: () => ({ created, runs, closed }) };
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
