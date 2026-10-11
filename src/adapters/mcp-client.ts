import { lookup } from 'node:dns/promises';
import { BlockList, isIP } from 'node:net';
import { Agent, buildConnector, fetch as httpFetch } from 'undici';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { SSEClientTransport } from '@modelcontextprotocol/sdk/client/sse.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import type { Json } from '../domain.js';
import type { McpConfig, McpConnection, McpConnector, McpTool } from '../mcp.js';

const blocked = new BlockList();
for (const [address, prefix] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 3]] as const) blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
blocked.addSubnet('2001:db8::', 32, 'ipv6');
blocked.addSubnet('2002::', 16, 'ipv6'); // 6to4 can embed private IPv4 addresses.
blocked.addSubnet('2001::', 32, 'ipv6'); // Teredo has a similar indirect route.
export function publicMcpAddress(address: string): boolean {
  const family = isIP(address);
  return family === 4 ? !blocked.check(address, 'ipv4') : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}

export function remoteMcpConnector(options: { allowPrivate?: boolean } = {}): McpConnector {
  return async (config: McpConfig, token?: string): Promise<McpConnection> => {
    const endpoint = new URL(config.url);
    if (!options.allowPrivate && endpoint.protocol !== 'https:') throw new Error('Public MCP endpoints require HTTPS');
    const connector = buildConnector({ timeout: config.timeoutMs });
    // Resolve and validate the address used by the actual socket, rather than
    // checking DNS and then allowing fetch to resolve the hostname again.
    const dispatcher = new Agent({ connect: (socketOptions, callback) => {
      void (async () => {
        const hostname = socketOptions.hostname.replace(/^\[|\]$/g, '');
        const addresses = isIP(hostname) ? [{ address: hostname, family: isIP(hostname) }] : await lookup(hostname, { all: true });
        if (!addresses.length || !options.allowPrivate && addresses.some(item => !publicMcpAddress(item.address))) throw new Error('Private MCP destinations are blocked');
        connector({ ...socketOptions, hostname: addresses[0]!.address, servername: hostname }, callback);
      })().catch(() => callback(new Error('MCP endpoint could not be reached safely'), null));
    } });
    const guardedFetch: typeof fetch = async (input, init) => {
      const request = new Request(input, init), url = new URL(request.url);
      // SSE servers can advertise a POST endpoint. Never forward credentials to
      // another origin or follow redirects, including on background GET streams.
      if (url.origin !== endpoint.origin) throw new Error('MCP origin changed');
      if (token) request.headers.set('Authorization', `Bearer ${token}`);
      const controller = new AbortController(), timer = setTimeout(() => controller.abort(), config.timeoutMs);
      try {
        const response = await httpFetch(request.url, {
          method: request.method, headers: [...request.headers],
          ...(request.body ? { body: request.body as never, duplex: 'half' as const } : {}),
          redirect: 'error', dispatcher,
          signal: AbortSignal.any([request.signal, controller.signal]),
        });
        // Timeout headers, not the lifetime of a persistent SSE stream. RPC
        // deadlines are enforced separately by the SDK for discovery and calls.
        const body = response.body as unknown as ReadableStream<Uint8Array> | null;
        return new Response(body, { status: response.status, statusText: response.statusText, headers: [...response.headers] });
      } finally { clearTimeout(timer); }
    };
    const client = new Client({ name: 'slopbot', version: '0.1.0' });
    // No roots, sampling, or elicitation capabilities are advertised. Remote
    // servers cannot ask this client to read the host or invoke the model.
    const transportOptions = { fetch: guardedFetch, requestInit: { redirect: 'error' as const } };
    const transport = config.transport === 'sse' ? new SSEClientTransport(endpoint, transportOptions)
      : new StreamableHTTPClientTransport(endpoint, { ...transportOptions, reconnectionOptions: { maxRetries: 0, maxReconnectionDelay: 1000, initialReconnectionDelay: 1000, reconnectionDelayGrowFactor: 1 } });
    // The SDK's optional sessionId declaration predates exactOptionalPropertyTypes.
    try { await client.connect(transport as Transport, { timeout: config.timeoutMs }); }
    catch { await client.close().catch(() => {}); await dispatcher.destroy(); throw new Error('MCP initialization failed'); }
    let closed = false;
    return {
      async listTools() {
        const tools: McpTool[] = [], cursors = new Set<string>();
        let cursor: string | undefined;
        const deadline = Date.now() + config.timeoutMs;
        do {
          if (Date.now() >= deadline) throw new Error('MCP discovery timeout');
          const page = await client.listTools(cursor ? { cursor } : {}, { timeout: Math.max(1, deadline - Date.now()) });
          for (const tool of page.tools) tools.push({ name: tool.name, ...(tool.description ? { description: tool.description } : {}), inputSchema: tool.inputSchema as Json,
            ...(tool.outputSchema ? { outputSchema: tool.outputSchema as Json } : {}), ...(tool.annotations?.readOnlyHint !== undefined ? { readOnlyHint: tool.annotations.readOnlyHint } : {}) });
          if (tools.length > 100) throw new Error('MCP discovery exceeds 100 tools');
          cursor = page.nextCursor;
          if (cursor && cursors.has(cursor)) throw new Error('MCP discovery repeated a cursor');
          if (cursor) cursors.add(cursor);
        } while (cursor);
        return tools;
      },
      async callTool(name, args) {
        const result = await client.callTool({ name, arguments: args }, undefined, { timeout: config.timeoutMs });
        if (!Array.isArray(result.content)) throw new Error('Invalid MCP content');
        return { content: result.content as Json[], ...(result.structuredContent ? { structuredContent: result.structuredContent as Json } : {}), ...(typeof result.isError === 'boolean' ? { isError: result.isError } : {}) };
      },
      async close() { if (closed) return; closed = true; await client.close().catch(() => {}); await dispatcher.destroy(); },
    };
  };
}
