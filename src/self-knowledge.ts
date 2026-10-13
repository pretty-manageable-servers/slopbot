import { decisionQuestions, participationPrompt } from "./participation-prompts.js";
import { readFileSync } from "node:fs";
import { ToolError, type ToolDefinition, type ToolRegistry } from "./tools.js";

// Only this reviewed, public guide is readable. Never inspect environment files or logs.
// Internal prompts. Only a member of the Slopbot team may read them.
const TEAM_TOPICS = new Set(["decision_prompt", "participation_prompt"]);

export function selfKnowledgeTool(registry: ToolRegistry, isTeamEditor: (user: string) => Promise<boolean>, runtime: () => string): ToolDefinition {
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
    description: "Read Slopbot's architecture, tools, error diagnostics, current safe runtime, and reviewed PMServers documentation/changelog. Use this before explaining how the bot works or how to use it. Documentation describes design, not live service health.",
    fields: { topic: { type: "string", description: "Default: overview. Use capabilities for registered tools, runtime for current safe configuration.", choices: topics } },
    access: "member", effect: "read", retrySafe: true,
    async execute(context, args) {
      const topic = String(args.topic ?? "overview");
      if (TEAM_TOPICS.has(topic) && !await isTeamEditor(context.message.author)) throw new ToolError("Only the Slopbot team can read this topic.");
      if (topic === "runtime") return { text: `Current configuration, not a health check:\n${runtime()}` };
      if (topic === "capabilities") return { text: `Registered tools: ${registry.definitions().map(tool => `${tool.name} (${tool.access}, ${tool.effect})`).join(", ")}.\nFunction schemas provide arguments; permissions are enforced by the shared registry. The same handlers serve slash commands and model calls.` };
      const content = sections.get(topic);
      if (!content) throw new ToolError("Unknown bot_info topic");
      return { text: `Slopbot guide / ${topic}\n${content}`, sources: [{ kind: "web", url: "https://github.com/pretty-manageable-servers/slopbot/blob/main/architecture/BOT_GUIDE.md", title: "Slopbot usage and architecture guide" }, ...[...new Set(content.match(/https:\/\/docs\.pmservers\.org\/[a-z0-9_\/-]+/g) ?? [])].map(url => ({ kind: "web" as const, url, title: "PMServers documentation" }))] };
    },
  };
}
