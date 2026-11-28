import type { McpManager } from "../mcp.js";
import { ToolError } from "../tools.js";

export const MAX_CONNECTORS = 5;
const NAME = /^[a-z0-9-]{1,32}$/;
const idOf = (user: string, name: string) => `u:${user}:${name}`;

export interface ConnectorInput { name: string; url: string; token?: string; transport?: "http" | "sse"; enabled?: boolean; timeoutMs?: number; concurrency?: number }
export interface ConnectorInfo {
  name: string; url: string; transport: "http" | "sse"; enabled: boolean; timeoutMs: number; concurrency: number;
  hasToken: boolean; status: string; error: string | null; tools: { name: string; effect: "read" | "write" }[];
}

/** The user's personal connectors. Tokens are never returned, only whether one is set. */
export function listConnectors(mcp: McpManager, user: string): ConnectorInfo[] {
  const prefix = idOf(user, "");
  return mcp.snapshot().connections.filter(c => c.owner === user && c.id.startsWith(prefix)).map(c => ({
    name: c.id.slice(prefix.length), url: c.url, transport: c.transport, enabled: c.enabled, timeoutMs: c.timeoutMs, concurrency: c.concurrency,
    hasToken: c.hasToken, status: c.status, error: c.error, tools: c.tools.map(tool => ({ name: tool.name, effect: tool.effect })),
  }));
}

export async function putConnector(mcp: McpManager, user: string, input: ConnectorInput): Promise<void> {
  if (!NAME.test(input.name)) throw new ToolError("Connector names use 1-32 lowercase letters, numbers or dashes.");
  const existing = listConnectors(mcp, user);
  if (!existing.some(c => c.name === input.name) && existing.length >= MAX_CONNECTORS) throw new ToolError(`Limit reached: ${MAX_CONNECTORS} connectors.`);
  const { name, ...rest } = input;
  await mcp.configure(user, { transport: "http", enabled: true, ...rest, action: "save", id: idOf(user, name), owner: user });
}

export async function removeConnector(mcp: McpManager, user: string, name: string): Promise<void> {
  if (!NAME.test(name)) throw new ToolError("Unknown connector.");
  await mcp.configure(user, { action: "remove", id: idOf(user, name), owner: user });
}
