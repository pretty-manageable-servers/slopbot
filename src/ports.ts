import type { TaskContext } from "./context.js";
import type { ToolCall, ToolOutput } from "./tools.js";
import type { Message, ModelEvent, Prompt, PromptItem, Reply } from "./domain.js";

export interface LLM {
  readonly outputTokenLimit?: number;
  readonly contextTokenLimit?: number;
  stream(prompt: Prompt, signal?: AbortSignal): AsyncIterable<ModelEvent>;
}

// Async contracts allow remote databases without changing application logic.
export interface Store {
  lastContextChange?(server: string, channel: string): unknown | Promise<unknown>;
  partialReply?(message: Message): Promise<string | undefined>;
  recordSources(runId: string, server: string, sourceIds: readonly string[]): Promise<void>;
  linkOutput(message: Message, runId: string | undefined, sourceId: string): Promise<void>;
  contextVersion(server: string, channel: string): Promise<number>;
  ingest(message: Message): Promise<boolean>;
  context(message: Message, limit: number): Promise<readonly Message[]>;
  history(taskKey: string): Promise<readonly PromptItem[]>;
  taskContext(taskKey: string): Promise<TaskContext>;
  checkpoint(taskKey: string, through: number, item: PromptItem, runId: string): Promise<void>;
  finishToolRun(runId: string, text: string): Promise<void>;
  agentTurns(message: Message): AgentTurn[] | Promise<AgentTurn[]>;
  addAgentTurn(message: Message, text: string, calls: ToolCall[]): AgentTurn | Promise<AgentTurn>;
  agentResult(turnId: string, index: number, result: ToolOutput): void | Promise<void>;
  startRun(runId: string, message: Message, prompt: Prompt): Promise<void>;
  appendEvent(runId: string, sequence: number, event: ModelEvent): Promise<void>;
  appendEvents?(runId: string, startSequence: number, events: readonly ModelEvent[]): Promise<void>;
  complete(runId: string, taskKey: string | undefined, inputs: readonly PromptItem[], text: string): Promise<void>;
  fail(runId: string, error: string): Promise<void>;
  userUsage(server: string, user: string): Promise<UserLimitState>;
  // Changes run in one transaction per user, so every window is read and written together.
  updateUserLimits<T>(server: string, user: string, change: (windows: readonly UserLimitWindow[]) => { windows?: readonly UserLimitWindow[]; result: T }): Promise<T>;
  resetUserUsage(server: string, user: string): Promise<void>;
  grantResets(server: string, user: string, kind: string, count: number): Promise<void>;
  // Uses one banked reset and clears that window in the same transaction.
  useReset(server: string, user: string, kind: string): Promise<boolean>;
}

/** Spend in micro-dollars for one window kind, starting at windowStart. */
export interface UserLimitWindow { kind: string; windowStart: number; spent: number }
export interface UserLimitState { windows: readonly UserLimitWindow[]; resets: Readonly<Record<string, number>> }

export interface Transport {
  send(message: Message, reply: Reply): Promise<void>;
}

export interface AgentTurn {
  id: string; text: string; calls: ToolCall[]; results: Record<string, ToolOutput>; version: number;
}
