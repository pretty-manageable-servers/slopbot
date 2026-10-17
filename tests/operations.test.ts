import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import type { OperationsClient, Issue, Container, PullRequest } from '../src/adapters/operations-client.js';
import { HttpOperationsClient, boundedBody } from '../src/adapters/operations-client.js';
import { registerOperationsTools, safeDiagnosticData, type FixWatch } from '../src/operations.js';
import { ToolRegistry } from '../src/tools.js';
import type { Message, Json } from '../src/domain.js';
import { loadOperationsConfig } from '../src/operations-config.js';
import { runToolsCodeTool } from '../src/run-tools-code.js';
import type { ButtonInteraction } from 'discord.js';
import { handleConfirm, saveConfirmation, CONFIRM_RECORD } from '../src/adapters/discord-code.js';

const sha = 'a'.repeat(40), oldSha = 'b'.repeat(40);
const report: Message = { server: 's', channel: 'task', id: 'report', author: 'admin', text: 'Investigate and file an issue' };
const request: Message = { ...report, channel: 'source', id: 'request', text: 'private conversation text', timestamp: Date.now() };
const output: Message = { ...request, id: '20000000000000001', isBot: true, text: 'private answer' };
const issue = (number: number, title = 'Attachment decoding fails', body = ''): Issue => ({ number, title, body, state: 'open', html_url: `https://github.com/o/r/issues/${number}` });
class FakeClient implements OperationsClient {
  repository = 'o/r';
  issues: Issue[] = []; notes: Issue[] = []; creates = 0; commentsWritten = 0; edits = 0; loseWrite = false;
  image = `ghcr.io/o/r:${sha}`; issueState = 'open';
  pullValue: PullRequest = { number: 2, title: 'Fix', state: 'closed', merged: true, merge_commit_sha: sha, html_url: 'https://github.com/o/r/pull/2', head: { sha } };
  async searchIssues() { return { items: this.issues, total: this.issues.length }; }
  async issue(number: number) { return { ...(this.issues.find(value => value.number === number) ?? issue(number)), state: this.issueState }; }
  async updateIssue(number: number, body: string) {
    this.edits++;
    const value = this.issues.find(value => value.number === number)!; value.body = body;
    if (this.loseWrite) { this.loseWrite = false; throw new Error('connection lost after edit'); }
    return value;
  }
  async comments() { return this.notes; }
  async createIssue(title: string, body: string) {
    this.creates++; const value = issue(this.creates, title, body); this.issues.push(value);
    if (this.loseWrite) { this.loseWrite = false; throw new Error('connection lost after create'); } return value;
  }
  async comment(number: number, body: string) {
    this.commentsWritten++; const value = issue(number, '', body); this.notes.push(value);
    if (this.loseWrite) { this.loseWrite = false; throw new Error('connection lost after comment'); } return value;
  }
  async findIssue(marker: string) { return this.issues.find(i => i.body?.includes(marker)); }
  async findComment(_number: number, marker: string) { return this.notes.find(i => i.body?.includes(marker)); }
  async file() { return 'name: deploy\nsecret=github_pat_abcdefghijklmnop\n'; }
  async runs() { return [{ id: 3, name: 'Deploy', head_sha: sha, status: 'completed', conclusion: 'success', html_url: 'https://github.com/o/r/actions/runs/3', created_at: '2026-10-13T00:00:00Z', updated_at: '2026-10-13T00:00:01Z' }]; }
  async jobs(): Promise<Json> { return { jobs: [{ id: 4, conclusion: 'failure', steps: [{ name: 'Test', conclusion: 'failure' }] }] }; }
  async jobLogs() { return { text: 'setup\nerror: decoding\nsecret=github_pat_abcdefghijklmnop\n', truncated: false }; }
  async pull() { return this.pullValue; }
  async relatedPulls() { return [2]; }
  async containsCommit(base: string, head: string) { return base === head; }
  async containers(): Promise<Container[]> { return [{ id: 'ctr', name: 'slopbot', image: this.image, status: 'running', created_at: '2026-10-01T00:00:00Z', updated_at: '2026-10-13T00:00:00Z' }]; }
  async logs() { return [
    { time: 't', message: JSON.stringify({ type: 'error', context: { server: 'foreign', channel: 'foreign' }, message: 'other server private text' }) },
    { time: 't', message: JSON.stringify({ type: 'error', context: { server: 's', channel: 'hidden' }, message: 'hidden channel' }) },
    { time: 't', message: JSON.stringify({ type: 'error', context: { server: 's', channel: 'source' }, code: 'DECODE_FAILED', message: 'secret=github_pat_abcdefghijklmnop' }) },
  ]; }
  async events() { return []; }
}
async function fixture(t: { after(fn: () => void): void }, servers = ['s']) {
  const store = new SQLiteStore(); t.after(() => store.close());
  const client = new FakeClient(); let admin = true; const denied = new Set<string>(['hidden']);
  const authorize = async (_message: Message, channel: string) => { if (denied.has(channel)) throw new Error('Channel access denied'); };
  const registry = new ToolRegistry(store, async () => admin);
  const ops = registerOperationsTools(registry, { store, client, config: { servers, repository: 'o/r', containers: ['slopbot'] }, authorize }, 's');
  await store.ingest(request); await store.ingest(output);
  await store.startRun('run', request, { prefixVersion: 'v', prefix: [{ role: 'system', content: 'secret system prompt' }], history: [], inputs: [{ role: 'user', content: request.text }] });
  await store.fail('run', 'DECODE_FAILED secret=github_pat_abcdefghijklmnop');
  await store.linkOutput(output, 'run', request.id);
  await store.putRecord('s', 'run_runtime', 'run', { commit: sha, startedAt: Date.parse('2026-10-13T00:01:00Z'), builtAt: null }, 1);
  const invoke = (name: string, args: Record<string, Json>, id: string, message = report) => registry.invokeResult(message, name, args, id, 'command');
  const evidence = async (id = 'inspect') => (await invoke('interaction_inspect', { message_id: output.id }, id)).data as { evidence_id: string };
  return { store, client, registry, ops, denied, invoke, evidence, setAdmin(value: boolean) { admin = value; } };
}
const reportArgs = (id: string) => ({ title: 'Attachment decoding fails', expected: 'Summary of the attachment', actual: 'DECODE_FAILED', steps: 'Reply to the linked attachment', acceptance: 'Attachment summary succeeds', evidence_ids: [id] });

test('the original reporter can remove evidence and replace their report without creating duplicates', async t => {
  const f = await fixture(t); const e = await f.evidence();
  await f.invoke('issue_report', reportArgs(e.evidence_id), 'owned-create'); f.setAdmin(false);
  await assert.rejects(f.invoke('issue_report_edit', { issue_number: 1, action: 'remove_evidence' }, 'foreign-edit', { ...report, author: 'another-user' }), /original reporter/);
  await f.invoke('issue_report_edit', { issue_number: 1, action: 'remove_evidence' }, 'remove-evidence');
  assert.ok(!f.client.issues[0]!.body!.includes('## Collected evidence')); assert.match(f.client.issues[0]!.body!, /Acceptance check/);
  // Source edits invalidate evidence for publication, but cannot prevent its reporter removing a public report's diagnostics.
  await f.store.revise({ ...request, text: 'edited' });
  await f.invoke('issue_report_edit', { issue_number: 1, action: 'replace', body: 'A concise report. secret=github_pat_abcdefghijklmnop' }, 'replace-body');
  assert.match(f.client.issues[0]!.body!, /A concise report/); assert.ok(!f.client.issues[0]!.body!.includes('github_pat_'));
  assert.equal(f.client.creates, 1); assert.equal(f.client.commentsWritten, 0);
});

test('lost issue edits reconcile once and a spoofed public footer cannot establish ownership', async t => {
  const f = await fixture(t); const e = await f.evidence();
  await f.invoke('issue_report', reportArgs(e.evidence_id), 'original-create');
  f.client.issues.push(issue(99, 'Spoof', f.client.issues[0]!.body ?? ''));
  await assert.rejects(f.invoke('issue_report_edit', { issue_number: 99, action: 'remove_evidence' }, 'spoof-edit'), /durable creation record/);
  const args = { issue_number: 1, action: 'replace', body: 'New concise report' };
  f.client.loseWrite = true;
  await assert.rejects(f.invoke('issue_report_edit', args, 'lost-edit'), /uncertain/);
  assert.match((await f.invoke('issue_report_edit', args, 'lost-edit')).text, /Recovered GitHub edit/);
  assert.equal(f.client.edits, 1);
});

test('interaction evidence resolves a reply and retains execution version without prompt/text/arguments', async t => {
  const f = await fixture(t); const result = await f.invoke('interaction_inspect', {}, 'inspect', { ...report, replyTo: output.id });
  assert.match(result.text, /DECODE_FAILED/); assert.match(result.text, new RegExp(sha));
  assert.match(result.text, /prefixVersion/); assert.ok(!result.text.includes('private conversation')); assert.ok(!result.text.includes('secret system prompt'));
  assert.ok(!result.text.includes('github_pat_')); assert.equal(result.sources?.length, 2);
  assert.equal(f.registry.definitions().find(d => d.name === 'interaction_inspect')?.programmatic, undefined);
  f.denied.add('source');
  await assert.rejects(f.invoke('interaction_inspect', {}, 'inspect', { ...report, replyTo: output.id }), /denied/);
});

test('source edits invalidate saved evidence before publication, even on replay', async t => {
  const f = await fixture(t); const e = await f.evidence();
  await f.store.revise({ ...request, text: 'edited input' });
  await assert.rejects(f.invoke('issue_report', reportArgs(e.evidence_id), 'report-one'), /edited, deleted/);
  assert.equal(f.client.creates, 0);
});

test('issue creation reconciles a lost response and exact duplicates become comments', async t => {
  const f = await fixture(t); const e = await f.evidence(); const args = reportArgs(e.evidence_id);
  f.client.loseWrite = true;
  await assert.rejects(f.invoke('issue_report', args, 'create-one'), /uncertain/);
  const recovered = await f.invoke('issue_report', args, 'create-one'); assert.match(recovered.text, /Recovered/); assert.equal(f.client.creates, 1);
  const body = f.client.issues[0]!.body!;
  assert.match(body, /Acceptance check/); assert.match(body, /slopbot-operation:/); assert.ok(!body.includes('github_pat_')); assert.ok(!body.includes('private conversation'));
  assert.match(body, new RegExp(output.id));
  assert.ok(!body.includes(sha)); assert.ok(!body.includes('prefixVersion')); assert.ok(!body.includes('requestId'));
  assert.ok(!body.includes('```json')); assert.ok(Buffer.byteLength(body) <= 8192);
  await f.invoke('issue_report', args, 'duplicate'); assert.equal(f.client.creates, 1); assert.equal(f.client.commentsWritten, 1);
  f.client.loseWrite = true;
  await assert.rejects(f.invoke('issue_report', { ...args, issue_number: 1 }, 'comment-one'), /uncertain/);
  await f.invoke('issue_report', { ...args, issue_number: 1 }, 'comment-one'); assert.equal(f.client.commentsWritten, 2);
});

test('public reports reject oversized multibyte text without publishing a partial report', async t => {
  const f = await fixture(t); const e = await f.evidence();
  await assert.rejects(f.invoke('issue_report', { ...reportArgs(e.evidence_id), expected: '界'.repeat(1800), actual: '界'.repeat(1800) }, 'oversized'), /exceeds 8 KiB/);
  assert.equal(f.client.creates, 0); assert.equal(f.client.commentsWritten, 0);
});

test('unresolved writes stay blocked and do not blindly create another issue', async t => {
  const f = await fixture(t); const e = await f.evidence(); const args = reportArgs(e.evidence_id);
  f.client.createIssue = async () => { f.client.creates++; throw new Error('timeout before outcome known'); };
  await assert.rejects(f.invoke('issue_report', args, 'unknown'), /uncertain/);
  await assert.rejects(f.invoke('issue_report', args, 'unknown'), /uncertain/);
  await assert.rejects(f.invoke('issue_report', args, 'other-operation'), /waits until it is reconciled/);
  assert.equal(f.client.creates, 1);
});

test('member reports preserve guild/task boundaries while infrastructure remains admin-only', async t => {
  const f = await fixture(t); const e = await f.evidence();
  f.setAdmin(false);
  await f.invoke('github_issue_read', { query: 'attachment' }, 'member-search');
  await f.invoke('issue_report', reportArgs(e.evidence_id), 'member-report');
  assert.equal(f.client.creates, 1);
  await assert.rejects(f.invoke('deployment_inspect', {}, 'infra-no-admin'), /Manage Server/);
  await f.invoke('interaction_inspect', { message_id: output.id }, 'member');
  f.setAdmin(true);
  await assert.rejects(f.invoke('issue_report', reportArgs(e.evidence_id), 'foreign-task', { ...report, channel: 'another', author: 'other' }), /another task/);
  await assert.rejects(f.invoke('deployment_inspect', {}, 'foreign-guild', { ...report, server: 'foreign' }), /not enabled/);
  await assert.rejects(f.invoke('pipeline_read', { path: '.env' }, 'env-file'), /Invalid choice for path: ".env"\. Use one of: /);
  assert.equal(f.client.creates, 1);
});

test('PMServers logs exclude other guilds and inaccessible channels, then recheck access on publication', async t => {
  const f = await fixture(t); const logs = await f.invoke('service_inspect', { action: 'logs' }, 'logs');
  assert.match(logs.text, /DECODE_FAILED/); assert.ok(!logs.text.includes('other server private')); assert.ok(!logs.text.includes('hidden channel')); assert.ok(!logs.text.includes('github_pat_'));
  f.denied.add('source');
  await assert.rejects(f.invoke('issue_report', reportArgs((logs.data as { evidence_id: string }).evidence_id), 'publish-logs'), /denied/);
});

test('members cannot publish administrator diagnostic snapshots, including saved reports on replay', async t => {
  const f = await fixture(t);
  const snapshot = await f.invoke('deployment_inspect', {}, 'admin-snapshot');
  const id = (snapshot.data as { evidence_id: string }).evidence_id;
  await f.invoke('issue_report', reportArgs(id), 'admin-report');
  f.setAdmin(false);
  await assert.rejects(f.invoke('issue_report', reportArgs(id), 'member-infra'), /Manage Server/);
  await assert.rejects(f.invoke('issue_report', reportArgs(id), 'admin-report'), /Manage Server/);
  assert.equal(f.client.creates, 1); assert.equal(f.client.commentsWritten, 0);
});

test('behavioral verification requires the deployed fix and an interaction executed after deployment', async t => {
  const f = await fixture(t);
  await f.invoke('fix_watch', { action: 'start', issue_number: 1, pull_number: 2, acceptance: 'Attachment summary succeeds' }, 'watch');
  const sample = await f.evidence();
  const deploy = await f.invoke('deployment_inspect', {}, 'deploy');
  const args = { action: 'verify', issue_number: 1, result: 'passed', observation: 'A fresh attachment returned its summary', evidence_ids: [sample.evidence_id, (deploy.data as { evidence_id: string }).evidence_id] };
  await f.invoke('fix_watch', args, 'verified');
  const saved = (await f.store.record('s', 'fix_watch', JSON.stringify(['task', 1])))!.value as unknown as FixWatch;
  assert.equal(saved.observation?.result, 'passed'); assert.equal(saved.observation?.author, 'admin');
  f.client.image = `ghcr.io/o/r:${oldSha}`;
  const old = await f.invoke('deployment_inspect', {}, 'old-deploy');
  await assert.rejects(f.invoke('fix_watch', { ...args, evidence_ids: [sample.evidence_id, (old.data as { evidence_id: string }).evidence_id] }, 'wrong-image'), /does not establish/);
  await f.store.putRecord('s', 'run_runtime', 'run', { commit: sha, startedAt: 1 }, 2);
  const stale = await f.evidence('stale-sample');
  await assert.rejects(f.invoke('fix_watch', { ...args, evidence_ids: [stale.evidence_id, (deploy.data as { evidence_id: string }).evidence_id] }, 'old-interaction'), /executed on the deployed fix/);
});

test('operator configuration requires explicit server scope and never reuses CI/sandbox tokens', () => {
  assert.equal(loadOperationsConfig({ PMS_TOKEN: 'ci-token', E2B_API_KEY: 'sandbox-token' }), undefined);
  assert.deepEqual(loadOperationsConfig({ SLOPBOT_GITHUB_TOKEN: 'secret' })?.servers, []);
  assert.throws(() => loadOperationsConfig({ SLOPBOT_PMS_TOKEN: 'secret', SLOPBOT_PMS_PROJECT_ID: 'project' }), /GUILD_IDS/);
  assert.throws(() => loadOperationsConfig({ SLOPBOT_OPERATIONS_GUILD_IDS: '12345678901234567', SLOPBOT_PMS_TOKEN: 'secret' }), /PROJECT_ID/);
  assert.throws(() => loadOperationsConfig({ SLOPBOT_OPERATIONS_GUILD_IDS: '12345678901234567', SLOPBOT_GITHUB_REPOSITORY: 'o/..' }), /owner\/repository/);
  assert.equal(loadOperationsConfig({ SLOPBOT_OPERATIONS_GUILD_IDS: '12345678901234567' })?.repository, 'pretty-manageable-servers/slopbot');
  assert.equal((safeDiagnosticData({ token: 'secret', body: 'github_pat_abcdefghijklmnop' }) as Record<string, Json>).token, '[redacted]');
});

test('GitHub log redirects send no credential to signed storage and refuse unrelated hosts', async () => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init });
    return calls.length === 1 ? new Response(null, { status: 302, headers: { location: 'https://logs.blob.core.windows.net/job?sig=secret' } }) : new Response('log text');
  };
  const client = new HttpOperationsClient({ servers: ['s'], repository: 'o/r', githubToken: 'ghp_testcredential1234', containers: ['slopbot'] }, fetcher);
  assert.equal((await client.jobLogs(1)).text, 'log text');
  assert.match(JSON.stringify(calls[0]!.init?.headers), /ghp_test/); assert.equal(calls[1]!.init?.headers, undefined);
  const bad = new HttpOperationsClient({ servers: ['s'], repository: 'o/r', containers: ['slopbot'] }, async () => new Response(null, { status: 302, headers: { location: 'https://attacker.example/log' } }));
  await assert.rejects(bad.jobLogs(1), /unsupported log download host/);
  const limited = await boundedBody(new Response('123456'), 3, true); assert.equal(limited.text, '123'); assert.equal(limited.truncated, true);
});

test('PMServers adapter uses GET only, allowlists resources, omits env values and refuses unauthorized logs', async () => {
  const calls: string[] = [];
  const client = new HttpOperationsClient({ servers: ['s'], repository: 'o/r', pmsToken: 'pms-test', project: 'prj_1', containers: ['slopbot'] }, async (input, init) => {
    assert.ok(!init?.method || init.method === 'GET'); calls.push(String(input));
    if (String(input).endsWith('/containers')) return Response.json({ items: [{ id: 'ctr', name: 'slopbot', image: 'image', status: 'running', env: { PASSWORD: 'do-not-return' } }, { id: 'other', name: 'other', image: 'other' }] });
    if (String(input).endsWith('/events')) return Response.json({ items: [{ id: 'event', resource_id: 'ctr' }, { id: 'foreign', resource_id: 'other' }] });
    return Response.json({ lines: [{ time: 't', message: 'crash' }] });
  });
  assert.ok(!JSON.stringify(await client.containers()).includes('do-not-return'));
  assert.equal((await client.events()).length, 1);
  await client.logs('slopbot', 100, true); assert.match(calls.at(-1)!, /containers\/ctr\/logs\?tail=100&previous=true$/);
  await assert.rejects(client.logs('other', 100, false), /allowlist/);
});

test('GitHub write server failures preserve uncertain outcomes; known permission rejection is final', async () => {
  const config = { servers: ['s'], repository: 'o/r', githubToken: 'secret', containers: ['slopbot'] };
  const uncertain = new HttpOperationsClient(config, async () => new Response('', { status: 503 }));
  await assert.rejects(uncertain.createIssue('title', 'body'), error => error instanceof Error && error.name !== 'ToolError');
  const rejected = new HttpOperationsClient(config, async () => new Response('', { status: 403 }));
  await assert.rejects(rejected.createIssue('title', 'body'), /HTTP 403/);
});

test('issue searches keep state filters and exclude results outside the configured repository', async () => {
  let query = '';
  const client = new HttpOperationsClient({ servers: ['s'], repository: 'o/r', containers: ['slopbot'] }, async input => {
    query = new URL(String(input)).searchParams.get('q')!;
    return Response.json({ total_count: 2, items: [issue(1), { ...issue(2), html_url: 'https://github.com/foreign/r/issues/2' }] });
  });
  const result = await client.searchIssues('is:open repo:foreign/r attachment');
  assert.match(query, /repo:o\/r is:issue/); assert.match(query, /is:open/); assert.ok(!query.includes('repo:foreign'));
  assert.equal(result.items.length, 1);
});

test('issue_report always needs Confirm; reads do not', async t => {
  const f = await fixture(t);
  assert.equal(f.registry.definitions().find(d => d.name === 'issue_report')?.confirm?.({}), true);
  assert.equal(f.registry.definitions().find(d => d.name === 'interaction_inspect')?.confirm, undefined);
});

test('confirmed report carries owner evidence across tasks and remains retryable after an access block', async t => {
  const f = await fixture(t);
  const evidence = await f.evidence();
  f.registry.register(runToolsCodeTool(f.registry, { confirmations: {
    record: async (server, id) => (await f.store.record(server, CONFIRM_RECORD, id))?.value,
    save: (server, id, value) => saveConfirmation(f.store, server, id, value),
  } }));
  const followup = { ...report, channel: 'followup', id: 'originating-report', taskId: 'followup' };
  const queued = await f.registry.invokeResult(followup, 'run_tools_code', { code: `return await tools.issue_report(${JSON.stringify(reportArgs(evidence.evidence_id))})` }, 'queued-report', 'agent');
  const id = (queued.data as { confirmation: { operationId: string } }).confirmation.operationId;
  assert.equal(((await f.store.record('s', CONFIRM_RECORD, id))!.value as { requestId: string }).requestId, followup.id);
  const replies: { content?: string; components?: unknown[] }[] = [];
  const interaction = {
    customId: `slopconfirm:${id}:yes`, guildId: 's', channelId: 'followup', id: 'confirm-click', user: { id: report.author },
    deferUpdate: async () => {}, followUp: async (payload: { content?: string }) => { replies.push(payload); },
    editReply: async (payload: { content?: string; components?: unknown[] }) => { replies.push(payload); },
  } as unknown as ButtonInteraction;
  f.denied.add('task');
  await handleConfirm(interaction, f.store, f.registry);
  assert.equal(f.client.creates, 0);
  const pending = (await f.store.record('s', CONFIRM_RECORD, id))!.value as { done?: boolean };
  assert.equal(pending.done, undefined);
  assert.match(replies.at(-1)!.content!, /still pending/);
  assert.equal(replies.at(-1)!.components, undefined);
  f.denied.delete('task');
  await handleConfirm(interaction, f.store, f.registry);
  assert.equal(f.client.creates, 1);
  assert.match(replies.at(-1)!.content!, /https:\/\/github.com\/o\/r\/issues\/1/);
  await handleConfirm(interaction, f.store, f.registry);
  assert.equal(f.client.creates, 1);
});
