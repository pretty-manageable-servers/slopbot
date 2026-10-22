import { createHash } from 'node:crypto';
import type { Json, Message } from './domain.js';
import { ToolError } from './errors.js';
import type { OperationsClient } from './adapters/operations-client.js';
import type { RuntimeStore } from './runtime-store.js';
import { authoredSourceText } from './source-context.js';
import type { ToolArgs, ToolContext, ToolDefinition } from './tools.js';
import type { UiDocument } from './ui/schema.js';

/** app_records kind. One draft per channel or thread. */
export const ISSUE_DRAFT_KIND = 'issue_draft';
/** app_records kind for the filing intent of a file_report call, so a lost response reconciles instead of filing twice. */
const ISSUE_DRAFT_INTENT_KIND = 'issue_draft_intent';
export const DRAFT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const MAX_CITES = 8, MAX_CITE_TEXT = 2000, EXCERPT = 200;
const LIMITS: Record<string, number> = { title: 200, expected: 1000, actual: 1000, steps: 1500, acceptance: 1000, hypotheses: 1000, missing: 1000 };
const REQUIRED = ['title', 'expected', 'actual', 'steps', 'acceptance'] as const;
const OPTIONAL = ['hypotheses', 'missing'] as const;

/** A message or tool run saved when the draft is saved. The model never sees its evidence ID. */
export interface DraftCite { kind: 'message' | 'run'; id: string; channel: string; author: string; time: number; text?: string; purpose?: string; status?: string }
export interface IssueDraft {
  server: string; channel: string; requester: string; createdAt: number; expiresAt: number;
  title: string; expected: string; actual: string; steps: string; acceptance: string;
  hypotheses?: string; missing?: string; cites: DraftCite[]; filed?: string;
}

const json = (value: unknown): Json => JSON.parse(JSON.stringify(value)) as Json;
const hash = (value: string) => createHash('sha256').update(value).digest('hex').slice(0, 32);
const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;
const quote = (text: string) => text.trim().slice(0, EXCERPT).split('\n').map(line => `> ${line}`).join('\n');

export const issueDraftInputSchema: Json = json({
  type: 'object',
  properties: {
    title: { type: 'string', maxLength: LIMITS.title, description: 'Short bug title' },
    expected: { type: 'string', maxLength: LIMITS.expected, description: 'Expected behavior' },
    actual: { type: 'string', maxLength: LIMITS.actual, description: 'Observed behavior' },
    steps: { type: 'string', maxLength: LIMITS.steps, description: 'Reproduction steps, or say that they are unknown' },
    acceptance: { type: 'string', maxLength: LIMITS.acceptance, description: 'A concrete check that verifies the fix' },
    hypotheses: { type: 'string', maxLength: LIMITS.hypotheses, description: 'Suspected causes, clearly unconfirmed' },
    missing: { type: 'string', maxLength: LIMITS.missing, description: 'Missing evidence or uncertainty' },
    cites: { type: 'array', minItems: 1, maxItems: MAX_CITES, items: { type: 'string', minLength: 1, maxLength: 200 }, description: 'Message refs such as m3, Discord message IDs, web chat message IDs, or tool-run IDs that support the report' },
  },
  required: [...REQUIRED, 'cites'],
  additionalProperties: false,
});

/** Shape checks run when the draft is saved. Every problem is listed in one tool result. */
export function checkDraftArgs(input: ToolArgs): ToolArgs {
  const problems: string[] = [];
  const valid = ['cites', ...REQUIRED, ...OPTIONAL];
  for (const key of Object.keys(input)) if (!valid.includes(key)) problems.push(`unknown field ${key}; valid fields are ${valid.join(', ')}`);
  for (const key of REQUIRED) {
    const value = input[key];
    if (typeof value !== 'string' || !value.trim()) problems.push(`${key} is missing; supply text`);
    else if (value.length > LIMITS[key]!) problems.push(`${key} is ${value.length} characters; the limit is ${LIMITS[key]}`);
  }
  for (const key of OPTIONAL) {
    const value = input[key];
    if (value !== undefined && (typeof value !== 'string' || value.length > LIMITS[key]!)) problems.push(`${key} must be text up to ${LIMITS[key]} characters`);
  }
  const cites = input.cites;
  if (!Array.isArray(cites) || cites.length < 1 || cites.length > MAX_CITES || cites.some(cite => typeof cite !== 'string' || !cite.trim()))
    problems.push(`cites needs 1 to ${MAX_CITES} items: message refs (m3), Discord or web chat message IDs, or tool-run IDs`);
  if (problems.length) throw new ToolError(`Issue draft not saved. Fix these and call issue_draft again:\n${problems.map(problem => `- ${problem}`).join('\n')}`);
  return input;
}

/** Resolves each cite to a snapshot. A cite the requester cannot read, or that does not exist, is listed in one error. */
export async function snapshotCites(store: RuntimeStore, server: string, cites: readonly string[], authorize: (channel: string) => Promise<void>): Promise<DraftCite[]> {
  const found: DraftCite[] = [], missing: string[] = [];
  for (const id of new Set(cites)) {
    const message = await store.canonicalMessage(server, id);
    if (message) {
      await authorize(message.channel);
      found.push({ kind: 'message', id: message.id, channel: message.channel, author: message.author, time: message.timestamp ?? 0, text: authoredSourceText(message).slice(0, MAX_CITE_TEXT) });
      continue;
    }
    const run = await store.runRecord(id);
    if (run && run.message.server === server) {
      await authorize(run.message.channel);
      found.push({ kind: 'run', id, channel: run.message.channel, author: run.message.author, time: run.message.timestamp ?? 0, purpose: run.purpose, status: run.status });
      continue;
    }
    missing.push(id);
  }
  if (missing.length) throw new ToolError(`These cites are not available in this chat: ${missing.map(id => id.slice(0, 40)).join(', ')}. Use m-refs from this chat, or message and tool-run IDs from this channel.`);
  return found;
}

/** Saves the draft for this channel. A new call replaces the old draft. Returns the saved draft. */
export async function saveDraft(store: RuntimeStore, context: ToolContext, args: ToolArgs, cites: DraftCite[], now = Date.now()): Promise<IssueDraft> {
  const { server, channel } = context.message;
  const old = await store.record(server, ISSUE_DRAFT_KIND, channel);
  const draft: IssueDraft = {
    server, channel, requester: context.message.author, createdAt: now, expiresAt: now + DRAFT_TTL_MS,
    title: String(args.title), expected: String(args.expected), actual: String(args.actual), steps: String(args.steps), acceptance: String(args.acceptance),
    ...(typeof args.hypotheses === 'string' ? { hypotheses: args.hypotheses } : {}), ...(typeof args.missing === 'string' ? { missing: args.missing } : {}), cites,
  };
  if (!await store.putRecord(server, ISSUE_DRAFT_KIND, channel, json(draft), old?.revision ?? 0)) throw new ToolError('The issue draft changed while it was saved. Call issue_draft again.');
  return draft;
}

/** The open draft of a channel. Expired and already filed drafts are not open. */
export async function openDraft(store: RuntimeStore, server: string, channel: string, now = Date.now()): Promise<IssueDraft | undefined> {
  const record = await store.record(server, ISSUE_DRAFT_KIND, channel);
  const draft = record?.value as unknown as IssueDraft | undefined;
  if (!draft || draft.filed || draft.expiresAt <= now) return undefined;
  return draft;
}

/** The one embed-style card shown in Discord and private chats. Its File report button runs file_report. */
export function draftCard(draft: IssueDraft, now = Date.now()): UiDocument {
  const messages = draft.cites.filter(cite => cite.kind === 'message').length, runs = draft.cites.length - messages;
  const days = Math.max(1, Math.ceil((draft.expiresAt - now) / (24 * 60 * 60 * 1000)));
  const text = [
    `**Expected:** ${draft.expected}`, `**Actual:** ${draft.actual}`, `**Steps:** ${draft.steps}`, `**Acceptance:** ${draft.acceptance}`,
    `**Evidence:** ${plural(messages, 'message', 'messages')}, ${plural(runs, 'tool run', 'tool runs')}`,
    `-# Draft · /file-report · expires in ${days} ${days === 1 ? 'day' : 'days'}`,
  ].join('\n');
  return { version: 1, type: 'card', title: draft.title.slice(0, 150), text: text.slice(0, 3500), actions: [{ label: 'File report', action: 'issue.file', arguments: {} }] };
}

/** The issue body. Each cite shows its snapshot, and "edited since" or "deleted since" when the source changed. */
export async function issueBody(store: RuntimeStore, draft: IssueDraft, requesterNote: string, marker: string): Promise<string> {
  const evidence: string[] = [];
  for (const cite of draft.cites) {
    const now = cite.kind === 'message' ? await store.canonicalMessage(draft.server, cite.id) : await store.runRecord(cite.id);
    const status = !now ? ' (deleted since)' : cite.kind === 'message' && authoredSourceText(now as Message).slice(0, MAX_CITE_TEXT) !== cite.text ? ' (edited since)' : '';
    const link = cite.kind === 'message' && /^\d+$/.test(cite.id) ? `https://discord.com/channels/${draft.server}/${cite.channel}/${cite.id}` : cite.id;
    const head = cite.kind === 'message'
      ? `- Message ${link}, by ${cite.author} at ${new Date(cite.time).toISOString()}${status}`
      : `- Tool run ${cite.id} (${cite.purpose ?? 'run'}, ${cite.status ?? 'unknown'})${status}`;
    evidence.push(cite.kind === 'message' && cite.text?.trim() ? `${head}\n${quote(cite.text)}` : head);
  }
  return [
    '## Report', `Expected: ${draft.expected}`, `Actual: ${draft.actual}`,
    '## Reproduction', draft.steps, '## Acceptance check', draft.acceptance,
    '## Unconfirmed hypotheses', draft.hypotheses ?? 'None established.', '## Missing evidence', draft.missing ?? 'None reported.',
    '## Evidence', evidence.join('\n'),
    `${requesterNote}\n\n${marker}`,
  ].join('\n\n');
}

export interface IssueDraftServices {
  store: RuntimeStore;
  client: OperationsClient;
  authorize(message: Message, channel: string): Promise<void>;
  repository?: string;
}

/** The issue_draft and file_report tools. Both are offered to the requester in the channel. */
export function issueDraftTools(services: IssueDraftServices): ToolDefinition[] {
  const { store, client } = services;
  const issueDraft: ToolDefinition = {
    name: 'issue_draft', surface: 'top', access: 'member', effect: 'write', retrySafe: true,
    description: 'Save a bug report draft for this channel or thread. Use it when the requester asks to file a bug. Give a short title, Expected, Actual, Steps, Acceptance check (a concrete check that verifies the fix), and up to 8 cites: message refs (m3), message IDs or tool-run IDs that support the report. Optional: hypotheses and missing. The draft is saved with a snapshot of each cite. A new call replaces the open draft. The requester files it with /file-report. Keep chat text short.',
    fields: {}, inputSchema: issueDraftInputSchema,
    resource: message => `issue-draft:${message.server}:${message.channel}`,
    validate: checkDraftArgs,
    async execute(context, args) {
      await services.authorize(context.message, context.message.channel);
      const cites = await snapshotCites(store, context.message.server, (args.cites as string[]), channel => services.authorize(context.message, channel));
      await context.assertActive();
      const draft = await saveDraft(store, context, args, cites);
      const messages = cites.filter(cite => cite.kind === 'message').length, runs = cites.length - messages;
      return {
        text: `Issue draft saved (${plural(messages, 'message', 'messages')}, ${plural(runs, 'tool run', 'tool runs')}). The draft card is shown to the requester. Keep your chat reply to one or two sentences; do not repeat the draft. The requester files it with /file-report or the File report button.`,
        data: { title: draft.title, cites: cites.length, expires_at: new Date(draft.expiresAt).toISOString() },
        ui: draftCard(draft),
      };
    },
  };
  const fileReport: ToolDefinition = {
    name: 'file_report', access: 'member', effect: 'write', retrySafe: false, publicResult: () => true,
    description: 'File the open issue draft of this channel as a GitHub issue, or as a comment on issue_number. Only the draft requester or a bot admin can file it. Cites edited or deleted since the draft are marked in the issue, and do not block filing.',
    fields: { issue_number: { type: 'integer', description: 'Existing issue to comment on instead of creating a new issue', min: 1, max: Number.MAX_SAFE_INTEGER } },
    resource: message => `issue-draft:${message.server}:${message.channel}`,
    async execute(context, args) {
      const draft = await openDraft(store, context.message.server, context.message.channel);
      if (!draft) throw new ToolError('No open issue draft in this channel. Ask Slopbot to draft the report first; drafts expire after 7 days.');
      if (draft.requester !== context.message.author && !context.isAdmin) throw new ToolError('Only the requester of this draft or a bot admin can file it.');
      const number = args.issue_number === undefined ? undefined : Number(args.issue_number);
      if (number && (await client.issue(number)).pull_request) throw new ToolError('Choose an issue, not a pull request');
      const marker = `<!-- slopbot-draft:${hash(context.operationId)} -->`;
      const body = await issueBody(store, draft, `Reported by Discord user ${draft.requester} through /file-report. Investigation by Slopbot; code changes belong to coding agents.`, marker);
      await store.putRecord(context.message.server, ISSUE_DRAFT_INTENT_KIND, hash(context.operationId), { number: number ?? null }, 0);
      await context.assertActive();
      const issue = number ? await client.comment(number, body) : await client.createIssue(draft.title.slice(0, 200), body);
      const current = await store.record(context.message.server, ISSUE_DRAFT_KIND, context.message.channel);
      if (current) await store.putRecord(context.message.server, ISSUE_DRAFT_KIND, context.message.channel, json({ ...draft, filed: issue.html_url }), current.revision);
      return { text: `${number ? 'Comment added' : 'Issue created'}: ${issue.html_url}`, data: { number: number ?? issue.number, url: issue.html_url }, artifacts: [{ url: issue.html_url, label: number ? 'Issue comment' : 'GitHub issue' }] };
    },
    async reconcile(context) {
      const intent = await store.record(context.message.server, ISSUE_DRAFT_INTENT_KIND, hash(context.operationId));
      if (!intent) return undefined;
      const number = (intent.value as { number: number | null }).number;
      const marker = `<!-- slopbot-draft:${hash(context.operationId)} -->`;
      const found = number ? await client.findComment(number, marker) : await client.findIssue(marker);
      return found ? { text: `Recovered GitHub report: ${found.html_url}`, data: { number: number ?? found.number, url: found.html_url }, artifacts: [{ url: found.html_url, label: 'GitHub report' }] } : undefined;
    },
  };
  return [issueDraft, fileReport];
}

