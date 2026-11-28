import assert from "node:assert/strict";
import { inQuietHours } from "../src/clients/discord/assistant-notifier.js";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { ChannelAccess } from "../src/channel-access.js";
import { loadConfig } from "../src/config.js";
import type { Message } from "../src/domain.js";
import type { Directory } from "../src/engine/api.js";
import { PERSONAL_SERVER } from "../src/personal.js";
import { PersonalServer } from "../src/personal-server.js";
import { createUsageMeter } from "../src/usage-meter.js";
import { McpManager, McpSecrets, mcpToolName, type McpConnection } from "../src/mcp.js";
import { ToolRegistry } from "../src/tools.js";
import { putConnector } from "../src/assistant/connectors.js";
import { assistantHomeChannel, assistantTaskChannel, type AssistantTask } from "../src/assistant/types.js";

const owner = "1528063444874432735";

function fixture() {
  const config = loadConfig({ DISCORD_BOT_TOKEN: "test-only", LLM_MODE: "mock" });
  const store = new SQLiteStore();
  const llm = { async *stream() { yield { kind: "text" as const, payload: { text: "Checked in." } }; } };
  const directory = { isMember: async () => false, canManage: async () => false } as unknown as Directory;
  const personal = new PersonalServer({
    config, store, llm, usage: createUsageMeter(config, store), access: new ChannelAccess({ facts: async () => undefined }),
    team: { canEdit: async () => false } as never, directory,
  });
  const assistant = personal.assistant!;
  const task = (patch: Partial<AssistantTask> = {}): AssistantTask => ({
    id: "t1", owner, goal: "Watch the build", instructions: "", status: "active", pause: null, wake: { kind: "interval", minutes: 120 },
    nextAt: Date.now() - 1000, rules: {}, effort: "medium", failures: 0, lastRunAt: null, lastError: null, createdAt: 1, updatedAt: 1, revision: 1, ...patch,
  });
  return { personal, store, assistant, task };
}

test("a due sprout wakes once in its own web chat, the workspace answers, and nextAt moves forward", async t => {
  const f = fixture();
  t.after(async () => { await f.personal.stop(); f.store.close(); });
  await f.personal.ready("bot");
  await f.assistant.store.putSettings({ user: owner, enabled: true, briefCron: null, timezone: "UTC", dmUpdates: false, quietStart: null, quietEnd: null, updated: 1 });
  const due = f.task();
  await f.assistant.store.putTask(due, null);
  // ready() already started the real tick loop; drive a tick by hand so the test does not wait for the interval.
  const worker = (f.personal as unknown as { assistantWorker: { tick(): Promise<void> } }).assistantWorker;
  await worker.tick();
  await worker.tick();
  await f.personal.workspace.worker.idle();
  const channel = assistantTaskChannel("t1");
  const saved = await f.store.recentChannelMessages(PERSONAL_SERVER, channel, 10);
  assert.equal(saved.filter(m => m.author === owner).length, 1, "woken once");
  assert.ok(saved.some(m => m.text === "Checked in."), JSON.stringify(saved.map(m => m.text)));
  assert.equal((await f.store.webChat("assistant-task:t1"))?.owner, owner);
  const after = (await f.assistant.store.task("t1"))!;
  assert.ok(after.nextAt! > Date.now() + 60 * 60_000 && after.lastRunAt !== null);
});

test("a write call from an assistant wake is queued, and gate.execute runs it as the owner", async t => {
  const f = fixture();
  t.after(async () => { await f.personal.stop(); f.store.close(); });
  await f.personal.ready("bot");
  await f.assistant.store.putTask(f.task({ nextAt: null }), null);
  const message: Message = {
    id: "wake1", server: PERSONAL_SERVER, channel: assistantTaskChannel("t1"), author: owner, text: "wake", surface: "web", timestamp: Date.now(),
    assistant: { owner, task: "t1", trigger: "timer" },
  };
  const result = await f.personal.workspace.tools.invokeResult(message, "memory_remember", { text: "The build is green", source_policy: "independent" }, "op1", "agent");
  assert.match(result.text, /Queued for approval/);
  const [pending] = await f.assistant.store.pendingApprovals(owner);
  assert.equal(pending?.tool, "memory_remember");
  assert.equal(await f.store.memories(PERSONAL_SERVER, `user:${owner}`).then(m => m.length), 0);
  const ran = await f.assistant.gate.execute(pending!.id, owner, false);
  assert.match(ran.text, /Saved as your/);
  assert.equal((await f.assistant.store.approval(pending!.id))?.status, "approved");
});

test("a personal connector's tools are offered only to its owner", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  const manager = new McpManager(PERSONAL_SERVER, store, registry, async (): Promise<McpConnection> => ({
    listTools: async () => [{ name: "read_it", readOnlyHint: true, inputSchema: { type: "object", properties: {} } }], close: async () => {}, callTool: async () => ({ content: [] }),
  }), new McpSecrets(Buffer.alloc(32, 3).toString("base64")));
  t.after(() => manager.close());
  await putConnector(manager, "alice", { name: "notes", url: "https://example.com/mcp" });
  const name = mcpToolName("u:alice:notes", "read_it");
  const as = (author: string): Message => ({ id: author, server: PERSONAL_SERVER, channel: assistantHomeChannel(author), author, text: "x", surface: "web" });
  assert.ok(registry.catalog(as("alice")).includes(name));
  assert.ok(!registry.catalog(as("bob")).includes(name));
});

test("quiet hours with an invalid timezone do not throw", () => {
  assert.equal(inQuietHours({ timezone: "Not/AZone", quietStart: "22:00", quietEnd: "07:00" }, Date.now()), false);
});
