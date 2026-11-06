import { z } from "zod";
import { ToolStatus, type EngineEvent } from "./events.js";

type ToolStatusEvent = Extract<EngineEvent, { type: "tool.status" }>;

export interface ToolPart {
  readonly kind: "tool";
  readonly call: string;
  readonly name: string;
  readonly status: z.infer<typeof ToolStatus> | "streaming";
  readonly inputText: string;
  readonly input?: unknown;
  readonly result?: string;
  readonly reason?: string;
  readonly code?: string;
  readonly parent?: string;
}

/** startedAt and durationMs: the time of the first delta, and the time to the next part or the turn end. Only with event times. */
export interface ThinkingPart { readonly kind: "thinking"; readonly text: string; readonly startedAt?: number; readonly durationMs?: number }

export type TurnPart = { readonly kind: "text"; readonly text: string } | ThinkingPart | ToolPart;

export interface TurnView {
  readonly turn: string;
  readonly status: "streaming" | "done" | "failed" | "interrupted";
  readonly parts: readonly TurnPart[];
}

/**
 * Pure. Text and thinking deltas of the same kind join the last part, else they start a new part.
 * tool.input and tool.status join the part with the same call. A message.* event is not part of a turn:
 * it returns the view unchanged, and it throws when there is no view yet.
 * at: the event time (the envelope's `at`). With it, a thinking part gets its "Thought for" time when it ends.
 */
export function reduceTurn(view: TurnView | undefined, event: EngineEvent, at?: number): TurnView {
  if (event.type === "message.upsert" || event.type === "message.delete") {
    if (view) return view;
    throw new TypeError(`${event.type} is not part of a turn`);
  }
  const base: TurnView = view ?? { turn: event.turn, status: "streaming", parts: [] };
  switch (event.type) {
    case "turn.start":
    case "round.start":
      return base;
    case "text.delta":
      return { ...base, parts: appendText(endThinking(base.parts, at), "text", event.text) };
    case "thinking.delta":
      return { ...base, parts: appendThinking(base.parts, event.text, at) };
    case "tool.input":
      return { ...base, parts: editTool(endThinking(base.parts, at), event.call, event.name, part => ({ ...part, inputText: part.inputText + event.text })) };
    case "tool.status":
      return { ...base, parts: editTool(endThinking(base.parts, at), event.call, event.name, part => toolStatusPart(part, event)) };
    case "turn.end":
      return { ...base, status: event.status, parts: endThinking(base.parts, at) };
  }
}

function appendText(parts: readonly TurnPart[], kind: "text", text: string): TurnPart[] {
  const last = parts.at(-1);
  if (last?.kind === kind) return [...parts.slice(0, -1), { kind, text: last.text + text }];
  return [...parts, { kind, text }];
}

function appendThinking(parts: readonly TurnPart[], text: string, at: number | undefined): TurnPart[] {
  const last = parts.at(-1);
  if (last?.kind === "thinking") return [...parts.slice(0, -1), { ...last, text: last.text + text }];
  return [...parts, { kind: "thinking", text, ...(at !== undefined ? { startedAt: at } : {}) }];
}

/** The last part, when it is thinking that has a start time, ends at this time. */
function endThinking(parts: readonly TurnPart[], at: number | undefined): readonly TurnPart[] {
  const last = parts.at(-1);
  if (at === undefined || last?.kind !== "thinking" || last.startedAt === undefined || last.durationMs !== undefined) return parts;
  return [...parts.slice(0, -1), { ...last, durationMs: Math.max(0, at - last.startedAt) }];
}

function editTool(parts: readonly TurnPart[], call: string, name: string, edit: (part: ToolPart) => ToolPart): TurnPart[] {
  const index = parts.findIndex(part => part.kind === "tool" && part.call === call);
  const existing = index === -1 ? undefined : parts[index];
  const part: ToolPart = existing?.kind === "tool" ? existing : { kind: "tool", call, name, status: "streaming", inputText: "" };
  const next = edit(part);
  return index === -1 ? [...parts, next] : parts.map((item, i) => (i === index ? next : item));
}

/** A status event sets the status and the fields it carries. Fields it leaves out keep their earlier value. */
function toolStatusPart(part: ToolPart, event: ToolStatusEvent): ToolPart {
  return {
    ...part,
    status: event.status,
    ...(event.input !== undefined ? { input: event.input } : {}),
    ...(event.result !== undefined ? { result: event.result } : {}),
    ...(event.reason !== undefined ? { reason: event.reason } : {}),
    ...(event.code !== undefined ? { code: event.code } : {}),
    ...(event.parent !== undefined ? { parent: event.parent } : {}),
  };
}
