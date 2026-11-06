import { pathToFileURL } from "node:url";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { Server } from "node:http";
import { closeWeb } from "./close-web.js";
import { logError } from "./errors.js";
import { loadConfig } from "./config.js";
import { PostgresStore } from "./adapters/postgres.js";
import { SQLiteStore } from "./adapters/sqlite.js";
import { FakeLLM } from "./adapters/fake-llm.js";
import { ChatCompletionsLLM } from "./adapters/chat-completions.js";
import { DynamicLLM, RoutingLLM } from "./adapters/routing-llm.js";
import { S3StorageProvider } from "./adapters/s3-storage.js";
import { BreakerHealth } from "./llm-health.js";
import { loadDegradedSettings, openFallbackKey } from "./llm-settings.js";
import { WebKeySecrets } from "./web-keys.js";
import { ProviderEmbeddings } from "./adapters/embeddings.js";
import { consoleOptions, createConsole } from "./clients/web/web-console.js";
import { AdminPanel } from "./admin-panel.js";
import { startConversationEventRetention } from "./run-events.js";
import { createChatRoutes, WebChatService } from "./clients/web/web-chats.js";
import { createUsageMeter } from "./usage-meter.js";
import { MemberDirectory } from "./member-directory.js";
import { TeamAdmins } from "./team-admins.js";
import { ChannelAccess } from "./channel-access.js";
import { ShareService, type ShareRule } from "./shares.js";
import { LocalDiskStorage } from "./web-chat-images.js";
import { WorkspaceEngine } from "./engine/engine.js";
import { engineEvents } from "./engine/event-log.js";
import { DEFAULT_WORLD_PATH, loadLocalWorld } from "./local/world.js";
import { LocalDirectory, localChannelAccessSource, localMemberSource, localTeamSource } from "./local/local-sources.js";
import { LocalServer } from "./local/local-server.js";
import { localConsoleAdmin, localConsoleBackend } from "./local/local-console.js";

export interface LocalConsole {
  web: Server;
  origin: string;
  stop(): Promise<void>;
}

/** Runs the web console from the fixture world with no Discord. Resolves once the console is listening. */
export async function startLocalConsole(env: NodeJS.ProcessEnv = process.env): Promise<LocalConsole> {
  const config = loadConfig(env);
  if (config.platform !== "local") throw new Error("web-main runs the local console only: set SLOPBOT_PLATFORM=local");
  const webOptions = consoleOptions(env);
  if (!webOptions) throw new Error("Local mode is the web console only: set WEB_ENABLED=true");
  const world = loadLocalWorld(env.LOCAL_WORLD ?? DEFAULT_WORLD_PATH);
  if (config.databasePath !== ":memory:") mkdirSync(dirname(config.databasePath), { recursive: true });
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
    const health = new BreakerHealth(() => loadDegradedSettings(store));
    const router = new RoutingLLM(llm, health, () => loadDegradedSettings(store), endpoint => openFallbackKey({ ...loadDegradedSettings(store), fallback: endpoint }, secrets, { baseUrl: config.baseUrl, apiKey: config.apiKey }));
    return { health, router };
  })();
  const retention = startConversationEventRetention(store, { days: config.conversationEventsRetentionDays, maxRows: config.conversationEventsMaxRows });
  const routing = degraded ? { router: degraded.router, health: degraded.health, mode: () => degraded.health.state().mode, statusNoteMinutes: () => loadDegradedSettings(store).statusNoteMinutes } : undefined;
  const serverLlm = routing ? new DynamicLLM(routing.router, llm, routing.health) : llm;
  const usage = createUsageMeter(config, store);
  // Embedding calls are charged through the same meter as model calls.
  embeddings?.attachUsage(usage);
  engineEvents.attach(store);
  const members = new MemberDirectory(localMemberSource(world));
  const team = new TeamAdmins(localTeamSource(world));
  const access = new ChannelAccess(localChannelAccessSource(world));
  const directory = new LocalDirectory(world, members);
  const images = config.objectStorage ? new S3StorageProvider(config.objectStorage) : undefined;

  const engine = new WorkspaceEngine();
  const openings: Promise<unknown>[] = [];
  const servers = world.servers.map(({ id }) => {
    const server = new LocalServer({ config, store, llm: serverLlm, server: id, usage, access, team, directory, ...(images ? { images } : {}), ...(routing ? { degraded: routing } : {}) });
    const opening = server.ready(world.bot.id).then(() => server.workspace);
    engine.add(id, opening);
    openings.push(opening);
    return server;
  });

  const shareRule: ShareRule = { manager: (user, server) => directory.canManage(user, server), teamAdmin: user => team.canEdit(user) };
  const shares = new ShareService({ store, access, rule: shareRule, member: (user, server) => directory.isMember(user, server), images: images ?? new LocalDiskStorage() });
  const chats = new WebChatService(store, { engine, directory, limiter: usage.limiter, access, ...(images ? { images } : {}) });
  const panel = new AdminPanel(config, store, usage.limiter, members);
  if (degraded) panel.setLlmState(() => degraded.health.state());
  const admin = localConsoleAdmin({ world, team, panel });
  const localBackend = localConsoleBackend({ world, config, store, members, usage });
  const consoleOptionsLive = degraded ? { ...webOptions, llmStatus: () => ({ mode: degraded.health.state().mode, canChat: degraded.router.select(undefined) !== undefined }), settings: store } : webOptions;
  const web = createConsole(consoleOptionsLive, {
    ...localBackend, access, admin, chats: createChatRoutes(chats),
    continueShare: (user, id) => chats.continueShare(user, id, shares), shares, sessions: store,
  });
  const stop = async () => {
    retention();
    if (web.listening) await closeWeb(web);
    if (store instanceof PostgresStore) store.stopIndexing();
    for (const server of servers) await server.stop();
    await store.finishIndexing();
    await store.close();
  };
  try {
    await Promise.all(openings);
    await new Promise<void>((resolve, reject) => { web.once("error", reject); web.listen(webOptions.port, webOptions.host, resolve); });
  } catch (error) { await stop().catch(() => undefined); throw error; }
  const origin = webOptions.origin;
  console.log(`Slopbot local console: ${origin}/console (no Discord)`);
  return { web, origin, stop };
}

async function main(): Promise<void> {
  const local = await startLocalConsole();
  const shutdown = async () => { await local.stop(); process.exit(0); };
  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => { void shutdown().catch(error => { logError("shutdown_failed", error, { stage: "shutdown" }); process.exitCode = 1; }); });
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => {
    logError("startup_failed", error, { stage: "startup" });
    process.exitCode = 1;
  });
}
