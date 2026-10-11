import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { publicMcpAddress, remoteMcpConnector } from '../src/adapters/mcp-client.js';
import type { McpConfig } from '../src/mcp.js';

test('MCP networking blocks private, metadata, mapped IPv6, and reserved addresses', () => {
  for (const address of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '172.16.1.2', '192.168.1.2', '100.64.0.1', '0.0.0.0', '224.0.0.1', '::1', 'fc00::1', 'fe80::1', '::ffff:127.0.0.1', '2001:db8::1', '2002:7f00:1::1', 'not-an-address']) assert.equal(publicMcpAddress(address), false, address);
  assert.equal(publicMcpAddress('8.8.8.8'), true); assert.equal(publicMcpAddress('2606:4700:4700::1111'), true);
});

for (const transport of ['http', 'sse'] as const) test(`real MCP ${transport} transport initializes, discovers paginated tools, and returns structured content`, async t => {
  let stream: ServerResponse | undefined, calls = 0;
  const authorization: (string | undefined)[] = [];
  const server = createServer(async (req, res) => {
    authorization.push(req.headers.authorization);
    if (req.method === 'GET' && req.url === '/sse') {
      stream = res;
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      res.write('event: endpoint\ndata: /messages\n\n'); return;
    }
    if (req.method !== 'POST') { res.writeHead(405); res.end(); return; }
    let text = ''; for await (const chunk of req) text += chunk;
    const request = JSON.parse(text) as { id?: string | number; method: string; params?: { cursor?: string; protocolVersion?: string; arguments?: { value?: number } } };
    if (request.id === undefined) { res.writeHead(204); res.end(); return; }
    let result: unknown;
    if (request.method === 'initialize') result = { protocolVersion: request.params!.protocolVersion, capabilities: { tools: {} }, serverInfo: { name: 'test', version: '1' } };
    else if (request.method === 'tools/list') result = { tools: [{ name: request.params?.cursor ? 'second' : 'first', inputSchema: { type: 'object' } }], ...(!request.params?.cursor ? { nextCursor: 'page2' } : {}) };
    else if (request.method === 'tools/call') { calls++; result = { content: [{ type: 'text', text: 'Result' }], structuredContent: { value: request.params!.arguments!.value } }; }
    else result = {};
    const response = { jsonrpc: '2.0', id: request.id, result };
    if (req.url === '/messages') {
      res.writeHead(202); res.end(); stream!.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
    } else { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(response)); }
  });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { stream?.end(); server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  const config: McpConfig = { id: 'test', transport, url: `http://127.0.0.1:${address.port}/${transport === 'sse' ? 'sse' : 'mcp'}`, enabled: true, tools: [], timeoutMs: 2000, concurrency: 2 };
  await assert.rejects(remoteMcpConnector()(config), /HTTPS/);
  const client = await remoteMcpConnector({ allowPrivate: true })(config, 'test-token'); t.after(() => client.close());
  assert.deepEqual((await client.listTools()).map(tool => tool.name), ['first', 'second']);
  const result = await client.callTool('first', { value: 3 });
  assert.deepEqual(result.structuredContent, { value: 3 }); assert.equal(calls, 1);
  assert.ok(authorization.every(value => value === 'Bearer test-token'));
  await client.close(); await client.close();
});

test('MCP redirects cannot forward a credential to another endpoint', async t => {
  let requests = 0;
  const server = createServer((_req, res) => { requests++; res.writeHead(307, { Location: '/stolen' }); res.end(); });
  server.listen(0, '127.0.0.1'); await once(server, 'listening');
  t.after(() => { server.closeAllConnections(); return new Promise<void>(resolve => server.close(() => resolve())); });
  const address = server.address(); assert.ok(address && typeof address !== 'string');
  await assert.rejects(remoteMcpConnector({ allowPrivate: true })({ id: 'test', transport: 'http', url: `http://127.0.0.1:${address.port}/mcp`, enabled: true, tools: [], timeoutMs: 1000, concurrency: 1 }, 'secret'), /initialization failed/);
  assert.equal(requests, 1);
});
