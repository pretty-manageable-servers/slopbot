import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { Application } from '../src/application.js';
import { McpManager, McpSecrets, mcpSchemaHash, mcpToolName, type McpConnection, type McpTool, type McpResult } from '../src/mcp.js';
import { ToolRegistry, UncertainActionError, type ToolExecutor } from '../src/tools.js';
import type { LLM } from '../src/ports.js';

const message = { id: 'm', server: 's', channel: 'c', taskId: 'c', author: 'alice', text: 'use the connected tool' };
const tool: McpTool = { name: 'get/issues', description: 'List issues', readOnlyHint: true,
  inputSchema: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 10 } }, required: ['limit'], additionalProperties: false },
  outputSchema: { type: 'object', properties: { count: { type: 'integer' } }, required: ['count'], additionalProperties: false } };
const config = { action: 'save', id: 'github', url: 'https://example.com/mcp', transport: 'http', enabled: true, tools: [] };
const grant = (definition = tool, effect: 'read' | 'write' = 'read', access: 'member' | 'admin' = 'member') => ({ name: definition.name, schemaHash: mcpSchemaHash(definition), effect, access });

test('provider replacement preserves native tools and is atomic on invalid definitions', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  const definition = { name: 'native', description: 'native', fields: {}, access: 'member' as const, effect: 'read' as const, retrySafe: true, execute: async () => 'ok' };
  registry.register(definition);
  registry.replaceProvider('example', [{ ...definition, name: 'external', provider: 'example' }]);
  assert.throws(() => registry.replaceProvider('example', [{ ...definition, name: 'next', provider: 'example' }, { ...definition, provider: 'example' }]), /duplicate/);
  assert.deepEqual(registry.definitions().map(tool => tool.name), ['external', 'native']);
  assert.throws(() => registry.replaceProvider('example', [{ ...definition, name: 'external', provider: 'example', fields: { constructor: { type: 'string' as const, description: 'invalid' } } }]), /field/);
  assert.deepEqual(registry.definitions().map(tool => tool.name), ['external', 'native']);
});

test('runtime discovery requires explicit grants and calls use the shared validation, permissions, and journal', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  let admin = false, calls = 0;
  const registry = new ToolRegistry(store, async () => admin);
  const manager = new McpManager('s', store, registry, async () => ({ listTools: async () => [tool], close: async () => {},
    callTool: async (_name, args) => { calls++; return { content: [{ type: 'text', text: 'Issue count' }], structuredContent: { count: args.limit! } }; } }));
  t.after(() => manager.close());
  await manager.configure('admin', config);
  assert.equal(registry.definitions().length, 0);
  assert.equal(manager.snapshot().connections[0]!.tools[0]!.enabled, false);
  await manager.configure('admin', { ...config, tools: [grant(tool, 'read', 'admin')] });
  const name = mcpToolName('github', tool.name);
  await assert.rejects(registry.invokeResult(message, name, { limit: 2 }, 'op', 'agent'), /Manage Server/);
  admin = true;
  await assert.rejects(registry.invokeResult(message, name, { limit: 11 }, 'bad', 'agent'), /schema/);
  await assert.rejects(registry.invokeResult(message, name, { limit: 2, extra: true }, 'bad2', 'agent'), /schema/);
  assert.equal(calls, 0);
  const result = await registry.invokeResult(message, name, { limit: 2 }, 'op', 'agent');
  assert.deepEqual(result.data, { count: 2 });
  assert.deepEqual(result.content, [{ type: 'text', text: 'Issue count' }]);
  assert.deepEqual(await registry.invokeResult(message, name, { limit: 2 }, 'op', 'agent'), result);
  assert.equal(calls, 1);
  admin = false;
  await assert.rejects(registry.invokeResult(message, name, { limit: 2 }, 'op', 'agent'), /Manage Server/);
  assert.equal(registry.definitions()[0]!.effect, 'read');
});

test('connection credentials are encrypted, omitted from snapshots, restored, and cleared when the endpoint changes', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const secrets = new McpSecrets(Buffer.alloc(32, 7).toString('base64'));
  const tokens: (string | undefined)[] = [];
  const connect = async (_config: unknown, token?: string): Promise<McpConnection> => {
    tokens.push(token);
    return { listTools: async () => [tool], callTool: async () => ({ content: [] }), close: async () => {} };
  };
  const registry = new ToolRegistry(store, async () => true), manager = new McpManager('s', store, registry, connect, secrets);
  t.after(() => manager.close());
  await manager.configure('admin', { ...config, token: 'private-token', tools: [grant()] });
  const record = await store.record('s', 'mcp_connection', 'github');
  assert.ok(record);
  assert.ok(!JSON.stringify(record).includes('private-token'));
  assert.ok(!JSON.stringify(manager.snapshot()).includes('private-token'));
  assert.equal(manager.snapshot().connections[0]!.hasToken, true);
  const registry2 = new ToolRegistry(store, async () => true), restored = new McpManager('s', store, registry2, connect, secrets);
  t.after(() => restored.close()); await restored.restore();
  assert.equal(registry2.definitions().length, 1); assert.deepEqual(tokens, ['private-token', 'private-token']);
  await manager.configure('admin', { ...config, url: 'https://another.example/mcp', tools: [grant()] });
  assert.equal(tokens.at(-1), undefined);
  assert.equal(manager.snapshot().connections[0]!.hasToken, false);
  assert.throws(() => secrets.open((record.value as { secret: string }).secret, 'wrong-server:github'));
  await manager.configure('admin', { action: 'remove', id: 'github' });
  assert.equal(manager.snapshot().connections.length, 0);
  const deleted = await store.record('s', 'mcp_connection', 'github');
  assert.equal((deleted!.value as { secret?: string }).secret, undefined);
  const afterDelete = new McpManager('s', store, new ToolRegistry(store, async () => true), connect, secrets);
  t.after(() => afterDelete.close()); await afterDelete.restore();
  assert.equal(afterDelete.snapshot().connections.length, 0);
});

test('failed connection updates preserve working tools and sanitize errors', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  const manager = new McpManager('s', store, registry, async value => {
    if (value.url.includes('broken')) throw new Error('private-token from remote error');
    return { listTools: async () => [tool], callTool: async () => ({ content: [], structuredContent: { count: 1 } }), close: async () => {} };
  });
  t.after(() => manager.close());
  await manager.configure('admin', { ...config, tools: [grant()] });
  await assert.rejects(manager.configure('admin', { ...config, url: 'https://broken.example/mcp', tools: [grant()] }), error => {
    assert.ok(error instanceof Error); assert.ok(!error.message.includes('private-token')); return true;
  });
  assert.equal(manager.snapshot().connections[0]!.url, config.url);
  assert.equal(registry.definitions().length, 1);
  const noKey = new McpManager('s', store, registry, async () => { throw Error('must not connect'); });
  t.after(() => noKey.close());
  await assert.rejects(noKey.configure('admin', { ...config, id: 'other', token: 'secret' }), /MCP_SECRET_KEY/);
});

test('refresh disables changed definitions until reviewed and disable invalidates captured catalogs', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  let discovered = tool;
  const registry = new ToolRegistry(store, async () => true);
  const manager = new McpManager('s', store, registry, async () => ({ listTools: async () => [discovered], callTool: async () => ({ content: [] }), close: async () => {} }));
  t.after(() => manager.close());
  await manager.configure('admin', { ...config, tools: [grant()] });
  const selected = registry.capture(), name = mcpToolName('github', tool.name);
  discovered = { ...tool, description: 'Now also changes issues' };
  await manager.configure('admin', { action: 'refresh', id: 'github' });
  assert.equal(registry.definitions().length, 0);
  assert.equal(manager.snapshot().connections[0]!.tools[0]!.needsReview, true);
  assert.throws(() => selected.assertCurrent(name), /changed/);
  await assert.rejects(manager.configure('admin', { ...config, tools: [grant()] }), /definitions changed/);
  await manager.configure('admin', { ...config, tools: [grant(discovered, 'write')] });
  const enabled = registry.capture();
  await manager.configure('admin', { action: 'disable', id: 'github' });
  assert.equal(registry.definitions().length, 0); assert.throws(() => enabled.assertCurrent(name), /changed/);
  await manager.configure('admin', { action: 'refresh', id: 'github' });
  assert.equal(registry.definitions().length, 0);
  assert.equal(manager.snapshot().connections[0]!.enabled, false);
});

test('uncertain MCP writes are not retried and read hints do not authorize reads', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true); let calls = 0;
  const manager = new McpManager('s', store, registry, async () => ({ listTools: async () => [tool], close: async () => {}, callTool: async () => {
    calls++; throw new Error('lost connection with private-token');
  } })); t.after(() => manager.close());
  await manager.configure('admin', { ...config, tools: [grant(tool, 'write')] });
  const name = mcpToolName('github', tool.name);
  assert.equal(registry.requiresThread(name, { limit: 1 }), true);
  await assert.rejects(registry.invokeResult(message, name, { limit: 1 }, 'write', 'agent'), UncertainActionError);
  await assert.rejects(registry.invokeResult(message, name, { limit: 1 }, 'write', 'agent'), UncertainActionError);
  await assert.rejects(registry.invokeResult(message, name, { limit: 1 }, 'another', 'agent'), /did not finish/);
  assert.equal(calls, 1);
});

test('MCP application errors and invalid outputs preserve uncertain write semantics', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true); let result: McpResult = { content: [], isError: true };
  const manager = new McpManager('s', store, registry, async () => ({ listTools: async () => [tool], close: async () => {}, callTool: async () => result }));
  t.after(() => manager.close());
  await manager.configure('admin', { ...config, tools: [grant(tool, 'write')] });
  await assert.rejects(registry.invokeResult(message, mcpToolName('github', tool.name), { limit: 1 }, 'write', 'agent'), UncertainActionError);
  // A separate connection lets us test output validation without bypassing the
  // original connection's unresolved-write resource lock.
  result = { content: [], structuredContent: { count: 'invalid' } };
  await manager.configure('admin', { ...config, id: 'other', tools: [grant()] });
  await assert.rejects(registry.invokeResult(message, mcpToolName('other', tool.name), { limit: 1 }, 'read', 'agent'), /MCP call failed/);
});

test('disabling a connection drains started calls and rejects waiting calls', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  let started!: () => void, complete!: () => void, calls = 0, closed = 0;
  const firstStarted = new Promise<void>(resolve => { started = resolve; });
  const work = new Promise<void>(resolve => { complete = resolve; });
  const manager = new McpManager('s', store, registry, async () => ({ listTools: async () => [tool], close: async () => { closed++; }, callTool: async () => {
    calls++; started(); await work; return { content: [], structuredContent: { count: 1 } };
  } })); t.after(() => manager.close());
  await manager.configure('admin', { ...config, concurrency: 1, tools: [grant()] });
  const name = mcpToolName('github', tool.name), running = registry.invokeResult(message, name, { limit: 1 }, 'first', 'agent');
  await firstStarted;
  const waiting = registry.invokeResult(message, name, { limit: 1 }, 'second', 'agent');
  const rejected = assert.rejects(waiting, /Unknown tool|changed/);
  await manager.configure('admin', { action: 'disable', id: 'github' });
  assert.equal(closed, 0); complete(); await running; await rejected;
  assert.equal(calls, 1); assert.equal(closed, 1);
});

test('new requests see runtime tools while active requests retain their catalog and budget', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true), manager = new McpManager('s', store, registry, async () => ({ listTools: async () => [tool], callTool: async () => ({ content: [], structuredContent: { count: 1 } }), close: async () => {} }));
  t.after(() => manager.close());
  const executor: ToolExecutor = { catalog: () => registry.catalog(), execute: (m, call, id) => registry.invokeResult(m, call.name, call.arguments, id, 'agent'), snapshot: () => {
    const snapshot = registry.capture();
    return { catalog: snapshot.catalog, execute: (m, call, id) => { snapshot.assertCurrent(call.name); return executor.execute(m, call, id); } };
  } };
  let requests = 0, firstVersion = '';
  const llm: LLM = { async *stream(prompt) {
    if (++requests === 1) {
      firstVersion = prompt.prefixVersion;
      assert.ok(!JSON.stringify(prompt.tools ?? []).includes('get/issues'));
      await manager.configure('admin', { ...config, tools: [grant()] });
      // Updating the registry does not mutate the prompt already being streamed.
      assert.ok(!JSON.stringify(prompt.tools ?? []).includes('get/issues'));
    } else {
      // MCP tools are discovery only, so the prompt does not change when they change.
      assert.ok(!JSON.stringify(prompt.tools ?? []).includes('get/issues'));
      assert.equal(prompt.prefixVersion, firstVersion);
    }
    yield { kind: 'text', payload: { text: 'Done' } };
  } };
  const app = new Application(store, llm, { allowedChannels: [{ server: 's', channel: 'c' }], maxContextTokens: 32000, maxOutputTokens: 2000 }, undefined, { tools: executor });
  await app.handle(message); await app.handle({ ...message, id: 'next' });
  assert.equal(requests, 2);
});

test('schema dialects and formats are enforced and async validators cannot bypass validation', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  let discovered: McpTool = { name: 'dates', inputSchema: { $schema: 'https://json-schema.org/draft/2020-12/schema', type: 'object', properties: { date: { type: 'string', format: 'date' } }, required: ['date'], additionalProperties: false } };
  const manager = new McpManager('s', store, registry, async () => ({ listTools: async () => [discovered], callTool: async () => ({ content: [] }), close: async () => {} }));
  t.after(() => manager.close());
  await manager.configure('admin', { ...config, tools: [grant(discovered)] });
  const name = mcpToolName('github', discovered.name);
  await assert.rejects(registry.invokeResult(message, name, { date: '2026-13-32' }, 'invalid', 'agent'), /schema/);
  await registry.invokeResult(message, name, { date: '2026-10-11' }, 'valid', 'agent');
  discovered = { ...discovered, inputSchema: { $async: true, type: 'object' } };
  await assert.rejects(manager.configure('admin', { ...config, tools: [] }), /valid tools/);
  assert.equal(registry.definitions().length, 1);
});

test('queued calls recheck permissions before dispatch and reject cross-server requests', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  let admin = true, calls = 0, ready!: () => void, complete!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; }), finish = new Promise<void>(resolve => { complete = resolve; });
  const registry = new ToolRegistry(store, async () => admin);
  const manager = new McpManager('s', store, registry, async () => ({ listTools: async () => [tool], close: async () => {}, callTool: async () => { calls++; ready(); await finish; return { content: [], structuredContent: { count: 1 } }; } }));
  t.after(() => manager.close());
  await manager.configure('admin', { ...config, concurrency: 1, tools: [grant(tool, 'read', 'admin')] });
  const name = mcpToolName('github', tool.name);
  await assert.rejects(registry.invokeResult({ ...message, server: 'other' }, name, { limit: 1 }, 'other-server', 'agent'), /another server/);
  const running = registry.invokeResult(message, name, { limit: 1 }, 'first', 'agent'); await started;
  const queued = registry.invokeResult(message, name, { limit: 1 }, 'second', 'agent');
  const rejected = assert.rejects(queued, /Manage Server/);
  admin = false; complete(); await running; await rejected;
  assert.equal(calls, 1);
});
