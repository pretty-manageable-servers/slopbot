import { checkUiMarkupCode, showUiTool } from "agentic-ui-kit/core";
import type { ToolRegistry } from "../tools.js";
import { showUiSpecs } from "./show-ui-specs.js";

const tool = showUiTool(showUiSpecs);

/**
 * show_ui: the model writes JSX of the web console's components, and the chat draws it while it streams
 * (agentic-ui-kit). Only web chats can draw it, so Discord channels are not offered it. The tool does
 * nothing on the server. Its result is the markup check, so the model can fix a bad call.
 */
export function registerShowUiTool(registry: ToolRegistry): void {
  registry.register({
    name: tool.name,
    surface: "top",
    needs: ["web_visuals"],
    description: tool.description,
    fields: { markup: { type: "string", description: tool.inputSchema.properties.markup.description, required: true, max: 20000 } },
    access: "member",
    effect: "read",
    retrySafe: true,
    async execute(_context, args) {
      return { text: checkUiMarkupCode(args.markup, showUiSpecs, tool.name).feedback };
    },
  });
}
