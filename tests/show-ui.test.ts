import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { ToolRegistry } from "../src/tools.js";
import { registerShowUiTool } from "../src/ui/show-ui.js";

test("show_ui answers with the markup check, so the model can fix a bad call", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  registerShowUiTool(registry);
  const message = { server: "s", channel: "web:chat-1", taskId: "web:chat-1", id: "m", author: "alice", text: "plan", addressed: true };
  const good = await registry.invokeResult(message, "show_ui", { markup: '<Card title="Plan"><Metric label="Total" value="3" /></Card>' }, "op1", "agent");
  assert.match(JSON.stringify(good), /Shown to the user\./);
  const bad = await registry.invokeResult(message, "show_ui", { markup: "<Card><Chart /></Card>" }, "op2", "agent");
  assert.match(JSON.stringify(bad), /unknown \\"Chart\\"/);
});
