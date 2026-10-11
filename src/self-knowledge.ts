import { decisionQuestions, participationPrompt } from "./participation-prompts.js";
import { readFileSync } from "node:fs";
import { ToolError, type ToolDefinition, type ToolRegistry } from "./tools.js";

// Only this reviewed, public guide is readable. Never inspect environment files or logs.
export function selfKnowledgeTool(registry: ToolRegistry, runtime: () => string): ToolDefinition {
  const document = readFileSync(new URL("../architecture/BOT_GUIDE.md", import.meta.url), "utf8");
  const sections = new Map(document.split(/^## /m).slice(1).map(section => {
    const end = section.indexOf("\n");
    return [section.slice(0, end).trim(), section.slice(end + 1).trim()];
  }));
  sections.set("decision_prompt", JSON.stringify(decisionQuestions, null, 2));
  sections.set("participation_prompt", participationPrompt);
  const topics = [...sections.keys(), "capabilities", "runtime"];
  return {
    name: "bot_info",
    description: "Read Slopbot's own architecture, context/memory, tools, deployment, caching, limitations and current runtime. Use this before explaining how the bot works or how to use it. Documentation describes design, not live service health.",
    fields: { topic: { type: "string", description: "Default: overview. Use capabilities for registered tools, runtime for current safe configuration.", choices: topics } },
    access: "member", effect: "read", retrySafe: true,
    async execute(_context, args) {
      const topic = String(args.topic ?? "overview");
      if (topic === "runtime") return { text: `Current configuration, not a health check:\n${runtime()}` };
      if (topic === "capabilities") return { text: `Registered tools: ${registry.definitions().map(tool => `${tool.name} (${tool.access}, ${tool.effect})`).join(", ")}.\nUse the tool catalog for arguments and permissions. The same handlers serve slash commands and model calls.` };
      const content = sections.get(topic);
      if (!content) throw new ToolError("Unknown bot_info topic");
      return { text: `Slopbot guide / ${topic}\n${content}\nOther topics: ${topics.join(", ")}.`, sources: [{ kind: "web", url: "https://github.com/pretty-manageable-servers/slopbot/blob/main/architecture/BOT_GUIDE.md", title: "Slopbot usage and architecture guide" }] };
    },
  };
}
