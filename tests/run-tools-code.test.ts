import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { Application } from '../src/application.js';
import type { Json } from '../src/domain.js';
import { runToolsCodeTool } from '../src/run-tools-code.js';
import type { SandboxProvider, SandboxSession } from '../src/sandbox.js';
import { ToolRegistry, type ToolContext, type ToolDefinition, type ToolExecutor, type ToolResult } from '../src/tools.js';
import type { ToolActivity } from '../src/tool-activity.js';
import type { LLM } from '../src/ports.js';

const request = { server: 's', channel: 'c', taskId: 'c', id: 'm', author: 'alice', text: 'Compare the results.' };
const privateRequest = { ...request, channel: 'web:private' };
const readTool = (name: string, execute: ToolDefinition['execute'], extra: Partial<ToolDefinition> = {}): ToolDefinition =>
  ({ name, description: 'Structured read.', fields: {}, access: 'member', effect: 'read', retrySafe: true, execute, ...extra });
const outputs = (result: ToolResult) => (result.data as { outputs: Json[] }).outputs;
const codeSchema = (registry: ToolRegistry, message = request) => registry.schemas(message).find(tool => tool.function.name === 'run_tools_code')!;

test('catalog_same_for_admin_and_member', async t => {
  const descriptions: string[] = [];
  for (const admin of [true, false]) {
    const store = new SQLiteStore(); t.after(() => store.close());
    const registry = new ToolRegistry(store, async () => admin);
    registry.register(readTool('read_items', async () => ({ text: 'ok' }), { fields: { id: { type: 'string', description: 'Id', required: true } } }));
    registry.register(readTool('admin_items', async () => ({ text: 'x' }), { access: 'admin' }));
    registry.register(runToolsCodeTool(registry));
    descriptions.push(JSON.stringify(codeSchema(registry, admin ? request : privateRequest)));
  }
  assert.equal(descriptions[0], descriptions[1]);
});

test('catalog_sorted', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  registry.register(readTool('zeta', async () => ({ text: 'z' })));
  registry.register(readTool('alpha', async () => ({ text: 'a' })));
  registry.register(readTool('top_tool', async () => ({ text: 't' }), { surface: 'top' }));
  registry.register(runToolsCodeTool(registry));
  const names = [...codeSchema(registry).function.description.matchAll(/^- (\w+)\(/gm)].map(match => match[1]);
  assert.deepEqual(names, ['alpha', 'zeta']);
});

test('catalog_excludes_discovery', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  registry.register(readTool('core_read', async () => ({ text: 'core' })));
  registry.register(readTool('mcp_list', async () => ({ text: 'listed', data: { ok: true } }), { surface: 'discovery', provider: 'mcp:github' }));
  registry.register(runToolsCodeTool(registry));
  const description = codeSchema(registry).function.description;
  assert.match(description, /core_read\(/);
  assert.doesNotMatch(description, /mcp_list/);
  const result = await registry.invokeResult(request, 'run_tools_code', { code: 'text(await tools.mcp_list({}));' }, 'discovery-call', 'agent');
  assert.deepEqual(outputs(result), [{ ok: true }]);
});

test('list_tools_filters_access', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  let admin = false;
  const registry = new ToolRegistry(store, async () => admin);
  registry.register(readTool('member_read', async () => ({ text: 'm' })));
  registry.register(readTool('admin_read', async () => ({ text: 'a' }), { access: 'admin' }));
  registry.register(readTool('discovery_read', async () => ({ text: 'd' }), { surface: 'discovery', provider: 'mcp:github' }));
  registry.register(readTool('discord_read', async () => ({ text: 'x' }), { scope: 'discord' }));
  registry.register(runToolsCodeTool(registry));
  const code = 'text((await list_tools()).map(tool => tool.name));';
  assert.deepEqual(outputs(await registry.invokeResult(request, 'run_tools_code', { code }, 'member-list', 'agent')), [['discord_read', 'discovery_read', 'member_read']]);
  assert.deepEqual(outputs(await registry.invokeResult(privateRequest, 'run_tools_code', { code }, 'private-list', 'agent')), [['discovery_read', 'member_read']]);
  admin = true;
  assert.deepEqual(outputs(await registry.invokeResult(request, 'run_tools_code', { code }, 'admin-list', 'agent')), [['admin_read', 'discord_read', 'discovery_read', 'member_read']]);
});

test('describe_tool_mcp returns the full field schema of a discovery tool', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  const inputSchema: Json = { type: 'object', properties: { repo: { type: 'string' } }, required: ['repo'], additionalProperties: false };
  registry.register(readTool('mcp_issues', async (_context, args) => ({ text: 'issues', data: { repo: String(args.repo) } }), {
    surface: 'discovery', provider: 'mcp:github', description: 'List issues. Read only.', inputSchema, validate: args => args,
    fields: { repo: { type: 'string', description: 'Repository', required: true } },
  }));
  registry.register(runToolsCodeTool(registry));
  const result = await registry.invokeResult(request, 'run_tools_code', { code: 'text(await describe_tool("mcp_issues"));text(await tools.mcp_issues({repo:"a/b"}));' }, 'describe', 'agent');
  const [described, called] = outputs(result) as [{ fields: { repo: { required: boolean } }; inputSchema: Json }, Json];
  assert.equal(described.fields.repo.required, true);
  assert.deepEqual(described.inputSchema, inputSchema);
  assert.deepEqual(called, { repo: 'a/b' });
});

test('save_to_sandbox_writes', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const files = new Map<string, string>();
  const session: SandboxSession = {
    id: 'workspace-1',
    async run() { return { stdout: '', stderr: '', exitCode: 0 }; },
    async read(path) { return files.get(path) ?? ''; },
    async readBytes() { return new Uint8Array(); },
    async write(path, data) { files.set(path, typeof data === 'string' ? data : Buffer.from(data).toString('utf8')); },
    async renew() {}, async close() {},
  };
  const sandbox: SandboxProvider = { defaultTemplate: 'base', async create() { return session; }, async connect() { return session; } };
  const registry = new ToolRegistry(store, async () => true);
  registry.register(runToolsCodeTool(registry, { store, sandbox }));
  const code = `await save_to_sandbox("notes/a.txt", {x:1}); await save_to_sandbox("/home/user/b.txt", "plain");
    try { await save_to_sandbox("/etc/x", "no"); } catch (error) { text("blocked"); }`;
  assert.deepEqual(outputs(await registry.invokeResult(request, 'run_tools_code', { code }, 'save', 'agent')), ['blocked']);
  assert.equal(files.get('/home/user/notes/a.txt'), '{"x":1}');
  assert.equal(files.get('/home/user/b.txt'), 'plain');
  assert.equal(files.has('/etc/x'), false);
});

test('write_tool_allowed and write_retry_same_operation_id', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  let puts = 0, flaky = 0;
  registry.register({ name: 'put', description: 'Write a value.', fields: { v: { type: 'integer', description: 'Value', required: true } }, access: 'member', effect: 'write', retrySafe: true,
    execute: async (_context, args) => { puts++; return { text: 'written', data: { v: args.v ?? null } }; } });
  registry.register(readTool('flaky', async () => { if (++flaky === 1) throw Error('temporary outage'); return { text: 'second', data: { value: 3 } }; }));
  registry.register(runToolsCodeTool(registry));
  const code = 'await tools.put({v:2}); const r = await tools.flaky({}); text(r.value);';
  await assert.rejects(registry.invokeResult(request, 'run_tools_code', { code }, 'write-retry', 'agent'), /transient tool failure/);
  assert.deepEqual(outputs(await registry.invokeResult(request, 'run_tools_code', { code }, 'write-retry', 'agent')), [3]);
  assert.equal(puts, 1); assert.equal(flaky, 2);
});

test('confirm_tool_stops_program', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const saved = new Map<string, Json>();
  const registry = new ToolRegistry(store, async () => true);
  let removed = 0, other = 0;
  registry.register({ name: 'remove', description: 'Remove a channel.', fields: { id: { type: 'string', description: 'Channel', required: true } }, access: 'member', effect: 'write', retrySafe: true,
    confirm: () => true, execute: async (_context, args) => { removed++; return { text: 'removed', data: { id: args.id ?? null } }; } });
  registry.register(readTool('other', async () => { other++; return { text: 'other' }; }));
  registry.register(runToolsCodeTool(registry, { confirmations: { record: async (_server, operationId) => saved.get(operationId), save: async (_server, operationId, value) => { saved.set(operationId, value); } } }));
  const code = 'try { await tools.remove({id:"c1"}); } catch (error) { text("caught"); } await tools.other({}); text("after");';
  const result = await registry.invokeResult(request, 'run_tools_code', { code }, 'confirm-run', 'agent');
  assert.equal(result.text, 'Waiting for alice to confirm remove. The bot posted Confirm and Cancel buttons.');
  assert.equal(removed, 0); assert.equal(other, 0);
  const [operationId] = [...saved.keys()];
  assert.ok(operationId);
  assert.equal((saved.get(operationId!) as { name: string }).name, 'remove');
  // The Confirm button runs that one call with its operation ID.
  await registry.invokeResult(request, 'remove', { id: 'c1' }, operationId!, 'agent');
  assert.equal(removed, 1);
});

test('cancelled_confirm_not_repeated', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const saved = new Map<string, Json>();
  const registry = new ToolRegistry(store, async () => true);
  let removed = 0, asked = 0;
  registry.register({ name: 'remove', description: 'Remove a channel.', fields: { id: { type: 'string', description: 'Channel', required: true } }, access: 'member', effect: 'write', retrySafe: true,
    confirm: () => true, execute: async (_context, args) => { removed++; return { text: 'removed', data: { id: args.id ?? null } }; } });
  const tool = runToolsCodeTool(registry, { confirmations: { record: async (_server, operationId) => saved.get(operationId), save: async (_server, operationId, value) => { asked++; saved.set(operationId, value); } } });
  registry.register(tool);
  const code = 'text(await tools.remove({id:"c1"}));';
  assert.equal((await registry.invokeResult(request, 'run_tools_code', { code }, 'confirm-run', 'agent')).text, 'Waiting for alice to confirm remove. The bot posted Confirm and Cancel buttons.');
  assert.equal(asked, 1);
  const [operationId] = [...saved.keys()];
  // The Cancel button writes the record as done and cancelled.
  saved.set(operationId!, { done: true, cancelled: true });
  // The same program runs again with the same parent operation and no child journal entry, as after an interruption.
  const context = { message: request, operationId: 'confirm-run', isAdmin: true, source: 'agent', toolName: 'run_tools_code', arguments: { code }, resource: null, assertActive: async () => {} } as unknown as ToolContext;
  const again = await tool.execute(context, { code }) as ToolResult;
  assert.deepEqual(outputs(again), ['Cancelled by alice. Ask before trying again.']);
  assert.equal(asked, 1); assert.equal(removed, 0);
});

test('policy_change_continues', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  registry.replaceProvider('p', [readTool('calc', async () => ({ text: 'v1', data: { v: 1 } }), { provider: 'p' })]);
  registry.register(readTool('first', async () => {
    registry.replaceProvider('p', [readTool('calc', async () => ({ text: 'v2', data: { v: 2 } }), { provider: 'p' })]);
    return { text: 'first', data: { v: 0 } };
  }));
  registry.register(runToolsCodeTool(registry));
  const result = await registry.invokeResult(request, 'run_tools_code', { code: 'const a = await tools.first({}); const b = await tools.calc({}); text([a.v, b.v]);' }, 'policy', 'agent');
  assert.deepEqual(outputs(result), [[0, 2]]);
});

test('access_lost_fails', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  let admin = true, guarded = 0;
  const registry = new ToolRegistry(store, async () => admin);
  registry.register(readTool('revoke', async () => { admin = false; return { text: 'Revoked', data: {} }; }));
  registry.register(readTool('secret', async () => { guarded++; return { text: 'secret', data: { secret: true } }; }, { access: 'admin' }));
  registry.register(runToolsCodeTool(registry));
  const result = await registry.invokeResult(request, 'run_tools_code', { code: 'await tools.revoke({});try {await tools.secret({});}catch{}text("partial");' }, 'permissions', 'agent');
  assert.equal(guarded, 0);
  assert.ok(result.text.startsWith('Incomplete program result'));
  assert.equal((result.data as { failures: unknown[] }).failures.length, 1);
});

test('discord_scope_blocks_private_chat', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  let ran = 0;
  registry.register(readTool('discord_write', async () => { ran++; return { text: 'ran', data: {} }; }, { scope: 'discord', effect: 'write' }));
  registry.register(runToolsCodeTool(registry));
  await assert.rejects(registry.invokeResult(privateRequest, 'run_tools_code', { code: 'await tools.discord_write({});text("done");' }, 'private', 'agent'), /only available in Discord/);
  assert.equal(ran, 0);
});

test('child_activity_parent_id', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  registry.register(readTool('read_a', async () => ({ text: 'a', data: { v: 1 } })));
  registry.register(runToolsCodeTool(registry));
  const events: ToolActivity[] = [];
  const code = 'text(await tools.read_a({}));';
  await registry.invokeResult(request, 'run_tools_code', { code }, 'parent-act', 'agent', undefined, { onActivity: async event => { events.push(event); } });
  assert.equal(events.find(event => event.id === 'parent-act' && event.code)?.code, code);
  const child = events.find(event => event.name === 'read_a' && event.status === 'completed');
  assert.equal(child?.parentId, 'parent-act');
});

test('the agent loop receives reduced output and child evidence, not intermediate payloads', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  await store.ingest({ ...request, id: 'evidence', text: 'Evidence' });
  const registry = new ToolRegistry(store, async () => true);
  registry.register(readTool('read', async () => ({ text: 'intermediate', data: { values: [1, 2, 3], largeIntermediate: 'RAW'.repeat(10000) }, sources: [{ kind: 'message', server: 's', channel: 'c', id: 'evidence' }] })));
  registry.register(runToolsCodeTool(registry));
  let rounds = 0;
  const llm: LLM = { async *stream(prompt) {
    if (++rounds === 1) yield { kind: 'tool_call', payload: [{ name: 'run_tools_code', arguments: { code: 'const r=await tools.read({});text({sum:r.values.reduce((a,b)=>a+b,0)});' } }] };
    else {
      const trace = JSON.stringify(prompt.inputs);
      assert.ok(trace.includes('sum')); assert.ok(!trace.includes('RAWRAW'));
      yield { kind: 'text', payload: { text: 'The sum is 6.' } };
    }
  } };
  const executor: ToolExecutor = { schemas: () => [], catalog: () => registry.catalog(), execute: (message, call, id, version, invocation) => registry.invokeResult(message, call.name, call.arguments, id, 'agent', version, invocation) };
  const app = new Application(store, llm, { allowedChannels: [{ server: 's', channel: 'c' }] }, undefined, { tools: executor });
  const reply = await app.handle(request); assert.equal(reply?.text, 'The sum is 6.');
  const result = store.agentTurns(request)[0]!.results['0'] as ToolResult;
  assert.equal(result.sources![0]!.kind, 'message'); assert.equal((result.data as { calls: number }).calls, 1);
  const output = { ...request, id: 'out', text: reply!.text };
  await store.ingest(output); await store.linkOutput(output, reply!.runId, request.id);
  await store.remove('s', 'c', 'evidence'); assert.equal(store.canonicalMessage('s', 'out'), undefined);
});

test('interrupting an agent program terminates its worker and stops subsequent reads', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  let started!: () => void, complete!: () => void, calls = 0;
  const ready = new Promise<void>(resolve => { started = resolve; }), finish = new Promise<void>(resolve => { complete = resolve; });
  registry.register(readTool('read', async () => { calls++; started(); await finish; return { text: 'read', data: {} }; }));
  registry.register(runToolsCodeTool(registry));
  const llm: LLM = { async *stream() { yield { kind: 'tool_call', payload: [{ name: 'run_tools_code', arguments: { code: 'await tools.read({});await tools.read({});text("done");' } }] }; } };
  const app = new Application(store, llm, { allowedChannels: [{ server: 's', channel: 'c' }] }, undefined, { tools: { schemas: () => [], catalog: () => registry.catalog(), execute: (message, call, id, version, invocation) => registry.invokeResult(message, call.name, call.arguments, id, 'agent', version, invocation) } });
  const handle = app.handle(request), interrupted = assert.rejects(handle, /interrupted/);
  await ready; assert.equal(await app.interrupt('s', request.id), true); await interrupted;
  complete(); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
});

test('bare_name_call', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  registry.register(readTool('echo_items', async (_context, args) => ({ text: 'echo', data: { n: args.n ?? null } }), { fields: { n: { type: 'integer', description: 'Count', required: true } } }));
  // A tool named like a JavaScript global keeps the global; it is still callable as tools.NAME.
  registry.register(readTool('escape', async () => ({ text: 'escaped', data: { ok: true } })));
  registry.register(runToolsCodeTool(registry));
  const result = await registry.invokeResult(request, 'run_tools_code', { code: 'text([await echo_items({n:12}), await tools.echo_items({n:3}), await tools.escape({}), typeof escape]);' }, 'bare', 'agent');
  assert.deepEqual(outputs(result), [[{ n: 12 }, { n: 3 }, { ok: true }, 'function']]);
});

test('no_args_call', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  registry.register(readTool('ping', async () => ({ text: 'pong', data: { ok: true } })));
  registry.register(runToolsCodeTool(registry));
  const result = await registry.invokeResult(request, 'run_tools_code', { code: 'text([await ping(), await tools.ping(), await ping(undefined)]);' }, 'noargs', 'agent');
  assert.deepEqual(outputs(result), [[{ ok: true }, { ok: true }, { ok: true }]]);
});

test('scalar_arg_wrapped', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  // One required argument: a bare string is wrapped as { id }.
  registry.register(readTool('lookup', async (_context, args) => ({ text: 'ok', data: args }), { fields: { id: { type: 'string', description: 'Id', required: true } } }));
  // One required json argument: a bare array is wrapped as { ids }.
  registry.register(readTool('batch', async (_context, args) => ({ text: 'ok', data: args }), { fields: { ids: { type: 'json', description: 'Ids', required: true } } }));
  // Only one argument, optional: a bare number is wrapped as { n }.
  registry.register(readTool('limit_only', async (_context, args) => ({ text: 'ok', data: args }), { fields: { n: { type: 'integer', description: 'Count' } } }));
  registry.register(runToolsCodeTool(registry));
  const code = 'text([await lookup("abc"), await batch([1,2]), await limit_only(4)]);';
  assert.deepEqual(outputs(await registry.invokeResult(request, 'run_tools_code', { code }, 'wrap', 'agent')), [[{ id: 'abc' }, { ids: [1, 2] }, { n: 4 }]]);
});

test('bad_arg_lists_fields', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  // Two required arguments: a bare value is not wrapped, so the error lists the names.
  registry.register(readTool('pair', async () => ({ text: 'ok', data: {} }), { fields: { a: { type: 'integer', description: 'A', required: true }, b: { type: 'integer', description: 'B', required: true } } }));
  registry.register(readTool('ping', async () => ({ text: 'pong', data: {} })));
  registry.register(runToolsCodeTool(registry));
  const code = `const messages = [];
    try { await pair(5); } catch (error) { messages.push(error.message); }
    try { await ping(5); } catch (error) { messages.push(error.message); }
    text(messages);`;
  const [messages] = outputs(await registry.invokeResult(request, 'run_tools_code', { code }, 'bad-args', 'agent')) as [string[]];
  assert.match(messages![0]!, /pair takes: a \(required\), b \(required\)\./);
  assert.match(messages![1]!, /ping takes: no arguments\./);
});
