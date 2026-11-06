import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import type { Message } from "../src/domain.js";
import { ProgramRuntime, programLimits } from "../src/program-runtime.js";
import { programText, runToolsCodeTool } from "../src/run-tools-code.js";
import { ToolRegistry, type ToolDefinition } from "../src/tools.js";

const message: Message = { id: "1", server: "s", channel: "t", author: "alice", text: "hello" };

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
