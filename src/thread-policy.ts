import type { ToolArgs } from './tools.js';

type Policy = 'inline' | 'thread' | { actions: readonly string[] };
/** Every native write tool belongs here. Edit this table to change automatic thread routing. */
export const NATIVE_THREAD_POLICY = {
  bot_replies: 'inline', calibration: 'inline', channels: 'thread', context: 'inline', cooldown: 'inline',
  default_effort: 'inline', edit: 'inline', file_store: 'inline', fix_watch: 'thread',
  inbox_add: 'inline', inbox_done: 'inline', index: 'thread', issue_report: 'thread', issue_report_edit: 'thread',
  memory_forget: 'inline', memory_remember: 'inline', memory_update: 'inline', monitoring: 'inline', mute_users: 'inline',
  profile: 'inline', reactions: 'inline', reminder: 'inline', sandbox_manage: { actions: ['build_template'] },
  schedule: 'inline', shell: 'inline', task_manage: 'inline', task_retry: 'thread',
  task_start: 'inline', timing: 'inline', tool_display: 'inline', voice: 'inline', write: 'inline',
} as const satisfies Record<string, Policy>;

export function toolNeedsThread(name: string, args: ToolArgs, effect: 'read' | 'write', provider?: string, execution?: 'inline' | 'thread'): boolean {
  if (effect === 'read') return false;
  const policy: Policy | undefined = provider ? undefined : (NATIVE_THREAD_POLICY as Record<string, Policy>)[name];
  // External and custom tools default to a thread unless explicitly granted inline execution.
  if (!policy) return execution !== 'inline';
  return typeof policy === 'string' ? policy === 'thread' : policy.actions.includes(String(args.action));
}
