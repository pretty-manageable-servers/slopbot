import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const environment = 'slopbot-changelog';
const guild = '1528063444874432734';
const channel = '1559233255763353600';
const shaPattern = /^[a-f0-9]{40}$/;

export function announcementDecision(records, sha) {
  const attempts = records.filter(record => record.sha === sha);
  if (attempts.some(record => record.state === 'success')) return 'skip';
  if (attempts.some(record => record.state !== 'failure')) return 'uncertain';
  return 'send';
}

export function announcementPayload({ repository, sha, baseline, notes, runUrl }) {
  const changes = notes.trim() || 'Deployment completed. No release notes were supplied.';
  const fullChanges = baseline ? `https://github.com/${repository}/compare/${baseline}...${sha}` : `https://github.com/${repository}/commit/${sha}`;
  const heading = `Slopbot deployed · ${sha.slice(0, 7)}`;
  const description = changes.length > 3800 ? `${changes.slice(0, 3750)}\n\nMore changes in the link below.` : changes;
  return {
    username: 'Slopbot Updates',
    allowed_mentions: { parse: [] },
    embeds: [{ title: heading, description, color: 0x57f287, url: fullChanges,
      fields: [{ name: 'Full changes', value: `[View changes](${fullChanges})`, inline: true },
        { name: 'Deployment', value: `[Workflow](${runUrl})`, inline: true }] }],
  };
}

export async function postChangelog(config, dependencies = {}) {
  const fetcher = dependencies.fetcher ?? fetch;
  const log = dependencies.log ?? console.log;
  const { repository, sha, token, webhook, runUrl, initialBase } = config;
  if (!/^[\w.-]+\/[\w.-]+$/.test(repository) || !shaPattern.test(sha) || (initialBase && !shaPattern.test(initialBase))) throw new Error('[CHANGELOG_CONFIG] Invalid repository or commit SHA');
  if (!token || !webhook) throw new Error('[CHANGELOG_CONFIG] Missing GitHub token or SLOPBOT_CHANGELOG_WEBHOOK_URL');
  const webhookUrl = new URL(webhook);
  if (webhookUrl.protocol !== 'https:' || webhookUrl.hostname !== 'discord.com' || !/^\/api\/webhooks\/\d+\/[\w-]+$/.test(webhookUrl.pathname) || webhookUrl.search || webhookUrl.hash || webhookUrl.username || webhookUrl.password) throw new Error('[CHANGELOG_CONFIG] Invalid Discord webhook URL');
  const request = async (url, init, stage) => {
    try { return await fetcher(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(30000) }); }
    catch { throw new Error(`[CHANGELOG_NETWORK] ${stage} failed or timed out. Credentials and response bodies are omitted.`); }
  };
  const api = async (path, body) => {
    const response = await request(`https://api.github.com/repos/${repository}/${path}`, {
      method: body ? 'POST' : 'GET',
      headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'content-type': 'application/json', 'x-github-api-version': '2022-11-28' },
      ...(body ? { body: JSON.stringify(body) } : {}),
    }, 'GitHub delivery journal');
    if (!response.ok) throw new Error(`[CHANGELOG_GITHUB] Delivery journal returned HTTP ${response.status}`);
    try { return await response.json(); } catch { throw new Error('[CHANGELOG_GITHUB] Delivery journal returned invalid JSON'); }
  };
  const metadata = await request(webhookUrl, {}, 'Discord destination validation');
  if (!metadata.ok) throw new Error(`[CHANGELOG_DESTINATION] Discord returned HTTP ${metadata.status}`);
  let destination;
  try { destination = await metadata.json(); } catch { throw new Error('[CHANGELOG_DESTINATION] Invalid webhook metadata'); }
  if (destination.guild_id !== guild || destination.channel_id !== channel) throw new Error('[CHANGELOG_DESTINATION] Webhook must target the fixed Slopbot changelog channel and server');

  const statuses = async deployment => {
    const result = await api(`deployments/${deployment.id}/statuses?per_page=1`);
    return { ...deployment, state: result[0]?.state ?? 'pending' };
  };
  const matching = [];
  for (let page = 1; ; page++) {
    const entries = await api(`deployments?environment=${environment}&sha=${sha}&per_page=100&page=${page}`);
    matching.push(...entries);
    if (entries.length < 100) break;
  }
  const records = await Promise.all(matching.map(statuses));
  const decision = announcementDecision(records, sha);
  if (decision === 'skip') { log('[CHANGELOG_ALREADY_POSTED] This version already has a confirmed announcement'); return; }
  if (decision === 'uncertain') throw new Error('[CHANGELOG_DELIVERY_UNCERTAIN] A previous attempt reserved this version without a confirmed result. Inspect the channel and GitHub deployment record before marking that attempt success or failure. Automatic reposting is blocked.');

  let baseline = initialBase;
  for (let page = 1; ; page++) {
    const deployments = await api(`deployments?environment=${environment}&per_page=100&page=${page}`);
    let found = false;
    for (const deployment of deployments) {
      const record = await statuses(deployment);
      if (record.state === 'success') { baseline = record.sha; found = true; break; }
    }
    if (found || deployments.length < 100) break;
  }
  const notes = await (dependencies.releaseNotes ?? releaseNotes)(baseline, sha);
  const payload = announcementPayload({ repository, sha, baseline, notes, runUrl });
  // Reserve before sending. If confirmation is lost, a retry must reconcile first.
  const record = await api('deployments', { ref: sha, environment, task: 'deploy:changelog', auto_merge: false, required_contexts: [], production_environment: false, payload: { baseline, run_url: runUrl }, description: 'Changelog delivery reservation' });
  if (!Number.isSafeInteger(record.id) || record.id < 1) throw new Error('[CHANGELOG_GITHUB] Invalid reservation response; no Discord write attempted');
  const status = (state, description, environmentUrl) => api(`deployments/${record.id}/statuses`, { state, description, log_url: runUrl, auto_inactive: false, ...(environmentUrl ? { environment_url: environmentUrl } : {}) });
  const sendUrl = new URL(webhookUrl); sendUrl.searchParams.set('wait', 'true');
  let response;
  try {
    response = await request(sendUrl, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(payload) }, 'Discord changelog delivery');
  } catch {
    throw new Error(`[CHANGELOG_DELIVERY_UNCERTAIN] Discord send failed or timed out; delivery record ${record.id} remains reserved. Inspect the channel before retrying. The application deployment succeeded.`);
  }
  if (!response.ok) {
    // A server error can follow a completed write; do not automatically resend it.
    if (response.status >= 500) throw new Error(`[CHANGELOG_DELIVERY_UNCERTAIN] Discord returned HTTP ${response.status}; record ${record.id} remains reserved. Inspect the channel before retrying.`);
    await status('failure', `Discord rejected delivery with HTTP ${response.status}`);
    throw new Error(`[CHANGELOG_REJECTED] Discord returned HTTP ${response.status}. No announcement was confirmed; the application deployment succeeded.`);
  }
  let message;
  try { message = await response.json(); } catch { throw new Error(`[CHANGELOG_DELIVERY_UNCERTAIN] Discord confirmation was unreadable; record ${record.id} remains reserved. Inspect the channel before retrying.`); }
  if (!/^\d{17,20}$/.test(message.id) || message.channel_id !== channel) throw new Error(`[CHANGELOG_DELIVERY_UNCERTAIN] Discord confirmation did not match the target; record ${record.id} remains reserved.`);
  const messageUrl = `https://discord.com/channels/${guild}/${channel}/${message.id}`;
  await status('success', 'Changelog posted and confirmed', messageUrl);
  log(`[CHANGELOG_POSTED] ${messageUrl}`);
}

export function releaseNotes(baseline, sha) {
  const git = args => execFileSync('git', args, { encoding: 'utf8', maxBuffer: 2_000_000 });
  const range = baseline ? `${baseline}..${sha}` : sha;
  const names = git(['diff', '--name-only', '--diff-filter=AM', baseline ?? `${sha}^`, sha, '--', 'changelog/*.md']).trim().split('\n').filter(Boolean).sort();
  const notes = names.map(name => {
    if (!/^changelog\/[a-zA-Z0-9_.-]+\.md$/.test(name)) throw new Error('[CHANGELOG_NOTES] Invalid release-note path');
    return git(['show', `${sha}:${name}`]).trim();
  });
  return notes.length ? notes.join('\n\n') : git(['log', '--format=- %s', baseline ? range : '-1', ...(baseline ? [] : [sha])]).trim();
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await postChangelog({ repository: process.env.GITHUB_REPOSITORY, sha: process.env.GITHUB_SHA,
      token: process.env.GITHUB_TOKEN, webhook: process.env.SLOPBOT_CHANGELOG_WEBHOOK_URL,
      runUrl: `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
      initialBase: process.env.CHANGELOG_INITIAL_BASE });
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
