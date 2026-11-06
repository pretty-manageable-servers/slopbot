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

test('sandbox_manage builds and lists templates without replacing the task sandbox', async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.registry.invoke(f.message, 'shell', { command: 'echo keep' }, 'start', 'agent');
  const build = { action: 'build_template', template: 'analysis:v2', apt_packages: ['ffmpeg', 'ffmpeg'], pip_packages: ['numpy==2.0.0'] };
  await f.registry.invoke(f.message, 'sandbox_manage', build, 'build', 'agent');
  assert.deepEqual(f.builds, [{ name: 'analysis:v2', aptPackages: ['ffmpeg'], pipPackages: ['numpy==2.0.0'] }]);
  assert.equal(f.counts().created, 1);
  assert.match(await f.registry.invoke(f.message, 'sandbox_manage', { action: 'templates' }, 'list', 'command'), /analysis:v2/);
});

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

test('status and close never start a sandbox', async t => {
  const f = setup(); t.after(() => f.store.close());
  assert.match(await f.registry.invoke(f.message, 'sandbox_manage', { action: 'status' }, 'status-empty', 'command'), /No active sandbox/);
  assert.match(await f.registry.invoke(f.message, 'sandbox_manage', { action: 'close' }, 'close-empty', 'command'), /No active sandbox/);
  assert.equal(f.counts().created, 0);
  await f.registry.invoke(f.message, 'shell', { command: 'ok' }, 'start', 'agent');
  assert.match(await f.registry.invoke(f.message, 'sandbox_manage', { action: 'status' }, 'status', 'command'), /is connected/);
  assert.equal(await f.registry.invoke(f.message, 'sandbox_manage', { action: 'close' }, 'close', 'agent'), 'Sandbox closed. Its files and processes are gone.');
  assert.equal(f.counts().closed, 1);
  assert.match(await f.registry.invoke(f.message, 'sandbox_manage', { action: 'status' }, 'status-after', 'command'), /No active sandbox/);
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

test('template build failures do not advertise success; lost responses remain uncertain', async t => {
  const {TemplateBase, BuildError, NotFoundError} = await import('e2b');
  const {E2BSandboxProvider} = await import('../src/adapters/e2b-sandbox.js');
  const provider = new E2BSandboxProvider({apiKey:'test-only',apiUrl:'https://api.pmservers.org/sandboxes',sandboxUrl:'https://sandbox.pmservers.org'});
  const build = t.mock.method(TemplateBase, 'build', async () => {throw new BuildError('build failed');});
  await assert.rejects(provider.buildTemplate({name:'broken',aptPackages:[],pipPackages:[]}), ToolError);
  build.mock.mockImplementation(async () => {throw Error('response lost');});
  await assert.rejects(provider.buildTemplate({name:'unknown',aptPackages:[],pipPackages:[]}), UncertainActionError);
  const {Sandbox} = await import('e2b');
  t.mock.method(Sandbox, 'create', async () => {throw new NotFoundError('missing template');});
  await assert.rejects(provider.create({},600000,'missing'), error => error instanceof ToolError && /template/.test(error.message));
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

  await assert.rejects(provider.create({}, 600000, 'python'), error => error instanceof ToolError && error.status === 'rejected'
    && error.message === 'Sandbox template "python" does not exist. Use action "templates" to list templates, or omit template to use the default.');
  assert.deepEqual(seen, ['POST /v2/sandboxes']);
  assert.ok(!(await rejection(provider.create({}, 600000, 'python'))).message.includes('private backend detail'));

  status = 400;
  await assert.rejects(provider.create({}, 600000, 'bad name'), error => error instanceof ToolError && /HTTP 400\)\. No sandbox was created/.test(error.message));
  status = 403;
  await assert.rejects(provider.create({}, 600000), error => error instanceof ToolError && error.status === 'failed' && /HTTP 403/.test(error.message));
  status = 408;
  await assert.rejects(provider.create({}, 600000), UncertainActionError);
});

async function rejection(promise: Promise<unknown>): Promise<Error> {
  try { await promise; } catch (error) { return error as Error; }
  throw new Error('expected a rejection');
}

