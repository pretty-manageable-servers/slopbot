// The bot's console API: request and response bodies of each route, from the handlers (see the source of each
// group). Writes need the CSRF token (api.ts adds it). Errors are { error: string } with the HTTP status.

// ----- Session and server settings (src/web-console.ts, src/adapters/discord.ts) -----
export interface ServerSummary { id: string; name: string; icon: string | null; admin: boolean }
export interface Session {
  user: string;
  /** Name and avatar from the first server; null when Discord does not know them. */
  me: { displayName: string; avatarUrl: string | null } | null;
  servers: ServerSummary[];
  csrf: string;
}
export interface Version { sha: string | null; time: string | null; url: string | null }
export interface Status { mode: "normal" | "fallback" | "offline"; canChat: boolean }

/** GET /api/settings?server= */
export interface SettingsResponse { data: SettingsSnapshot; csrf: string }
export type SettingsSnapshot =
  | { user: string; servers: ServerSummary[]; server: null }
  | ServerSnapshot;
export interface ServerSnapshot {
  user: string;
  servers: ServerSummary[];
  server: { id: string; name: string };
  /** Manage Server in this server. Without it the server sections are read-only notes. */
  admin: boolean;
  /** Text channels that both the user and Slopbot can see. */
  channels: SnapshotChannel[];
  me: { id: string; displayName: string; avatarUrl: string | null };
  profile: UserProfile | undefined;
  /** Only for admins. */
  mcp: McpSnapshot | null;
  /** Only for admins. */
  settings: ServerSettings | null;
}
export interface SnapshotChannel { id: string; name: string; monitored: boolean; history?: HistoryState }
export interface HistoryState {
  days: number; syncedThrough: number; exhausted: boolean; paused: boolean;
  oldest: { id: string; timestamp: number } | null;
  job: null | { kind: "window" | "more"; before: string | null; cutoff: number; started: number; remaining: number | null; scanned: number; added: number; reachedAt: number | null };
  error: boolean; errorReason?: string;
}
export interface UserProfile { userId: string; name: string; identity: Record<string, string>; allowEdits: boolean; fields: ProfileField[] }
export interface ProfileField { field: string; value: unknown; editor: string; sourceIds: string[]; revision: string }
export interface ServerSettings {
  monitoring: boolean;
  /** Fractions 0..1. The calibration setting takes percents 0..100. */
  participation_thresholds: { addressed: number; respond: number; unsolicited: number; funny: number };
  classifier_context: number; reply_context: number; cooldown_seconds: number; max_unsolicited_per_hour: number;
  tool_display: "none" | "summary" | "full";
  default_effort: "default" | "low" | "medium" | "xhigh";
  timing_footer: boolean; mock: boolean;
}

/** POST /api/settings { server, channel, name, args }. The answer is a tool result; show its text. */
export type SettingName = "calibration" | "monitoring" | "context" | "cooldown" | "channels" | "index" | "profile" | "timing" | "tool_display" | "default_effort" | "voice";
export interface SettingArgs {
  monitoring: { enabled: boolean };
  calibration: { action: "set"; addressed: number; respond: number; unsolicited: number; funny: number };
  /** Messages 0..100 (jev at most 5). Saved once per target. */
  context: { messages: number; target: "jev" | "reply" };
  cooldown: { seconds: number; per_hour: number };
  tool_display: { mode: "none" | "summary" | "full" };
  default_effort: { level: "default" | "low" | "medium" | "xhigh" };
  timing: { enabled: boolean };
  /** instructions "default" resets the voice. */
  voice: { action: "style"; instructions: string } | { action: "status" };
  /** Ask before remove. channel is the channel's id. */
  channels: { action: "add" | "remove"; channel: string };
  /** Sent with channel = that channel. A shorter window deletes saved messages: ask first. days 1..3650. */
  index: { action: "pause" | "resume" } | { action: "window"; days: number };
  profile: { action: "lock"; allow_edits: boolean } | { action: "set"; field: string; value: string } | { action: "remove"; field: string };
}
export interface ToolResult { text: string; status?: "ok" | "rejected" | "failed"; reason?: string }

export interface NonZdr { allow: boolean }
export interface TranscriptChannel { id: string; name: string; enabled: boolean }
export interface Usage { plan: string; windows: { kind: string; percent: number | null; resetAt: number | null; banked: number }[] }

// ----- MCP (src/mcp.ts:104-180). POST /api/mcp answers { text, mcp }. -----
export interface McpSnapshot { credentialsEnabled: boolean; connections: McpConnection[] }
export interface McpTool {
  name: string; registeredName: string; description?: string; schemaHash: string; enabled: boolean;
  access?: "admin" | "member"; effect?: "read" | "write"; needsReview?: boolean;
  /** The tool's JSON schemas, as the MCP server gave them. */
  inputSchema?: unknown; outputSchema?: unknown;
}
export interface McpConnection {
  id: string; url: string; transport: "http" | "sse"; enabled: boolean; timeoutMs: number; concurrency: number;
  hasToken: boolean; updatedBy: string; updatedAt: number; status: "error" | "connected" | "disabled"; error: string | null;
  tools: McpTool[];
}
export interface McpBody {
  server: string;
  /** /^[a-z][a-z0-9_]{0,11}$/ */
  id: string;
  action: "save" | "refresh" | "disable" | "remove";
  url?: string; transport?: "http" | "sse"; enabled?: boolean;
  /** 1000..60000 */ timeoutMs?: number;
  /** 1..16 */ concurrency?: number;
  tools?: { name: string; schemaHash: string; access: string; effect: string }[];
  /** "" removes the saved token. Leave out to keep it. */
  token?: string;
}

// ----- Inbox, shares, usage (src/web-console.ts:360-449, src/shares.ts) -----
export interface InboxItem { id: string; server: string; target: string; sender: string; channel: string; sourceIds: string[]; summary: string; created_at: number; done_at: number | null }
export interface ServerShare { id: string; channel: string; created_at: number; revoked: boolean }
/** `frozen_at` is when the copy was taken; `newer` is true when the chat has messages after it. */
export interface ChatShare { id: string; created_at: number; revoked: boolean; frozen_at: number; newer: boolean }
export interface CreateShareBody { server: string; channel: string; from?: string; to?: string; show_avatars?: boolean; show_thinking?: boolean }

// ----- Transcripts (src/web-transcripts.ts:437-465) -----
export interface Conversation { id: string; name: string; kind: "channel" | "thread"; parent: string | null; newest: number | null; canSend: boolean; enabled: boolean }
export interface ChannelHeader { channel: { id: string; name: string; parent: string | null }; canSend: boolean; canShare: boolean }
export interface TranscriptMessage {
  id: string; channel: string; author: string; authorName: string; username: string | null; avatarUrl: string | null;
  text: string; timestamp: number | null; editedAt: number | null; slopbot: boolean; runIds: string[]; turn?: string;
  images?: { imageId: string; name: string; contentType: string; size: number }[];
  remoteImages?: { src: string; name: string; size: number }[];
  files?: ChatFile[]; used: boolean;
}
export interface TranscriptPage extends ChannelHeader { streamId: number; hasMore: boolean; messages: TranscriptMessage[] }
export interface ConversationSummary { id: string; title: string; author: string; authorName: string; start: number; end: number; messageCount: number }
export interface ConversationSearch { query: string; channels: { id: string; name: string }[]; messages: TranscriptMessage[] }
export interface ReplyResult { id: string; messageId: string; status: "posted" | "failed"; via: "webhook" | "bot" }

// ----- Private chats (src/web-chats.ts:508-565) -----
export type Effort = "low" | "medium" | "xhigh";
export interface ChatSummary { id: string; title: string; updated: number; effort: Effort }
export interface ChatFile { fileId: string; name: string; contentType: string; size: number }
export interface ChatImage { imageId: string; name: string; contentType: string; size: number }

// ----- Team admin (/api/admin/*, src/admin-panel.ts). A team member only; writes need canEdit. -----
export type TeamRole = "owner" | "admin" | "developer" | "read_only";
export interface AdminMe { role: TeamRole; canEdit: boolean }
export interface Limits { five_hour_cost_micros: number; week_cost_micros: number; grace_percent: number }
export interface LimitsView extends Limits { defaults: Limits }
export interface MemberProfile { id: string; displayName: string; username: string | null; avatarUrl: string | null }
export interface UserUsageWindow { kind: string; spent: number; limit: number; resetAt: number | null; banked: number }
export interface UserLimitOverride { five_hour_cost_micros: number | null; week_cost_micros: number | null }
export interface UserRow { user: MemberProfile; servers: { id: string; name: string }[]; windows: UserUsageWindow[]; override: UserLimitOverride | null }
/** limit is 5, 10, 25 or 50. */
export interface UsersPage { total: number; limit: number; offset: number; users: UserRow[] }
export interface TokenTotal { model: string; requests: number; firstAt: number; lastAt: number; input: number; output: number; cached: number; costMicros: number }
export interface UserDetail extends UserRow { totals: (TokenTotal & { server: string; serverName: string })[] }
export interface ModelPrice { input: number; cached_input: number; output: number }
export interface Prices { models: { model: string; default: ModelPrice & { source: "config" | "fallback" }; override: ModelPrice | null }[]; fallback: ModelPrice }
export interface SystemPrompt { text: string | null; default: string; max: number }
export interface BotReplyLimit { replies: number; minutes: number }
export interface BotReplies extends BotReplyLimit { temporary?: BotReplyLimit & { until: number }; default: BotReplyLimit }
export interface ScheduleLimits { perServer: number; perUser: number; minMinutes: { message: number; prompt: number; tool: number } }
export interface AdminServer { id: string; name: string; icon?: string | null; channelCount: number; transcriptsOn: number }
export interface UsageRow { requests: number; cost_micros: number; total_tokens: number; input_tokens: number; cached_tokens: number; output_tokens: number }
export interface UsageTotals { total: UsageRow; servers: (UsageRow & { name: string; icon: string | null; server: string })[]; models: (UsageRow & { model: string })[] }
export type KeyedProvider = "tavily" | "firecrawl";
export interface WebKey { id: string; provider: KeyedProvider; label: string; last4: string; owner: string; createdAt: number; used: number; exhausted: boolean; lastError: { at: number; status: string; message: string; exhausted: boolean } | null; mine: boolean }
export interface WebKeys { enabled: boolean; month: string; caps: Record<KeyedProvider, number>; keys: WebKey[] }
export type LlmOverride = "auto" | "normal" | "fallback" | "offline";
export interface Breaker { failures: number; windowSeconds: number; cooldownSeconds: number; maxCooldownSeconds: number }
export interface LlmFallback { baseUrl: string; model: string; zdr: boolean; contextTokens: number; outputTokens: number; keyLast4?: string }
export interface Llm {
  settings: { override: LlmOverride; breaker: Breaker; statusNoteMinutes: number; fallback?: LlmFallback };
  state: { mode: "normal" | "fallback" | "offline"; source: "override" | "breaker"; since: number; lastError?: string };
}
