import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { Application } from '../src/application.js';
import { programTool } from '../src/program-tools.js';
import { ToolError, ToolRegistry, type ToolDefinition, type ToolExecutor, type ToolResult } from '../src/tools.js';
import { McpManager, mcpSchemaHash, mcpToolName, type McpTool } from '../src/mcp.js';
import { registerWebSearch } from '../src/web-search.js';
import type { Json } from '../src/domain.js';
import type { LLM } from '../src/ports.js';

const request = { server: 's', channel: 'c', taskId: 'c', id: 'm', author: 'alice', text: 'Compare the results.' };
const readTool = (name: string, execute: ToolDefinition['execute']): ToolDefinition => ({ name, description: 'Structured read', fields: {}, access: 'member', effect: 'read', retrySafe: true, programmatic: true, outputSchema: { type: 'object' }, execute });

test('private chats retain read-only catalogs and programs cannot bypass write restrictions', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  let writes = 0;
  registry.register(readTool('read', async () => ({ text: 'Read', data: { value: 1 } })));
  registry.register({ ...readTool('mixed', async () => { writes++; return { text: 'Written', data: {} }; }),
    fields: { action: { type: 'string', required: true, description: 'Action', choices: ['read', 'write'] } }, writes: args => args.action === 'write' });
  registry.register(programTool(registry));
  const message = { ...request, channel: 'web:private' };
  const selected = registry.capture();
  const catalog = JSON.parse(selected.catalog(message)) as { name: string; programmatic: boolean }[];
  assert.equal(catalog.find(tool => tool.name === 'read')?.programmatic, true);
  assert.equal(catalog.some(tool => tool.name === 'mixed'), false);
  assert.match(selected.schemas(message).find(tool => tool.function.name === 'read')!.function.description, /program_exec/);
  await assert.rejects(registry.invokeResult(message, 'mixed', { action: 'write' }, 'private-direct', 'agent'), /not available in private chats/);
  await assert.rejects(registry.invokeResult(message, 'program_exec', { tools: ['mixed'], code: 'await tools.mixed({action:"write"});' }, 'private-program', 'agent'), /cannot execute writes/);
  assert.equal(writes, 0);
});

test('a program composes native search with two MCP servers and preserves evidence and child journals', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  const remote: McpTool = { name: 'list_issues', inputSchema: { type: 'object', additionalProperties: false }, outputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'] } };
  const manager = new McpManager('s', store, registry, async config => ({ listTools: async () => [remote], callTool: async () => ({ content: [], structuredContent: { count: config.id === 'github' ? 2 : 5 } }), close: async () => {} }));
  t.after(() => manager.close());
  for (const id of ['github', 'tickets']) await manager.configure('admin', { action: 'save', id, url: `https://${id}.example/mcp`, transport: 'http', enabled: true, tools: [{ name: remote.name, schemaHash: mcpSchemaHash(remote), effect: 'read', access: 'member' }] });
  registerWebSearch(registry, { search: async () => [{ title: 'Reference', url: 'https://example.com/reference', snippet: 'Documentation' }] });
  registry.register(programTool(registry));
  const names = [mcpToolName('github', remote.name), mcpToolName('tickets', remote.name), 'web_search'];
  const activity: string[] = [];
  const result = await registry.invokeResult(request, 'program_exec', { tools: names, code: `
    const [a,b,search]=await Promise.all([tools.${names[0]}({}),tools.${names[1]}({}),tools.web_search({query:"reference"})]);
    text({total:a.count+b.count, reference:search.results[0].url});
  ` }, 'program', 'agent', undefined, { onActivity: async event => { activity.push(`${event.name}:${event.status}`); } });
  assert.deepEqual((result.data as { outputs: Json[] }).outputs, [{ total: 7, reference: 'https://example.com/reference' }]);
  assert.ok(result.sources?.some(source => source.kind === 'web' && source.url === 'https://example.com/reference'));
  const childCalls = (result.data as { childCalls: { operationId: string; status: string }[] }).childCalls;
  assert.equal(childCalls.length, 3);
  for (const call of childCalls) { assert.equal(call.status, 'completed'); assert.equal((await store.operation(call.operationId))?.status, 'done'); }
  assert.equal(activity.filter(value => value.endsWith(':completed')).length, 3);
});

test('programs cannot invoke writes, recursive programs, direct-only tools, or tools outside their allowlist', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true); let writes = 0;
  registry.register({ ...readTool('mixed', async () => { writes++; return { text: 'changed', data: {} }; }), effect: 'write', fields: { action: { type: 'string', description: 'action', required: true } }, writes: args => args.action !== 'read' });
  registry.register({ ...readTool('direct', async () => { throw Error('must not run'); }), programmatic: false });
  registry.register(programTool(registry));
  await assert.rejects(registry.invokeResult(request, 'program_exec', { tools: ['mixed'], code: 'await tools.mixed({action:"write"});text("done");' }, 'write', 'agent'), /cannot execute writes/);
  await assert.rejects(registry.invokeResult(request, 'program_exec', { tools: ['program_exec'], code: 'text(1);' }, 'recursive', 'agent'), /not available/);
  await assert.rejects(registry.invokeResult(request, 'program_exec', { tools: ['direct'], code: 'text(1);' }, 'direct', 'agent'), /not available/);
  await assert.rejects(registry.invokeResult(request, 'program_exec', { tools: [], code: 'await tools.mixed({action:"write"});text("done");' }, 'hidden', 'agent'), /not a function/);
  assert.equal(writes, 0);
});

test('each nested read checks access again, including after a prior result', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  let admin = true, guarded = 0;
  const registry = new ToolRegistry(store, async () => admin);
  registry.register(readTool('revoke', async () => { admin = false; return { text: 'Revoked', data: {} }; }));
  registry.register({ ...readTool('secret', async () => { guarded++; return { text: 'secret', data: { secret: true } }; }), access: 'admin' });
  registry.register(programTool(registry));
  const result = await registry.invokeResult(request, 'program_exec', { tools: ['revoke', 'secret'], code: 'await tools.revoke({});try {await tools.secret({});}catch{}text("partial");' }, 'permissions', 'agent');
  assert.equal(guarded, 0); assert.ok(result.text.startsWith('Incomplete program result'));
  assert.equal((result.data as { failures: unknown[] }).failures.length, 1);
});

test('catalog snapshots prevent a program from selecting a newly added or changed tool', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true); registry.register(programTool(registry));
  const before = registry.capture();
  registry.register(readTool('new_read', async () => { throw Error('must not run'); }));
  await assert.rejects(registry.invokeResult(request, 'program_exec', { tools: ['new_read'], code: 'text(await tools.new_read({}));' }, 'old', 'agent', undefined, { assertTool: before.assertCurrent }), /changed/);
});

test('cached program results recheck child resource authorization before replay', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  let allowed = true, executions = 0;
  const registry = new ToolRegistry(store, async () => true);
  registry.register({ ...readTool('private_read', async () => { executions++; return { text: 'private', data: { value: 1 } }; }), authorize: async () => { if (!allowed) throw new ToolError('Resource access revoked'); } });
  registry.register(programTool(registry));
  const args = { tools: ['private_read'], code: 'text(await tools.private_read({}));' };
  await registry.invokeResult(request, 'program_exec', args, 'cached', 'agent');
  allowed = false;
  await assert.rejects(registry.invokeResult(request, 'program_exec', args, 'cached', 'agent'), /Resource access revoked/);
  assert.equal(executions, 1);
});

test('interrupting an agent program terminates its worker and stops subsequent reads', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  let started!: () => void, complete!: () => void, calls = 0;
  const ready = new Promise<void>(resolve => { started = resolve; }), finish = new Promise<void>(resolve => { complete = resolve; });
  registry.register(readTool('read', async () => { calls++; started(); await finish; return { text: 'read', data: {} }; }));
  registry.register(programTool(registry));
  const llm: LLM = { async *stream() { yield { kind: 'text', payload: { text: JSON.stringify({ tool_calls: [{ name: 'program_exec', arguments: { tools: ['read'], code: 'await tools.read({});await tools.read({});text("done");' } }] }) } }; } };
  const app = new Application(store, llm, { allowedChannels: [{ server: 's', channel: 'c' }] }, undefined, { tools: { catalog: () => registry.catalog(), execute: (message, call, id, version, invocation) => registry.invokeResult(message, call.name, call.arguments, id, 'agent', version, invocation) } });
  const handle = app.handle(request), interrupted = assert.rejects(handle, /interrupted/);
  await ready; assert.equal(await app.interrupt('s', request.id), true); await interrupted;
  complete(); await new Promise(resolve => setImmediate(resolve)); assert.equal(calls, 1);
});

test('recovery reuses completed child reads after a transient failure and completed parent results', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true); let first = 0, flaky = 0;
  registry.register(readTool('first', async () => { first++; return { text: 'first', data: { value: 2 } }; }));
  registry.register(readTool('flaky', async () => { if (++flaky === 1) throw Error('temporary outage'); return { text: 'second', data: { value: 3 } }; }));
  registry.register(programTool(registry));
  const args = { tools: ['first', 'flaky'], code: 'const a=await tools.first({});const b=await tools.flaky({});text(a.value+b.value);' };
  await assert.rejects(registry.invokeResult(request, 'program_exec', args, 'recover', 'agent'), /transient tool failure/);
  assert.equal(store.operation('recover')?.status, 'started');
  assert.equal((await registry.invokeResult(request, 'program_exec', args, 'recover', 'agent')).text, '5');
  assert.equal(first, 1); assert.equal(flaky, 2);
  await registry.invokeResult(request, 'program_exec', args, 'recover', 'agent');
  assert.equal(first, 1); assert.equal(flaky, 2);
});

test('the agent loop receives reduced output and child evidence, not intermediate payloads', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  await store.ingest({ ...request, id: 'evidence', text: 'Evidence' });
  const registry = new ToolRegistry(store, async () => true);
  registry.register(readTool('read', async () => ({ text: 'intermediate', data: { values: [1, 2, 3], largeIntermediate: 'RAW'.repeat(10000) }, sources: [{ kind: 'message', server: 's', channel: 'c', id: 'evidence' }] })));
  registry.register(programTool(registry));
  let rounds = 0;
  const llm: LLM = { async *stream(prompt) {
    if (++rounds === 1) yield { kind: 'text', payload: { text: JSON.stringify({ tool_calls: [{ name: 'program_exec', arguments: { tools: ['read'], code: 'const r=await tools.read({});text({sum:r.values.reduce((a,b)=>a+b,0)});' } }] }) } };
    else {
      const trace = JSON.stringify(prompt.inputs);
      assert.ok(trace.includes('sum')); assert.ok(!trace.includes('RAWRAW'));
      yield { kind: 'text', payload: { text: 'The sum is 6.' } };
    }
  } };
  const executor: ToolExecutor = { catalog: () => registry.catalog(), execute: (message, call, id, version, invocation) => registry.invokeResult(message, call.name, call.arguments, id, 'agent', version, invocation) };
  const app = new Application(store, llm, { allowedChannels: [{ server: 's', channel: 'c' }] }, undefined, { tools: executor });
  const reply = await app.handle(request); assert.equal(reply?.text, 'The sum is 6.');
  const result = store.agentTurns(request)[0]!.results['0'] as ToolResult;
  assert.equal(result.sources![0]!.kind, 'message'); assert.equal((result.data as { calls: number }).calls, 1);
  const output = { ...request, id: 'out', text: reply!.text };
  await store.ingest(output); await store.linkOutput(output, reply!.runId, request.id);
  await store.remove('s', 'c', 'evidence'); assert.equal(store.canonicalMessage('s', 'out'), undefined);
});

test('program tool rejects malformed allowlists before executing code', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true); registry.register(programTool(registry));
  for (const tools of [['read', 'read'], ['invalid.name'], {}, ['read', 1]]) await assert.rejects(registry.invokeResult(request, 'program_exec', { code: 'text(1);', tools }, 'bad', 'agent'), ToolError);
  assert.equal((await registry.invokeResult(request, 'program_exec', { code: 'text(1+1);', tools: [] }, 'math', 'agent')).text, '2');
});
