import { logError } from "./errors.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "./config.js";
import { DiscordAdapter } from "./adapters/discord.js";
import { PostgresStore } from "./adapters/postgres.js";
import { SQLiteStore } from "./adapters/sqlite.js";
import { FakeLLM } from "./adapters/fake-llm.js";
import { ChatCompletionsLLM } from "./adapters/chat-completions.js";
import { discordStartupError } from "./startup-error.js";
import { ProviderEmbeddings } from "./adapters/embeddings.js";
import { consoleOptions, createConsole, type ConsoleAdmin } from './web-console.js';
import { AdminPanel } from './admin-panel.js';
import { createTranscripts } from './web-transcripts.js';
import { configuredChannels } from './server-tools.js';
import { startConversationEventRetention } from './run-events.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const webOptions = consoleOptions();
  mkdirSync(dirname(config.databasePath), { recursive: true });
  const embeddings = config.embeddingsEnabled && !config.mock
    ? new ProviderEmbeddings(config.baseUrl, config.apiKey, config.embeddingModel) : undefined;
  const store = config.databaseUrl ? await PostgresStore.connect(config.databaseUrl, embeddings, config.databaseSchema) : new SQLiteStore(config.databasePath, embeddings);
  const llm = config.mock ? new FakeLLM() : new ChatCompletionsLLM({
    baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model,
    outputTokens: config.outputTokens, contextTokens: config.contextTokens,
  });
  const retention = startConversationEventRetention(store, { days: config.conversationEventsRetentionDays, maxRows: config.conversationEventsMaxRows });
  const discord = new DiscordAdapter(config, store, llm);
  // Embedding calls are charged through the same meter as model calls.
  embeddings?.attachUsage(discord.usage);
  const panel = new AdminPanel(config, store, discord.usage.limiter, discord.members);
  const admin: ConsoleAdmin = { role: user => discord.team.role(user), canEdit: user => discord.team.canEdit(user), servers: () => discord.adminServers(), setTranscript: (server, channel, enabled) => discord.adminSetTranscript(server, channel, enabled), rotateWebhook: (server, channel) => discord.adminRotateWebhook(server, channel), panel };
  const conversations = createTranscripts({ store, access: discord.access, configured: server => configuredChannels(config, store, server), channelName: (server, channel) => discord.channelName(server, channel), shareRule: discord.shareRule, members: discord.members });
  const web = webOptions ? createConsole(webOptions, { snapshot: (user, server) => discord.consoleSnapshot(user, server), usage: (user, server) => discord.consoleUsage(user, server), invoke: (user, server, channel, name, args) => discord.consoleInvoke(user, server, channel, name, args), mcp: (user, server, input) => discord.consoleMcp(user, server, input), transcripts: (user, server) => discord.consoleTranscripts(user, server), setTranscript: (user, server, channel, enabled) => discord.consoleSetTranscript(user, server, channel, enabled), access: discord.access, admin, conversations, reply: (user, server, channel, text) => discord.consoleReply(user, server, channel, text), shares: discord.shares, sessions: store }) : undefined;
  const shutdown = async () => { retention(); if (web?.listening) await new Promise<void>((resolve, reject) => web.close(error => error ? reject(error) : resolve())); if (store instanceof PostgresStore) store.stopIndexing(); await discord.stop(); await store.finishIndexing(); await store.close(); process.exit(0); };
  process.once("SIGINT", () => { void shutdown().catch(error => { logError("shutdown_failed", error, { stage: "shutdown" }); process.exitCode = 1; }); });
  process.once("SIGTERM", () => { void shutdown().catch(error => { logError("shutdown_failed", error, { stage: "shutdown" }); process.exitCode = 1; }); });
  try { await discord.start(); if (web && webOptions) { await new Promise<void>((resolve, reject) => { web.once('error', reject); web.listen(webOptions.port, webOptions.host, resolve); }); console.log(`Slopbot settings: ${webOptions.origin}`); } }
  catch (error) { retention(); await store.close(); await discord.stop(); throw new Error(discordStartupError(error), { cause: error }); }
}

void main().catch(error => {
  logError("startup_failed", error, { stage: "startup" });
  process.exitCode = 1;
});
