import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Readable } from 'node:stream';
import { S3Client } from '@aws-sdk/client-s3';
import { S3StorageProvider } from '../src/adapters/s3-storage.js';
import { MAX_STORED_FILE_BYTES } from '../src/object-storage.js';
import { ToolError, UncertainActionError } from '../src/errors.js';
const options = { bucket: 'slopbot-files', endpoint: 'http://garage.pms-storage.svc:3900', publicEndpoint: 'https://s3.pmservers.org', region: 'pms', accessKeyId: 'test-key', secretAccessKey: 'test-secret' };

test('S3 body limits apply to both ContentLength and streamed bytes and cancel the body', async t => {
  for (const contentLength of [MAX_STORED_FILE_BYTES + 1, undefined]) {
    const stream = Readable.from([new Uint8Array(MAX_STORED_FILE_BYTES + 1)]);
    const mock = t.mock.method(S3Client.prototype, 'send', async () => ({ Body: stream, ContentLength: contentLength }));
    const provider = new S3StorageProvider(options);
    await assert.rejects(provider.get('huge'), /10 MiB/); assert.equal(stream.destroyed, true); provider.close(); mock.mock.restore();
  }
});

test('share URLs use public HTTPS, path-style bucket, bounded lifetime and safe filenames', async t => {
  const provider = new S3StorageProvider(options); t.after(() => provider.close());
  const url = new URL(await provider.link('users/a/file name', "report'file.txt", 3600));
  assert.equal(url.origin, 'https://s3.pmservers.org'); assert.equal(url.pathname, '/slopbot-files/users/a/file%20name');
  assert.equal(url.searchParams.get('X-Amz-Expires'), '3600');
  assert.ok(url.searchParams.get('X-Amz-Credential')?.includes('/pms/s3/'));
  assert.equal(url.searchParams.get('response-content-disposition'), "attachment; filename*=UTF-8''report%27file.txt");
  assert.ok(!url.href.includes('test-secret'));
});

test('known S3 failures return actionable errors and mutations with unknown outcomes remain uncertain', async t => {
  t.mock.method(S3Client.prototype, 'send', async () => { throw new Error('network unavailable'); });
  const provider = new S3StorageProvider(options); t.after(() => provider.close());
  await assert.rejects(provider.get('file'), ToolError);
  await assert.rejects(provider.put('file', new Uint8Array(), 'text/plain'), UncertainActionError);
  await assert.rejects(provider.delete('file'), UncertainActionError);
});
