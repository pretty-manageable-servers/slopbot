import { test } from 'node:test';
import assert from 'node:assert/strict';
import { errorCounts } from './error-counts.mjs';

test('error counts select a period/server and attribute tool and agent failures without exposing log bodies', () => {
  const entry = (code, tool, timestamp = '2026-10-14T12:00:00Z', server = 's') => JSON.stringify({ code, timestamp, message: 'private log body', context: { tool, server } });
  const lines = [entry('TOOL_BLOCKED', 'file_read'), entry('TOOL_BLOCKED', 'file_read'), entry('TOOL_FAILED', 'shell'), entry('CONTEXT_BUDGET'), entry('TOOL_ROUND_LIMIT'), entry('TOOL_FAILED', 'shell', '2026-10-13T12:00:00Z'), entry('TOOL_FAILED', 'shell', undefined, 'other'), JSON.stringify({ time: '2026-10-14T13:00:00Z', message: entry('TOOL_FAILED', 'web_fetch', undefined) }), '{bad', JSON.stringify({ code: 'TOOL_FAILED' })];
  const result = errorCounts(lines, { server: 's', since: Date.parse('2026-10-14'), until: Date.parse('2026-10-15') });
  assert.equal(result.counts.find(row => row.code === 'TOOL_BLOCKED')?.count, 2);
  assert.equal(result.counts.find(row => row.code === 'CONTEXT_BUDGET')?.tool, '(agent)');
  assert.equal(result.counts.reduce((n, row) => n + row.count, 0), 6);
  assert.ok(!JSON.stringify(result).includes('private log body'));
  assert.equal(errorCounts([JSON.stringify({ code: 'TOOL_FAILED' })]).undated, 1);
});
