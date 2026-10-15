import test from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_BREAKER, isOutageError } from '../src/llm-mode.js';

test('outage codes', () => {
  for (const code of ['PROVIDER_NETWORK', 'PROVIDER_HTTP_502', 'PROVIDER_HTTP_503', 'PROVIDER_HTTP_504', 'PROVIDER_MODEL_NOT_FOUND', 'PROVIDER_STREAM_ERROR', 'PROVIDER_STREAM_INTERRUPTED', 'REQUEST_TIMEOUT']) assert.equal(isOutageError(code), true, code);
});

test('non-outage codes', () => {
  for (const code of ['PROVIDER_HTTP_400', 'PROVIDER_HTTP_401', 'PROVIDER_HTTP_402', 'PROVIDER_HTTP_403', 'PROVIDER_HTTP_413', 'PROVIDER_HTTP_429', 'PROVIDER_CONTENT_FILTERED', 'PROVIDER_TOOL_PROTOCOL', 'LLM_OFFLINE', 'PROVIDER_HTTP_500', 'PROVIDER_HTTP_404', 'REQUEST_ABORTED', 'PROVIDER_STREAM_ERRORFUL']) assert.equal(isOutageError(code), false, code);
});

test('breaker defaults', () => {
  assert.deepEqual(DEFAULT_BREAKER, { failures: 5, windowSeconds: 60, probeSeconds: 30, recoverProbes: 2 });
});
