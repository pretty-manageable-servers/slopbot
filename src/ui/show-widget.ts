import { checkWidgetCode, visualizeGuide, visualizeTool } from "agentic-ui-kit/core";
import type { ToolRegistry } from "../tools.js";

const props = visualizeTool.inputSchema.properties;

/**
 * show_widget: the model writes an HTML or SVG fragment with its own scripts, and the web console draws it in
 * a sandboxed frame while it streams (agentic-ui-kit's visualize preset). Use it for charts, sliders and other
 * interactive visuals that show_ui's components cannot draw. Web chats only. The tool does nothing on the
 * server. Its result is the kit's code check, so the model can fix a bad call. The kit's design guide is part
 * of the description, so it reaches the model only where the tool is offered.
 */
export function registerShowWidgetTool(registry: ToolRegistry): void {
  registry.register({
    name: visualizeTool.name,
    surface: "top",
    scope: "web",
    description: `${visualizeTool.description}\n\n${visualizeGuide}`,
    fields: {
      widget_code: { type: "string", description: props.widget_code.description, required: true, max: 60000 },
      title: { type: "string", description: props.title.description, max: 80 },
      loading_messages: { type: "json", description: props.loading_messages.description, schema: props.loading_messages as never },
    },
    access: "member",
    effect: "read",
    retrySafe: true,
    async execute(_context, args) {
      return { text: checkWidgetCode(args.widget_code, undefined, visualizeTool.name).feedback };
    },
  });
}
