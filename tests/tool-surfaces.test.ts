import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { SQLiteStore } from "../src/adapters/sqlite.js";
import type { Message } from "../src/domain.js";
import { directMessageChannel, privateChannel } from "../src/private-chat.js";
import { ToolError, ToolRegistry, discordOnlyMessage, webOnlyMessage, type ToolDefinition } from "../src/tools.js";
import { registerShowUiTool } from "../src/ui/show-ui.js";
import { registerShowWidgetTool } from "../src/ui/show-widget.js";

const guild = "100000000000000001";
const dm = directMessageChannel("200000000000000002");
const webChat = privateChannel("0123456789abcdef0123456789abcdef");

const discordChannel: Message = { id: "m1", server: "s", channel: guild, author: "alice", text: "hi", surface: "discord" };
const directMessage: Message = { id: "m2", server: "s", channel: dm, author: "alice", text: "hi", surface: "discord-dm" };
const webMessage: Message = { id: "m3", server: "s", channel: webChat, author: "alice", text: "hi", surface: "web" };
const oldWebMessage: Message = { id: "m4", server: "s", channel: "web:abc", author: "alice", text: "hi" };

async function registry(t: TestContext): Promise<ToolRegistry> {
  const store = new SQLiteStore(); t.after(() => store.close());
  const tools = new ToolRegistry(store, async () => true);
  registerShowUiTool(tools);
  registerShowWidgetTool(tools);
  const channels: ToolDefinition = { name: "channels", surface: "top", description: "lists channels", fields: {}, access: "member", effect: "read", retrySafe: true, needs: ["discord_actions"], async execute() { return "listed"; } };
  const reader: ToolDefinition = { name: "reader", surface: "top", description: "reads", fields: {}, access: "member", effect: "read", retrySafe: true, async execute() { return "read ok"; } };
  tools.register(channels);
  tools.register(reader);
  return tools;
}

test("each surface is offered only the tools whose capabilities it has", async t => {
  const tools = await registry(t);
  const offered = (message: Message) => tools.schemas(message).map(item => item.function.name).sort();
  const cases: [string, Message, string[]][] = [
    ["a Discord channel gets Discord tools, not web visuals", discordChannel, ["channels", "reader"]],
    ["a DM gets neither Discord tools nor web visuals", directMessage, ["reader"]],
    ["a web chat gets web visuals, not Discord tools", webMessage, ["reader", "show_ui", "show_widget"]],
    ["a saved message with no surface in a web chat is a web chat", oldWebMessage, ["reader", "show_ui", "show_widget"]],
  ];
  for (const [name, message, expected] of cases) assert.deepEqual(offered(message), expected, name);
});

test("a surface that lacks a capability is refused the tool with that capability's message", async t => {
  const tools = await registry(t);
  const widgetInput = { widget_code: '<svg viewBox="0 0 10 10"><circle cx="5" cy="5" r="4"/></svg>' };
  const cases: [string, Message, string, Record<string, unknown>, string][] = [
    ["a DM calling show_widget", directMessage, "show_widget", widgetInput, webOnlyMessage],
    ["a DM calling a Discord tool", directMessage, "channels", {}, discordOnlyMessage],
    ["a Discord channel calling show_ui", discordChannel, "show_ui", { markup: "<p>hi</p>" }, webOnlyMessage],
    ["a web chat calling a Discord tool", webMessage, "channels", {}, discordOnlyMessage],
  ];
  for (const [name, message, tool, input, expected] of cases) {
    await assert.rejects(tools.invokeResult(message, tool, input, `op-${name}`, "agent"), (error: unknown) => error instanceof ToolError && error.message === expected, name);
  }
});
