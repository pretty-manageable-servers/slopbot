// MCP connection forms: the drafts the forms edit and the POST /api/mcp bodies they become (web/app.js renderMcp
// built the same bodies from the form fields). Pure, so the rules are tested without the DOM.
import type { McpBody, McpConnection, McpTool } from "../../api-types";

export type Transport = McpConnection["transport"];
export type Access = NonNullable<McpTool["access"]>;
export type Effect = NonNullable<McpTool["effect"]>;

/** A tool as the snapshot sends it. api-types.ts McpTool lacks needsReview, which src/mcp.ts adds to each tool. */
export type ReviewTool = McpTool & { needsReview?: boolean };

export interface ToolChoice { enabled: boolean; access: Access; effect: Effect }

export interface ConnectionDraft {
  url: string; transport: Transport; enabled: boolean; timeoutMs: number; concurrency: number;
  token: string; removeToken: boolean; tools: Record<string, ToolChoice>;
}

export interface NewConnectionDraft { id: string; url: string; transport: Transport; token: string }

/** The same checks as src/mcp.ts configure(). */
export const CONNECTION_ID = /^[a-z][a-z0-9_]{0,11}$/;
export const TIMEOUT_MS = { min: 1000, max: 60000 };
export const CONCURRENCY = { min: 1, max: 16 };

export const isConnectionId = (id: string) => CONNECTION_ID.test(id);
export const inRange = (value: number, { min, max }: { min: number; max: number }) => Number.isInteger(value) && value >= min && value <= max;

/** The endpoint host for the table, or the text as typed when it is not a URL. */
export function hostOf(url: string): string {
  try { return new URL(url).host; } catch { return url; }
}

export function draftFromConnection(connection: McpConnection): ConnectionDraft {
  return {
    url: connection.url, transport: connection.transport, enabled: connection.enabled,
    timeoutMs: connection.timeoutMs, concurrency: connection.concurrency, token: "", removeToken: false,
    tools: Object.fromEntries(connection.tools.map((tool) => [tool.name, { enabled: tool.enabled, access: tool.access ?? "admin", effect: tool.effect ?? "write" }])),
  };
}

export const newConnectionReady = (draft: NewConnectionDraft) => isConnectionId(draft.id) && draft.url.trim() !== "";
export const connectionReady = (draft: Pick<ConnectionDraft, "url" | "timeoutMs" | "concurrency">) =>
  draft.url.trim() !== "" && inRange(draft.timeoutMs, TIMEOUT_MS) && inRange(draft.concurrency, CONCURRENCY);

/** "" removes the saved token, a new token replaces it, a blank field keeps it (the field is left out). */
function tokenField(token: string, remove: boolean): { token?: string } {
  if (remove) return { token: "" };
  return token ? { token } : {};
}

/** Adds a connection. Its tools start off, as in the old console. */
export function newConnectionBody(draft: NewConnectionDraft): Omit<McpBody, "server"> {
  return { action: "save", id: draft.id, url: draft.url.trim(), transport: draft.transport, enabled: true, tools: [], ...tokenField(draft.token, false) };
}

/** Saves an existing connection with its enabled tools. Only the tools switched on are sent. */
export function saveConnectionBody(connection: McpConnection, draft: ConnectionDraft): Omit<McpBody, "server"> {
  return {
    action: "save", id: connection.id, url: draft.url.trim(), transport: draft.transport, enabled: draft.enabled,
    timeoutMs: draft.timeoutMs, concurrency: draft.concurrency, ...tokenField(draft.token, draft.removeToken),
    tools: connection.tools.flatMap((tool) => {
      const choice = draft.tools[tool.name];
      return choice?.enabled ? [{ name: tool.name, schemaHash: tool.schemaHash, access: choice.access, effect: choice.effect }] : [];
    }),
  };
}
