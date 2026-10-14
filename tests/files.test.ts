import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { zipSync, strToU8 } from 'fflate';
import { defaultFileReaders } from '../src/adapters/file-readers.js';
import { DiscordFileFetcher, WorkerFileDecoder, inspectFile } from '../src/files.js';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { ToolError } from '../src/tools.js';
import { wireMessages } from '../src/adapters/chat-completions.js';
import type { LLM } from '../src/ports.js';
test('GIF reader samples ordered frames and worker decodes text', async () => {
  const gif = await sharp(Buffer.from([255,0,0,0,0,255]), { raw: { width: 1, height: 2, channels: 3, pageHeight: 1 } }).gif({ delay: [100,200] }).toBuffer();
  const value = await defaultFileReaders().read('motion.gif','image/gif',gif);
  assert.equal(value.images.length,2); assert.match(value.images[1]!.label,/100 ms/);
  const first = await sharp(Buffer.from(value.images[0]!.url.split(',')[1]!, 'base64')).raw().toBuffer();
  const last = await sharp(Buffer.from(value.images[1]!.url.split(',')[1]!, 'base64')).raw().toBuffer();
  assert.ok(first[0]! > first[2]!); assert.ok(last[2]! > last[0]!);
  assert.equal((await new WorkerFileDecoder().read('a.txt','text/plain',strToU8('hello'))).text,'hello');
});
test('documents extract DOCX text and reject excessive zip expansion', async () => {
  const zip = zipSync({ '[Content_Types].xml': strToU8('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>'), 'word/document.xml': strToU8('<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>Oscar text</w:t></w:r></w:p></w:body></w:document>') });
  assert.match((await defaultFileReaders().read('a.docx','',zip)).text,/Oscar text/);
  await assert.rejects(defaultFileReaders().read('a.docx','',zipSync({ 'bomb': new Uint8Array(25*1024*1024) })),/expands/);
});
test('downloads reject arbitrary hosts, redirect SSRF and oversize streams', async () => {
  const attachment = { name:'a.txt',url:'https://cdn.discordapp.com/a' };
  await assert.rejects(new DiscordFileFetcher().fetch({...attachment,url:'https://localhost/a'}),/hosts/);
  await assert.rejects(new DiscordFileFetcher(async () => new Response(null,{status:302,headers:{location:'http://127.0.0.1'}})).fetch(attachment),/hosts/);
  await assert.rejects(new DiscordFileFetcher(async () => new Response('a',{headers:{'content-length':String(11*1024*1024)}})).fetch(attachment),/10 MiB/);
});
test('XLSX reads cached cells and PDF extracts text', async () => {
  const { default: ExcelJS } = await import('exceljs');
  const book = new ExcelJS.Workbook(); book.addWorksheet('People').addRow(['Oscar',42]);
  const xlsx = await book.xlsx.writeBuffer();
  assert.match((await defaultFileReaders().read('a.xlsx','',new Uint8Array(xlsx))).text,/Oscar\t42/);
  const content = 'BT /F1 12 Tf 10 50 Td (Oscar PDF) Tj ET';
  const objects = ['<< /Type /Catalog /Pages 2 0 R >>','<< /Type /Pages /Kids [3 0 R] /Count 1 >>','<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 100] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>','<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',`<< /Length ${content.length} >>\nstream\n${content}\nendstream`];
  let pdf='%PDF-1.4\n'; const offsets=[0];
  objects.forEach((object,index)=>{offsets.push(Buffer.byteLength(pdf));pdf+=`${index+1} 0 obj\n${object}\nendobj\n`;});
  const xref=Buffer.byteLength(pdf); pdf+=`xref\n0 6\n0000000000 65535 f \n${offsets.slice(1).map(offset=>String(offset).padStart(10,'0')+' 00000 n \n').join('')}trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  assert.match((await defaultFileReaders().read('a.pdf','application/pdf',Buffer.from(pdf))).text,/Oscar PDF/);
});

 test('Klipy GIF media is allowed without permitting lookalike hosts', async () => {
   let calls = 0;
   const fetcher = new DiscordFileFetcher(async () => { calls++; return new Response('webp bytes'); });
   const file = { name: 'animation.webp', url: 'https://static.klipy.com/ii/example/animation.webp' };
   assert.equal(new TextDecoder().decode(await fetcher.fetch(file)), 'webp bytes');
   await assert.rejects(fetcher.fetch({ ...file, url: 'https://static.klipy.com.attacker.example/animation.webp' }), /hosts/);
   assert.equal(calls, 1);
   const webp = await sharp(Buffer.from([255,0,0,0,0,255]), { raw: { width:1, height:2, channels:3, pageHeight:1 } }).webp({ delay:[100,200] }).toBuffer();
   assert.equal((await defaultFileReaders().read('animation.webp', 'image/webp', webp)).images.length, 2);
 });
test('Discord external media proxies are allowed with exact host checks', async () => {
  const fetcher = new DiscordFileFetcher(async () => new Response('image'));
  for (const host of ['images-ext-1.discordapp.net', 'images-ext-2.discordapp.net']) {
    assert.equal((await fetcher.fetch({name:'a.webp',url:`https://${host}/external/example/image.webp`})).length,5);
  }
  await assert.rejects(fetcher.fetch({name:'a.webp',url:'https://images-ext-1.discordapp.net.attacker.example/a.webp'}),/hosts/);
});
test('stored-file inspection works without a Discord attachment source and checks current authorization', async t => {
  const { inspectFile } = await import('../src/files.js');
  const store = new SQLiteStore(); t.after(() => store.close());
  const message = { id: 'request', server: 's', channel: 'c', author: 'a', text: 'inspect my stored file' };
  await store.ingest(message); let currentChecks = 0;
  const llm: LLM = { outputTokenLimit: 32000, contextTokenLimit: 64000, async *stream(prompt) {
    assert.equal(prompt.purpose, 'inspection'); assert.equal(prompt.maxOutputTokens, 32000);
    assert.match(prompt.prefix[0]!.content, /untrusted evidence/); assert.match(prompt.inputs[0]!.content, /saved image/);
    assert.ok(Array.isArray(wireMessages(prompt)[1]!.content));
    yield { kind: 'text', payload: { text: 'A red image.' } };
  } };
  const result = await inspectFile({ store, llm, decoder: { read: async () => ({ text: 'saved image', images: [{ url: 'data:image/png;base64,AA==', label: 'image' }] }) }, assertCurrent: async () => { currentChecks++; } }, { message, operationId: 'stored-inspection', isAdmin: false, source: 'agent', toolName: 'file_store', arguments: {}, resource: null, assertActive: async () => {} }, 'saved.png', 'image/png', new Uint8Array(), 'Describe it');
  assert.equal(result, 'A red image.'); assert.equal(currentChecks, 1);
});

test('unknown file types point to file_store to_sandbox', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const message = { id: 'request', server: 's', channel: 'c', author: 'a', text: 'what is inside' };
  await store.ingest(message);
  const llm: LLM = { outputTokenLimit: 32000, contextTokenLimit: 64000, async *stream() { yield { kind: 'text', payload: { text: 'unused' } }; } };
  const context = { message, operationId: 'inspect', isAdmin: false, source: 'agent' as const, toolName: 'file_store', arguments: {}, resource: null, assertActive: async () => {} };
  await assert.rejects(inspectFile({ store, llm, decoder: { read: async () => { throw new Error('Unsupported file format. Use text, PDF, DOCX, XLSX, PNG, JPEG, WebP or GIF.'); } } }, context, 'bundle.zip', 'application/zip', new Uint8Array([80, 75]), 'What is inside?'),
    (error: unknown) => error instanceof ToolError && /to_sandbox/.test(error.message));
});
