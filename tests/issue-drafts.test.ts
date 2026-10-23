import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import type { OperationsClient, Issue } from '../src/adapters/operations-client.js';
import { DRAFT_TTL_MS, ISSUE_DRAFT_KIND, issueDraftTools, openDraft, saveDraft, type IssueDraft } from '../src/issue-drafts.js';
import { ToolError, ToolRegistry, type ToolContext } from '../src/tools.js';
import { registerOperationsTools } from '../src/operations.js';
import type { Message } from '../src/domain.js';

const now = Date.parse('2026-10-22T12:00:00Z');
const requester: Message = { server: 's', channel: 'c1', id: '30000000000000001', author: 'u1', text: 'Please file a bug about the attachment', timestamp: now };
const source: Message = { server: 's', channel: 'c1', id: '20000000000000002', author: 'u2', text: 'attachment decoding fails for PNG files', timestamp: now - 1000 };
const other: Message = { server: 's', channel: 'c1', id: '20000000000000003', author: 'u3', text: 'it also fails for GIF files', timestamp: now - 500 };
const draftArgs = { title: 'Attachment decoding fails', expected: 'The PNG is summarized', actual: 'The bot reports a decode error', steps: 'Attach a PNG and ask for a summary', acceptance: 'The summary of the PNG succeeds', cites: [source.id, other.id] };

class FakeClient {
  issues: Issue[] = []; comments: { number: number; body: string }[] = []; creates: { title: string; body: string }[] = [];
  async issue(number: number): Promise<Issue> { return { number, title: 'Existing', body: '', state: 'open', html_url: `https://github.com/o/r/issues/${number}` }; }
  async createIssue(title: string, body: string): Promise<Issue> { this.creates.push({ title, body }); return { number: this.creates.length, title, body, state: 'open', html_url: `https://github.com/o/r/issues/${this.creates.length}` }; }
  async comment(number: number, body: string): Promise<Issue> { this.comments.push({ number, body }); return { number, title: 'Existing', body, state: 'open', html_url: `https://github.com/o/r/issues/${number}#c` }; }
  async findIssue() { return undefined; }
  async findComment() { return undefined; }
}

async function fixture(t: { after(fn: () => void): void }) {
  const store = new SQLiteStore(); t.after(() => store.close());
  const client = new FakeClient();
  let admin = false;
  const registry = new ToolRegistry(store, async message => admin || message.author === 'admin');
  for (const tool of issueDraftTools({ store, client: client as unknown as OperationsClient, authorize: async () => {} })) registry.register(tool);
  await store.ingest(source); await store.ingest(other);
  // file_report runs only from a person's command or button, so the fixture calls it as a command.
  const invoke = (name: string, args: Record<string, unknown>, id: string, author = 'u1') => registry.invokeResult({ ...requester, author, id: `chat-${id}` }, name, args, id, name === 'file_report' ? 'command' : 'agent');
  return { store, client, registry, invoke, setAdmin(value: boolean) { admin = value; } };
}

test('draft_rejects_missing_fields_with_list', async t => {
  const f = await fixture(t);
  await assert.rejects(f.invoke('issue_draft', { title: '', expected: 'x', cites: [] }, 'bad-draft'), error => {
    const text = String((error as Error).message);
    assert.match(text, /Issue draft not saved/);
    assert.match(text, /- title is missing/);
    assert.match(text, /- actual is missing/);
    assert.match(text, /- cites needs 1 to 8 items/);
    return true;
  });
  assert.equal((await f.store.records('s', ISSUE_DRAFT_KIND)).length, 0);
});

test('draft_snapshots_cites', async t => {
  const f = await fixture(t);
  const result = await f.invoke('issue_draft', draftArgs, 'draft-one');
  assert.match(result.text, /2 messages, 0 tool runs/);
  assert.ok(!result.text.includes(source.id), 'the model result never shows message IDs');
  const saved = (await f.store.record('s', ISSUE_DRAFT_KIND, 'c1'))!.value as unknown as IssueDraft;
  assert.deepEqual(saved.cites.map(cite => [cite.id, cite.author, cite.text]), [[source.id, 'u2', source.text], [other.id, 'u3', other.text]]);
  await f.store.revise({ ...source, text: 'edited after the draft' });
  const after = (await f.store.record('s', ISSUE_DRAFT_KIND, 'c1'))!.value as unknown as IssueDraft;
  assert.equal(after.cites[0]!.text, source.text, 'the snapshot keeps the text saved with the draft');
  await assert.rejects(f.invoke('issue_draft', { ...draftArgs, cites: ['30000000000000999'] }, 'unknown-cite'), /not available in this chat/);
});

test('new_draft_replaces_old', async t => {
  const f = await fixture(t);
  await f.invoke('issue_draft', draftArgs, 'first');
  await f.invoke('issue_draft', { ...draftArgs, title: 'Second title' }, 'second');
  const records = await f.store.records('s', ISSUE_DRAFT_KIND);
  assert.equal(records.length, 1);
  assert.equal((records[0]!.value as unknown as IssueDraft).title, 'Second title');
});

test('draft_expires_after_7_days', async t => {
  const f = await fixture(t);
  const context = { message: requester, operationId: 'expiry', isAdmin: false } as unknown as ToolContext;
  const draft = await saveDraft(f.store, context, draftArgs, [], now);
  assert.equal(draft.expiresAt - draft.createdAt, DRAFT_TTL_MS);
  assert.ok(await openDraft(f.store, 's', 'c1', now + DRAFT_TTL_MS - 1));
  assert.equal(await openDraft(f.store, 's', 'c1', now + DRAFT_TTL_MS), undefined);
});

test('file_report_requester_or_admin_only', async t => {
  const f = await fixture(t);
  await f.invoke('issue_draft', draftArgs, 'draft-owner');
  await assert.rejects(f.invoke('file_report', {}, 'stranger', 'u9'), /Only the requester of this draft or a bot admin/);
  assert.equal(f.client.creates.length, 0);
  const filed = await f.invoke('file_report', {}, 'requester-files');
  assert.match(filed.text, /Issue created: https:\/\/github\.com\/o\/r\/issues\/1/);
  assert.equal(f.client.creates.length, 1);
});

test('file_report_marks_edited_and_deleted_cites', async t => {
  const f = await fixture(t);
  await f.invoke('issue_draft', draftArgs, 'draft-marks');
  await f.store.revise({ ...source, text: 'attachment decoding fails for PNG and JPEG files' });
  await f.store.remove('s', 'c1', other.id);
  const result = await f.invoke('file_report', {}, 'file-marks');
  assert.match(result.text, /Issue created/);
  const body = f.client.creates[0]!.body;
  assert.match(body, /Message .*20000000000000002.*\(edited since\)/);
  assert.match(body, /Message .*20000000000000003.*\(deleted since\)/);
  assert.match(body, /attachment decoding fails for PNG files/, 'the body keeps the snapshot text');
});

test('file_report_comments_with_issue_number', async t => {
  const f = await fixture(t);
  await f.invoke('issue_draft', draftArgs, 'draft-comment');
  const result = await f.invoke('file_report', { issue_number: 7 }, 'comment-seven');
  assert.match(result.text, /Comment added: https:\/\/github\.com\/o\/r\/issues\/7#c/);
  assert.equal(f.client.comments.length, 1);
  assert.equal(f.client.comments[0]!.number, 7);
  assert.equal(f.client.creates.length, 0);
  assert.equal(await openDraft(f.store, 's', 'c1'), undefined, 'a filed draft is no longer open');
});

test('bot_guide_has_no_issue_report', () => {
  // The guide ships to the model. It must describe the draft flow, not the removed issue_report tools.
  const guide = readFileSync(new URL('../architecture/BOT_GUIDE.md', import.meta.url), 'utf8');
  assert.doesNotMatch(guide, /issue_report\b/);
  assert.doesNotMatch(guide, /issue_report_edit|evidence_id|still pending|chat changed many times|Source or channel changed/);
  assert.match(guide, /issue_draft/);
  assert.match(guide, /\/file-report/);
  assert.match(guide, /This may have happened\. Check before you retry\./);
  assert.match(guide, /10 minutes/);
});

test('model_cannot_call_file_report', async t => {
  const f = await fixture(t);
  await f.invoke('issue_draft', draftArgs, 'draft-for-model');
  // The model's direct call and its call from run_tools_code (which passes the agent source) are both refused, and nothing is filed.
  const asModel = (args: Record<string, unknown>, id: string) => f.registry.invokeResult({ ...requester, id: `chat-${id}` }, 'file_report', args, id, 'agent');
  await assert.rejects(asModel({}, 'model-direct'), error => error instanceof ToolError && /Only a person can file a report: use \/file-report or the File report button\./.test(error.message));
  await assert.rejects(asModel({ issue_number: 7 }, 'model-comment'), ToolError);
  assert.equal(f.client.creates.length, 0);
  assert.equal(f.client.comments.length, 0);
  // The model is not offered the tool in its catalog or schemas.
  const message = { ...requester, id: 'chat-offer' };
  assert.doesNotMatch(f.registry.catalog(message), /file_report/);
  assert.ok(!f.registry.schemas(message).some(schema => JSON.stringify(schema).includes('"file_report"')));
  // A person's command still files it.
  const filed = await f.invoke('file_report', {}, 'person-files');
  assert.match(String(filed.text), /Issue created/);
  assert.equal(f.client.creates.length, 1);
});

// Mirrors DiscordServer: drafts register on every server when GitHub is configured; diagnostics only in operations.servers.
function githubRegistry(t: { after(fn: () => void): void }, servers: string[], guild: string) {
  const store = new SQLiteStore(); t.after(() => store.close());
  const client = new FakeClient();
  const registry = new ToolRegistry(store, async () => false);
  const config = { servers, repository: 'o/r', containers: ['slopbot'] };
  const authorize = async () => {};
  registerOperationsTools(registry, { store, client: client as unknown as OperationsClient, config, authorize }, guild);
  for (const tool of issueDraftTools({ store, client: client as unknown as OperationsClient, authorize })) registry.register(tool);
  return registry;
}

test('issue_draft_available_on_any_server_with_github', t => {
  const registry = githubRegistry(t, ['allowed'], 'dynamic');
  const names = registry.definitions().map(definition => definition.name);
  assert.ok(names.includes('issue_draft'));
  assert.ok(names.includes('file_report'));
  assert.ok(names.includes('github_issue_read'));
  assert.ok(names.includes('interaction_inspect'));
});

test('admin_diagnostics_still_limited', t => {
  const registry = githubRegistry(t, ['allowed'], 'dynamic');
  const names = registry.definitions().map(definition => definition.name);
  for (const admin of ['deployment_inspect', 'ci_inspect', 'service_inspect', 'pipeline_read', 'fix_watch']) assert.ok(!names.includes(admin), `${admin} stays limited to operations.servers`);
  const allowed = githubRegistry(t, ['allowed'], 'allowed').definitions().map(definition => definition.name);
  assert.ok(allowed.includes('deployment_inspect'));
});
