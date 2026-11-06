// Replays six scripted runs through the run loop and compares replies, tool activity and
// harness_events rows with fixtures recorded before Auger drove the loop. Set RECORD_REPLAY=1 to re-record.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { Application } from '../src/application.js';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { ToolError } from '../src/tools.js';
import type { LLM } from '../src/ports.js';
import type { HarnessJournal } from '../src/harness-state.js';
import type { ToolActivity } from '../src/tool-activity.js';
import type { Message } from '../src/domain.js';

const policy = { allowedChannels: [{ server: 's', channel: 'c' }] };
const fixtureDir = new URL('../../tests/fixtures/agent-runner-replay/', import.meta.url);
interface Script { name: string; rounds: ReadonlyArray<{ calls: ReadonlyArray<string> } | { text: string } | 'block'>; tool(name: string, signal?: AbortSignal): Promise<string>; }

// Timings are dropped; random turn ids and hashed call ids are replaced so rows compare across runs.
const norm = (value: unknown): unknown => JSON.parse(JSON.stringify(value, (key, item) => key === 'startedAt' || key === 'durationMs' ? undefined : item).replace(/[0-9a-f]{8}-[0-9a-f-]{27}/g, 'T').replace(/call_[0-9a-f]+/g, 'call_H'));

async function replay(script: Script) {
  const store = new SQLiteStore();
  try {
    const message: Message = { server: 's', channel: 'c', author: 'a', id: 'm', text: script.name, addressed: true };
    const harnessRows: unknown[] = [];
    const journal: HarnessJournal = {
      harnessState: (server, id) => store.harnessState(server, id),
      async recordHarness(m, state, event) {
        await store.recordHarness(m, state, event);
        harnessRows.push({ event, state });
      },
    };
    const seen: ToolActivity[] = [];
    let round = 0;
    let toolStarted!: () => void;
    const started = new Promise<void>(resolve => { toolStarted = resolve; });
    let app!: Application;
    const llm: LLM = { async *stream() {
      const next = script.rounds[Math.min(round++, script.rounds.length - 1)]!;
      if (next === 'block') { yield { kind: 'text', payload: { text: 'never' } }; return; }
      if ('calls' in next) yield { kind: 'tool_call', payload: next.calls.map((name, index) => ({ id: `p${round}_${index}`, name, arguments: { n: index } })) };
      else yield { kind: 'text', payload: { text: next.text } };
    } };
    app = new Application(store, llm, policy, undefined, {
      harness: journal,
      onToolActivity: async (_m, activity) => { seen.push(activity); },
      tools: { schemas: () => [], catalog: () => '', execute: async (_m, call, _id, _v, options) => { toolStarted(); return script.tool(call.name, options?.signal); } },
    });
    
    const pending = app.handle(message).then(
      reply => ({ reply: reply!.text, toolActivity: reply!.toolActivity }),
      error => ({ error: (error as Error).name }),
    );
    if (script.name === 'interrupt during a tool') { await started; assert.equal(await app.interrupt('s', 'm'), true); }
    const outcome = await pending;
    return norm({
      outcome,
      activityEvents: seen.map(a => ({ id: a.id, name: a.name, status: a.status, callId: a.callId, code: a.code, reason: a.reason })),
      harness: harnessRows,
      final: (await store.harnessState('s', 'm'))?.kind,
      rounds: round,
    });
  } finally { store.close(); }
}

const ok = async () => 'ok';
const scripts: Script[] = [
  { name: 'no tools', rounds: [{ text: 'plain answer' }], tool: ok },
  { name: 'one tool', rounds: [{ calls: ['read'] }, { text: 'one tool done' }], tool: ok },
  { name: 'two tools in one batch', rounds: [{ calls: ['read', 'list'] }, { text: 'two tools done' }], tool: async name => `result of ${name}` },
  { name: 'a failing tool', rounds: [{ calls: ['read', 'broken'] }, { text: 'explained the failure' }], tool: async name => { if (name === 'broken') throw new ToolError('broken tool', 'failed'); return 'ok'; } },
  { name: 'three failing rounds', rounds: [{ calls: ['broken'] }, { calls: ['broken'] }, { calls: ['broken'] }, { calls: ['broken'] }, { text: 'gave up' }], tool: async () => { throw new ToolError('always broken', 'failed'); } },
  { name: 'interrupt during a tool', rounds: [{ calls: ['slow'] }, { text: 'unreachable' }], tool: (_name, signal) => new Promise<string>(resolve => { signal?.addEventListener('abort', () => resolve('late result'), { once: true }); }) },
];

mkdirSync(fixtureDir, { recursive: true });
for (const script of scripts) {
  test(`run loop replay: ${script.name}`, async () => {
    const file = new URL(`${script.name.replace(/[^a-z]+/g, '-')}.json`, fixtureDir);
    const actual = await replay(script);
    if (process.env.RECORD_REPLAY === '1' || !existsSync(file)) { writeFileSync(file, JSON.stringify(actual, null, 2) + '\n'); return; }
    assert.deepEqual(actual, JSON.parse(readFileSync(file, 'utf8')));
  });
}
