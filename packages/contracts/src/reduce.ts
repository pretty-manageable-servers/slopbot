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

export type TurnPart = { readonly kind: "text" | "thinking"; readonly text: string } | ToolPart;

export interface TurnView {
  readonly turn: string;
  readonly status: "streaming" | "done" | "failed" | "interrupted";
  readonly parts: readonly TurnPart[];
}

/**
 * Pure. Text and thinking deltas of the same kind join the last part, else they start a new part.
 * tool.input and tool.status join the part with the same call. A message.* event is not part of a turn:
 * it returns the view unchanged, and it throws when there is no view yet.
 */
export function reduceTurn(view: TurnView | undefined, event: EngineEvent): TurnView {
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
      return { ...base, parts: appendText(base.parts, "text", event.text) };
    case "thinking.delta":
      return { ...base, parts: appendText(base.parts, "thinking", event.text) };
    case "tool.input":
      return { ...base, parts: editTool(base.parts, event.call, event.name, part => ({ ...part, inputText: part.inputText + event.text })) };
    case "tool.status":
      return { ...base, parts: editTool(base.parts, event.call, event.name, part => toolStatusPart(part, event)) };
    case "turn.end":
      return { ...base, status: event.status };
  }
}

function appendText(parts: readonly TurnPart[], kind: "text" | "thinking", text: string): TurnPart[] {
  const last = parts.at(-1);
  if (last && last.kind !== "tool" && last.kind === kind) return [...parts.slice(0, -1), { kind, text: last.text + text }];
  return [...parts, { kind, text }];
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
