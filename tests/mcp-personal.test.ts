import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { McpManager, McpSecrets, mcpToolName, type McpConnection, type McpTool } from '../src/mcp.js';
import { PERSONAL_SERVER } from '../src/personal.js';
import { ToolRegistry } from '../src/tools.js';
import { listConnectors, putConnector, removeConnector } from '../src/assistant/connectors.js';

const reader: McpTool = { name: 'read_it', readOnlyHint: true, inputSchema: { type: 'object', properties: {} } };
const writer: McpTool = { name: 'write_it', inputSchema: { type: 'object', properties: {} } };
const key = Buffer.alloc(32, 3).toString('base64');
const msg = (author: string, server = PERSONAL_SERVER) => ({ id: 'm' + Math.random(), server, channel: 'c', taskId: 'c', author, text: 'x' });

function setup(t: { after(fn: () => unknown): void }, server = PERSONAL_SERVER) {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  const tokens: (string | undefined)[] = [];
  const manager = new McpManager(server, store, registry, async (_c, token): Promise<McpConnection> => {
    tokens.push(token);
    return { listTools: async () => [reader, writer], close: async () => {}, callTool: async () => ({ content: [{ type: 'text', text: 'ok' }] }) };
  }, new McpSecrets(key));
  t.after(() => manager.close());
  return { store, registry, manager, tokens };
}

test('other user cannot call personal tool', async t => {
  const { registry, manager } = setup(t);
  await putConnector(manager, 'alice', { name: 'notes', url: 'https://example.com/mcp' });
  const name = mcpToolName('u:alice:notes', 'read_it');
  assert.equal((await registry.invokeResult(msg('alice'), name, {}, 'a', 'agent')).text, 'ok');
  await assert.rejects(registry.invokeResult(msg('bob'), name, {}, 'b', 'agent'), /belongs to another user/);
  await assert.rejects(removeConnector(manager, 'bob', 'notes'), /Unknown/);
  assert.equal(listConnectors(manager, 'bob').length, 0);
});

test('token sealed per id', async t => {
  const { store, manager, tokens } = setup(t);
  await putConnector(manager, 'alice', { name: 'one', url: 'https://example.com/mcp', token: 'sekret' });
  assert.equal(tokens.at(-1), 'sekret');
  const record = (await store.record(PERSONAL_SERVER, 'mcp_connection', 'u:alice:one'))!;
  const saved = record.value as { secret: string };
  assert.ok(!JSON.stringify(record.value).includes('sekret'));
  assert.equal(new McpSecrets(key).open(saved.secret, `${PERSONAL_SERVER}:u:alice:one`), 'sekret');
  assert.throws(() => new McpSecrets(key).open(saved.secret, `${PERSONAL_SERVER}:u:alice:two`));
});

test('effect from readOnlyHint', async t => {
  const { registry, manager } = setup(t);
  await putConnector(manager, 'alice', { name: 'notes', url: 'https://example.com/mcp' });
  const effects = Object.fromEntries(registry.definitions().map(d => [d.name, d.effect]));
  assert.equal(effects[mcpToolName('u:alice:notes', 'read_it')], 'read');
  assert.equal(effects[mcpToolName('u:alice:notes', 'write_it')], 'write');
});

test('limit 5', async t => {
  const { manager } = setup(t);
  for (let i = 0; i < 5; i++) await putConnector(manager, 'alice', { name: `c${i}`, url: 'https://example.com/mcp' });
  await assert.rejects(putConnector(manager, 'alice', { name: 'c5', url: 'https://example.com/mcp' }), /Limit reached: 5 connectors\./);
  await putConnector(manager, 'alice', { name: 'c0', url: 'https://example.com/mcp2' });
  await putConnector(manager, 'bob', { name: 'c0', url: 'https://example.com/mcp' });
  await assert.rejects(putConnector(manager, 'bob', { name: 'Bad Name', url: 'https://example.com/mcp' }), /Connector names/);
  await removeConnector(manager, 'alice', 'c1');
  await putConnector(manager, 'alice', { name: 'c5', url: 'https://example.com/mcp' });
});

test('list hides token', async t => {
  const { manager } = setup(t);
  await putConnector(manager, 'alice', { name: 'notes', url: 'https://example.com/mcp', token: 'sekret' });
  const list = listConnectors(manager, 'alice');
  assert.equal(list[0]!.hasToken, true);
  assert.ok(!JSON.stringify(list).includes('sekret'));
  assert.equal(list[0]!.name, 'notes');
});

test('server MCP unchanged', async t => {
  const { registry, manager } = setup(t, 's');
  await assert.rejects(manager.configure('alice', { action: 'save', id: 'u:alice:x', owner: 'alice', url: 'https://example.com/mcp', transport: 'http', enabled: true, tools: [] }), /Invalid personal connector/);
  await manager.configure('admin', { action: 'save', id: 'github', url: 'https://example.com/mcp', transport: 'http', enabled: true, tools: [] });
  assert.equal(registry.definitions().length, 0);
  assert.equal(manager.snapshot().connections[0]!.tools[0]!.effect, 'write');
  assert.equal(manager.snapshot().connections[0]!.tools[0]!.enabled, false);
});
