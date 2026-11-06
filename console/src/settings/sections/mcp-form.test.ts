import { describe, expect, test } from "vitest";
import type { McpConnection } from "../../api-types";
import { connectionReady, draftFromConnection, hostOf, isConnectionId, newConnectionBody, newConnectionReady, saveConnectionBody, type ConnectionDraft } from "./mcp-form";

const hash = "a".repeat(64);
const connection: McpConnection = {
  id: "github", url: "https://api.example.com/mcp", transport: "http", enabled: true, timeoutMs: 15000, concurrency: 4,
  hasToken: true, updatedBy: "1", updatedAt: 1, status: "connected", error: null,
  tools: [
    { name: "search", registeredName: "mcp_github_search", description: "Search", schemaHash: hash, enabled: true, access: "member", effect: "read" },
    { name: "create", registeredName: "mcp_github_create", schemaHash: hash, enabled: false, access: "admin", effect: "write" },
  ],
};

describe("saveConnectionBody", () => {
  test("keeps the saved token when the token field is blank", () => {
    const body = saveConnectionBody(connection, draftFromConnection(connection));
    expect(body).not.toHaveProperty("token");
    expect(body).toMatchObject({ action: "save", id: "github", url: connection.url, transport: "http", enabled: true, timeoutMs: 15000, concurrency: 4 });
  });

  test("sends an empty token when the saved token is removed", () => {
    const draft: ConnectionDraft = { ...draftFromConnection(connection), removeToken: true };
    expect(saveConnectionBody(connection, draft).token).toBe("");
  });

  test("sends a typed token", () => {
    const draft: ConnectionDraft = { ...draftFromConnection(connection), token: "new-secret" };
    expect(saveConnectionBody(connection, draft).token).toBe("new-secret");
  });

  test("sends only the enabled tools, with their schema hash, access and operation", () => {
    const draft = draftFromConnection(connection);
    expect(saveConnectionBody(connection, draft).tools).toEqual([{ name: "search", schemaHash: hash, access: "member", effect: "read" }]);
    draft.tools.create = { enabled: true, access: "admin", effect: "write" };
    expect(saveConnectionBody(connection, draft).tools).toEqual([
      { name: "search", schemaHash: hash, access: "member", effect: "read" },
      { name: "create", schemaHash: hash, access: "admin", effect: "write" },
    ]);
  });

  test("trims the endpoint and keeps the switched-off state", () => {
    const draft: ConnectionDraft = { ...draftFromConnection(connection), url: "  https://example.com/mcp ", enabled: false };
    expect(saveConnectionBody(connection, draft)).toMatchObject({ url: "https://example.com/mcp", enabled: false });
  });
});

describe("newConnectionBody", () => {
  test("adds an enabled connection with no tools and leaves the token out when blank", () => {
    expect(newConnectionBody({ id: "github", url: "https://example.com/mcp", transport: "sse", token: "" })).toEqual({
      action: "save", id: "github", url: "https://example.com/mcp", transport: "sse", enabled: true, tools: [],
    });
  });

  test("sends the token when one is typed", () => {
    expect(newConnectionBody({ id: "github", url: "https://example.com/mcp", transport: "http", token: "secret" }).token).toBe("secret");
  });
});

describe("isConnectionId", () => {
  test.each(["github", "a", "a_b2", "abcdefghijkl"])("accepts %s", (id) => {
    expect(isConnectionId(id)).toBe(true);
  });

  test.each(["", "1github", "GitHub", "git-hub", "git hub", "abcdefghijklm"])("rejects %j", (id) => {
    expect(isConnectionId(id)).toBe(false);
  });
});

describe("connectionReady and newConnectionReady", () => {
  test("needs an endpoint and a timeout and concurrency in range", () => {
    const ok = { url: "https://example.com/mcp", timeoutMs: 1000, concurrency: 16 };
    expect(connectionReady(ok)).toBe(true);
    expect(connectionReady({ ...ok, timeoutMs: 999 })).toBe(false);
    expect(connectionReady({ ...ok, timeoutMs: Number.NaN })).toBe(false);
    expect(connectionReady({ ...ok, concurrency: 17 })).toBe(false);
    expect(connectionReady({ ...ok, url: "  " })).toBe(false);
  });

  test("a new connection needs a valid ID and an endpoint", () => {
    expect(newConnectionReady({ id: "github", url: "https://example.com/mcp", transport: "http", token: "" })).toBe(true);
    expect(newConnectionReady({ id: "GitHub", url: "https://example.com/mcp", transport: "http", token: "" })).toBe(false);
    expect(newConnectionReady({ id: "github", url: "", transport: "http", token: "" })).toBe(false);
  });
});

describe("hostOf", () => {
  test("shows the host of the endpoint, or the text when it is not a URL", () => {
    expect(hostOf("https://api.example.com:8443/mcp")).toBe("api.example.com:8443");
    expect(hostOf("not a url")).toBe("not a url");
  });
});
