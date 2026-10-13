import type { ToolActivity } from "../tool-activity.js";
const label = (name: string) =>
  "`" + name.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 80) + "`";
const status = (item: ToolActivity) => {
  const text = item.status === "rejected" ? "blocked" : item.status;
  return item.reused ? `${text}, saved result` : text;
};
const reason = (item: ToolActivity, limit = 500) => item.reason
  ? `: ${item.reason.replace(/\s+/g, " ").replace(/[\\`*_~<>|\[\]]/g, "\\$&").slice(0, limit).replace(/[\uD800-\uDBFF]$/, "")}`
  : "";
export function toolFailureSummary(activity: readonly ToolActivity[]): string {
  return activity.filter(item => item.status === "rejected" || item.status === "failed")
    .map(item => `- ${label(item.name)}: ${status(item)}${reason(item)}`).join("\n");
}
const duration = (item: ToolActivity) =>
  item.durationMs === undefined
    ? ""
    : ` | ${(item.durationMs / 1000).toFixed(1)}s`;
export type ToolDisplayMode = "none" | "summary" | "full";
export function toolDisplayMode(value: unknown): ToolDisplayMode {
  return value === "none" || value === "full" ? value : "summary";
}
const clip = (text: string, limit: number) => text.length <= limit ? text : text.slice(0, Math.max(0, limit - 1)).replace(/[\uD800-\uDBFF]$/, "") + "…";
function argumentsBlock(item: ToolActivity, limit?: number): string {
  if (!item.arguments || !Object.keys(item.arguments).length) return "";
  const json = JSON.stringify(item.arguments, (key, value) =>
    /^(?:password|secret|token|api[_-]?key|authorization|credentials|access[_-]?token|client[_-]?secret)$/i.test(key) ? "[redacted]" : value, 2)
    .replace(/`/g, "\\u0060");
  return "\n```json\n" + (limit === undefined ? json : clip(json, limit)) + "\n```";
}
export function toolFooter(activity: readonly ToolActivity[], mode: ToolDisplayMode = "full"): string {
  if (!activity.length || mode === "none") return "";
  const prefix = "\n\n**Tool activity**\n";
  if (mode === "summary") {
    const groups = new Map<string, number>();
    for (const item of activity) groups.set(item.name, (groups.get(item.name) ?? 0) + 1);
    return prefix + [...groups].map(([name, count]) => `${label(name)} × ${count}`).join(" · ");
  }
  return prefix + activity.map(item =>
    `- ${label(item.name)}: ${status(item)}${duration(item)}${reason(item)}${argumentsBlock(item)}`
  ).join("\n");
}
export function toolProgress(activity: readonly ToolActivity[]): string {
  const prefix = "**Working**\n" + (activity.length > 8 ? `Earlier steps: ${activity.length - 8}\n` : "");
  const recent = activity.slice(-8);
  const rows = recent.map((item, index) => `${activity.length - recent.length + index + 1}. ${label(item.name)}: ${status(item)}${duration(item)}`);
  const fixed = prefix.length + rows.join('\n').length;
  const budget = Math.max(0, Math.floor((2000 - fixed) / Math.max(1, recent.length)));
  return prefix + rows.map((row, index) => {
    const item = recent[index]!;
    const detail = reason(item, Math.min(200, Math.max(0, item.arguments ? Math.floor(budget / 3) : budget - 20)));
    const args = argumentsBlock(item, Math.max(0, budget - detail.length - 16));
    return row + detail + args;
  }).join('\n');
}
