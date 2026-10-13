import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';

function deploy({ existing = [], wrongImage = false } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'slopbot-deploy-test-'));
  try {
    const bin = join(directory, 'bin'), archiveRoot = join(directory, 'archive'), packageRoot = join(archiveRoot, 'package');
    mkdirSync(bin); mkdirSync(packageRoot, { recursive: true });
    const cli = `#!/usr/bin/env python3
import json, os, sys
args=sys.argv[1:]
with open(os.environ['PMS_TEST_CALLS'], 'a') as output: output.write(json.dumps(args)+'\\n')
existing=json.loads(os.environ['PMS_TEST_EXISTING'])
if 'edit' in args:
    for index, arg in enumerate(args):
        if arg == '--unset-env' and args[index+1] not in existing: raise SystemExit('No such variable')
    open(os.environ['PMS_TEST_EDITED'], 'w').close()
elif 'show' in args:
    edited=os.path.exists(os.environ['PMS_TEST_EDITED'])
    image=os.environ['IMAGE'] if edited and os.environ['PMS_TEST_BAD_IMAGE']=='0' else 'old-image'
    print(json.dumps({'status':'running','image':image,'env_names':existing if not edited else []}))
else: raise SystemExit('Unexpected CLI invocation')
`;
    writeFileSync(join(packageRoot, 'pms'), cli, { mode: 0o700 });
    const archiveName = 'pms-v0.7.0-x86_64-unknown-linux-gnu.tar.gz', archive = join(directory, archiveName);
    execFileSync('tar', ['-czf', archive, '-C', archiveRoot, 'package']);
    const sums = join(directory, 'SHA256SUMS'); writeFileSync(sums, `${createHash('sha256').update(readFileSync(archive)).digest('hex')}  ${archiveName}\n`);
    writeFileSync(join(bin, 'gh'), '#!/bin/sh\ncp "$PMS_TEST_ARCHIVE" .\ncp "$PMS_TEST_SUMS" .\n', { mode: 0o700 });
    // macOS has shasum but no sha256sum. The CI script uses sha256sum --check, so the test adds a shim there.
    if (spawnSync('sh', ['-c', 'command -v sha256sum']).status !== 0) writeFileSync(join(bin, 'sha256sum'), '#!/bin/sh\nexec shasum -a 256 "$@"\n', { mode: 0o700 });
    const calls = join(directory, 'calls');
    const result = spawnSync('bash', [resolve('scripts/deployment/ci-deploy.sh')], {
      encoding: 'utf8', env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, RUNNER_TEMP: directory,
        GH_TOKEN: 'test-only', PMS_TOKEN: 'test-only', IMAGE: 'expected-image',
        PMS_TEST_CALLS: calls, PMS_TEST_EXISTING: JSON.stringify(existing), PMS_TEST_EDITED: join(directory, 'edited'),
        PMS_TEST_BAD_IMAGE: wrongImage ? '1' : '0', PMS_TEST_ARCHIVE: archive, PMS_TEST_SUMS: sums },
    });
    return { ...result, calls: readFileSync(calls, 'utf8').trim().split('\n').map(line => JSON.parse(line)) };
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('deployment succeeds repeatedly when token overrides are already absent', () => {
  const result = deploy(); assert.equal(result.status, 0, result.stderr);
  assert.ok(!result.calls.find(args => args.includes('edit')).includes('--unset-env'));
  assert.match(result.stdout, /Verified deployed image is running/);
});

test('deployment removes only token overrides that actually exist', () => {
  for (const existing of [['OUTPUT_TOKENS'], ['OUTPUT_TOKENS', 'CONTEXT_TOKENS']]) {
    const result = deploy({ existing }); assert.equal(result.status, 0, result.stderr);
    const edit = result.calls.find(args => args.includes('edit'));
    const removed = edit.flatMap((arg, index) => arg === '--unset-env' ? [edit[index + 1]] : []);
    assert.deepEqual(removed, existing);
  }
});

test('a different running image fails deployment verification before announcements', () => {
  const result = deploy({ wrongImage: true }); assert.notEqual(result.status, 0);
  assert.match(result.stderr, /target image is not running; no changelog will be posted/);
});
