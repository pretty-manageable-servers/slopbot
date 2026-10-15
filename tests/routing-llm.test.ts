import test from 'node:test';
import assert from 'node:assert/strict';
import { RoutingLLM, outageCode } from '../src/adapters/routing-llm.js';
import { modelsInUse } from '../src/usage-meter.js';
import { DEFAULT_BREAKER, DEFAULT_STATUS_NOTE_MINUTES, type FallbackEndpoint, type LlmDegradedSettings, type LlmHealth, type LlmMode, type LlmModeState } from '../src/llm-mode.js';
import { ProviderError, RequestError } from '../src/errors.js';
import type { LLM } from '../src/ports.js';
import type { ModelEvent, Prompt } from '../src/domain.js';

class FakeHealth implements LlmHealth {
  mode: LlmMode = 'normal';
  failures: string[] = [];
  successes = 0;
  state(): LlmModeState { return { mode: this.mode, source: this.mode === 'normal' ? 'breaker' : 'override', since: 0 }; }
  recordFailure(code: string): void { this.failures.push(code); }
  recordSuccess(): void { this.successes++; }
  onChange(): () => void { return () => undefined; }
}

class FakePrimary implements LLM {
  calls = 0;
  readonly model = 'primary-model';
  constructor(private readonly error?: unknown) {}
  async *stream(_prompt: Prompt): AsyncIterable<ModelEvent> {
    this.calls++;
    if (this.error) throw this.error;
    yield { kind: 'text', payload: { text: 'primary' } };
  }
}

type Sent = { url: string; auth: string; model: string };

function sseFetch(sent: Sent[]): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const headers = init?.headers as Record<string, string>;
    sent.push({ url: String(url), auth: headers.Authorization ?? '', model: JSON.parse(String(init?.body)).model });
    return new Response('data: {"choices":[{"index":0,"delta":{"content":"backup"}}]}\n\ndata: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
}

function endpoint(overrides: Partial<FallbackEndpoint> = {}): FallbackEndpoint {
  return { baseUrl: 'https://backup.example.test/v1', model: 'backup-model', zdr: true, contextTokens: 8192, outputTokens: 1024, keySealed: 'sealed-1', ...overrides };
}

function settings(fallback?: FallbackEndpoint): LlmDegradedSettings {
  return { override: 'auto', breaker: DEFAULT_BREAKER, statusNoteMinutes: DEFAULT_STATUS_NOTE_MINUTES, ...(fallback ? { fallback } : {}) };
}

const prompt: Prompt = { prefixVersion: 'test-v1', prefix: [], history: [], inputs: [{ role: 'user', content: 'hi' }] };

async function drain(llm: LLM): Promise<ModelEvent[]> {
  const events: ModelEvent[] = [];
  for await (const event of llm.stream(prompt)) events.push(event);
  return events;
}

const who = { user: 'u1', server: 's1', private: false };

test('normal uses primary', async () => {
  const primary = new FakePrimary();
  const router = new RoutingLLM(primary, new FakeHealth(), () => settings(endpoint()), key => `key-for-${key}`);
  const selected = router.select(who);
  assert.ok(selected);
  assert.equal(selected.model, 'primary-model');
  assert.deepEqual(await drain(selected), [{ kind: 'text', payload: { text: 'primary' } }]);
  assert.equal(router.select(undefined), selected);
  assert.equal(primary.calls, 1);
});

test('offline returns undefined', () => {
  const health = new FakeHealth();
  health.mode = 'offline';
  const router = new RoutingLLM(new FakePrimary(), health, () => settings(endpoint()), key => key);
  assert.equal(router.select(who), undefined);
  assert.equal(router.select(undefined), undefined);
});

test('fallback zdr used', async () => {
  const health = new FakeHealth();
  health.mode = 'fallback';
  const sent: Sent[] = [];
  const primary = new FakePrimary();
  const router = new RoutingLLM(primary, health, () => settings(endpoint()), key => `key-for-${key}`, { fetcher: sseFetch(sent) });
  const selected = router.select(who);
  assert.ok(selected);
  await drain(selected);
  assert.deepEqual(sent, [{ url: 'https://backup.example.test/v1/chat/completions', auth: 'Bearer key-for-sealed-1', model: 'backup-model' }]);
  assert.equal(primary.calls, 0);
  assert.equal(selected.model, 'backup-model');
});

test('non-zdr needs opt-in', () => {
  const health = new FakeHealth();
  health.mode = 'fallback';
  const cloud = endpoint({ zdr: false });
  const router = new RoutingLLM(new FakePrimary(), health, () => settings(cloud), key => key, { consent: { user: () => false, server: () => true } });
  assert.equal(router.select(who), undefined);
  assert.equal(router.select({ ...who, private: true }), undefined);
  assert.equal(router.select(undefined), undefined);
});

test('non-zdr in shared channel needs server allow', () => {
  const health = new FakeHealth();
  health.mode = 'fallback';
  const cloud = endpoint({ zdr: false });
  const denied = new RoutingLLM(new FakePrimary(), health, () => settings(cloud), key => key, { consent: { user: () => true, server: () => false } });
  assert.equal(denied.select(who), undefined);
  const allowed = new RoutingLLM(new FakePrimary(), health, () => settings(cloud), key => key, { consent: { user: () => true, server: s => s === 's1' } });
  assert.ok(allowed.select(who));
});

test('non-zdr in private chat with opt-in', () => {
  const health = new FakeHealth();
  health.mode = 'fallback';
  const router = new RoutingLLM(new FakePrimary(), health, () => settings(endpoint({ zdr: false })), key => key, { consent: { user: () => true, server: () => false } });
  assert.ok(router.select({ ...who, private: true }));
});

test('outage error feeds breaker', async () => {
  const health = new FakeHealth();
  const network = new RequestError('PROVIDER_NETWORK', 'down', 'retry');
  const overloaded = new ProviderError(503, undefined, 'overloaded');
  for (const error of [network, overloaded]) {
    const router = new RoutingLLM(new FakePrimary(error), health, () => settings(endpoint()), key => key);
    await assert.rejects(drain(router.select(who)!), error);
  }
  assert.deepEqual(health.failures, ['PROVIDER_NETWORK', 'PROVIDER_HTTP_503']);
  assert.equal(outageCode(new ProviderError(504, undefined, 'x')), 'PROVIDER_HTTP_504');
});

test('400 does not feed breaker', async () => {
  const health = new FakeHealth();
  const bad = new ProviderError(400);
  const filtered = new RequestError('PROVIDER_CONTENT_FILTERED', 'filtered', 'review');
  for (const error of [bad, filtered]) {
    const router = new RoutingLLM(new FakePrimary(error), health, () => settings(endpoint()), key => key);
    await assert.rejects(drain(router.select(who)!), error);
  }
  assert.deepEqual(health.failures, []);
});

test('primary success recorded, fallback not', async () => {
  const health = new FakeHealth();
  const router = new RoutingLLM(new FakePrimary(), health, () => settings(endpoint()), key => key, { fetcher: sseFetch([]) });
  await drain(router.select(who)!);
  assert.equal(health.successes, 1);
  health.mode = 'fallback';
  await drain(router.select(who)!);
  assert.equal(health.successes, 1);
});

test('fallback rebuilt on settings change', async () => {
  const health = new FakeHealth();
  health.mode = 'fallback';
  const sent: Sent[] = [];
  let current = settings(endpoint());
  const router = new RoutingLLM(new FakePrimary(), health, () => current, key => `key-for-${key}`, { fetcher: sseFetch(sent) });
  const first = router.select(who)!;
  assert.equal(router.select(who), first);
  current = settings(endpoint({ model: 'backup-two', keySealed: 'sealed-2' }));
  const second = router.select(who)!;
  assert.notEqual(second, first);
  await drain(second);
  assert.deepEqual(sent, [{ url: 'https://backup.example.test/v1/chat/completions', auth: 'Bearer key-for-sealed-2', model: 'backup-two' }]);
});

test('modelsInUse includes fallback', () => {
  const config = { model: 'nimbus', jevModel: 'vane', embeddingModel: 'embed', baseUrl: 'https://gateway.example.test/v1' };
  assert.deepEqual(modelsInUse(config), modelsInUse(config, undefined));
  assert.ok(modelsInUse(config, 'backup-model').includes('backup-model'));
  assert.equal(modelsInUse(config, 'nimbus').filter(id => id === 'nimbus').length, 1);
});
