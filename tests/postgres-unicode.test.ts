import { test } from 'node:test';
import assert from 'node:assert/strict';
import { PostgresDatabase, postgresValue } from '../src/adapters/postgres-database.js';
import { errorContext, errorReply } from '../src/errors.js';

test('Postgres parameters repair NUL and lone surrogates without damaging emoji or literal escapes', () => {
  const input = { text: 'a\u0000b\ud800c\udfff😀', literal: '\\u0000 \\ud800', nested: [{ value: '\u0000' }], ['bad\u0000key']: true };
  assert.deepEqual(JSON.parse(postgresValue(JSON.stringify(input)) as string), {
    text: 'a�b�c�😀', literal: input.literal, nested: [{ value: '�' }], 'bad�key': true,
  });
  assert.equal(postgresValue('raw\u0000\ud800😀'), 'raw��😀');
  assert.equal(postgresValue('text \\u0000'), 'text \\u0000');
  assert.equal(postgresValue(JSON.stringify({ nestedJsonText: '{"value":"\\u0000"}' })), JSON.stringify({ nestedJsonText: '{"value":"\\u0000"}' }));
  assert.equal(postgresValue(123), 123);
  assert.equal(postgresValue(null), null);
});

test('database failures retain the operation stage and request/job IDs in the notice', () => {
  const error = errorContext(errorContext(Object.assign(new Error('unsupported Unicode escape sequence'), { code: '22P05' }), { stage: 'database update agent_turns' }), { stage: 'agent round', messageId: 'request-1', jobId: 'job-1' });
  const notice = errorReply(error, 'job-1');
  assert.match(notice, /database update agent/);
  assert.match(notice, /Request ID: request-1/);
  assert.match(notice, /Job ID: job-1/);
});

test('Postgres can cast and update repaired tool results as jsonb', { skip: !process.env.TEST_DATABASE_URL }, async () => {
  const db = await PostgresDatabase.connect(process.env.TEST_DATABASE_URL!);
  try {
    await db.exec('CREATE TEMP TABLE unicode_tool_results (id text PRIMARY KEY, results text)');
    await db.prepare('INSERT INTO unicode_tool_results VALUES (?,?)').run('turn', JSON.stringify({ text: 'start\u0000\ud800😀' }));
    await db.prepare('UPDATE unicode_tool_results SET results=json_set(results,?,json(?)) WHERE id=?').run('$."0"', JSON.stringify({ text: 'tool\u0000\udfff😀', literal: '\\u0000' }), 'turn');
    const row = await db.prepare('SELECT results::jsonb AS result FROM unicode_tool_results WHERE id=?').get('turn');
    assert.deepEqual(row?.result, { text: 'start��😀', 0: { text: 'tool��😀', literal: '\\u0000' } });
  } finally { await db.close(); }
});
