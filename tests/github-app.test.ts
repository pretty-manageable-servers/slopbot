import assert from 'node:assert/strict';
import { generateKeyPairSync, verify } from 'node:crypto';
import { test } from 'node:test';
import { HttpOperationsClient } from '../src/adapters/operations-client.js';
import { loadOperationsConfig } from '../src/operations-config.js';
import { redactErrorText, ToolError } from '../src/errors.js';
import { diagnosticText, safeDiagnosticData } from '../src/operations.js';

const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const privateKey = keys.privateKey.export({ type: 'pkcs1', format: 'pem' }).toString();
const app = { id: '123', installationId: '456', privateKey };
const config = { servers: ['12345678901234567'], repository: 'o/r', containers: ['slopbot'], githubApp: app };
const environment = { SLOPBOT_OPERATIONS_GUILD_IDS: config.servers[0], SLOPBOT_GITHUB_APP_ID: app.id,
  SLOPBOT_GITHUB_APP_INSTALLATION_ID: app.installationId, SLOPBOT_GITHUB_APP_PRIVATE_KEY: privateKey };

test('App config validates complete, exclusive credentials and RSA keys without exposing secrets', () => {
  assert.equal(loadOperationsConfig(environment)?.githubApp?.privateKey, privateKey.trim());
  assert.equal(loadOperationsConfig({ ...environment, SLOPBOT_GITHUB_APP_PRIVATE_KEY: privateKey.replace(/\n/g, '\\n') })?.githubApp?.privateKey, privateKey.trim());
  assert.throws(() => loadOperationsConfig({ SLOPBOT_GITHUB_APP_ID: '123' }), /together/);
  assert.deepEqual(loadOperationsConfig({ ...environment, SLOPBOT_OPERATIONS_GUILD_IDS: '' })?.servers, []);
  assert.throws(() => loadOperationsConfig({ ...environment, SLOPBOT_GITHUB_TOKEN: 'secret' }), /not both/);
  assert.throws(() => loadOperationsConfig({ ...environment, SLOPBOT_GITHUB_APP_INSTALLATION_ID: '../456' }), /numeric/);
  assert.throws(() => loadOperationsConfig({ ...environment, SLOPBOT_GITHUB_APP_PRIVATE_KEY: 'bad secret' }), /RSA private key/);
  assert.equal(redactErrorText(privateKey), '[redacted] ');
  assert.equal(diagnosticText(privateKey).trim(), '[redacted]');
  assert.equal(redactErrorText('ghs_123_abcdefghijklm.payload.signature'), '[redacted]');
  assert.deepEqual(safeDiagnosticData({ privateKey, private_key: privateKey }), { privateKey: '[redacted]', private_key: '[redacted]' });
});

test('App JWT is signed correctly; concurrent reads share tokens and expiry refreshes before writes', async () => {
  let now = Date.parse('2026-10-14T12:00:00Z'), mints = 0;
  const client = new HttpOperationsClient(config, async (input, init) => {
    const authorization = new Headers(init?.headers).get('Authorization')!;
    if (String(input).includes('/access_tokens')) {
      mints++;
      assert.equal(String(input), 'https://api.github.com/app/installations/456/access_tokens');
      assert.equal(init?.redirect, 'manual');
      const [header, payload, signature] = authorization.slice(7).split('.');
      assert.equal(JSON.parse(Buffer.from(header!, 'base64url').toString()).alg, 'RS256');
      const claims = JSON.parse(Buffer.from(payload!, 'base64url').toString());
      assert.equal(claims.iss, app.id); assert.equal(claims.iat, now / 1000 - 60); assert.equal(claims.exp, now / 1000 + 540);
      assert.ok(verify('RSA-SHA256', Buffer.from(`${header}.${payload}`), keys.publicKey, Buffer.from(signature!, 'base64url')));
      assert.deepEqual(JSON.parse(String(init?.body)), { repositories: ['r'], permissions: { contents: 'read', actions: 'read', pull_requests: 'read', issues: 'write' } });
      return Response.json({ token: `installation-${mints}`, expires_at: new Date(now + 3600000).toISOString() });
    }
    assert.equal(authorization, `Bearer installation-${mints}`);
    return Response.json({ number: 1, html_url: 'https://github.com/o/r/issues/1' });
  }, () => now);
  await Promise.all([client.issue(1), client.comments(1)]); assert.equal(mints, 1);
  now += 3539000; await client.issue(1); assert.equal(mints, 1);
  now += 1000; await client.createIssue('title', 'body'); assert.equal(mints, 2);
  await client.comment(1, 'body'); assert.equal(mints, 2);
});

test('401 refreshes once; server/network write failures never retry repository writes', async () => {
  for (const status of [401, 503, 0]) {
    let mints = 0, writes = 0;
    const client = new HttpOperationsClient(config, async input => {
      if (String(input).includes('/access_tokens')) {
        mints++; return Response.json({ token: `token-${mints}`, expires_at: new Date(Date.now() + 3600000).toISOString() });
      }
      writes++;
      if (!status) throw new Error('lost connection');
      return new Response(null, { status });
    });
    await assert.rejects(client.createIssue('title', 'body'));
    assert.equal(writes, status === 401 ? 2 : 1); assert.equal(mints, status === 401 ? 2 : 1);
  }
});

test('authentication failure is final before publication, conceals response bodies and can recover', async () => {
  let broken = true, writes = 0;
  const client = new HttpOperationsClient(config, async input => {
    if (String(input).includes('/access_tokens')) {
      if (broken) return new Response('sensitive response', { status: 403 });
      return Response.json({ token: 'working', expires_at: new Date(Date.now() + 3600000).toISOString() });
    }
    writes++; return Response.json({ number: 1 });
  });
  await assert.rejects(client.createIssue('title', 'body'), error => error instanceof ToolError && !error.message.includes('sensitive'));
  assert.equal(writes, 0);
  broken = false; await client.createIssue('title', 'body'); assert.equal(writes, 1);
});
