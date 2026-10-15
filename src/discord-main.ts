import { closeWeb } from './close-web.js';
import { logError } from "./errors.js";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { loadConfig } from "./config.js";
import { DiscordAdapter } from "./adapters/discord.js";
import { PostgresStore } from "./adapters/postgres.js";
import { SQLiteStore } from "./adapters/sqlite.js";
import { FakeLLM } from "./adapters/fake-llm.js";
import { ChatCompletionsLLM } from "./adapters/chat-completions.js";
import { DynamicLLM, probePrimary, RoutingLLM } from "./adapters/routing-llm.js";
import { BreakerHealth } from "./llm-health.js";
import { loadDegradedSettings, openFallbackKey } from "./llm-settings.js";
import { WebKeySecrets } from "./web-keys.js";
import { discordStartupError } from "./startup-error.js";
import { ProviderEmbeddings } from "./adapters/embeddings.js";
import { consoleOptions, createConsole, type ConsoleAdmin } from './web-console.js';
import { AdminPanel } from './admin-panel.js';
import { discordPresentation } from './presentation/discord.js';
import { createTranscripts } from './web-transcripts.js';
import { configuredChannels } from './server-tools.js';
import { startConversationEventRetention } from './run-events.js';
import { createChatRoutes, WebChatService } from './web-chats.js';

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
  // Degraded mode: the breaker and the router. Mock runs keep the single LLM.
  const degraded = config.mock ? undefined : (() => {
    const secrets = new WebKeySecrets();
    const health = new BreakerHealth(() => loadDegradedSettings(store), () => probePrimary(config.baseUrl, config.apiKey, config.model));
    const router = new RoutingLLM(llm, health, () => loadDegradedSettings(store), endpoint => openFallbackKey({ ...loadDegradedSettings(store), fallback: endpoint }, secrets, { baseUrl: config.baseUrl, apiKey: config.apiKey }));
    return { health, router };
  })();
  const retention = startConversationEventRetention(store, { days: config.conversationEventsRetentionDays, maxRows: config.conversationEventsMaxRows });
  const routing = degraded ? { router: degraded.router, mode: () => degraded.health.state().mode, statusNoteMinutes: () => loadDegradedSettings(store).statusNoteMinutes } : undefined;
  const discord = routing ? new DiscordAdapter(config, store, new DynamicLLM(routing.router, llm), undefined, routing) : new DiscordAdapter(config, store, llm);
  // Embedding calls are charged through the same meter as model calls.
  embeddings?.attachUsage(discord.usage);
  const panel = new AdminPanel(config, store, discord.usage.limiter, discord.members, discordPresentation);
  if (degraded) panel.setLlmState(() => degraded.health.state());
  const admin: ConsoleAdmin = { role: user => discord.team.role(user), canEdit: user => discord.team.canEdit(user), servers: page => discord.adminServers(page), serverChannels: server => discord.adminServerChannels(server), serverInfo: server => discord.adminServerInfo(server),setTranscript: (server, channel, enabled) => discord.adminSetTranscript(server, channel, enabled), rotateWebhook: (server, channel) => discord.adminRotateWebhook(server, channel), panel };
  const chats = new WebChatService(store, discord.chatHost());
  if (webOptions) discord.webChat = { continueMessage: async (user, server, source) => `${webOptions.origin}/chat/${encodeURIComponent((await chats.continueMessage(user, server, source)).id)}?server=${encodeURIComponent(server)}` };
  const conversations = createTranscripts({ store, access: discord.access, configured: server => configuredChannels(config, store, server), channelName: (server, channel) => discord.channelName(server, channel), shareRule: discord.shareRule, members: discord.members, ownsPrivateChat: (server, channel, user) => chats.owns(user, server, channel) });
  // Mock runs keep the console as before: no mode banner and no non-ZDR switch.
  const consoleOptionsLive = webOptions && degraded ? { ...webOptions, llmStatus: () => ({ mode: degraded.health.state().mode, canChat: degraded.router.select(undefined) !== undefined }), settings: store } : webOptions;
  const web = consoleOptionsLive ? createConsole(consoleOptionsLive, { canSignIn: user => discord.canSignIn(user), servers: user => discord.consoleServers(user), snapshot: (user, server) => discord.consoleSnapshot(user, server), usage: (user, server) => discord.consoleUsage(user, server), useReset: (user, server, kind) => discord.consoleUseReset(user, server, kind), invoke: (user, server, channel, name, args) => discord.consoleInvoke(user, server, channel, name, args), mcp: (user, server, input) => discord.consoleMcp(user, server, input), transcripts: (user, server) => discord.consoleTranscripts(user, server), inbox: { list: (user, server, includeDone) => discord.consoleInbox(user, server, includeDone), done: (user, server, ids) => discord.consoleInboxDone(user, server, ids) }, setTranscript: (user, server, channel, enabled) => discord.consoleSetTranscript(user, server, channel, enabled), access: discord.access, admin, conversations, chats: createChatRoutes(chats), continueShare: (user, id) => chats.continueShare(user, id, discord.shares), reply: (user, server, channel, text) => discord.consoleReply(user, server, channel, text), shares: discord.shares, sessions: store }) : undefined;
  const shutdown = async () => { retention(); degraded?.health.stop(); if (web?.listening) await closeWeb(web); if (store instanceof PostgresStore) store.stopIndexing(); await discord.stop(); await store.finishIndexing(); await store.close(); process.exit(0); };
  process.once("SIGINT", () => { void shutdown().catch(error => { logError("shutdown_failed", error, { stage: "shutdown" }); process.exitCode = 1; }); });
  process.once("SIGTERM", () => { void shutdown().catch(error => { logError("shutdown_failed", error, { stage: "shutdown" }); process.exitCode = 1; }); });
  try { degraded?.health.start(); await discord.start(); if (web && webOptions) { await new Promise<void>((resolve, reject) => { web.once('error', reject); web.listen(webOptions.port, webOptions.host, resolve); }); console.log(`Slopbot settings: ${webOptions.origin}`); } }
  catch (error) { retention(); degraded?.health.stop(); await store.close(); await discord.stop(); throw new Error(discordStartupError(error), { cause: error }); }
}

void main().catch(error => {
  logError("startup_failed", error, { stage: "startup" });
  process.exitCode = 1;
});
