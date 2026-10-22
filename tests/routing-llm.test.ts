import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { DynamicLLM, RoutingLLM } from '../src/adapters/routing-llm.js';
import { BreakerHealth } from '../src/llm-health.js';
import { openFallbackKey } from '../src/llm-settings.js';
import { WebKeySecrets } from '../src/web-keys.js';
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
  trialDue(): boolean { return false; }
  claimTrial(): boolean { return false; }
  endTrial(): void { /* no trials in this fake */ }
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

const openKey = (endpoint: FallbackEndpoint) => endpoint.keySealed === undefined ? undefined : `key-for-${endpoint.keySealed}`;

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
  const router = new RoutingLLM(primary, new FakeHealth(), () => settings(endpoint()), openKey);
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
  const router = new RoutingLLM(new FakePrimary(), health, () => settings(endpoint()), openKey);
  assert.equal(router.select(who), undefined);
  assert.equal(router.select(undefined), undefined);
});

test('fallback zdr used', async () => {
  const health = new FakeHealth();
  health.mode = 'fallback';
  const sent: Sent[] = [];
  const primary = new FakePrimary();
  const router = new RoutingLLM(primary, health, () => settings(endpoint()), openKey, { fetcher: sseFetch(sent) });
  const selected = router.select(who);
  assert.ok(selected);
  await drain(selected);
  assert.deepEqual(sent, [{ url: 'https://backup.example.test/v1/chat/completions', auth: 'Bearer key-for-sealed-1', model: 'backup-model' }]);
  assert.equal(primary.calls, 0);
  assert.equal(selected.model, 'backup-model');
});

test('non-zdr fallback needs user opt-in in private chat and server allow in shared channels', () => {
  const health = new FakeHealth();
  health.mode = 'fallback';
  const cloud = endpoint({ zdr: false });
  const cases: [string, { user: boolean; server: boolean }, { user: string; server: string; private: boolean } | undefined, boolean][] = [
    ['no user opt-in, shared', { user: false, server: true }, who, false],
    ['no user opt-in, private', { user: false, server: true }, { ...who, private: true }, false],
    ['no requester', { user: false, server: true }, undefined, false],
    ['shared channel without server allow', { user: true, server: false }, who, false],
    ['shared channel with server allow', { user: true, server: true }, who, true],
    ['private chat with opt-in', { user: true, server: false }, { ...who, private: true }, true],
  ];
  for (const [name, consent, requester, allowed] of cases) {
    const router = new RoutingLLM(new FakePrimary(), health, () => settings(cloud), openKey, { consent: { user: () => consent.user, server: () => consent.server } });
    assert.equal(router.select(requester) !== undefined, allowed, name);
  }
});

test('only outage errors feed the breaker', async () => {
  const cases: [string, unknown, string[]][] = [
    ['network', new RequestError('PROVIDER_NETWORK', 'down', 'retry'), ['PROVIDER_NETWORK']],
    ['overloaded', new ProviderError(503, undefined, 'overloaded'), ['PROVIDER_HTTP_503']],
    ['bad request', new ProviderError(400), []],
    ['content filter', new RequestError('PROVIDER_CONTENT_FILTERED', 'filtered', 'review'), []],
  ];
  for (const [name, error, expected] of cases) {
    const health = new FakeHealth();
    const router = new RoutingLLM(new FakePrimary(error), health, () => settings(endpoint()), openKey);
    await assert.rejects(drain(router.select(who)!), error as Error);
    assert.deepEqual(health.failures, expected, name);
  }
});

test('same-gateway fallback reuses primary key', async () => {
  const primaryGateway = { baseUrl: 'https://gateway.example.test/v1', apiKey: 'primary-key' };
  const secrets = new WebKeySecrets('');
  const health = new FakeHealth();
  health.mode = 'fallback';
  const sent: Sent[] = [];
  const same: FallbackEndpoint = { baseUrl: 'https://gateway.example.test/v1/', model: 'backup-model', zdr: true, contextTokens: 8192, outputTokens: 1024 };
  const sameKey = (endpointValue: FallbackEndpoint) => openFallbackKey(settings(endpointValue), secrets, primaryGateway);
  await drain(new RoutingLLM(new FakePrimary(), health, () => settings(same), sameKey, { fetcher: sseFetch(sent) }).select(who)!);
  const other: FallbackEndpoint = { ...same, baseUrl: 'https://backup.example.test/v1' };
  await drain(new RoutingLLM(new FakePrimary(), health, () => settings(other), sameKey, { fetcher: sseFetch(sent) }).select(who)!);
  assert.deepEqual(sent.map(call => call.auth), ['Bearer primary-key', '']);
});

// A real breaker with a clock, so the trial tests run the whole path.
function trialRig(t: TestContext, fallback?: FallbackEndpoint) {
  t.mock.method(console, 'log', () => {});
  let clock = 1_000_000;
  const cfg = { settings: settings(fallback) };
  const health = new BreakerHealth(() => cfg.settings, () => clock);
  return {
    cfg,
    health,
    advance: (seconds: number) => { clock += seconds * 1000; },
    open: () => { for (let index = 0; index < 5; index++) health.recordFailure('PROVIDER_HTTP_503'); },
  };
}

test('trial outage falls back in same request', async t => {
  const r = trialRig(t, endpoint());
  r.open();
  r.advance(600);
  const sent: Sent[] = [];
  const primary = new FakePrimary(new ProviderError(503, undefined, 'overloaded'));
  const dynamic = new DynamicLLM(new RoutingLLM(primary, r.health, () => r.cfg.settings, openKey, { fetcher: sseFetch(sent) }), primary, r.health);
  const texts = (await drain(dynamic)).flatMap(event => event.kind === 'text' ? [event.payload.text] : []);
  assert.deepEqual(texts, ['backup']);
  assert.equal(primary.calls, 1);
  assert.equal(sent.length, 1);
  assert.equal(r.health.state().mode, 'fallback');
  assert.equal(r.health.state().lastError, 'PROVIDER_HTTP_503');
});

test('trial counted once', async t => {
  const r = trialRig(t);
  r.open();
  r.advance(600);
  const recorded: string[] = [];
  const original = r.health.recordFailure.bind(r.health);
  r.health.recordFailure = code => { recorded.push(code); original(code); };
  const primary = new FakePrimary(new ProviderError(503, undefined, 'overloaded'));
  const dynamic = new DynamicLLM(new RoutingLLM(primary, r.health, () => r.cfg.settings, openKey), primary, r.health);
  await assert.rejects(drain(dynamic));
  assert.deepEqual(recorded, [], 'the trial reports only through endTrial');
  // One doubling only: 600 s to the first retry, then 1200 s after the failed trial.
  r.advance(1199);
  assert.equal(r.health.trialDue(), false);
  r.advance(1);
  assert.equal(r.health.trialDue(), true);
});
