import type { Config } from "./config.js";
import { selfKnowledgeTool } from "./self-knowledge.js";
import type { Json, Message } from "./domain.js";
import type { Knowledge } from "./memory.js";
import type { ParticipationOptions } from "./participation.js";
import type { HistoryImporter } from "./history.js";
import type { QueueStore } from "./queue.js";
import { ToolError, type ToolField, type ToolRegistry, type ToolDefinition } from "./tools.js";

export interface ServerToolStore extends Knowledge, QueueStore {
  setting(server: string, key: string): unknown;
  setSetting(server: string, key: string, value: Json): void | Promise<void>;
  indexStats(server: string, channel: string): {
    messages: number; vectors: number; oldest: number | null; newest: number | null;
    usage: { model: string; purpose: string; requests: number; tokens: number; unknown: number }[];
  } | Promise<{ messages: number; vectors: number; oldest: number | null; newest: number | null; usage: { model: string; purpose: string; requests: number; tokens: number; unknown: number }[] }>;
  llmUsage(server: string): { requests: number; input: number; output: number; cached: number } | Promise<{ requests: number; input: number; output: number; cached: number }>;
}
export interface ServerToolServices {
  config: Config;
  server: string;
  store: ServerToolStore;
  participation: { options: ParticipationOptions; diagnostics: Map<string, string> };
  history: HistoryImporter;
  channels(): readonly string[];
  setChannels(channels: string[]): void | Promise<void>;
  validateChannel(message: Message, channel: string, parentOnly?: boolean): Promise<void>;
  findChannels(message: Message, query: string): Promise<string>;
  accepts(channel: string): boolean;
  setReplyContext(messages: number): void;
  originMessage(message: Message): Message | Promise<Message>;
  startTask(message: Message, goal: string): Promise<string>;
  reconcileTask(message: Message): Promise<string | undefined>;
  wakeWorker(): void;
}
const channel: ToolField = { type: "channel", description: "Discord channel ID; defaults to the current channel" };
const choice = (description: string, choices: string[]): ToolField => ({ type: "string", description, choices });
const integer = (description: string, max: number, required = true, min = 0): ToolField => ({ type: "integer", description, min, max, required });
const date = (value: number | null) => value === null ? "none" : new Date(value).toISOString();

export function configuredChannels(config: Config, store: Pick<ServerToolStore, "setting">, server: string): string[] {
  const saved = store.setting(server, "channels");
  return Array.isArray(saved) && saved.every(id => typeof id === "string" && /^\d{17,20}$/.test(id)) ? [...new Set(saved as string[])] : server === config.channelServer ? [...config.channelIds] : [];
}

export const webTranscriptKey = (channel: string): string => `web_transcripts:${channel}`;
/** Off unless an admin turns it on. A thread uses its parent channel's switch, so the caller passes the parent ID. */
export function webTranscriptsEnabled(store: Pick<ServerToolStore, "setting">, server: string, channelOrParent: string): boolean {
  return store.setting(server, webTranscriptKey(channelOrParent)) === true;
}
/** The switch that applies to a channel or thread: a thread uses its parent's switch. */
export function transcriptSwitchOn(store: Pick<ServerToolStore, "setting"> & { taskThreads(server: string): { thread: string; parent: string }[] }, server: string, channel: string): boolean {
  const parent = store.taskThreads(server).find(task => task.thread === channel)?.parent ?? channel;
  return webTranscriptsEnabled(store, server, parent);
}

export function registerServerTools(registry: ToolRegistry, services: ServerToolServices): void {
  const { config, store, participation, history, server } = services;
  const add = (tool: ToolDefinition) => registry.register(tool);
  add({ name: "timing", description: "Toggle request timing footers for this server; full delivery timings remain in logs", fields: { enabled: { type: "boolean", description: "Show timing at the end of replies", required: true } }, access: "admin", effect: "write", execution: "inline", retrySafe: true,
    async execute(_context, args) { await store.setSetting(server, "timing_footer", args.enabled!); return `Timing footers ${args.enabled ? "enabled" : "disabled"}. Footer totals end before Discord delivery; logs include delivery.`; }
  });
  add({ name: "tool_display", description: "Choose tool activity in completed replies: none, summary (one grey line with counts), or full (counts plus failed calls).", fields: { mode: { ...choice("Tool activity display", ["none", "summary", "full"]), required: true } }, access: "admin", effect: "write", execution: "inline", retrySafe: true,
    async execute(_context, args) { await store.setSetting(server, "tool_display", args.mode!); return `Tool activity display set to ${args.mode}. Live progress remains enabled.`; }
  });
  add(selfKnowledgeTool(registry, () => `Native function calling: enabled\nObject storage: ${config.objectStorage ? "configured" : "not configured"}; file_store scopes user/server/user_server, with ownership and sharing controls\nTool rounds per attempt: ${config.maxToolRounds}\nPMServers docs reviewed: 2026-10-12; latest changelog: 2026-10-12\nReply model: ${config.model}\nParticipation model: ${config.jevModel}\nMock mode: ${config.mock}\nDatabase adapter: ${config.databaseUrl ? "PostgreSQL/pgvector" : "SQLite"}\nMonitoring enabled: ${participation.options.enabled}\nEmbeddings enabled: ${config.embeddingsEnabled && !config.mock}; model: ${config.embeddingModel}\nContext budget: ${config.contextTokens}; output reserve: ${config.outputTokens}\nReply context messages: ${store.setting(server, "reply_context") ?? config.replyContextMessages}`));
  const scoped = async (message: Message, target: Json | undefined): Promise<string> => {
    const id = target === undefined ? (await services.originMessage(message)).channel : String(target);
    if (!services.accepts(id)) throw new ToolError("That channel is not configured for Slopbot.");
    await services.validateChannel(message, id);
    return id;
  };
  add({ name: "status", description: "Show models, context budgets, cache usage and monitored channels", fields: {}, access: "admin", effect: "read", retrySafe: true,
    async execute() {
      const usage = await store.llmUsage(server);
      return `Reply model: ${config.model}\nJEV model: ${config.jevModel}\nMonitoring: ${participation.options.enabled}\nJEV context: ${participation.options.contextMessages} messages\nReply context: ${store.setting(server, "reply_context") ?? config.replyContextMessages} messages\nUnsolicited limits per channel: ${participation.options.cooldownMs / 1000}s, ${participation.options.maxUnsolicitedPerHour}/hour\nChannels: ${services.channels().map(id => `<#${id}>`).join(", ") || "none"}\nContext: ${config.contextTokens} token budget, ${config.outputTokens} reserved for output; conservative UTF-8 byte counter\nEmbeddings: ${config.embeddingsEnabled && !config.mock}; saved lesson/memory semantic search; chat uses SQL keywords\nLLM reported usage: ${usage.input} input, ${usage.output} output, ${usage.cached} cached input tokens from ${usage.requests} usage events. Missing provider usage is not inferred.`;
    } });
  add({ name: "monitoring", description: "Enable or disable JEV monitoring", fields: { enabled: { type: "boolean", description: "Whether JEV monitors unaddressed messages", required: true } }, access: "admin", effect: "write", retrySafe: true,
    async execute(_context, args) {
      await store.setSetting(server, "monitoring", args.enabled!);
      participation.options.enabled = Boolean(args.enabled) && !config.mock;
      return `Monitoring ${participation.options.enabled ? "enabled" : "disabled"}. Mentions and replies still work.`;
    } });
  add({ name: "reactions", description: "Set emoji reaction frequency from 0 (off) to 100 (every suitable opportunity); requires monitoring", fields: {
    frequency: integer("0 to 100. Default 60. Percentage of classifier-selected funny messages to react to", 100),
  }, access: "admin", effect: "write", retrySafe: true,
    async execute(_context, args) {
      const frequency = Number(args.frequency);
      await store.setSetting(server, "reaction_frequency", frequency);
      participation.options.reactionFrequency = frequency;
      return `Reaction frequency: ${frequency}/100. ${frequency === 0 ? "Reactions disabled." : `${frequency}% of suitable funny messages; no separate cooldown or hourly cap. Monitoring must be enabled.`}`;
    } });
  add({ name: "context", description: "Configure preceding messages for JEV or replies", fields: { messages: integer("0 to 100 preceding messages", 100), target: choice("Default: jev", ["jev", "reply"]) }, access: "admin", effect: "write", retrySafe: true,
    async execute(_context, args) {
      const count = Number(args.messages), target = args.target ?? "jev";
      if (target === "reply") { await store.setSetting(server, "reply_context", count); services.setReplyContext(count); }
      else { await store.setSetting(server, "classifier_context", count); participation.options.contextMessages = count; }
      return `${target} receives up to ${count} preceding messages.`;
    } });
  add({ name: "cooldown", description: "Set unsolicited reply limits per channel", fields: { seconds: integer("Minimum interval in seconds", 3600), per_hour: integer("Maximum unsolicited replies per hour", 1000) }, access: "admin", effect: "write", retrySafe: true,
    async execute(_context, args) {
      await store.setSetting(server, "cooldown_seconds", args.seconds!); await store.setSetting(server, "max_unsolicited_per_hour", args.per_hour!);
      participation.options.cooldownMs = Number(args.seconds) * 1000; participation.options.maxUnsolicitedPerHour = Number(args.per_hour);
      return `Unsolicited replies: ${args.per_hour}/hour per channel, at least ${args.seconds}s apart. Explicit requests bypass limits.`;
    } });
  add({ name: "why", description: "Inspect the latest JEV decision in a channel", fields: { channel }, access: "admin", effect: "read", retrySafe: true,
    async execute(context, args) {
      const id = await scoped(context.message, args.channel);
      const reason = participation.diagnostics.get(JSON.stringify([server, id]));
      return `Monitoring enabled: ${participation.options.enabled}\nLast JEV outcome: ${reason ?? "none since startup"}\nExplicit requests bypass JEV and unsolicited cooldowns.`;
    } });
  add({ name: "channel_find", description: "Find visible server text channels by name before changing channel settings", fields: { query: { type: "string", description: "Channel name to search", required: true } }, access: "admin", effect: "read", retrySafe: true,
    async execute(context, args) { return services.findChannels(context.message, String(args.query)); } });
  add({ name: "channels", description: "List, add or remove monitored channels; removal purges searchable content", fields: { action: choice("Default: list", ["list", "add", "remove"]), channel }, access: "admin", effect: "write", retrySafe: true, writes: args => (args.action ?? "list") !== "list",
    async execute(context, args) {
      const action = args.action ?? "list", channels = [...services.channels()];
      if (action === "list") return channels.map(id => `<#${id}>`).join("\n") || "No channels configured.";
      if (!args.channel) throw new ToolError("Choose a channel to add or remove.");
      const id = String(args.channel);
      await services.validateChannel(context.message, id, true);
      await context.assertActive();
      const next = action === "add" ? [...new Set([...channels, id])] : channels.filter(value => value !== id);
      await store.setSetting(server, "channels", next); await services.setChannels(next);
      return action === "add" ? `<#${id}> is configured. Older chat history will be imported; new messages are saved and searchable. Only saved lessons and memories use embeddings.` : `<#${id}> is disabled. Searchable content and its task scopes were purged; operational logs remain retained.`;
    } });
  add({ name: "index", description: "Manage history windows, older imports, progress and saved memory embedding usage", fields: { channel, action: choice("Default: status", ["status", "window", "more", "pause", "resume"]), days: integer("Initial coverage window in days", 3650, false, 1) }, access: "admin", effect: "write", retrySafe: false, writes: args => (args.action ?? "status") !== "status",
    matchRead(message) {
      if (!/\b(index(?:ing)?\b.*\b(status|progress)\b|(?:status|progress)\b.*\bindex(?:ing)?\b)/i.test(message.text)) return undefined;
      const target = message.text.match(/<#(\d{17,20})>/)?.[1];
      return { action: "status", ...(target ? { channel: target } : {}) };
    },
    async execute(context, args) {
      const id = await scoped(context.message, args.channel), action = args.action ?? "status";
      await context.assertActive();
      if (!services.channels().includes(id)) throw new ToolError("History import currently supports configured text channels, not task threads. Specify the parent channel.");
      if (args.days !== undefined && action !== "window") throw new ToolError("Use days with action:window.");
      if ((action === "window" || action === "more") && (history.state(id).job || history.busy(id))) throw new ToolError("An import is already pending. Use status, pause or resume.");
      if (action === "pause") await history.pause(id);
      else if (action === "resume") await history.resume(id);
      else if (action === "window" || action === "more") await history.start(id, action, args.days === undefined ? undefined : Number(args.days));
      const state = history.state(id), stats = await store.indexStats(server, id);
      const usage = stats.usage.map(item => `${item.model} ${item.purpose}: ${item.requests} successful requests, ${item.tokens} reported tokens, ${item.unknown} requests without token counts`).join("\n") || "No embedding usage recorded yet.";
      const result = `History window: ${state.days} days. Lowering the window deletes saved messages older than it.\nImport: ${state.paused ? "paused" : state.error ? `failed; retries automatically (${state.errorReason ?? "reason unavailable for this older failure"})` : state.job ? `${state.job.kind}, ${state.job.scanned} scanned, ${state.job.added} added` : "idle"}\nReached beginning of channel: ${state.exhausted}\nStored: ${stats.messages} messages, ${stats.vectors} saved memory vectors for the current model\nStored dates: ${date(stats.oldest)} to ${date(stats.newest)}\nLast completed window scan: ${date(state.syncedThrough || null)}\n${usage}\nCosts are not estimated. Live ingestion continues during an import pause.`;
      await store.setSetting(server, `index-operation:${context.operationId}`, result);
      return result;
    },
    async reconcile(context, args) {
      // Persisted command acknowledgement prevents a repeated "more" from extending twice.
      const saved = store.setting(server, `index-operation:${context.operationId}`);
      if (typeof saved === "string") return saved;
      const id = await scoped(context.message, args.channel);
      if ((args.action === "window" || args.action === "more") && history.state(id).job) return "The previously requested import is still pending; it was not started twice.";
      return undefined;
    } });
  add({ name: "memory_remember", description: "Save an attributed statement with its source message", fields: { text: { type: "string", description: "Statement to save", max: 2000, required: true } }, access: "member", effect: "write", retrySafe: false,
    async execute(context, args) { const note = await store.remember((await services.originMessage(context.message)), String(args.text)); return `Saved as your statement, not a group agreement. Memory ID: ${note.id}`; },
    async reconcile(context, args) { const origin = await services.originMessage(context.message); const found = (await store.memories(context.message.server, origin.channel)).find(note => note.author === context.message.author && note.content === args.text && note.sourceIds.includes(origin.id)); return found ? `Saved memory ID: ${found.id}` : undefined; } });
  add({ name: "memory", description: "List active source-linked memories in this channel", fields: {}, access: "member", effect: "read", retrySafe: true,
    async execute(context) { const notes = await store.memories(context.message.server, (await services.originMessage(context.message)).channel); return notes.length ? notes.slice(0, 20).map(note => `${note.id} | author ${note.author} | ${note.content}`).join("\n") : "No active saved memories in this channel."; } });
  add({ name: "memory_forget", description: "Forget one of your saved statements", fields: { id: { type: "string", description: "Memory ID", required: true } }, access: "member", effect: "write", retrySafe: true,
    async execute(context, args) { return await store.forget(context.message.server, (await services.originMessage(context.message)).channel, String(args.id), context.message.author) ? "Memory forgotten." : "No active memory with that ID owned by you in this channel."; } });
  add({ name: "task_start", description: "Move sustained work or an action request into a dedicated task thread", fields: { goal: { type: "string", description: "Task goal", required: true } }, access: "member", effect: "write", retrySafe: false, resource: message => `task-thread:${message.server}:${message.id}`,
    async execute(context, args) { await context.assertActive(); const threadId = await services.startTask(context.message, String(args.goal)); return { text: `Task thread: <#${threadId}>`, handoff: { threadId } }; },
    async reconcile(context) { const thread = await services.reconcileTask(context.message); return thread ? { text: `Task thread: <#${thread}>`, handoff: { threadId: thread } } : undefined; } });
  add({ name: "task_status", description: "Inspect queued, failed and blocked requests in this task", fields: {}, access: "member", effect: "read", retrySafe: true,
    async execute(context) { const jobs = (await store.jobs(context.message.server, context.message.channel)); return jobs.length ? jobs.map(job => `${job.id}: ${job.status}, attempts ${job.attempts}${job.error ? `, ${job.error}` : ""}`).join("\n") : "No queued requests in this channel."; } });
  add({ name: "task_retry", description: "Retry your failed task request; uncertain actions are reconciled first", fields: { id: { type: "string", description: "Job ID", required: true } }, access: "member", effect: "write", retrySafe: true,
    async execute(context, args) {
      const job = (await store.jobs(context.message.server, context.message.channel)).find(job => job.id === args.id);
      if (!job || (!context.isAdmin && job.message.author !== context.message.author)) throw new ToolError("Only the requester or a server admin can retry that job.");
      const retried = await store.retryJob(context.message.server, context.message.channel, String(args.id));
      services.wakeWorker(); return retried ? "Request queued for recovery." : "That request is not failed or blocked.";
    } });
}
