import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { AttachQueue, LINK_SECONDS, LINK_MAX_BYTES, fileBatches, registerAttachFile, runKey, sweepAttachLinks, type AttachDeps } from '../src/attach-file.js';
import { matchName, sniffMedia } from '../src/media-sniff.js';
import { UserFileStorage, type ObjectStorageProvider } from '../src/object-storage.js';
import type { SandboxProvider } from '../src/sandbox.js';
import type { Message } from '../src/domain.js';
import type { ToolContext, ToolDefinition, ToolRegistry } from '../src/tools.js';

const SERVER = '100000000000000001', CHANNEL = '200000000000000002', USER = '300000000000000003', MESSAGE = '400000000000000004';
const text = (value: string) => new TextEncoder().encode(value);
const withHead = (head: number[] | string, size = 64) => {
  const bytes = new Uint8Array(size);
  const parts = typeof head === 'string' ? [...head].map(char => char.charCodeAt(0)) : head;
  bytes.set(parts, 0);
  return bytes;
};
const PNG = withHead([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function fakeProvider(): ObjectStorageProvider & { puts: { key: string; contentType: string }[]; links: { seconds: number; inline?: boolean }[]; deleted: string[] } {
  const provider = { puts: [] as { key: string; contentType: string }[], links: [] as { seconds: number; inline?: boolean }[], deleted: [] as string[],
    async put(key: string, _bytes: Uint8Array, contentType: string) { provider.puts.push({ key, contentType }); },
    async get() { return new Uint8Array(); },
    async delete(key: string) { provider.deleted.push(key); },
    async link(_key: string, _name: string, seconds: number, inline?: boolean) { provider.links.push({ seconds, ...(inline !== undefined ? { inline } : {}) }); return `https://files.example/${provider.puts.length}?sig=x`; },
  };
  return provider;
}

function setup(sandboxBytes: Uint8Array, provider?: ObjectStorageProvider) {
  const store = new SQLiteStore();
  void store.putRecord(SERVER, 'sandbox', CHANNEL, { id: 'sandbox-1', expiresAt: Date.now() + 60_000, home: '/home/user' }, 0);
  const sandbox = { connect: async () => ({ readBytes: async (_path: string, max: number) => { if (sandboxBytes.length > max) throw new Error('too big'); return sandboxBytes; } }) } as unknown as SandboxProvider;
  const queue = new AttachQueue();
  let tool: ToolDefinition | undefined;
  const registry = { register(definition: ToolDefinition) { tool = definition; } } as unknown as ToolRegistry;
  const deps: AttachDeps = {
    store, queue, storage: new UserFileStorage(store, provider), ...(provider ? { provider } : {}),
    sandbox: { provider: sandbox }, authorize: async () => undefined,
  };
  registerAttachFile(registry, deps);
  const message = { id: MESSAGE, server: SERVER, channel: CHANNEL, author: USER, text: 'attach it', timestamp: Date.now() } as unknown as Message;
  const context = { message, operationId: 'op', isAdmin: false, assertActive: async () => undefined } as unknown as ToolContext;
  const run = (args: Record<string, string>) => tool!.execute(context, args);
  return { store, queue, run, close: () => store.close() };
}

test('sniff_sets_extension_and_mime', () => {
  const cases: [Uint8Array, string, string][] = [
    [PNG, 'png', 'image/png'],
    [withHead([0xff, 0xd8, 0xff, 0xe0]), 'jpg', 'image/jpeg'],
    [withHead('GIF89a'), 'gif', 'image/gif'],
    [withHead('RIFF\0\0\0\0WEBP'), 'webp', 'image/webp'],
    [withHead([0, 0, 0, 0x18, ...text('ftypisom')]), 'mp4', 'video/mp4'],
    [withHead([0, 0, 0, 0x14, ...text('ftypqt  ')]), 'mov', 'video/quicktime'],
    [withHead([0x1a, 0x45, 0xdf, 0xa3, 0x01, 0, 0, 0, 0, 0, 0, 0x1f, ...text('webm')]), 'webm', 'video/webm'],
    [withHead('ID3\x04\0\0\0\0\0\0'), 'mp3', 'audio/mpeg'],
    [withHead([0xff, 0xfb, 0x90, 0x64]), 'mp3', 'audio/mpeg'],
    [withHead('OggS\0\x02'), 'ogg', 'audio/ogg'],
    [withHead('RIFF\0\0\0\0WAVEfmt '), 'wav', 'audio/wav'],
  ];
  for (const [bytes, extension, contentType] of cases) {
    assert.equal(sniffMedia(bytes)?.extension, extension);
    assert.equal(sniffMedia(bytes)?.contentType, contentType);
  }
  assert.equal(sniffMedia(text('just some plain text, not media')), undefined);
  assert.equal(matchName('photo.jpeg', sniffMedia(withHead([0xff, 0xd8, 0xff]))), 'photo.jpg');
  assert.equal(matchName('shot', sniffMedia(PNG)), 'shot.png');
  assert.equal(matchName('notes.txt', undefined), 'notes.txt');
});

test('small_file_attaches', async () => {
  const f = setup(PNG);
  try {
    const output = await f.run({ path: 'out/shot.jpg', description: 'the screen' });
    assert.match(String((output as { text: string }).text), /Attached shot\.png/);
    const attached = f.queue.take(runKey(SERVER, MESSAGE));
    assert.equal(attached.files.length, 1);
    assert.equal(attached.files[0]!.name, 'shot.png');
    assert.equal(attached.files[0]!.contentType, 'image/png');
    assert.equal(attached.files[0]!.description, 'the screen');
    assert.deepEqual(attached.links, []);
    assert.equal(f.queue.take(runKey(SERVER, MESSAGE)).files.length, 0, 'the queue is cleared after the reply takes it');
  } finally { f.close(); }
});

test('large_file_goes_to_storage_link', async () => {
  const provider = fakeProvider();
  const bytes = withHead([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 20 * 1024 * 1024);
  const f = setup(bytes, provider);
  try {
    await f.run({ path: 'big/render.png', name: 'render' });
    assert.equal(provider.puts.length, 1);
    assert.equal(provider.puts[0]!.contentType, 'image/png');
    assert.deepEqual(provider.links, [{ seconds: 7 * 24 * 60 * 60, inline: true }]);
    const attached = f.queue.take(runKey(SERVER, MESSAGE));
    assert.equal(attached.files.length, 0);
    assert.equal(attached.links.length, 1);
    assert.equal(attached.links[0]!.name, 'render.png');
    assert.match(attached.links[0]!.url, /^https:\/\/files\.example\//);
    // After 7 days the object is deleted once; a second sweep finds nothing new.
    const later = Date.now() + LINK_SECONDS * 1000 + 1000;
    assert.equal(await sweepAttachLinks(f.store, provider, SERVER, later), 1);
    assert.deepEqual(provider.deleted, [provider.puts[0]!.key]);
    assert.equal(await sweepAttachLinks(f.store, provider, SERVER, later), 0);
  } finally { f.close(); }
});

test('over_100mb_rejected', async () => {
  const f = setup(new Uint8Array(LINK_MAX_BYTES + 1), fakeProvider());
  try {
    await assert.rejects(f.run({ path: 'huge.bin' }), /100 MB/);
    assert.equal(f.queue.take(runKey(SERVER, MESSAGE)).links.length, 0);
  } finally { f.close(); }
});

test('more_than_10_files_split_messages', () => {
  assert.deepEqual(fileBatches(Array.from({ length: 25 }, (_, i) => i)).map(batch => batch.length), [10, 10, 5]);
  assert.deepEqual(fileBatches([1, 2, 3]), [[1, 2, 3]]);
  assert.deepEqual(fileBatches([]), []);
});
