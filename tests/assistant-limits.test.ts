import test from 'node:test';
import assert from 'node:assert/strict';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { AdminPanel, type AdminConfig } from '../src/admin-panel.js';
import { clampAssistantLimits, readAssistantLimits } from '../src/assistant/limits.js';
import { ASSISTANT_LIMITS_KEY, DEFAULT_ASSISTANT_LIMITS } from '../src/assistant/types.js';
import { UserLimiter } from '../src/user-limiter.js';
import { MemberDirectory } from '../src/member-directory.js';
import { GLOBAL_SETTINGS_SCOPE } from '../src/usage-cost.js';
import { fakeSource } from './member-fakes.js';

const config: AdminConfig = { model: 'nimbus', jevModel: 'cirrus', embeddingModel: 'embed', baseUrl: 'https://models.example.com/v1', modelPrices: {}, fallbackPrice: { input: 1, cached_input: 1, output: 1 }, userLimit5hCostMicros: 100, userLimitWeekCostMicros: 0, userLimitGracePercent: 10 };

function setup() {
  const store = new SQLiteStore();
  const limiter = new UserLimiter(store, { fiveHourCostMicros: 100, weekCostMicros: 0, gracePercent: 10 });
  const panel = new AdminPanel(config, store, limiter, new MemberDirectory(fakeSource({})));
  return { store, panel };
}

test('admin limits clamp', async t => {
  const { store, panel } = setup(); t.after(() => store.close());
  assert.deepEqual(clampAssistantLimits({ maxActiveTasks: 500, minWakeMinutes: 1, maxPendingApprovals: 0, approvalTtlHours: 99999, mentionDebounceMinutes: -3 }), {
    maxActiveTasks: 100, minWakeMinutes: 15, maxPendingApprovals: 1, approvalTtlHours: 720, mentionDebounceMinutes: 0,
  });
  assert.deepEqual(clampAssistantLimits({ maxActiveTasks: 0, minWakeMinutes: 10080, maxPendingApprovals: 200, approvalTtlHours: 1, mentionDebounceMinutes: 1440 }), {
    maxActiveTasks: 0, minWakeMinutes: 10080, maxPendingApprovals: 200, approvalTtlHours: 1, mentionDebounceMinutes: 1440,
  }, 'the edges of each range are kept');
  assert.deepEqual(clampAssistantLimits({ maxActiveTasks: 2.5, minWakeMinutes: '30', maxPendingApprovals: Number.NaN, approvalTtlHours: null, mentionDebounceMinutes: Infinity }), DEFAULT_ASSISTANT_LIMITS, 'values that are not whole numbers take the default');
  assert.deepEqual(await panel.saveAssistantLimits({ maxActiveTasks: 900, minWakeMinutes: 2, maxPendingApprovals: 'many' }), {
    ...DEFAULT_ASSISTANT_LIMITS, maxActiveTasks: 100, minWakeMinutes: 15, default: DEFAULT_ASSISTANT_LIMITS,
  }, 'the admin save clamps too');
});

test('admin limits default', async t => {
  const { store, panel } = setup(); t.after(() => store.close());
  assert.deepEqual(panel.assistantLimits(), { ...DEFAULT_ASSISTANT_LIMITS, default: DEFAULT_ASSISTANT_LIMITS });
  assert.deepEqual(readAssistantLimits(store), DEFAULT_ASSISTANT_LIMITS);
  await store.setSetting(GLOBAL_SETTINGS_SCOPE, ASSISTANT_LIMITS_KEY, { maxActiveTasks: 7 });
  assert.deepEqual(readAssistantLimits(store), { ...DEFAULT_ASSISTANT_LIMITS, maxActiveTasks: 7 }, 'a stored partial value keeps the other defaults');
  await assert.rejects(panel.saveAssistantLimits(null), { name: 'AdminInputError', message: 'Send the limits as an object.' });
});

test('admin limits roundtrip', async t => {
  const { store, panel } = setup(); t.after(() => store.close());
  const body = { maxActiveTasks: 12, minWakeMinutes: 30, maxPendingApprovals: 50, approvalTtlHours: 24, mentionDebounceMinutes: 0 };
  const saved = await panel.saveAssistantLimits(body);
  assert.deepEqual(saved, { ...body, default: DEFAULT_ASSISTANT_LIMITS });
  assert.deepEqual(panel.assistantLimits(), saved);
  assert.deepEqual(readAssistantLimits(store), body);
});
