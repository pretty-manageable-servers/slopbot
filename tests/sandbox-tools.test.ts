import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import type { SandboxProvider, SandboxSession } from '../src/sandbox.js';
import { sandboxFileTools } from '../src/sandbox-tools.js';
import { ToolError, ToolRegistry, UncertainActionError } from '../src/tools.js';

const message = { id: 'm', server: 's', channel: 'task', author: 'a', text: 'edit files' };

function setup(options: { failRun?: boolean } = {}) {
  const store = new SQLiteStore();
  const sessions = new Map<string, SandboxSession>();
  const files = new Map<string, string>();
  const commands: string[] = [];
  const timeouts: number[] = [];
  const connectCalls: string[] = [];
  let created = 0;
  const provider: SandboxProvider = {
    defaultTemplate: 'base',
    async create() {
      const id = `workspace-${++created}`;
      const session: SandboxSession = {
        id,
        async run(command, timeout) {
          commands.push(command); timeouts.push(timeout);
          if (options.failRun && !command.startsWith('mkdir')) throw new UncertainActionError('Sandbox command timed out or its result was lost.');
          if (command.startsWith('mkdir')) return { stdout: '', stderr: '', exitCode: 0 };
          return { stdout: `ran ${command}`, stderr: '', exitCode: command === 'false' ? 1 : 0 };
        },
        async write(path, data) { files.set(`${id}:${path}`, String(data)); },
        async read(path) {
          const data = files.get(`${id}:${path}`);
          if (data === undefined) throw new ToolError(`no such file ${path}`);
          return data;
        },
        async readBytes() { return new Uint8Array(); },
        async renew() {},
        async close() { sessions.delete(id); },
      };
      sessions.set(id, session);
      return session;
    },
    async connect(id) {
      connectCalls.push(id);
      const session = sessions.get(id);
      if (!session) throw new ToolError('expired');
      return session;
    },
  };
  const registry = new ToolRegistry(store, async () => false);
  for (const tool of sandboxFileTools(store, provider)) registry.register(tool);
  const invoke = (name: string, args: object, operationId: string) => registry.invoke(message, name, args, operationId, 'agent');
  return { store, registry, provider, sessions, files, commands, timeouts, connectCalls, invoke, created: () => created };
}

test('read numbers lines of a file relative to the sandbox home', async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.invoke('write', { path: 'notes.txt', content: 'alpha\nbeta\n' }, 'w1');
  assert.equal(await f.invoke('read', { path: 'notes.txt' }, 'r1'), '1\talpha\n2\tbeta');
  assert.equal(f.files.get('workspace-1:/home/user/notes.txt'), 'alpha\nbeta\n');
});

test('read applies offset and limit and names the next offset', async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.invoke('write', { path: '/home/user/long.txt', content: 'l1\nl2\nl3\nl4\nl5\n' }, 'w1');
  const text = await f.invoke('read', { path: '/home/user/long.txt', offset: 2, limit: 2 }, 'r1');
  assert.match(text, /^2\tl2\n3\tl3\n\[Showing lines 2-3 of 5\. Use offset 4 to read more\.\]$/);
  assert.match(await f.invoke('read', { path: '/home/user/long.txt', offset: 9 }, 'r2'), /past the end/);
});

test('write creates parent directories before writing the file', async t => {
  const f = setup(); t.after(() => f.store.close());
  assert.match(await f.invoke('write', { path: '/home/user/my docs/it\'s/a.txt', content: 'hi' }, 'w1'), /Wrote \/home\/user\/my docs\/it's\/a\.txt/);
  assert.ok(f.commands.includes("mkdir -p '/home/user/my docs/it'\\''s'"));
  assert.equal(f.files.get("workspace-1:/home/user/my docs/it's/a.txt"), 'hi');
});

test('edit replaces one unique match and writes the file back', async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.invoke('write', { path: 'code.py', content: 'x = 1\ny = 2\n' }, 'w1');
  assert.match(await f.invoke('edit', { path: 'code.py', old_string: 'y = 2', new_string: 'y = $& 3' }, 'e1'), /1 of 1 matches replaced/);
  assert.equal(f.files.get('workspace-1:/home/user/code.py'), 'x = 1\ny = $& 3\n');
});

test('edit rejects zero matches and names the count found', async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.invoke('write', { path: 'code.py', content: 'x = 1\n' }, 'w1');
  await assert.rejects(f.invoke('edit', { path: 'code.py', old_string: 'z = 9', new_string: 'q' }, 'e1'), (error: unknown) => error instanceof ToolError && /Found 0 matches/.test(error.message));
});

test('edit rejects many matches without changing the file', async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.invoke('write', { path: 'code.py', content: 'a\na\n' }, 'w1');
  await assert.rejects(f.invoke('edit', { path: 'code.py', old_string: 'a', new_string: 'b' }, 'e1'), (error: unknown) => error instanceof ToolError && /occurs 2 times/.test(error.message) && /Found 2 matches/.test(error.message));
  assert.equal(f.files.get('workspace-1:/home/user/code.py'), 'a\na\n');
});

test('edit with replace_all replaces every match', async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.invoke('write', { path: 'code.py', content: 'a\na\nb\n' }, 'w1');
  assert.match(await f.invoke('edit', { path: 'code.py', old_string: 'a', new_string: 'c', replace_all: true }, 'e1'), /2 of 2 matches replaced/);
  assert.equal(f.files.get('workspace-1:/home/user/code.py'), 'c\nc\nb\n');
});

test('shell returns the exit code, stdout and stderr', async t => {
  const f = setup(); t.after(() => f.store.close());
  assert.equal(await f.invoke('shell', { command: 'ls' }, 's1'), 'Exit code: 0\nstdout:\nran ls\nstderr:\n');
  assert.match(await f.invoke('shell', { command: 'false' }, 's2'), /^Exit code: 1/);
});

test('shell passes the time limit in milliseconds and enforces its bounds', async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.invoke('shell', { command: 'ls' }, 's1');
  await f.invoke('shell', { command: 'ls', timeout_seconds: 45 }, 's2');
  assert.deepEqual(f.timeouts.slice(-2), [30000, 45000]);
  await assert.rejects(f.invoke('shell', { command: 'ls', timeout_seconds: 121 }, 's3'));
  await assert.rejects(f.invoke('shell', { command: 'ls', timeout_seconds: 0 }, 's4'));
});

test('the first call starts a sandbox and later calls reuse it', async t => {
  const f = setup(); t.after(() => f.store.close());
  assert.equal(f.created(), 0);
  assert.equal(await f.invoke('write', { path: 'a.txt', content: 'one' }, 'w1'), 'Wrote /home/user/a.txt.');
  assert.equal(f.created(), 1);
  assert.equal(await f.invoke('read', { path: 'a.txt' }, 'r1'), '1\tone');
  assert.equal(f.created(), 1);
});

test('an expired sandbox is replaced without an error and the result says so', async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.invoke('write', { path: 'a.txt', content: 'one' }, 'w1');
  const record = await f.store.record('s', 'sandbox', 'task');
  assert.ok(await f.store.putRecord('s', 'sandbox', 'task', { id: 'workspace-1', expiresAt: 0 }, record!.revision));
  const text = await f.invoke('shell', { command: 'ls' }, 's1');
  assert.match(text, /^New sandbox started; earlier files are gone\.\nExit code: 0/);
  assert.equal(f.created(), 2);
});

test('a sandbox that cannot be connected is retried once, then replaced with a notice', async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.invoke('write', { path: 'a.txt', content: 'one' }, 'w1');
  f.sessions.delete('workspace-1');
  const text = await f.invoke('shell', { command: 'ls' }, 's1');
  assert.match(text, /^New sandbox started; earlier files are gone\.\nExit code: 0/);
  assert.deepEqual(f.connectCalls, ['workspace-1', 'workspace-1']);
  assert.equal(f.created(), 2);
  const record = await f.store.record('s', 'sandbox', 'task');
  assert.equal((record?.value as { id?: string }).id, 'workspace-2');
});

test('a sandbox whose connect fails once is reconnected without replacement', async t => {
  const f = setup(); t.after(() => f.store.close());
  await f.invoke('write', { path: 'a.txt', content: 'one' }, 'w1');
  const kept = f.sessions.get('workspace-1')!;
  f.sessions.delete('workspace-1');
  setTimeout(() => f.sessions.set('workspace-1', kept), 300);
  assert.match(await f.invoke('shell', { command: 'ls' }, 's1'), /^Exit code: 0/);
  assert.deepEqual(f.connectCalls, ['workspace-1', 'workspace-1']);
  assert.equal(f.created(), 1);
});

test('shell returns a timeout result instead of an error when the run times out', async t => {
  const f = setup({ failRun: true }); t.after(() => f.store.close());
  assert.equal(await f.invoke('shell', { command: 'sleep 99', timeout_seconds: 7 }, 's1'), 'Exit code: 124 (timed out after 7 s). The command may still run in the sandbox.');
});

test('the file tools are top-level, member-only and inline', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const tools = sandboxFileTools(store);
  assert.deepEqual(tools.map(tool => tool.name), ['read', 'write', 'edit', 'shell']);
  for (const tool of tools) {
    assert.equal(tool.surface, 'top');
    assert.equal(tool.access, 'member');
    assert.equal(tool.execution, 'inline');
  }
  assert.equal(tools.find(tool => tool.name === 'read')?.effect, 'read');
  assert.ok(tools.filter(tool => tool.name !== 'read').every(tool => tool.effect === 'write'));
});
