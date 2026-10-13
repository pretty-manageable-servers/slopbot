import type { ToolActivity } from "../tool-activity.js";
import { currentStep, slopbotEmoji, toolEmoji, toolGroup } from "./tool-labels.js";
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
export type ToolDisplayMode = "none" | "summary" | "full";
const failed = (item: ToolActivity) => item.status === "rejected" || item.status === "failed";
const counts = (activity: readonly ToolActivity[]) => {
  const groups = new Map<string, number>();
  for (const item of activity) groups.set(item.name, (groups.get(item.name) ?? 0) + 1);
  return groups;
};
// Wall time from the first tool start to the last tool end.
const totalTime = (activity: readonly ToolActivity[]) => {
  const timed = activity.filter(item => item.startedAt !== undefined && item.durationMs !== undefined);
  if (!timed.length) return "";
  const ms = Math.max(...timed.map(item => item.startedAt! + item.durationMs!)) - Math.min(...timed.map(item => item.startedAt!));
  return ` · ${Math.max(1, Math.round(ms / 1000))}s`;
};
const title = (text: string) => text[0]!.toUpperCase() + text.slice(1);
export function toolDisplayMode(value: unknown): ToolDisplayMode {
  return value === "none" || value === "full" ? value : "summary";
}
const clip = (text: string, limit: number) => text.length <= limit ? text : text.slice(0, Math.max(0, limit - 1)).replace(/[\uD800-\uDBFF]$/, "") + "…";
export function toolFooter(activity: readonly ToolActivity[], mode: ToolDisplayMode = "full"): string {
  if (!activity.length || mode === "none") return "";
  const groups = [...counts(activity)].map(([name, count]) => `${toolEmoji(name)} ${count} ${toolGroup(name)[count === 1 ? 0 : 1]}`);
  const failures = mode === "full" ? activity.filter(failed).map(item => `-# ❌ ${toolGroup(item.name)[0]} ${status(item)}${reason(item, 200)}`) : [];
  return "\n\n" + [`-# ${groups.join(" · ")}${totalTime(activity)}`, ...failures].join("\n");
}
export function toolProgress(activity: readonly ToolActivity[], funLine: string): string {
  const groups = [...counts(activity)].map(([name, count]) => `${toolEmoji(name)} ${title(toolGroup(name)[0])} × ${count}`);
  const failures = activity.filter(failed).slice(-3).map(item => `-# ❌ ${toolGroup(item.name)[0]} ${status(item)}${reason(item, 120)}`);
  const last = activity[activity.length - 1];
  const now = last ? [`-# now: ${toolEmoji(last.name)} ${currentStep(last.name, last.arguments?.query)}`] : [];
  return clip([`${slopbotEmoji.pulse} ${funLine}`, ...groups, ...failures, ...now].join("\n"), 2000);
}
