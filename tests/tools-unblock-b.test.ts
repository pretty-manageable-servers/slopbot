import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import type { Message } from "../src/domain.js";
import { ProgramRuntime, programLimits } from "../src/program-runtime.js";
import { programText, runToolsCodeTool } from "../src/run-tools-code.js";
import { toolFooter } from "../src/presentation/tool-activity.js";
import { ToolRegistry, type ToolDefinition } from "../src/tools.js";
import type { ToolActivity } from "../src/tool-activity.js";
import { registerHistoryTools } from "../src/search/history-search.js";
import { registerServerTools } from "../src/server-tools.js";
import { registerProfileTools } from "../src/profiles.js";
import { registerReminderTools } from "../src/productivity/reminders.js";
import { registerScheduleTool } from "../src/schedules/schedule-tool.js";
import { issueDraftTools } from "../src/issue-drafts.js";
import { objectStorageTools } from "../src/object-storage.js";
import { registerViewImage } from "../src/view-image.js";
import { registerUsageTool } from "../src/usage-tools.js";

const message: Message = { id: "1", server: "s", channel: "t", author: "alice", text: "hello" };
const stub = {} as never;

/** A small tool with each kind of field the forgiving validator handles. */
const demo: ToolDefinition = {
  name: "demo", description: "Demo tool. Second sentence.", access: "member", effect: "read", retrySafe: true,
  fields: {
    query: { type: "string", description: "Search text", required: true },
    limit: { type: "integer", min: 1, max: 10, description: "Results" },
    topic: { type: "string", choices: ["overview", "architecture", "runtime"], description: "Topic" },
    history: { type: "string", choices: ["history_search", "history_read"], description: "Which" },
    deep: { type: "boolean", description: "Deep search" },
  },
  async execute(_context, args) { return { text: JSON.stringify(args) }; },
};
const demoRegistry = () => { const registry = new ToolRegistry(new SQLiteStore(), async () => true); registry.register(demo); return registry; };

/** The tools a real deployment registers with the registry, built from their own registration code. */
function productionRegistry(): ToolRegistry {
  const registry = new ToolRegistry(new SQLiteStore(), async () => true);
  registerHistoryTools(registry, stub);
  registerServerTools(registry, { config: {}, server: "s", store: {}, participation: { options: {}, diagnostics: new Map() }, history: {}, channels: () => [], inbox: {} } as never);
  registerProfileTools(registry, stub);
  registerReminderTools(registry, stub);
  registerScheduleTool(registry, stub);
  for (const tool of issueDraftTools(stub)) registry.register(tool);
  for (const tool of objectStorageTools(stub)) registry.register(tool);
  registerViewImage(registry, stub);
  registerUsageTool(registry, stub);
  registry.register(runToolsCodeTool(registry));
  return registry;
}

test("catalog_is_typed_and_under_2k_tokens", () => {
  const registry = productionRegistry();
  // The catalog is the run_tools_code description after "Core catalog:".
  const description = registry.definitions().find(tool => tool.name === "run_tools_code")!.description;
  const lines = description.slice(description.indexOf("Core catalog:\n") + "Core catalog:\n".length).split("\n");
  assert.ok(lines.length > 5, "the catalog lists the admin and rare tools");
  for (const line of lines) assert.match(line, /^- [a-z][a-z0-9_]*\([^)]*\): \S/, line);
  const text = lines.join("\n");
  assert.ok(text.length / 4 < 2000, `catalog is ${Math.round(text.length / 4)} estimated tokens`);
  assert.match(text, /\bfile_store_write\(action: /);
  assert.match(text, /\b\w+\((?:\w+\??: [^,)]+, )*\w+\??: bool\)/, "booleans are typed bool");
  assert.doesNotMatch(text, /\bhistory_search\(/, "direct tools are not in the catalog");
  assert.doesNotMatch(text, /\bmemory_forget\(/, "direct write tools are not in the catalog");
});

test("clamp_number_with_note", async () => {
  const registry = demoRegistry();
  assert.deepEqual(registry.check("demo", { query: "x", limit: 20 }), { args: { query: "x", limit: 10 }, notes: ["limit 20 → 10 (max)"] });
  assert.deepEqual(registry.check("demo", { query: "x", limit: 0 }).notes, ["limit 0 → 1 (min)"]);
  assert.deepEqual(registry.check("demo", { query: "x", limit: 3 }).notes, []);
  const result = await registry.invokeResult(message, "demo", { query: "x", limit: 20 }, "clamp", "agent");
  assert.equal(result.text, "Note: limit 20 → 10 (max).\n{\"query\":\"x\",\"limit\":10}");
  assert.deepEqual(result.notes, ["limit 20 → 10 (max)"]);
  // A replayed call returns the same note; it is not added twice.
  assert.equal((await registry.invokeResult(message, "demo", { query: "x", limit: 20 }, "clamp", "agent")).text, result.text);
});

test("enum_unique_match_mapped", () => {
  const registry = demoRegistry();
  assert.deepEqual(registry.check("demo", { query: "x", topic: "Architecture" }).args.topic, "architecture");
  assert.deepEqual(registry.check("demo", { query: "x", topic: "run time" }).args.topic, "runtime");
  assert.deepEqual(registry.check("demo", { query: "x", topic: "over" }).args.topic, "overview");
  assert.deepEqual(registry.check("demo", { query: "x", topic: "arch" }).notes, ['topic "arch" → architecture']);
});

test("enum_ambiguous_lists_values", () => {
  const registry = demoRegistry();
  assert.throws(() => registry.validate("demo", { query: "x", history: "history" }), error => error instanceof Error && error.message.includes("matches more than one value") && error.message.includes("history_search, history_read"));
  assert.throws(() => registry.validate("demo", { query: "x", topic: "nope" }), /Invalid choice for topic: "nope"\. Use one of: overview, architecture, runtime\./);
});

test("unknown_argument_lists_names", () => {
  const registry = demoRegistry();
  assert.throws(() => registry.validate("demo", { query: "x", colour: "red" }), /Unknown argument: colour\. demo takes: query, limit, topic, history, deep\./);
});

test("invalid_text_names_type", () => {
  const registry = demoRegistry();
  assert.throws(() => registry.validate("demo", { query: 5 }), /Invalid text: query\. Expected a string, got a number\./);
  assert.throws(() => registry.validate("demo", { query: "  " }), /query must not be empty\./);
  assert.throws(() => registry.validate("demo", { query: "x", deep: "yes" }), /Invalid boolean: deep\. Expected true or false, got a string\./);
});

test("program_output_truncated_not_failed", async () => {
  const runtime = new ProgramRuntime({ ...programLimits, maxOutputBytes: 100 });
  const result = await runtime.run('text("a".repeat(300)); text("never");', [], async () => ({}));
  assert.equal(result.error, undefined);
  assert.equal(result.outputs[0], "a".repeat(100));
  assert.equal(result.outputs.length, 1);
  assert.equal(result.truncatedBytes, 300 - 100 + 7);
  assert.match(programText(result), /truncated, 207 bytes more; use save_to_sandbox to keep all of it$/);
});

test("top_level_tool_from_code_clear_error", async () => {
  const registry = demoRegistry();
  registry.register({ name: "shell", surface: "top", description: "Run a command", fields: {}, access: "member", effect: "read", retrySafe: true, async execute() { return "ran"; } });
  registry.register(runToolsCodeTool(registry));
  const direct = await registry.invokeResult(message, "run_tools_code", { code: 'return await shell({});' }, "direct", "agent");
  assert.match(direct.text, /shell is a direct tool\. Call it outside run_tools_code\./);
  const modules = await registry.invokeResult(message, "run_tools_code", { code: 'return require("fs");' }, "modules", "agent");
  assert.match(modules.text, /require is not defined\. The sandbox has no Node modules/);
});

test("direct_tools_are_top_level", () => {
  const registry = productionRegistry();
  const top = new Set(registry.schemas().map(schema => schema.function.name));
  for (const name of ["history_search", "history_read", "memory", "bot_info", "profile", "file_store", "memory_remember", "memory_update", "memory_forget", "reminder", "schedule", "inbox_add", "inbox_done", "inbox_list", "issue_draft", "view_image"]) assert.ok(top.has(name), `${name} is a direct tool`);
  assert.ok(!top.has("file_store_write"), "file_store writes stay in the catalog");
});

test("footer_plain_words_counts_children", () => {
  const calls: ToolActivity[] = [
    { id: "run", name: "run_tools_code", status: "completed" },
    { id: "1", parentId: "run", name: "history_search", status: "completed" },
    { id: "2", parentId: "run", name: "history_search", status: "completed" },
    { id: "3", parentId: "run", name: "web_fetch", status: "completed" },
    { id: "4", parentId: "run", name: "web_fetch", status: "completed" },
    { id: "5", name: "history_search", status: "completed", startedAt: 1000, durationMs: 11000 },
  ];
  assert.equal(toolFooter(calls), "\n\n-# searched history 3× · read 2 pages · 11s");
  assert.doesNotMatch(toolFooter(calls), /code|Programmatic|🧩|🛠/);
});
