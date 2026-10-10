import assert from "node:assert/strict";
import { test } from "node:test";
import { ProviderEmbeddings } from "../src/adapters/embeddings.js";

test("embedding adapter preserves reported usage without inventing missing token counts", async () => {
  const responses = [
    { data: [{ embedding: [1, 0] }], usage: { prompt_tokens: 7, total_tokens: 7 } },
    { data: [{ embedding: [1, 0] }] },
  ];
  const provider = new ProviderEmbeddings("https://example.test", "test", "embedding-test", async () => Response.json(responses.shift()));
  assert.deepEqual(await provider.embedWithUsage("hello"), { vector: [1, 0], tokens: 7 });
  assert.deepEqual(await provider.embedWithUsage("hello"), { vector: [1, 0], tokens: null });
});

test("PMServers alias preserves the existing Gemma vector index identity", async () => {
  let sentModel: unknown;
  const provider = new ProviderEmbeddings("https://api.pmservers.org/ai/v1", "test", "llama.cpp/embeddinggemma-2", async (_url, init) => {
    sentModel = JSON.parse(String(init?.body)).model;
    return Response.json({ data: [{ embedding: [1, 0] }] });
  });
  await provider.embed("hello");
  assert.equal(sentModel, "embeddinggemma2");
  assert.equal(provider.model, "llama.cpp/embeddinggemma-2");
});
