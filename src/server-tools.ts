import { MAX_MUTE_MINUTES, MUTED_USERS_KEY, mutedUsers, userId } from "./muted-users.js";
import { CLASSIFIER_CONTEXT_LIMIT } from './classifier-input.js';
import { BOT_REPLY_LIMIT_KEY, MAX_BOT_REPLIES, MAX_BOT_REPLY_MINUTES, botReplyLimit } from "./bot-reply-limit.js";
import { GLOBAL_SETTINGS_SCOPE } from "./usage-cost.js";
import { isPrivateChannel } from "./private-chat.js";
import type { Config } from "./config.js";
import { selfKnowledgeTool } from "./self-knowledge.js";
import type { Json, Message } from "./domain.js";
import { MEMORY_CATEGORIES, newMemory, memoryIdForOperation, type Knowledge, type MemoryOptions, type MemoryPatch, type MemoryCategory } from "./memory.js";
import type { ParticipationOptions } from "./participation.js";
import { decisionThresholds, type ParticipationHistoryStore } from './participation-history.js';
import type { HistoryImporter } from "./history.js";
import type { QueueStore } from "./queue.js";
import { decodeToolResult, ToolError, type ToolContext, type ToolJournal, type ToolField, type ToolRegistry, type ToolDefinition } from "./tools.js";
import type { Inbox } from "./inbox.js";

export interface ServerToolStore extends Knowledge, QueueStore, ParticipationHistoryStore, Pick<ToolJournal, 'operation'> {
  taskThreads(server: string): { thread: string; parent: string }[];
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
  // True for a member of the Developer Portal team that owns Slopbot (owner, admin or developer).
  isTeamEditor(user: string): Promise<boolean>;
  // The inbox tools are registered only when this is set.
  inbox?: Inbox;
}
const channel: ToolField = { type: "channel", description: "Discord channel ID; defaults to the current channel" };
const choice = (description: string, choices: string[]): ToolField => ({ type: "string", description, choices });
const integer = (description: string, max: number, required = true, min = 0): ToolField => ({ type: "integer", description, min, max, required });
const date = (value: number | null) => value === null ? "none" : new Date(value).toISOString();
/** Splits a comma-separated argument and drops empty parts. */
const commaList = (raw: unknown): string[] => String(raw ?? "").split(",").map(part => part.trim()).filter(Boolean);
/** Age text for an inbox line, such as "5m ago", "3h ago" or "2d ago". */
function inboxAge(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h ago` : `${Math.floor(hours / 24)}d ago`;
}

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
  // A private chat has no switch. Its stream is read only by its owner (see web-chats.ts).
  if (isPrivateChannel(channel)) return true;
  const parent = store.taskThreads(server).find(task => task.thread === channel)?.parent ?? channel;
  return webTranscriptsEnabled(store, server, parent);
}

export function registerServerTools(registry: ToolRegistry, services: ServerToolServices): void {
  const { config, store, participation, history, server } = services;
  const add = (tool: ToolDefinition) => registry.register(tool);
  add({ name: "timing", scope: "discord", description: "Toggle request timing footers for this server; full delivery timings remain in logs", fields: { enabled: { type: "boolean", description: "Show timing at the end of replies", required: true } }, access: "admin", effect: "write", execution: "inline", retrySafe: true,
    async execute(_context, args) { await store.setSetting(server, "timing_footer", args.enabled!); return `Timing footers ${args.enabled ? "enabled" : "disabled"}. Footer totals end before Discord delivery; logs include delivery.`; }
  });
  add({ name: "default_effort", description: "Choose the default reasoning effort for this server: low, medium, xhigh, or default (the provider decides). Models without effort support ignore it.", fields: { level: { ...choice("Default reasoning effort", ["default", "low", "medium", "xhigh"]), required: true } }, access: "admin", effect: "write", execution: "inline", retrySafe: true,
    async execute(_context, args) { await store.setSetting(server, "default_effort", args.level!); return `Default reasoning effort set to ${args.level}.`; }
  });
  add({ name: "tool_display", scope: "discord", description: "Choose tool activity in completed replies: none, summary (one grey line with counts), or full (counts plus failed calls).", fields: { mode: { ...choice("Tool activity display", ["none", "summary", "full"]), required: true } }, access: "admin", effect: "write", execution: "inline", retrySafe: true,
    async execute(_context, args) { await store.setSetting(server, "tool_display", args.mode!); return `Tool activity display set to ${args.mode}. Live progress remains enabled.`; }
  });
  add({ name: "bot_replies", description: "Read or set how often Slopbot answers other bots in one channel (for all servers). replies=0 means never answer bots. Only the Slopbot team can set it. Use it when the team asks Slopbot to stop or limit replies to bots.", fields: { action: { ...choice("get or set", ["get", "set"]), required: true }, replies: integer("Most replies to bots in the window", MAX_BOT_REPLIES, false), minutes: integer("Window length in minutes", MAX_BOT_REPLY_MINUTES, false, 1) }, publicResult: () => true, access: "member", effect: "write", execution: "inline", retrySafe: true,
    async execute(context, args) {
      const current = botReplyLimit(store.setting(GLOBAL_SETTINGS_SCOPE, BOT_REPLY_LIMIT_KEY));
      if (args.action !== "set") return `Slopbot answers other bots at most ${current.replies} times in ${current.minutes} minutes per channel.`;
      if (!await services.isTeamEditor(context.message.author)) throw new ToolError("Only the Slopbot team can change replies to bots.");
      const next = botReplyLimit({ replies: args.replies ?? current.replies, minutes: args.minutes ?? current.minutes });
      await store.setSetting(GLOBAL_SETTINGS_SCOPE, BOT_REPLY_LIMIT_KEY, next as unknown as Json);
      return next.replies === 0 ? "Slopbot now does not answer other bots." : `Slopbot now answers other bots at most ${next.replies} times in ${next.minutes} minutes per channel.`;
    }
  });
  add({ name: "mute_users", description: "Stop Slopbot from answering a user (a person or a bot) in this server for some minutes, end a mute, or list mutes. Only the Slopbot team can mute or unmute, and team members cannot be muted. Use it when the team asks Slopbot to ignore or not reply to someone.", fields: { action: { ...choice("mute, unmute or list", ["mute", "unmute", "list"]), required: true }, user: { type: "string", description: "Discord user ID or mention, for mute and unmute", max: 40 }, minutes: integer("Mute length in minutes, for mute", MAX_MUTE_MINUTES, false, 1) }, publicResult: () => true, access: "member", effect: "write", execution: "inline", retrySafe: true,
    async execute(context, args) {
      const mutes = mutedUsers(store.setting(server, MUTED_USERS_KEY));
      if (args.action === "list") {
        const rows = Object.entries(mutes);
        return rows.length ? `Muted users: ${rows.map(([user, until]) => `<@${user}> until ${new Date(until).toISOString()}`).join(", ")}.` : "No users are muted.";
      }
      if (!await services.isTeamEditor(context.message.author)) throw new ToolError("Only the Slopbot team can mute or unmute users.");
      const user = userId(args.user);
      if (!user) throw new ToolError("Give a Discord user ID or mention.");
      if (args.action === "unmute") { delete mutes[user]; await store.setSetting(server, MUTED_USERS_KEY, mutes); return `<@${user}> is not muted now.`; }
      if (await services.isTeamEditor(user)) throw new ToolError("Slopbot team members cannot be muted.");
      const minutes = Number(args.minutes ?? 60);
      mutes[user] = Date.now() + minutes * 60_000;
      await store.setSetting(server, MUTED_USERS_KEY, mutes);
      return `Slopbot will not answer <@${user}> in this server until ${new Date(mutes[user]!).toISOString()}.`;
    }
  });
  add(selfKnowledgeTool(registry, services.isTeamEditor, () => `Native function calling: enabled\nObject storage: ${config.objectStorage ? "configured" : "not configured"}; file_store scopes user/server/user_server, with ownership and sharing controls\nTool rounds per attempt: ${config.maxToolRounds}\nPMServers docs reviewed: 2026-10-12; latest changelog: 2026-10-12`));
  const scoped = async (message: Message, target: Json | undefined): Promise<string> => {
    const id = target === undefined ? (await services.originMessage(message)).channel : String(target);
    if (!services.accepts(id)) throw new ToolError("That channel is not configured for Slopbot.");
    await services.validateChannel(message, id);
    return id;
  };
  add({ name: "monitoring", scope: "discord", description: "Enable or disable JEV monitoring", fields: { enabled: { type: "boolean", description: "Whether JEV monitors unaddressed messages", required: true } }, access: "admin", effect: "write", retrySafe: true,
    async execute(_context, args) {
      await store.setSetting(server, "monitoring", args.enabled!);
      participation.options.enabled = Boolean(args.enabled) && !config.mock;
      return `Monitoring ${participation.options.enabled ? "enabled" : "disabled"}. Mentions and replies still work.`;
    } });
  add({ name: "reactions", scope: "discord", description: "Set emoji reaction frequency from 0 (off) to 100 (every suitable opportunity); requires monitoring", fields: {
    frequency: integer("0 to 100. Default 60. Percentage of classifier-selected funny messages to react to", 100),
  }, access: "admin", effect: "write", retrySafe: true,
    async execute(_context, args) {
      const frequency = Number(args.frequency);
      await store.setSetting(server, "reaction_frequency", frequency);
      participation.options.reactionFrequency = frequency;
      return `Reaction frequency: ${frequency}/100. ${frequency === 0 ? "Reactions disabled." : `${frequency}% of suitable funny messages; no separate cooldown or hourly cap. Monitoring must be enabled.`}`;
    } });
  add({ name: "context", scope: "discord", description: "Configure preceding messages for JEV (maximum 5) or replies (maximum 100)", fields: { messages: integer("0 to 100 preceding messages; JEV is capped at 5", 100), target: choice("Default: jev", ["jev", "reply"]) }, access: "admin", effect: "write", retrySafe: true,
    async execute(_context, args) {
      const target = args.target ?? "jev", count = Math.min(Number(args.messages), target === 'reply' ? 100 : CLASSIFIER_CONTEXT_LIMIT);
      if (target === "reply") { await store.setSetting(server, "reply_context", count); services.setReplyContext(count); }
      else { await store.setSetting(server, "classifier_context", count); participation.options.contextMessages = count; }
      return `${target} receives up to ${count} preceding messages.`;
    } });
  add({ name: "cooldown", scope: "discord", description: "Set unsolicited reply limits per channel", fields: { seconds: integer("Minimum interval in seconds", 3600), per_hour: integer("Maximum unsolicited replies per hour", 1000) }, access: "admin", effect: "write", retrySafe: true,
    async execute(_context, args) {
      await store.setSetting(server, "cooldown_seconds", args.seconds!); await store.setSetting(server, "max_unsolicited_per_hour", args.per_hour!);
      participation.options.cooldownMs = Number(args.seconds) * 1000; participation.options.maxUnsolicitedPerHour = Number(args.per_hour);
      return `Unsolicited replies: ${args.per_hour}/hour per channel, at least ${args.seconds}s apart. Explicit requests bypass limits.`;
    } });
  const thresholdFields = {
    addressed: integer('Addressing score cutoff, percent (0–100). Default 65', 100, false),
    respond: integer('Reply score cutoff for addressed requests, percent. Default 50', 100, false),
    unsolicited: integer('Reply score cutoff for unsolicited contributions, percent. Default 90', 100, false),
    funny: integer('Funny score cutoff for a reaction, percent. Default 90', 100, false),
  };
  add({ name: 'calibration', scope: 'discord', description: 'Inspect or set participation score cutoffs for this server. Percentages from 0 to 100; changes apply immediately and persist.',
    fields: { action: choice('Default: get. Use set to change supplied cutoffs', ['get', 'set']), ...thresholdFields }, access: 'admin', effect: 'write', retrySafe: true, writes: args => args.action === 'set',
    async execute(_context, args) {
      const supplied = Object.keys(thresholdFields).filter(key => args[key] !== undefined) as (keyof typeof thresholdFields)[];
      const thresholds = decisionThresholds(participation.options.thresholds, config.jevThresholds);
      if (args.action === 'set') {
        if (!supplied.length) throw new ToolError('Supply at least one cutoff to set.');
        for (const key of supplied) thresholds[key] = Number(args[key]) / 100;
        await store.setSetting(server, 'participation_thresholds', { ...thresholds });
        participation.options.thresholds = thresholds;
      } else if (supplied.length) throw new ToolError('Use action:set to change cutoffs.');
      return `Participation cutoffs: addressed ${(thresholds.addressed * 100).toFixed(1)}%, addressed reply ${(thresholds.respond * 100).toFixed(1)}%, unsolicited reply ${(thresholds.unsolicited * 100).toFixed(1)}%, funny ${(thresholds.funny * 100).toFixed(1)}%. Reaction frequency is a separate setting. These cutoffs apply to native decision scores; the chat fallback supplies booleans without scores.`;
    } });
  add({ name: "why", description: "Explain saved participation decisions with scores and cutoffs. Defaults to last 10; filter by channel, time, message, author or text. Reply allowed does not prove delivery.", fields: {
    channel, count: integer('Newest matching decisions to return; default 10, maximum 100', 100, false, 1),
    after: { type: 'string', description: 'Inclusive ISO timestamp with timezone, e.g. 2026-10-13T14:00:00-04:00' },
    before: { type: 'string', description: 'Exclusive ISO timestamp with timezone; also useful for paging older decisions' },
    since_minutes: integer('Only decisions in the past N minutes; alternative to after', 43200, false, 1),
    message_id: { type: 'string', description: 'Exact Discord message ID to inspect' },
    author: { type: 'string', description: 'Exact author Discord ID or mention' },
    query: { type: 'string', description: 'Case-insensitive literal text to find in message excerpts', max: 200 },
  }, access: "member", effect: "read", retrySafe: true,
    async execute(context, args) {
      const id = await scoped(context.message, args.channel);
      const timestamp = (value: Json | undefined): number | undefined => {
        if (value === undefined) return undefined;
        if (typeof value !== 'string' || !/T.*(?:Z|[+-]\d{2}:\d{2})$/i.test(value) || !Number.isFinite(Date.parse(value))) throw new ToolError('Use ISO timestamps with an explicit timezone for after/before.');
        return Date.parse(value);
      };
      if (args.after !== undefined && args.since_minutes !== undefined) throw new ToolError('Choose after or since_minutes, not both.');
      const after = args.since_minutes === undefined ? timestamp(args.after) : Date.now() - Number(args.since_minutes) * 60000;
      const before = timestamp(args.before);
      if (after !== undefined && before !== undefined && after >= before) throw new ToolError('after must be earlier than before.');
      const records = await store.participationHistory(server, id, { count: Number(args.count ?? 10),
        ...(after !== undefined ? { after } : {}), ...(before !== undefined ? { before } : {}),
        ...(args.message_id ? { messageId: String(args.message_id) } : {}),
        ...(args.author ? { author: String(args.author).replace(/^<@!?(\d+)>$/, '$1') } : {}), ...(args.query ? { text: String(args.query) } : {}),
      });
      const lines = records.map(record => {
        const { decision: d, thresholds: t } = record, scores = d.scores;
        const replyThreshold = scores && scores.addressed >= t.addressed ? t.respond : t.unsolicited;
        const compare = (score: number, threshold: number) => `${score.toFixed(3)} ${score >= threshold ? '>=' : '<'} ${threshold.toFixed(3)}`;
        const scoreText = scores ? `Addressed ${compare(scores.addressed, t.addressed)}; reply ${compare(scores.respond, replyThreshold)}; funny ${scores.funny === undefined ? 'not provided' : compare(scores.funny, t.funny)}.` : 'Scores unavailable: classifier bypassed, disabled, failed, or chat fallback.';
        const source = /^\d+$/.test(record.messageId) && !isPrivateChannel(id) ? `https://discord.com/channels/${server}/${id}/${record.messageId}` : record.messageId;
        return `${new Date(record.timestamp).toISOString()} ${source}\n${record.text.replace(/@(everyone|here)/gi, '@\u200b$1')}\n${scoreText}\nOutcome: ${d.reason}; reply allowed=${d.respond}; reaction=${d.emoji ?? 'none'}. ${record.detail}`;
      });
      return { text: `Monitoring now: ${participation.options.enabled}. ${records.length} matching decision(s), newest first. Scores are compared against cutoffs used at the time. Excerpts show the current source text; edits can differ from what was evaluated.\n${lines.join('\n\n') || 'No matching decisions recorded.'}\nMentions, replies, task threads and private chats bypass classification. Historical classifier-only records cannot explain later usage blocks or delivery.`, data: { channel: id, records: records as unknown as Json } };
    } });
  add({ name: "channel_find", description: "Find visible server text channels by name before changing channel settings", fields: { query: { type: "string", description: "Channel name to search", required: true } }, access: "admin", effect: "read", retrySafe: true,
    async execute(context, args) { return services.findChannels(context.message, String(args.query)); } });
  add({ name: "channels", scope: "discord", description: "List, add or remove monitored channels; removal purges searchable content", fields: { action: choice("Default: list", ["list", "add", "remove"]), channel }, access: "admin", effect: "write", retrySafe: true, confirm: args => args.action === "remove", writes: args => (args.action ?? "list") !== "list",
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
  add({ name: "index", scope: "discord", description: "Manage history windows, older imports, progress and saved memory embedding usage", fields: { channel, action: choice("Default: status", ["status", "window", "more", "pause", "resume"]), days: integer("Initial coverage window in days", 3650, false, 1) }, access: "admin", effect: "write", retrySafe: false, writes: args => (args.action ?? "status") !== "status",
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
  const memoryFields: Record<string, ToolField> = {
    category: { type: 'string', choices: MEMORY_CATEGORIES, description: 'Memory category; saving defaults to fact, updates retain the current category when omitted. Categories describe content, not whether it is confirmed true' },
    tags: { type: 'json', max: 2000, description: 'Up to 20 tags, each at most 80 characters; [] clears tags on update', schema: { type: 'array', description: 'Up to 20 tags; [] clears tags on update. Search requires all supplied tags.', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 80 } } },
    details: { type: 'json', max: 8000, description: 'Category-specific object. Meme: media_url, media_type (image/gif/video), aliases (array), when_to_use, humor_notes (user explanation), interpretation (bot guess). Fact/preference/note: subject. Lesson: subject, when_to_use. Omit unknown details. On update replaces all details; {} clears them', schema: { type: 'object', description: 'Meme fields: media_url, media_type, aliases, when_to_use, humor_notes (user explanation), interpretation (bot guess). Fact/preference/note: subject. Lesson: subject, when_to_use. Omit unknowns. On update replaces all details; {} clears them.', additionalProperties: false, properties: {
      subject: { type: 'string', maxLength: 2000 }, media_url: { type: 'string', maxLength: 2000, format: 'uri' }, media_type: { type: 'string', enum: ['image', 'gif', 'video'] }, aliases: { type: 'array', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 200 } }, when_to_use: { type: 'string', maxLength: 2000 }, humor_notes: { type: 'string', maxLength: 2000 }, interpretation: { type: 'string', maxLength: 2000 },
    } } },
  };
  const memoryOptions = (args: Record<string, Json>): MemoryOptions => ({
    ...(args.category !== undefined ? { category: args.category as MemoryCategory } : {}),
    ...(args.tags !== undefined ? { tags: args.tags as string[] } : {}),
    ...(args.details !== undefined ? { details: args.details as Record<string, Json> } : {}),
    ...(args.source_policy !== undefined ? { sourcePolicy: args.source_policy as 'source_bound' | 'independent' } : {}),
    ...(args.source_ids !== undefined ? { sourceIds: args.source_ids as string[] } : {}),
  });
  const memoryResource = (message: Message, args: Record<string, Json>) => `memory:${message.server}:${message.channel}:${args.id ?? 'save'}`;
  const authorizeMemory = async (context: ToolContext) => {
    const previous = await store.operation(context.operationId);
    if (previous?.status !== 'done' || !previous.result) return;
    const data = decodeToolResult(previous.result).data as { id?: string; revision?: number; memories?: { id: string; revision: number }[] } | undefined;
    const saved = data?.id ? [{ id: data.id, revision: data.revision }] : data?.memories ?? [];
    if (!saved.length) return;
    const origin = await services.originMessage(context.message), current = await store.memories(origin.server, origin.channel);
    if (saved.some(item => !current.some(note => note.id === item.id && note.revision === item.revision))) throw new ToolError('Memory result changed or was forgotten. Search again with a new request.');
  };
  add({ name: "memory_remember", description: "Save an attributed memory in this channel. Categories share search and permissions. Facts default to source-bound; memes default to independent, requiring no saved source or media copy. A media_url is optional but needed to reuse media. Save when asked; keep humor explanations separate from bot interpretations.", fields: { text: { type: "string", description: "Searchable content to remember", max: 2000, required: true }, ...memoryFields,
    source_policy: { type: 'string', choices: ['source_bound', 'independent'], description: 'source_bound: supporting messages must exist; their edits/deletion invalidate the entry. independent: persists until forgotten and stores no message source IDs. Does not change channel access' },
    source_ids: { type: 'json', max: 4000, description: 'Optional source-bound message IDs in this same channel; defaults to the current request. Omit for independent memories', schema: { type: 'array', description: 'Source-bound message IDs in this same channel; defaults to current request. Omit for independent memories.', maxItems: 20, items: { type: 'string', minLength: 1, maxLength: 160 } } },
  }, access: "member", effect: "write", retrySafe: false, execution: "inline", resource: memoryResource, authorize: authorizeMemory,
    validate(args) { newMemory({ id: 'validation', server, channel: 'validation', author: 'validation', text: '' }, String(args.text), memoryOptions(args)); return args; },
    async execute(context, args) {
      const origin = await services.originMessage(context.message);
      const note = await store.remember(origin, String(args.text), { ...memoryOptions(args), operationId: context.operationId });
      return { text: `Saved as your ${note.category} memory, not a group agreement. Memory ID: ${note.id}; revision ${note.revision}; ${note.sourcePolicy}.`, data: JSON.parse(JSON.stringify(note)) as Json };
    },
    async reconcile(context) { const origin = await services.originMessage(context.message); const found = (await store.memories(origin.server, origin.channel)).find(note => note.id === memoryIdForOperation(context.operationId) && note.author === context.message.author); return found ? `Saved memory ID: ${found.id}; revision ${found.revision}.` : undefined; }
  });
  add({ name: "memory", description: "Search or browse active memories in this channel by category, tags, or situation. Returns structured details and revisions. Separate accessible task-thread scopes are listed; use memory there to read them.", fields: {
    query: { type: 'string', max: 2000, description: 'Optional name, topic, or situation; omit to browse' }, category: memoryFields.category!, tags: memoryFields.tags!,
    limit: { type: 'integer', min: 1, max: 50, description: 'Page size; default 20' }, offset: { type: 'integer', min: 0, max: 100000, description: 'Page offset; default 0' },
  }, access: "member", effect: "read", retrySafe: true, authorize: authorizeMemory,
    validate(args) { if (args.tags !== undefined) newMemory({ id: 'validation', server, channel: 'validation', author: 'validation', text: '' }, 'validation', { tags: args.tags as string[] }); return args; },
    async execute(context, args) {
      const origin = await services.originMessage(context.message);
      const notes = await store.searchMemories(origin, { ...(typeof args.query === 'string' ? { query: args.query } : {}), ...(args.category ? { category: args.category as MemoryCategory } : {}), ...(args.tags ? { tags: args.tags as string[] } : {}), limit: Number.MAX_SAFE_INTEGER });
      const offset = Number(args.offset ?? 0), limit = Number(args.limit ?? 20), page = notes.slice(offset, offset + limit), scopes: string[] = [];
      for (const task of store.taskThreads(origin.server).filter(task => task.parent === origin.channel).slice(-20)) {
        try { await services.validateChannel(context.message, task.thread); }
        catch (error) { if (error instanceof ToolError) continue; throw error; }
        const memories = await store.memories(origin.server, task.thread);
        if (memories.length) scopes.push(`${memories.length} saved memories in separate task-thread scope <#${task.thread}>. Use memory there to read or manage them.`);
      }
      return { text: [page.length ? page.map(note => JSON.stringify(note)).join("\n") : "No active saved memories matching this search in this channel.", ...scopes].join('\n'), data: { memories: JSON.parse(JSON.stringify(page)) as Json, total: notes.length, next_offset: offset + limit < notes.length ? offset + limit : null } };
    }
  });
  add({ name: 'memory_update', description: 'Correct one of your active memories using its current revision. Changes content, category, tags, or details. Details replace the entire object. Source policy and supporting messages remain unchanged. Changing category may require replacing details to match.', fields: {
    id: { type: 'string', required: true, description: 'Memory ID' }, expected_revision: { type: 'integer', min: 1, required: true, description: 'Current revision from memory search; protects against overwriting another edit' }, text: { type: 'string', max: 2000, description: 'Replacement searchable content' }, ...memoryFields,
  }, access: 'member', effect: 'write', retrySafe: false, execution: 'inline', resource: memoryResource, authorize: authorizeMemory,
    validate(args) { if (!['text', 'category', 'tags', 'details'].some(key => args[key] !== undefined)) throw new ToolError('Supply at least one memory field to update.'); return args; },
    async execute(context, args) {
      const origin = await services.originMessage(context.message);
      const patch: MemoryPatch = { ...(args.text !== undefined ? { content: String(args.text) } : {}), ...memoryOptions(args) };
      const note = await store.updateMemory(origin, String(args.id), patch, Number(args.expected_revision), context.operationId);
      return note ? { text: `Updated memory ${note.id}; revision ${note.revision}.`, data: JSON.parse(JSON.stringify(note)) as Json } : 'No active memory with that ID owned by you in this channel.';
    },
    async reconcile(context, args) { const origin = await services.originMessage(context.message); const note = (await store.memories(origin.server, origin.channel)).find(note => note.id === args.id && note.author === context.message.author && note.lastOperationId === context.operationId); return note ? `Updated memory ${note.id}; revision ${note.revision}.` : undefined; }
  });
  add({ name: "memory_forget", description: "Forget one of your saved memories without deleting chat history or other memories", fields: { id: { type: "string", description: "Memory ID", required: true } }, access: "member", effect: "write", retrySafe: true, execution: "inline", resource: memoryResource,
    async execute(context, args) { return await store.forget(context.message.server, (await services.originMessage(context.message)).channel, String(args.id), context.message.author) ? "Memory forgotten." : "No active memory with that ID owned by you in this channel."; } });
  add({ name: "task_start", surface: "top", scope: "discord", description: "Move sustained work or an action request into a dedicated task thread", fields: { goal: { type: "string", description: "Task goal", required: true } }, access: "member", effect: "write", retrySafe: false, resource: message => `task-thread:${message.server}:${message.id}`,
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
  const inbox = services.inbox;
  if (inbox) {
    add({ name: "inbox_add", description: "Put a summary in another member's inbox, when a member asks to put something in someone's inbox. Runs directly: do not call task_start first. Write a plain summary of at most 1000 characters: who said what and what the target must act on. Use the source message IDs from context.", fields: { target: { type: "string", description: "Discord user ID of the member whose inbox gets the item", required: true }, summary: { type: "string", description: "Plain summary, at most 1000 characters", required: true }, source_ids: { type: "string", description: "Comma-separated Discord message IDs that the summary covers", required: true } }, access: "member", effect: "write", execution: "inline", retrySafe: false,
      async execute(context, args) {
        const target = userId(args.target);
        if (!target) throw new ToolError("Target must be a Discord user ID.");
        const sourceIds = commaList(args.source_ids);
        if (!sourceIds.length || sourceIds.some(id => !/^\d{17,20}$/.test(id))) throw new ToolError("Source IDs must be comma-separated Discord message IDs.");
        const channel = (await services.originMessage(context.message)).channel;
        const item = await inbox.add({ server: context.message.server, target, sender: context.message.author, channel, sourceIds, summary: String(args.summary ?? "") });
        return `Added inbox item ${item.id} for <@${target}>.`;
      } });
    add({ name: "inbox_list", description: "List your own inbox items in this server: id, sender, age, summary and a jump link. Open items only, unless include_done is true.", fields: { include_done: { type: "boolean", description: "Include items you marked done" } }, access: "member", effect: "read", retrySafe: true,
      async execute(context, args) {
        const items = await inbox.list(context.message.server, context.message.author, args.include_done === true);
        if (!items.length) return "Your inbox is empty.";
        const now = Date.now();
        return items.map(item => `${item.id} | from <@${item.sender}> | ${inboxAge(now - item.created_at)} | ${item.summary} | https://discord.com/channels/${context.message.server}/${item.channel}/${item.sourceIds[0]}${item.done_at === null ? "" : " | done"}`).join("\n");
      } });
    add({ name: "inbox_done", description: "Mark your own inbox items done. Runs directly: do not call task_start first. Use the item IDs from inbox_list, comma-separated, or all.", fields: { ids: { type: "string", description: "Comma-separated item IDs, or all", required: true } }, access: "member", effect: "write", execution: "inline", retrySafe: true,
      async execute(context, args) {
        const raw = String(args.ids ?? "").trim();
        if (!raw) throw new ToolError("Give item IDs, or all.");
        const count = await inbox.done(context.message.server, context.message.author, raw === "all" ? "all" : commaList(raw));
        return count ? `Marked ${count} inbox item${count === 1 ? "" : "s"} done.` : "No open inbox items matched.";
      } });
  }
}
