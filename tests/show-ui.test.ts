import assert from "node:assert/strict";
import { test } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import { ToolRegistry } from "../src/tools.js";
import { registerShowUiTool } from "../src/ui/show-ui.js";
import { registerShowWidgetTool } from "../src/ui/show-widget.js";

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

test("show_widget answers with the widget code check and is offered only in web chats", async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => true);
  registerShowWidgetTool(registry);
  const message = { server: "s", channel: "web:chat-1", taskId: "web:chat-1", id: "m", author: "alice", text: "plot", addressed: true };
  const good = await registry.invokeResult(message, "show_widget", { widget_code: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4" fill="var(--chat-accent)"/></svg>' }, "op1", "agent");
  const bad = await registry.invokeResult(message, "show_widget", { widget_code: '<html><body><script src="https://cdn.example.com/d3.js"></script></body></html>' }, "op2", "agent");
  assert.match(JSON.stringify(good), /Shown to the user\./);
  assert.match(JSON.stringify(bad), /will not work as written/);
});
