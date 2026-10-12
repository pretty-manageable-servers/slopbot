import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { S3StorageProvider } from '../dist/src/adapters/s3-storage.js';
import { loadConfig } from '../dist/src/config.js';
const options = loadConfig().objectStorage;
if (!options) throw new Error('Configure OBJECT_STORAGE_BUCKET and a bucket-scoped S3 key first.');
const provider = new S3StorageProvider(options);
const key = `slopbot-smoke/${randomUUID()}/roundtrip.bin`;
const bytes = new Uint8Array([0, 255, 128, 13, 10]);
try {
  await provider.put(key, bytes, 'application/octet-stream');
  assert.deepEqual(await provider.get(key), Buffer.from(bytes));
  const url = await provider.link(key, 'roundtrip.bin', 60);
  const response = await fetch(url, { signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (!response.ok) throw new Error(`Signed download returned HTTP ${response.status}`);
  assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from(bytes));
  console.log('Object storage binary upload/read and signed public download passed.');
} finally {
  try { await provider.delete(key); console.log('Temporary smoke-test object removed.'); }
  finally { provider.close(); }
}
