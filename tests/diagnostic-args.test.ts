import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { diagnosticArgs } from '../src/diagnostic-data.js';

test('diagnostic arguments redact nested secrets before applying the UTF-8 size budget', () => {
  const args = diagnosticArgs({ password: 'private', nested: { authorization: 'Bearer private', code: 'const key = "github_pat_abcdefghijklmnop";\ntext(1);' } });
  assert.ok(!JSON.stringify(args).includes('private')); assert.ok(!JSON.stringify(args).includes('github_pat_'));
  const large = diagnosticArgs({ code: '😀"\\\n'.repeat(10000), api_key: 'private' });
  assert.ok(Buffer.byteLength(JSON.stringify(large)) <= 2048);
  assert.equal((large as { truncated: boolean }).truncated, true);
});

test('legacy agent turns migrate with null diagnostic arguments rather than exposing old raw code', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'slopbot-args-')); t.after(() => rmSync(directory, { recursive: true, force: true }));
  const path = join(directory, 'legacy.sqlite'); const legacy = new DatabaseSync(path);
  legacy.exec("CREATE TABLE agent_turns(sequence INTEGER PRIMARY KEY AUTOINCREMENT,id TEXT NOT NULL UNIQUE,server TEXT NOT NULL,message_id TEXT NOT NULL,text TEXT NOT NULL,calls TEXT NOT NULL,results TEXT NOT NULL,version INTEGER NOT NULL,valid INTEGER NOT NULL DEFAULT 1)");
  legacy.prepare('INSERT INTO agent_turns(id,server,message_id,text,calls,results,version) VALUES(?,?,?,?,?,?,?)').run('legacy', 's', 'old', '', JSON.stringify([{ name: 'run_tools_code', arguments: { code: 'legacy-private-code' } }]), '{}', 0);
  legacy.close(); const store = new SQLiteStore(path); t.after(() => store.close());
  assert.equal((await store.toolTurns('s', 'old'))[0]?.diagnosticArgs, null);
});
