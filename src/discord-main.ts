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

async function main(): Promise<void> {
  const config = loadConfig();
  mkdirSync(dirname(config.databasePath), { recursive: true });
  const embeddings = config.embeddingsEnabled && !config.mock
    ? new ProviderEmbeddings(config.baseUrl, config.apiKey, config.embeddingModel) : undefined;
  const store = config.databaseUrl ? await PostgresStore.connect(config.databaseUrl, embeddings) : new SQLiteStore(config.databasePath, embeddings);
  const llm = config.mock ? new FakeLLM() : new ChatCompletionsLLM({
    baseUrl: config.baseUrl, apiKey: config.apiKey, model: config.model,
  });
  const discord = new DiscordAdapter(config, store, llm);
  const shutdown = async () => { await discord.stop(); await store.finishIndexing(); await store.close(); process.exit(0); };
  process.once("SIGINT", () => { void shutdown(); });
  process.once("SIGTERM", () => { void shutdown(); });
  try { await discord.start(); }
  catch (error) { await store.close(); await discord.stop(); throw new Error(discordStartupError(error)); }
}

void main().catch(error => {
  console.error(error instanceof Error ? error.message : "Startup failed");
  process.exitCode = 1;
});
