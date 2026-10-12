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
import { consoleOptions, createConsole } from './web-console.js';

async function main(): Promise<void> {
  const config = loadConfig();
  const webOptions = consoleOptions();
  mkdirSync(dirname(config.databasePath), { recursive: true });
  const embeddings = config.embeddingsEnabled && !config.mock
    ? new ProviderEmbeddings(config.baseUrl, config.apiKey, config.embeddingModel) : undefined;
  const store = config.databaseUrl ? await PostgresStore.connect(config.databaseUrl, embeddings, config.databaseSchema) : new SQLiteStore(config.databasePath, embeddings);
  const llm = config.mock ? new FakeLLM() : new ChatCompletionsLLM({
    baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model,
  });
  const discord = new DiscordAdapter(config, store, llm);
  const web = webOptions ? createConsole(webOptions, { snapshot: user => discord.consoleSnapshot(user), invoke: (user, channel, name, args) => discord.consoleInvoke(user, channel, name, args), mcp: (user, input) => discord.consoleMcp(user, input) }) : undefined;
  const shutdown = async () => { if (web?.listening) await new Promise<void>((resolve, reject) => web.close(error => error ? reject(error) : resolve())); if (store instanceof PostgresStore) store.stopIndexing(); await discord.stop(); await store.finishIndexing(); await store.close(); process.exit(0); };
  process.once("SIGINT", () => { void shutdown().catch(error => { logError("shutdown_failed", error, { stage: "shutdown" }); process.exitCode = 1; }); });
  process.once("SIGTERM", () => { void shutdown().catch(error => { logError("shutdown_failed", error, { stage: "shutdown" }); process.exitCode = 1; }); });
  try { await discord.start(); if (web && webOptions) { await new Promise<void>((resolve, reject) => { web.once('error', reject); web.listen(webOptions.port, webOptions.host, resolve); }); console.log(`Slopbot settings: ${webOptions.origin}`); } }
  catch (error) { await store.close(); await discord.stop(); throw new Error(discordStartupError(error), { cause: error }); }
}

void main().catch(error => {
  logError("startup_failed", error, { stage: "startup" });
  process.exitCode = 1;
});
