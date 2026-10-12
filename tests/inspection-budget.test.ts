import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ByteTokenCounter, withInspectionBudget } from '../src/context.js';
import { ChatCompletionsLLM } from '../src/adapters/chat-completions.js';
import { RequestError } from '../src/errors.js';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { ToolRegistry } from '../src/tools.js';
import { registerReportTools } from '../src/search/reports.js';
import type { Prompt } from '../src/domain.js';

const prompt: Prompt = { prefixVersion: 'inspection-test', prefix: [], history: [], inputs: [{ role: 'user', content: 'Read this evidence.' }] };

test('internal reports send the configured provider allowance for both report tools', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const message = { server: 's', channel: 'c', author: 'u', id: 'request', text: 'Inspect decisions' };
  await store.ingest({ ...message, id: 'source', text: 'We decided to ship Friday.', timestamp: 1 });
  const sent: Record<string, unknown>[] = [];
  const llm = new ChatCompletionsLLM({ baseUrl: 'https://api.pmservers.org/ai/v1', model: 'cirrus', apiKey: 'test-only', outputTokens: 30000, contextTokens: 64000 }, async (_url, init) => {
    sent.push(JSON.parse(String(init?.body)));
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"Friday was agreed. [source](https://discord.com/channels/s/c/source)"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n');
  });
  const registry = new ToolRegistry(store, async () => false);
  registerReportTools(registry, { store, llm, authorize: async () => {} });
  for (const name of ['decision_lookup', 'conversation_summary']) await registry.invokeResult(message, name, { query: 'ship' }, name, 'agent');
  assert.equal(sent.length, 2);
  for (const request of sent) {
    assert.equal(request.max_tokens, 30000);
    const evidence = (request.messages as { content: string }[])[1]!.content;
    assert.match(evidence, /Indexed evidence:/); assert.ok(!evidence.includes('\\"'));
  }
});

test('inspection defaults follow the actual model, including legacy aliases', () => {
  for (const model of ['nimbus', 'qwen3.8-flash-next', 'cirrus', 'gemma4-e4b']) {
    const llm = new ChatCompletionsLLM({ baseUrl: 'https://api.pmservers.org/ai/v1', model, apiKey: 'test-only' });
    assert.equal(withInspectionBudget(llm, prompt).maxOutputTokens, ['cirrus', 'gemma4-e4b'].includes(model) ? 32000 : 50000);
  }
});

test('large inspection input reserves output within the context window and rejects unfittable input', () => {
  const limits = { contextTokenLimit: 64000, outputTokenLimit: 32000 };
  const large = { ...prompt, inputs: [{ role: 'user' as const, content: 'x'.repeat(45000) }] };
  const bounded = withInspectionBudget(limits, large);
  assert.ok(bounded.maxOutputTokens! > 1200 && bounded.maxOutputTokens! < 32000);
  assert.ok(new ByteTokenCounter().count(bounded.inputs) + bounded.maxOutputTokens! <= 64000);
  assert.throws(() => withInspectionBudget(limits, { ...prompt, inputs: [{ role: 'user', content: 'x'.repeat(64000) }] }), error => error instanceof RequestError && error.code === 'CONTEXT_BUDGET');
});
