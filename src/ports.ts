import type { TaskContext } from "./context.js";
import type { ToolCall, ToolOutput } from "./tools.js";
import type { Message, ModelEvent, Prompt, PromptItem, Reply } from "./domain.js";
import type { ProviderKeyStore } from "./web-providers.js";

export interface LLM {
  // The model id that prices this LLM's calls. Unnamed LLMs get the fallback price.
  readonly model?: string;
  readonly outputTokenLimit?: number;
  readonly contextTokenLimit?: number;
  stream(prompt: Prompt, signal?: AbortSignal): AsyncIterable<ModelEvent>;
}

// Async contracts allow remote databases without changing application logic.
export interface Store extends ProviderKeyStore {
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
  // Clears both windows, or only the given kind.
  resetUserUsage(server: string, user: string, kind?: string): Promise<void>;
  // Users with counters or banked resets in one server, highest 5-hour spend first.
  listUserUsage(server: string, limit: number): Promise<UserLimitRow[]>;
  grantResets(server: string, user: string, kind: string, count: number): Promise<void>;
  // Uses one banked reset and clears that window in the same transaction.
  useReset(server: string, user: string, kind: string): Promise<boolean>;
  // Lifetime totals per user and model. Chat delete, channel purge, retention and purgeUnconfigured never remove them.
  addTokenTotals(server: string, user: string, model: string, totals: TokenTotals, at: number): Promise<void>;
  userTokenTotals(server: string, user: string): Promise<UserTokenTotalRow[]>;
  // All servers together, plus the top `limit` servers and models by cost.
  tokenTotalsSummary(limit: number): Promise<TokenTotalsSummary>;
  /** Known users: authors in author_directory (bot=0) and users with global limit rows. search is a case-insensitive name substring or an exact ID; empty finds all. Sorted by global 5h spent, then first name, then ID. */
  listKnownUsers(search: string, limit: number, offset: number): Promise<KnownUserPage>;
  /** Lifetime totals of one user in every server, by server then model. */
  userTokenTotalsByServer(user: string): Promise<(UserTokenTotalRow & { server: string })[]>;
  // Replies sent since a time (ms), across all servers. Each triggering message counts once.
  countRepliesSince(since: number): Promise<number>;
}

/** Spend in micro-dollars for one window kind, starting at windowStart. */
export interface UserLimitWindow { kind: string; windowStart: number; spent: number }
export interface UserLimitState { windows: readonly UserLimitWindow[]; resets: Readonly<Record<string, number>> }
export interface UserLimitRow extends UserLimitState { user: string }
/** Token counts and cost of model calls. input is the uncached prompt tokens; cached is the cached part of the prompt. */
export interface TokenTotals { input: number; output: number; cached: number; costMicros: number }
/** One known user. servers are Discord server IDs from author_directory; 'web' is never listed. */
export interface KnownUserRow { user: string; names: string[]; servers: string[] }
export interface KnownUserPage { total: number; users: KnownUserRow[] }
export interface UserTokenTotalRow extends TokenTotals { model: string; requests: number; firstAt: number; lastAt: number }
/** Sums of the token totals and request count, over all rows of a group. */
export type TokenSums = TokenTotals & { requests: number };
export interface TokenTotalsSummary {
  total: TokenSums;
  servers: (TokenSums & { server: string })[];
  models: (TokenSums & { model: string })[];
}

export interface Transport {
  send(message: Message, reply: Reply): Promise<void>;
}

export interface AgentTurn {
  id: string; text: string; calls: ToolCall[]; results: Record<string, ToolOutput>; version: number;
}
