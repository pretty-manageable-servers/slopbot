import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import type { Message } from '../src/domain.js';
import type { FileFetcher } from '../src/files.js';
import { contextBlock } from '../src/context-block.js';
import { SANDBOX_HOME } from '../src/sandbox-session.js';
import type { SandboxProvider, SandboxSession } from '../src/sandbox.js';
import { isUploadable, uniqueNames, uploadName, uploadRequestFiles } from '../src/sandbox-uploads.js';
import { ToolError } from '../src/tools.js';

const message: Message = {
  id: 'request', server: 's', channel: 'task', author: 'person', text: 'Summarize these', addressed: true, uploadFiles: true,
  attachments: [
    { name: 'report.pdf', url: 'https://cdn.discordapp.com/attachments/1/report.pdf', contentType: 'application/pdf', size: 10 },
    { name: 'photo.png', url: 'https://cdn.discordapp.com/attachments/1/photo.png', contentType: 'image/png', size: 10 },
    { name: 'data.csv', url: 'https://cdn.discordapp.com/attachments/1/data.csv', contentType: 'text/csv', size: 10 },
  ],
};

function fixture(options: { fetch?: (url: string) => Promise<Uint8Array>; createError?: Error } = {}) {
  const store = new SQLiteStore();
  const written = new Map<string, Uint8Array>();
  const commands: string[] = [];
  const session: SandboxSession = {
    id: 'workspace', async run(command) { commands.push(command); return { stdout: '', stderr: '', exitCode: 0 }; },
    async write(path, data) { written.set(path, typeof data === 'string' ? new TextEncoder().encode(data) : data); },
    async read() { return ''; }, async readBytes() { return new Uint8Array(); }, async renew() {}, async close() {},
  };
  const provider: SandboxProvider = {
    defaultTemplate: 'base',
    async create() { if (options.createError) throw options.createError; return session; },
    async connect() { return session; },
  };
  const fetcher: FileFetcher = { fetch: async attachment => options.fetch ? options.fetch(attachment.url) : new TextEncoder().encode(attachment.name) };
  return { store, provider, fetcher, written, commands, close: () => store.close() };
}

test('request_uploads_files writes each non-image file to the upload directory before the run', async t => {
  const f = fixture(); t.after(f.close);
  const result = await uploadRequestFiles({ store: f.store, provider: f.provider, fetcher: f.fetcher }, message);
  assert.deepEqual(result, { files: [`${SANDBOX_HOME}/uploads/report.pdf`, `${SANDBOX_HOME}/uploads/data.csv`], failed: [] });
  assert.equal(new TextDecoder().decode(f.written.get(`${SANDBOX_HOME}/uploads/report.pdf`)), 'report.pdf');
  assert.ok(f.commands.some(command => command === `mkdir -p ${SANDBOX_HOME}/uploads`));
});

test('non_request_no_upload: a message without files returns nothing and writes nothing', async t => {
  const f = fixture(); t.after(f.close);
  const plain: Message = { ...message, attachments: [] };
  assert.equal(await uploadRequestFiles({ store: f.store, provider: f.provider, fetcher: f.fetcher }, plain), undefined);
  assert.equal(f.written.size, 0);
  assert.equal(f.commands.length, 0);
});

test('images_stay_inline: image and link preview attachments are never uploaded', async t => {
  const f = fixture(); t.after(f.close);
  const onlyImages: Message = { ...message, attachments: [message.attachments![1]!, { name: 'preview.html', url: 'https://example.com', contentType: 'text/html', preview: true }] };
  assert.equal(await uploadRequestFiles({ store: f.store, provider: f.provider, fetcher: f.fetcher }, onlyImages), undefined);
  assert.equal(f.written.size, 0);
  assert.equal(isUploadable(message.attachments![1]!), false);
  assert.equal(isUploadable(message.attachments![0]!), true);
});

test('name_clash_suffix adds -1 and -2 before the extension for one message', async t => {
  assert.deepEqual(uniqueNames(['a.pdf', 'a.pdf', 'a.pdf']), ['a.pdf', 'a-1.pdf', 'a-2.pdf']);
  assert.deepEqual(uniqueNames(['a.pdf', 'a.pdf', 'a-1.pdf']), ['a.pdf', 'a-1.pdf', 'a-1-1.pdf']);
  assert.deepEqual(uniqueNames(['README', 'README']), ['README', 'README-1']);
  assert.equal(uploadName('../../etc/pass wd.txt'), 'pass wd.txt');
  assert.equal(uploadName('a/b\\c.txt'), 'c.txt');
  const f = fixture(); t.after(f.close);
  const twins: Message = { ...message, attachments: [message.attachments![0]!, { ...message.attachments![0]! }] };
  const result = await uploadRequestFiles({ store: f.store, provider: f.provider, fetcher: f.fetcher }, twins);
  assert.deepEqual(result?.files, [`${SANDBOX_HOME}/uploads/report.pdf`, `${SANDBOX_HOME}/uploads/report-1.pdf`]);
});

test('upload_failure_continues: a failed download is reported by name and the other files are written', async t => {
  const f = fixture({ fetch: async url => { if (url.endsWith('report.pdf')) throw new ToolError('File exceeds 10 MiB'); return new TextEncoder().encode('ok'); } }); t.after(f.close);
  const result = await uploadRequestFiles({ store: f.store, provider: f.provider, fetcher: f.fetcher }, message);
  assert.deepEqual(result, { files: [`${SANDBOX_HOME}/uploads/data.csv`], failed: ['report.pdf: File exceeds 10 MiB'] });
});

test('upload_failure_continues: a sandbox that cannot start reports every file as failed without throwing', async t => {
  const f = fixture({ createError: new Error('sandbox service down') }); t.after(f.close);
  const result = await uploadRequestFiles({ store: f.store, provider: f.provider, fetcher: f.fetcher }, message);
  assert.deepEqual(result, { files: [], failed: ['report.pdf: sandbox service down', 'data.csv: sandbox service down'] });
});

test('uploaded_files appear in the request context block', () => {
  const block = contextBlock({ request: { channel_id: 'task', uploaded_files: [`${SANDBOX_HOME}/uploads/a.pdf`], upload_failed: ['b.zip: File exceeds 10 MiB'] }, people: [], evidence: [] });
  assert.match(block.content, /uploaded_files: \["\/home\/user\/uploads\/a\.pdf"\]/);
  assert.match(block.content, /upload_failed: \["b\.zip: File exceeds 10 MiB"\]/);
});

test('upload_uses_home: uploads go under the home of the profile', async t => {
  const f = fixture(); t.after(f.close);
  const profile = { template: 'base', user: 'ubuntu', home: '/home/ubuntu', os: 'Ubuntu 24.04.1 LTS', installed: [] };
  const result = await uploadRequestFiles({ store: f.store, provider: f.provider, fetcher: f.fetcher, profile }, message);
  assert.deepEqual(result, { files: ['/home/ubuntu/uploads/report.pdf', '/home/ubuntu/uploads/data.csv'], failed: [] });
  assert.ok(f.commands.includes('mkdir -p /home/ubuntu/uploads'));
});
