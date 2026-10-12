import { test } from 'node:test';
import assert from 'node:assert/strict';
import { describeError, errorContext, errorReply, errorSummary, logError, ProviderError, RequestError, ToolError, UncertainActionError, providerError } from '../src/errors.js';

test('diagnostics retain the stage, code, cause chain and frames without credentials', t => {
  const secret = 'private-test-api-token-987654';
  const before = process.env.TEST_API_KEY;
  process.env.TEST_API_KEY = secret;
  t.after(() => { if (before === undefined) delete process.env.TEST_API_KEY; else process.env.TEST_API_KEY = before; });
  const cause = Object.assign(new Error(`connect failed at postgres://user:db-password@db.local/app?token=query-secret Authorization: Bearer header-secret ${secret}`), { code: 'ECONNREFUSED' });
  const error = errorContext(new ToolError('Sandbox connection failed.', 'failed', { cause }), { stage: 'sandbox connect', jobId: 'job-1', tool: 'sandbox' });
  const info = describeError(error);
  assert.equal(info.code, 'TOOL_FAILED');
  assert.equal(info.context.stage, 'sandbox connect');
  assert.match(info.causes[0]!, /ECONNREFUSED/);
  const output: string[] = []; t.mock.method(console, 'error', (line: string) => output.push(line));
  logError('tool_failed', error);
  for (const text of [JSON.stringify(info), errorReply(error, 'job-1'), output[0]!]) {
    for (const value of [secret, 'db-password', 'query-secret', 'header-secret']) assert.ok(!text.includes(value), value);
  }
  assert.match(errorReply(error, 'job-1'), /Job ID: job-1/);
  assert.ok(JSON.parse(output[0]!).frames.length > 0);
});

test('causes are bounded and uncertainty survives added diagnostic context', () => {
  const error = new UncertainActionError('The write may have happened.');
  Object.assign(error, { cause: error });
  assert.equal(errorContext(error, { stage: 'tool execution' }), error);
  assert.ok(errorContext(error, { stage: 'request execution' }) instanceof UncertainActionError);
  assert.equal(describeError(error).context.stage, 'tool execution');
  assert.equal(describeError(error).code, 'ACTION_UNCERTAIN');
  assert.match(errorReply(error), /may already have happened/);
  assert.ok(errorSummary(new Error('x'.repeat(3000))).length <= 1000);
});

test('provider and limit errors give specific recovery instructions', () => {
  assert.match(errorReply(new ProviderError(429)), /PROVIDER.*429/);
  assert.match(errorReply(new ProviderError(429)), /rate limit/);
  const error = new RequestError('TOOL_ROUND_LIMIT', 'Reached 64 rounds; progress retained.', 'Retry to resume with a fresh allowance.', { limit: 64 });
  assert.equal(describeError(error).details?.limit, 64);
  assert.match(errorReply(error), /fresh allowance/);
});


test('structured provider errors retain the code and sanitized cause but ignore raw error bodies', async () => {
  const error = await providerError(Response.json({error:{code:'invalid_request',message:'Missing query. Authorization: Bearer top-secret-credential'}},{status:400}));
  assert.equal(describeError(error).code,'PROVIDER_INVALID_REQUEST');
  assert.equal(describeError(error).httpStatus,400);
  assert.match(errorReply(error),/Missing query/); assert.ok(!errorReply(error).includes('top-secret-credential'));
  const plain = await providerError(new Response('private upstream body',{status:502}));
  assert.ok(!errorReply(plain).includes('private upstream body'));
});
