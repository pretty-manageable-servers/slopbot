import type { ToolActivity } from "../tool-activity.js";
const label = (name: string) =>
  "`" + name.replace(/[^a-zA-Z0-9_]/g, "").slice(0, 80) + "`";
const status = (item: ToolActivity) =>
  item.reused ? `${item.status}, saved result` : item.status;
const duration = (item: ToolActivity) =>
  item.durationMs === undefined
    ? ""
    : ` | ${(item.durationMs / 1000).toFixed(1)}s`;
export function toolFooter(activity: readonly ToolActivity[]): string {
  const groups = new Map<string, { item: ToolActivity; count: number }>();
  for (const item of activity) {
    const key =
      item.durationMs === undefined ? `${item.name}:${status(item)}` : item.id;
    const group = groups.get(key);
    if (group) group.count++;
    else groups.set(key, { item, count: 1 });
  }
  return groups.size
    ? "\n\n**Tool activity**\n" +
        [...groups.values()]
          .map(
            ({ item, count }) =>
              `- ${label(item.name)}${count > 1 ? ` ×${count}` : ""}: ${status(item)}${duration(item)}`,
          )
          .join("\n")
    : "";
}
export function toolProgress(activity: readonly ToolActivity[]): string {
  return (
    "**Working**\n" +
    (activity.length > 8 ? `Earlier steps: ${activity.length - 8}\n` : "") +
    activity
      .slice(-8)
      .map(
        (item, index) =>
          `${activity.length - Math.min(activity.length, 8) + index + 1}. ${label(item.name)}: ${status(item)}${duration(item)}`,
      )
      .join("\n")
  );
}
