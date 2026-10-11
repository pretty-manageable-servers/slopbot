import type { ToolActivity } from '../tool-activity.js';
const label = (name: string) => name.replace(/[^a-zA-Z0-9_]/g, '').replace(/_/g, ' ').slice(0, 80);
const status = (item: ToolActivity) => item.reused ? `${item.status}, saved result` : item.status;
export function toolFooter(activity: readonly ToolActivity[]): string {
  const groups = new Map<string, {item: ToolActivity; count: number}>();
  for (const item of activity) {
    const key = `${item.name}:${status(item)}`;
    const group = groups.get(key);
    if (group) group.count++; else groups.set(key, {item, count: 1});
  }
  return groups.size ? '\n\n**Tool activity**\n' + [...groups.values()].map(({item,count})=>`- ${label(item.name)}${count > 1 ? ` ×${count}` : ''}: ${status(item)}`).join('\n') : '';
}
export function toolProgress(activity: readonly ToolActivity[]): string {
  return '**Working**\n' + (activity.length > 8 ? `Earlier steps: ${activity.length - 8}\n` : '') + activity.slice(-8).map((item,index)=>`${activity.length - Math.min(activity.length,8) + index + 1}. ${label(item.name)}: ${status(item)}`).join('\n');
}
