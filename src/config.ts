import { DEFAULT_MAX_TOOL_ROUNDS } from "./errors.js";
import { DEFAULT_CONTEXT_TOKENS, DEFAULT_OUTPUT_TOKENS, modelTokenLimits } from "./context.js";
import { parseFallbackPrice, parseModelPrices, type ModelPrice, type PriceTable } from "./usage-cost.js";
import { defaultDecisionThresholds, type DecisionThresholds } from './participation-history.js';
import { loadOperationsConfig, type OperationsConfig } from './operations-config.js';

export interface Config {
  voice?: { voice: string; instructions?: string };
  operations?: OperationsConfig;
  objectStorage?: import("./adapters/s3-storage.js").S3StorageOptions;
  sandboxApiKey?: string;
  sandboxApiUrl?: string;
  sandboxUrl?: string;
  sandboxTemplate?: string;
  discordToken: string;
  /** Servers Slopbot may join. Empty means every server that invites it. */
  guildIds: string[];
  /** Server that receives the initial DISCORD_CHANNEL_IDS list. */
  channelServer?: string;
  channelIds: string[];
  mock: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  databasePath: string;
  databaseUrl?: string;
  databaseSchema?: string;
  searxngUrl?: string;
  searxngAccess?: { clientId: string; clientSecret: string };
  jevEnabled: boolean;
  jevThresholds: DecisionThresholds;
  jevModel: string;
  jevContextMessages: number;
  jevCooldownSeconds: number;
  jevMaxRepliesPerHour: number;
  replyContextMessages: number;
  embeddingsEnabled: boolean;
  embeddingModel: string;
  historyWindowDays: number;
  /** Web transcript events older than this are pruned. */
  conversationEventsRetentionDays: number;
  /** Newest web transcript event rows kept after pruning. */
  conversationEventsMaxRows: number;
  contextTokens: number;
  outputTokens: number;
  checkpointTokens: number;
  maxToolRounds: number;
  userLimit5hCostMicros: number;
  userLimitWeekCostMicros: number;
  userLimitGracePercent: number;
  modelPrices: PriceTable;
  fallbackPrice: ModelPrice;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (key: string): string => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`Set ${key} in .env`);
    return value;
  };
  const mock = env.LLM_MODE === "mock";
  const operations = loadOperationsConfig(env);
  if (env.LLM_MODE && !["mock", "provider"].includes(env.LLM_MODE)) throw new Error("LLM_MODE must be mock or provider");
  const list = (key: string) => (env[key] ?? "").split(",").map(value => value.trim()).filter(Boolean);
  const channelServer = env.DISCORD_GUILD_ID?.trim() || undefined;
  const guildIds = [...new Set(list("DISCORD_GUILD_IDS"))];
  const channelIds = list("DISCORD_CHANNEL_IDS");
  if (channelIds.length && !channelServer) throw new Error("Set DISCORD_GUILD_ID for the server of DISCORD_CHANNEL_IDS");
  if (![...guildIds, ...(channelServer ? [channelServer] : []), ...channelIds].every(value => /^\d{17,20}$/.test(value))) {
    throw new Error("Discord server/channel IDs must be numeric IDs, not names");
  }
  const baseUrl = env.LLM_BASE_URL ?? "https://api.pmservers.org/ai/v1";
  const integer = (key: string, fallback: number, max: number, min = 0): number => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${key} must be an integer from ${min} to ${max}`);
    return value;
  };
  const enabled = (key: string, fallback: boolean): boolean => {
    if (env[key] === undefined) return fallback;
    if (!["true", "false"].includes(env[key]!)) throw new Error(`${key} must be true or false`);
    return env[key] === "true";
  };
  const threshold = (key: string, fallback: number): number => {
    const value = env[key] === undefined ? fallback : Number(env[key]);
    if (env[key]?.trim() === '' || !Number.isFinite(value) || value < 0 || value > 1) throw new Error(`${key} must be a number from 0 to 1`);
    return value;
  };
  const model = env.LLM_MODEL?.trim() || "nimbus";
  const limits = modelTokenLimits(model, baseUrl);
  const contextTokens = integer("CONTEXT_TOKENS", limits?.context ?? DEFAULT_CONTEXT_TOKENS, 1000000, 2048);
  const outputTokens = integer("OUTPUT_TOKENS", limits?.output ?? DEFAULT_OUTPUT_TOKENS, 100000, 128);
  if (limits && contextTokens > limits.context) throw new Error(`CONTEXT_TOKENS exceeds ${model} context window of ${limits.context}`);
  if (limits && outputTokens > limits.output) throw new Error(`OUTPUT_TOKENS exceeds ${model} maximum output of ${limits.output}`);
  const checkpointTokens = integer("CHECKPOINT_TOKENS", 2048, 100000, 128);
  if (outputTokens >= contextTokens) throw new Error("OUTPUT_TOKENS must leave room within CONTEXT_TOKENS for input");
  const url = new URL(baseUrl);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("LLM_BASE_URL must be an HTTP URL");
  if (env.SEARXNG_URL) {
    const searchUrl = new URL(env.SEARXNG_URL);
    if (!["https:", "http:"].includes(searchUrl.protocol) || searchUrl.username || searchUrl.password || searchUrl.search || searchUrl.hash) throw new Error("SEARXNG_URL must be an HTTP(S) base URL without credentials, query or fragment");
  }
  for (const key of ["E2B_API_URL", "E2B_SANDBOX_URL"]) if (env[key]) {
    const value = new URL(env[key]!);
    if (value.protocol !== "https:" || value.username || value.password || value.search || value.hash) throw new Error(`${key} must be an HTTPS URL without credentials, query or fragment`);
  }
  let objectStorage: Config['objectStorage'];
  if (env.OBJECT_STORAGE_BUCKET) {
    const bucket = env.OBJECT_STORAGE_BUCKET;
    if (!/^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/.test(bucket) || bucket.includes('..')) throw new Error('OBJECT_STORAGE_BUCKET must be a valid S3 bucket name');
    const endpoint = env.AWS_ENDPOINT_URL ?? 'https://s3.pmservers.org';
    const publicEndpoint = env.OBJECT_STORAGE_PUBLIC_ENDPOINT ?? 'https://s3.pmservers.org';
    for (const [key, value] of [['AWS_ENDPOINT_URL', endpoint], ['OBJECT_STORAGE_PUBLIC_ENDPOINT', publicEndpoint]]) {
      const parsed = new URL(value!);
      const privateEndpoint = key === 'AWS_ENDPOINT_URL' && value === 'http://garage.pms-storage.svc:3900';
      if ((!privateEndpoint && parsed.protocol !== 'https:') || parsed.username || parsed.password || parsed.search || parsed.hash || parsed.pathname !== '/') throw new Error(`${key} must be an HTTPS origin, or the documented private Garage endpoint for AWS_ENDPOINT_URL`);
    }
    objectStorage = { bucket, endpoint, publicEndpoint, region: env.AWS_REGION ?? 'pms', accessKeyId: required('AWS_ACCESS_KEY_ID'), secretAccessKey: required('AWS_SECRET_ACCESS_KEY') };
  }
  const accessId = env.SEARXNG_ACCESS_CLIENT_ID, accessSecret = env.SEARXNG_ACCESS_CLIENT_SECRET;
  if (accessId || accessSecret) {
    if (!accessId || !accessSecret || !env.SEARXNG_URL || new URL(env.SEARXNG_URL).protocol !== "https:") throw new Error("Protected search requires HTTPS SEARXNG_URL and both SEARXNG_ACCESS_CLIENT_ID and SEARXNG_ACCESS_CLIENT_SECRET");
  }
  if ([...(env.VOICE_INSTRUCTIONS?.trim() ?? '')].length > 1000) throw new Error('VOICE_INSTRUCTIONS must be at most 1000 characters');
  return {
    ...(enabled('VOICE_ENABLED', true) ? { voice: { voice: env.VOICE_NAME?.trim() || 'alloy', ...(env.VOICE_INSTRUCTIONS?.trim() ? { instructions: env.VOICE_INSTRUCTIONS.trim() } : {}) } } : {}),
    ...(operations ? { operations } : {}),
    ...(objectStorage ? { objectStorage } : {}),
    ...(accessId && accessSecret ? { searxngAccess: { clientId: accessId, clientSecret: accessSecret } } : {}),
    ...(env.E2B_API_KEY ? { sandboxApiKey: env.E2B_API_KEY, sandboxApiUrl: env.E2B_API_URL ?? "https://api.pmservers.org/sandboxes", sandboxUrl: env.E2B_SANDBOX_URL ?? "https://sandbox.pmservers.org" } : {}),
    ...(env.E2B_TEMPLATE ? { sandboxTemplate: env.E2B_TEMPLATE } : {}),
    ...(env.SEARXNG_URL ? { searxngUrl: env.SEARXNG_URL } : {}),
    discordToken: required("DISCORD_BOT_TOKEN"), guildIds, ...(channelServer ? { channelServer } : {}), channelIds, mock, baseUrl,
    apiKey: mock ? "" : required("LLM_API_KEY"),
    model,
    ...(env.DATABASE_URL ? { databaseUrl: env.DATABASE_URL } : {}),
    ...(env.DATABASE_SCHEMA ? { databaseSchema: env.DATABASE_SCHEMA } : {}),
    databasePath: env.DATABASE_PATH ?? "./data/slopbot.sqlite3",
    jevEnabled: enabled("JEV_ENABLED", true), jevModel: env.JEV_MODEL ?? "vane",
    jevThresholds: {
      addressed: threshold('JEV_ADDRESSED_THRESHOLD', defaultDecisionThresholds.addressed),
      respond: threshold('JEV_RESPONSE_THRESHOLD', defaultDecisionThresholds.respond),
      unsolicited: threshold('JEV_UNSOLICITED_THRESHOLD', defaultDecisionThresholds.unsolicited),
      funny: threshold('JEV_FUNNY_THRESHOLD', defaultDecisionThresholds.funny),
    },
    jevContextMessages: integer("JEV_CONTEXT_MESSAGES", 8, 100),
    jevCooldownSeconds: integer("JEV_COOLDOWN_SECONDS", 60, 3600),
    jevMaxRepliesPerHour: integer("JEV_MAX_REPLIES_PER_HOUR", 3, 1000),
    replyContextMessages: integer("REPLY_CONTEXT_MESSAGES", 12, 100),
    embeddingsEnabled: enabled("EMBEDDINGS_ENABLED", true),
    embeddingModel: env.EMBEDDING_MODEL ?? "llama.cpp/embeddinggemma-2",
    contextTokens,
    outputTokens,
    checkpointTokens,
    maxToolRounds: integer("MAX_TOOL_ROUNDS", DEFAULT_MAX_TOOL_ROUNDS, 1000, 1),
    historyWindowDays: integer("HISTORY_WINDOW_DAYS", 7, 3650, 1),
    conversationEventsRetentionDays: integer("CONVERSATION_EVENTS_RETENTION_DAYS", 14, 3650, 1),
    conversationEventsMaxRows: integer("CONVERSATION_EVENTS_MAX_ROWS", 2000000, 1000000000, 1),
    userLimit5hCostMicros: integer("USER_LIMIT_5H_COST_MICROS", 2000000, 1000000000000), userLimitWeekCostMicros: integer("USER_LIMIT_WEEK_COST_MICROS", 20000000, 1000000000000),
    userLimitGracePercent: integer("USER_LIMIT_GRACE_PERCENT", 10, 1000),
    modelPrices: parseModelPrices(env.MODEL_PRICES, "MODEL_PRICES"), fallbackPrice: parseFallbackPrice(env.MODEL_FALLBACK_PRICE, "MODEL_FALLBACK_PRICE"),
  };
}
