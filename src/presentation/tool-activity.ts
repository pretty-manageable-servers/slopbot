import type { ToolActivity } from "../tool-activity.js";
import { currentStep, plainWords, slopbotEmoji, toolEmoji, toolGroup } from "./tool-labels.js";

const PROGRAM_TOOL = "run_tools_code";
// Child calls of a code run are shown under the run, not in the summary counts.
const topLevel = (activity: readonly ToolActivity[]) => activity.filter(item => !item.parentId);
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
// Wall time from the first tool start to the last tool end, for example "12s".
const totalTime = (activity: readonly ToolActivity[]) => {
  const timed = activity.filter(item => item.startedAt !== undefined && item.durationMs !== undefined);
  if (!timed.length) return "";
  const ms = Math.max(...timed.map(item => item.startedAt! + item.durationMs!)) - Math.min(...timed.map(item => item.startedAt!));
  return `${Math.max(1, Math.round(ms / 1000))}s`;
};
const title = (text: string) => text[0]!.toUpperCase() + text.slice(1);
export function toolDisplayMode(value: unknown): ToolDisplayMode {
  return value === "none" || value === "full" ? value : "summary";
}
const clip = (text: string, limit: number) => text.length <= limit ? text : text.slice(0, Math.max(0, limit - 1)).replace(/[\uD800-\uDBFF]$/, "") + "…";
const progressSymbol = (item: ToolActivity) => ({ running: "◌", completed: "✓", failed: "×", rejected: "!", delegated: "↗" })[item.status];
function programProgress(run: ToolActivity, calls: readonly ToolActivity[], number: number, budget: number): string {
  const totals = new Map<string, number>();
  for (const call of calls) {
    const state = call.status === "rejected" ? "blocked" : call.status;
    totals.set(state, (totals.get(state) ?? 0) + 1);
  }
  const summary = [...totals].map(([state, count]) => `${count} ${state}`).join(" · ") || "0 tool calls";
  const header = `Run ${number} · ${status(run)}\n\`\`\`\n`;
  const footer = `\n└ ${summary}\n\`\`\``;
  const row = (call: ToolActivity) => {
    const name = call.name.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 40);
    const detail = call.status === "running" || call.durationMs === undefined ? status(call)
      : `${(call.durationMs / 1000).toFixed(1)}s${call.status === "completed" ? "" : ` · ${status(call)}`}${call.reused ? " · saved result" : ""}`;
    return `${progressSymbol(call)} ${name} · ${detail}`;
  };
  // Keep active calls first, then failures and recent completions. Reserve room
  // for an omission notice and the closing fence before selecting any rows.
  const priority = [...calls.filter(call => call.status === "running"), ...calls.filter(failed).reverse(), ...calls.filter(call => call.status !== "running" && !failed(call)).reverse()];
  const selected = new Set<ToolActivity>();
  let used = header.length + footer.length + 50;
  for (const call of priority) {
    const size = row(call).length + 3;
    if (used + size > budget) continue;
    selected.add(call); used += size;
  }
  const rows = calls.filter(call => selected.has(call)).map(row);
  if (selected.size < calls.length) rows.push(`… ${calls.length - selected.size} more calls in tool trace`);
  if (!rows.length) rows.push(run.status === "running" ? "◌ running" : `${progressSymbol(run)} ${status(run)}`);
  return header + rows.map((text, index) => `${index ? "│" : "┌"} ${text}`).join("\n") + footer;
}
/** One plain-words line after the reply. Every call counts by its own tool, including calls inside a code run; the run itself is not counted. Details are in the Tool runs view. */
export function toolFooter(activity: readonly ToolActivity[], mode: ToolDisplayMode = "full"): string {
  if (!activity.length || mode === "none") return "";
  const calls = activity.filter(item => item.name !== PROGRAM_TOOL);
  const parts = [...counts(calls.filter(item => item.status === 'completed'))].map(([name, count]) => plainWords(name, count));
  const blocked = calls.filter(item => item.status === 'rejected').length, failedCount = calls.filter(item => item.status === 'failed').length, unknown = calls.filter(item => item.status === 'running').length;
  if (blocked) parts.push(`${blocked} blocked`);
  if (failedCount) parts.push(`${failedCount} failed`);
  if (unknown) parts.push(`${unknown} outcome unknown`);
  if (!parts.length) return "";
  const time = totalTime(activity);
  return "\n\n-# " + [...parts, ...(time ? [time] : [])].join(" · ");
}
export function toolProgress(activity: readonly ToolActivity[], funLine: string): string {
  const programRuns = topLevel(activity).filter(item => item.name === PROGRAM_TOOL);
  const visibleRuns = programRuns.slice(-3);
  const runs = visibleRuns.map((run, index) => programProgress(run, activity.filter(item => item.parentId === run.id), programRuns.length - visibleRuns.length + index + 1, Math.floor(1500 / visibleRuns.length)));
  if (programRuns.length > visibleRuns.length) runs.unshift(`-# ${programRuns.length - visibleRuns.length} earlier code runs in tool trace`);
  const groups = [...counts(topLevel(activity).filter(item => item.name !== PROGRAM_TOOL))].map(([name, count]) => `${toolEmoji(name)} ${title(toolGroup(name)[0])} × ${count}`);
  const failures = topLevel(activity).filter(failed).slice(-3).map(item => `-# ❌ ${toolGroup(item.name)[0]} ${status(item)}${reason(item, 120)}`);
  const last = activity[activity.length - 1];
  const now = last && !last.parentId && last.name !== PROGRAM_TOOL ? [`-# now: ${toolEmoji(last.name)} ${currentStep(last.name, last.arguments?.query)}`] : [];
  const blocks = runs.join("\n");
  const other = clip([`${slopbotEmoji.pulse} ${funLine}`, ...groups, ...failures, ...now].join("\n"), 2000 - blocks.length - (blocks ? 1 : 0));
  return blocks ? `${other}\n${blocks}` : other;
}
