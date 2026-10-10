export interface Config {
  discordToken: string;
  guildId: string;
  channelIds: string[];
  mock: boolean;
  baseUrl: string;
  apiKey: string;
  model: string;
  databasePath: string;
  databaseUrl?: string;
  searxngUrl?: string;
  jevEnabled: boolean;
  jevModel: string;
  jevContextMessages: number;
  jevCooldownSeconds: number;
  jevMaxRepliesPerHour: number;
  replyContextMessages: number;
  embeddingsEnabled: boolean;
  embeddingModel: string;
  historyWindowDays: number;
  contextTokens: number;
  outputTokens: number;
  checkpointTokens: number;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const required = (key: string): string => {
    const value = env[key]?.trim();
    if (!value) throw new Error(`Set ${key} in .env`);
    return value;
  };
  const mock = env.LLM_MODE === "mock";
  if (env.LLM_MODE && !["mock", "provider"].includes(env.LLM_MODE)) throw new Error("LLM_MODE must be mock or provider");
  const guildId = required("DISCORD_GUILD_ID");
  const channelIds = (env.DISCORD_CHANNEL_IDS ?? "").split(",").map(value => value.trim()).filter(Boolean);
  if (![guildId, ...channelIds].every(value => /^\d{17,20}$/.test(value))) {
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
  const contextTokens = integer("CONTEXT_TOKENS", 32768, 1000000, 2048);
  const outputTokens = integer("OUTPUT_TOKENS", 2048, 100000, 128);
  const checkpointTokens = integer("CHECKPOINT_TOKENS", 2048, 100000, 128);
  if (outputTokens >= contextTokens) throw new Error("OUTPUT_TOKENS must leave room within CONTEXT_TOKENS for input");
  const url = new URL(baseUrl);
  if (!["https:", "http:"].includes(url.protocol)) throw new Error("LLM_BASE_URL must be an HTTP URL");
  if (env.SEARXNG_URL) {
    const searchUrl = new URL(env.SEARXNG_URL);
    if (!["https:", "http:"].includes(searchUrl.protocol) || searchUrl.username || searchUrl.password || searchUrl.search || searchUrl.hash) throw new Error("SEARXNG_URL must be an HTTP(S) base URL without credentials, query or fragment");
  }
  return {
    ...(env.SEARXNG_URL ? { searxngUrl: env.SEARXNG_URL } : {}),
    discordToken: required("DISCORD_BOT_TOKEN"), guildId, channelIds, mock, baseUrl,
    apiKey: mock ? "" : required("LLM_API_KEY"),
    model: env.LLM_MODEL?.trim() || "qwen3.8-flash-next",
    ...(env.DATABASE_URL ? { databaseUrl: env.DATABASE_URL } : {}),
    databasePath: env.DATABASE_PATH ?? "./data/slopbot.sqlite3",
    jevEnabled: enabled("JEV_ENABLED", true), jevModel: env.JEV_MODEL ?? "typesafe/kev-4b",
    jevContextMessages: integer("JEV_CONTEXT_MESSAGES", 8, 100),
    jevCooldownSeconds: integer("JEV_COOLDOWN_SECONDS", 60, 3600),
    jevMaxRepliesPerHour: integer("JEV_MAX_REPLIES_PER_HOUR", 3, 1000),
    replyContextMessages: integer("REPLY_CONTEXT_MESSAGES", 12, 100),
    embeddingsEnabled: enabled("EMBEDDINGS_ENABLED", true),
    embeddingModel: env.EMBEDDING_MODEL ?? "llama.cpp/embeddinggemma-2",
    contextTokens,
    outputTokens,
    checkpointTokens,
    historyWindowDays: integer("HISTORY_WINDOW_DAYS", 7, 3650, 1),
  };
}
