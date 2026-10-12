import assert from 'node:assert/strict';
import { test } from 'node:test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { announcementDecision, announcementPayload, postChangelog, releaseNotes } from './changelog.mjs';

const sha = 'a'.repeat(40), base = 'b'.repeat(40);
const config = { repository: 'owner/slopbot', sha, token: 'test-github-token', webhook: 'https://discord.com/api/webhooks/1559239423219077190/test-only', runUrl: 'https://github.com/owner/slopbot/actions/runs/1', initialBase: base };
const destination = { guild_id: '1528063444874432734', channel_id: '1559233255763353600' };
function fixture({ existing, channel, send = 'success', reservationFails = false } = {}) {
  const requests = [], statuses = [];
  return { requests, statuses, dependencies: { log: () => {}, releaseNotes: () => '- A user-visible improvement.', fetcher: async (url, init) => {
    const address = String(url); requests.push({ address, init });
    assert.equal(init.redirect, 'error');
    if (address.startsWith('https://discord.com/')) {
      assert.ok(!new Headers(init.headers).has('authorization'));
      if (init.method !== 'POST') return Response.json({ ...destination, ...(channel ? { channel_id: channel } : {}) });
      assert.equal(new URL(address).searchParams.get('wait'), 'true');
      if (send === 'timeout') throw new Error('network error with secret URL');
      if (send === 'rejected') return new Response('', { status: 403 });
      if (send === 'server-error') return new Response('', { status: 503 });
      if (send === 'bad-confirmation') return Response.json({ id: '1559235555666677777', channel_id: '999' });
      return Response.json({ id: '1559235555666677777', channel_id: destination.channel_id });
    }
    assert.equal(new Headers(init.headers).get('authorization'), `Bearer ${config.token}`);
    if (address.endsWith('/deployments') && init.method === 'POST') {
      if (reservationFails) return new Response('', { status: 403 });
      return Response.json({ id: 10 });
    }
    if (address.includes('/statuses') && init.method === 'POST') { statuses.push(JSON.parse(init.body)); return Response.json({}); }
    if (address.includes('/statuses')) return Response.json([{ state: existing }]);
    if (address.includes(`sha=${sha}`)) return Response.json(existing ? [{ id: 9, sha }] : []);
    return Response.json([]);
  } } };
}

test('announcements are confined to the fixed channel and confirmed before recording success', async () => {
  const f = fixture(); await postChangelog(config, f.dependencies);
  assert.equal(f.requests.filter(request => request.address.startsWith('https://discord.com/') && request.init.method === 'POST').length, 1);
  assert.equal(f.statuses[0].state, 'success'); assert.equal(f.statuses[0].auto_inactive, false);
  assert.match(f.statuses[0].environment_url, /discord.com\/channels\/1528063444874432734\/1559233255763353600/);
  const wrong = fixture({ channel: '999' });
  await assert.rejects(postChangelog(config, wrong.dependencies), /CHANGELOG_DESTINATION/);
  assert.ok(!wrong.requests.some(request => request.init.method === 'POST'));
});

test('confirmed versions skip posting and uncertain attempts require reconciliation', async () => {
  for (const state of ['success', 'pending', 'error', 'in_progress']) {
    const f = fixture({ existing: state });
    if (state === 'success') await postChangelog(config, f.dependencies);
    else await assert.rejects(postChangelog(config, f.dependencies), /CHANGELOG_DELIVERY_UNCERTAIN/);
    assert.ok(!f.requests.some(request => request.init.method === 'POST'));
  }
  assert.equal(announcementDecision([{ sha, state: 'failure' }], sha), 'send');
  await postChangelog(config, fixture({ existing: 'failure' }).dependencies);
});

test('uncertain Discord writes remain reserved and never expose webhook credentials', async () => {
  for (const send of ['timeout', 'server-error', 'bad-confirmation']) {
    const f = fixture({ send });
    await assert.rejects(postChangelog(config, f.dependencies), error => {
      assert.match(error.message, /CHANGELOG_DELIVERY_UNCERTAIN/);
      assert.ok(!error.message.includes(config.webhook)); assert.ok(!error.message.includes('test-only'));
      return true;
    });
    assert.equal(f.statuses.length, 0);
  }
});

test('definite rejection can retry, and failure to reserve prevents any Discord write', async () => {
  const rejected = fixture({ send: 'rejected' });
  await assert.rejects(postChangelog(config, rejected.dependencies), /CHANGELOG_REJECTED.*403/);
  assert.equal(rejected.statuses[0].state, 'failure');
  const denied = fixture({ reservationFails: true });
  await assert.rejects(postChangelog(config, denied.dependencies), /CHANGELOG_GITHUB.*403/);
  assert.ok(!denied.requests.some(request => request.address.startsWith('https://discord.com/') && request.init.method === 'POST'));
});

test('release embeds fit Discord limits, disable mentions and include comparison links', () => {
  const payload = announcementPayload({ ...config, baseline: base, notes: '@everyone ' + 'x'.repeat(8000) });
  assert.ok(payload.embeds[0].description.length <= 4096);
  assert.deepEqual(payload.allowed_mentions, { parse: [] });
  assert.match(payload.embeds[0].url, /compare\/b+\.\.\.a+/);
});

test('the last confirmed announcement sets the release-note baseline', async () => {
  const f = fixture(), previous = 'c'.repeat(40), fetcher = f.dependencies.fetcher;
  f.dependencies.fetcher = async (url, init) => {
    const address = String(url);
    if (address.includes('deployments?environment=slopbot-changelog&per_page=')) return Response.json([{ id: 8, sha: previous }]);
    if (address.includes('deployments/8/statuses')) return Response.json([{ state: 'success' }]);
    return fetcher(url, init);
  };
  f.dependencies.releaseNotes = (baseline, version) => {
    assert.equal(baseline, previous); assert.equal(version, sha); return '- Changes after the confirmed version.';
  };
  await postChangelog(config, f.dependencies);
});

test('release notes cover only changes after the last announced version, with commit fallback', () => {
  const directory = mkdtempSync(join(tmpdir(), 'slopbot-changelog-test-'));
  const previous = process.cwd();
  const git = args => execFileSync('git', args, { cwd: directory, encoding: 'utf8' }).trim();
  try {
    git(['init', '-q']); git(['config', 'user.name', 'Test']); git(['config', 'user.email', 'test@example.com']);
    mkdirSync(join(directory, 'changelog')); writeFileSync(join(directory, 'changelog/old.md'), '- Already announced.');
    git(['add', '.']); git(['commit', '-qm', 'Initial']); const initial = git(['rev-parse', 'HEAD']);
    writeFileSync(join(directory, 'changelog/new.md'), '- New improvement.'); git(['add', '.']); git(['commit', '-qm', 'Add improvement']); const next = git(['rev-parse', 'HEAD']);
    process.chdir(directory); assert.equal(releaseNotes(initial, next), '- New improvement.');
    writeFileSync(join(directory, 'code.txt'), 'changed'); git(['add', '.']); git(['commit', '-qm', 'Fix user-visible behavior']);
    assert.equal(releaseNotes(next, git(['rev-parse', 'HEAD'])), '- Fix user-visible behavior');
  } finally { process.chdir(previous); rmSync(directory, { recursive: true, force: true }); }
});
