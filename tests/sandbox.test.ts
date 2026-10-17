import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { sandboxManageTool, type SandboxProvider, type SandboxSession, type SandboxTemplateSpec } from '../src/sandbox.js';
import { sandboxFileTools } from '../src/sandbox-tools.js';
import { ToolRegistry, ToolError, UncertainActionError } from '../src/tools.js';

function setup() {
  const store = new SQLiteStore();
  const sessions = new Map<string, SandboxSession>();
  let created = 0, closed = 0;
  const builds: SandboxTemplateSpec[] = [];
  const provider: SandboxProvider = {
    defaultTemplate: 'base',
    async buildTemplate(spec) { builds.push(spec); },
    async listTemplates() { return ['base', 'analysis:v2']; },
    async create(_metadata, lifetime) {
      assert.equal(lifetime, 600000);
      const session: SandboxSession = {
        id: `workspace-${++created}`,
        async run(command) { return { stdout: command, stderr: '', exitCode: 0 }; },
        async write() {}, async read() { return ''; }, async readBytes() { return new Uint8Array(); },
        async renew() {}, async close() { closed++; sessions.delete(session.id); },
      };
      sessions.set(session.id, session);
      return session;
    },
    async connect(id) { const session = sessions.get(id); if (!session) throw new ToolError('expired'); return session; },
  };
  const registry = new ToolRegistry(store, async () => false);
  registry.register(sandboxManageTool(store, provider));
  for (const tool of sandboxFileTools(store, provider)) registry.register(tool);
  const message = { id: 'm', server: 's', channel: 'task', author: 'a', text: 'run code' };
  return { store, registry, provider, builds, message, counts: () => ({ created, closed }) };
}

test('sandbox_manage rejects invalid arguments before the provider is called', async t => {
  const f = setup(); t.after(() => f.store.close());
  const invalid = [
    { action: 'build_template' }, { action: 'build_template', template: 'bad name' },
    { action: 'build_template', template: 'ok', apt_packages: ['curl; whoami'] },
    { action: 'build_template', template: 'ok', pip_packages: ['--index-url'] },
    { action: 'build_template', template: 'ok', pip_packages: ['numpy>=2'] },
    { action: 'status', template: 'ok' }, { action: 'close', pip_packages: ['numpy'] },
  ];
  for (const [index, args] of invalid.entries()) await assert.rejects(f.registry.invoke(f.message, 'sandbox_manage', args, `bad-${index}`, 'agent'), ToolError);
  assert.equal(f.builds.length, 0);
  assert.equal(f.counts().created, 0);
});

test('sandbox create maps a refused request to a plain tool error; timeouts and server errors stay uncertain', async t => {
  const { createServer } = await import('node:http');
  const { E2BSandboxProvider } = await import('../src/adapters/e2b-sandbox.js');
  const seen: string[] = [];
  let status = 404;
  const server = createServer((request, response) => {
    seen.push(`${request.method} ${request.url}`);
    response.writeHead(status, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ code: status, message: 'private backend detail' }));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise<void>(resolve => server.close(() => resolve())));
  const { port } = server.address() as import('node:net').AddressInfo;
  const provider = new E2BSandboxProvider({ apiKey: 'test-only', apiUrl: `http://127.0.0.1:${port}`, sandboxUrl: `http://127.0.0.1:${port}` });

  await assert.rejects(provider.create({}, 600000, 'python'), error => error instanceof ToolError && error.status === 'rejected');
  assert.deepEqual(seen, ['POST /v2/sandboxes']);
  assert.ok(!(await rejection(provider.create({}, 600000, 'python'))).message.includes('private backend detail'));

  status = 400;
  await assert.rejects(provider.create({}, 600000, 'bad name'), error => error instanceof ToolError);
  status = 403;
  await assert.rejects(provider.create({}, 600000), error => error instanceof ToolError && error.status === 'failed');
  status = 408;
  await assert.rejects(provider.create({}, 600000), UncertainActionError);
});

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try { await promise; } catch (error) { return error as Error; }
  throw new Error('expected a rejection');
}

