import type { Json, Message } from './domain.js';
import type { RecordStore } from './records.js';
import type { ToolActivity } from './tool-activity.js';
import { decodeToolResult, type ToolJournal } from './tools.js';
import { diagnosticArgs, diagnosticText, safeDiagnosticData } from './diagnostic-data.js';
import { stableJson } from './prompt-cache.js';
import { PROGRAM_CODE_KEEP_MS } from './code-display.js';
import { uiKey } from './ui/runtime.js';

export const TOOL_TRACE_KIND = 'tool_trace';
export const TOOL_TRACE_CURSOR_KIND = 'tool_trace_cursor';
export interface TraceStep {
  id: string;
  name: string;
  arguments: Json;
  status: ToolActivity['status'];
  durationMs: number | null;
  outcome: string;
}
export interface ToolTrace {
  owner: string;
  channel: string;
  expires: number;
  steps: TraceStep[];
}
export interface TraceCursor { trace: string; index: number; actor: string; channel: string; expires: number }

/** Frozen with the reply so later operation changes cannot rewrite its trace. */
export async function saveToolTrace(store: RecordStore & Pick<ToolJournal, 'operation'>, message: Message, activity: readonly ToolActivity[]): Promise<string | undefined> {
  if (!activity.length) return undefined;
  const id = uiKey(`trace:${message.channel}:${message.id}`);
  if (await store.record(message.server, TOOL_TRACE_KIND, id)) return id;
  const ordered = activity.map((step, index) => ({ step, index }));
  if (activity.every(step => step.startedAt !== undefined))
    ordered.sort((a, b) => a.step.startedAt! - b.step.startedAt! || a.index - b.index);
  const steps = await Promise.all(ordered.map(async ({ step }): Promise<TraceStep> => {
    const operation = await store.operation(step.id);
    const output = operation?.result ? decodeToolResult(operation.result) : undefined;
    return {
      id: step.id, name: step.name,
      arguments: diagnosticArgs(step.arguments ?? operation?.args ?? (step.code ? { code: step.code } : {})),
      status: step.status, durationMs: step.durationMs ?? null,
      outcome: diagnosticText(step.reason ?? output?.text ?? (step.status === 'running' ? 'Outcome unknown; no confirmed result.' : 'No saved result is available.'), 2000),
    };
  }));
  await store.putRecord(message.server, TOOL_TRACE_KIND, id, { owner: message.author, channel: message.channel, expires: Date.now() + PROGRAM_CODE_KEEP_MS, steps } as unknown as Json, 0);
  return id;
}

const clipped = (text: string, limit: number) => text.length <= limit ? text : `${text.slice(0, limit - 20).replace(/[\uD800-\uDBFF]$/, '')}… [truncated]`;
function fields(step: TraceStep): Record<string, string> {
  return {
    tool: step.name,
    arguments: stableJson(safeDiagnosticData(step.arguments)),
    status: step.status,
    duration: step.durationMs === null ? 'unavailable' : `${step.durationMs} ms`,
    outcome: step.outcome.replace(/\s+/g, ' '),
  };
}

/** Each field is compared with the preceding chronological step. Unchanged values are omitted. */
export function tracePage(trace: ToolTrace, index: number): string {
  const step = trace.steps[index]!;
  const previous = index ? fields(trace.steps[index - 1]!) : {};
  const current = fields(step);
  const diff = Object.entries(current).flatMap(([key, value]) => previous[key] === value
    ? [] : [...(previous[key] !== undefined ? [`- ${key}: ${clipped(previous[key], 240)}`] : []), `+ ${key}: ${clipped(value, 240)}`]);
  const header = `Tool run ${index + 1}/${trace.steps.length}: ${step.name.replace(/[^a-zA-Z0-9_]/g, '').slice(0, 80)} · ${step.status} · ${current.duration}`;
  // Fixed fences and disabled mentions keep diagnostic strings inert in Discord.
  const body = clipped(diff.join('\n').replace(/`/g, 'ˋ'), 1550);
  return `${header}\n${index ? `Changes from run ${index}.` : 'Initial step.'}\n\`\`\`diff\n${body || '  No fields changed.'}\n\`\`\``;
}

/** Expired snapshots are scrubbed; tombstones prevent a delivery retry from reviving them. */
export async function pruneToolTraces(store: RecordStore, server: string, now = Date.now()): Promise<void> {
  for (const kind of [TOOL_TRACE_KIND, TOOL_TRACE_CURSOR_KIND]) {
    for (const record of await store.records(server, kind)) {
      const value = record.value as { expires?: number; expired?: boolean };
      if (value.expires !== undefined && value.expires <= now && !value.expired)
        await store.putRecord(server, kind, record.id, { expired: true }, record.revision);
    }
  }
}
