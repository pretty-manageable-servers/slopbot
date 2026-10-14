import assert from 'node:assert/strict';
import { test } from 'node:test';
import sharp from 'sharp';
import { zipSync, strToU8 } from 'fflate';
import { defaultFileReaders } from '../src/adapters/file-readers.js';
import { DiscordFileFetcher, WorkerFileDecoder, registerFileTool } from '../src/files.js';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { ToolError, ToolRegistry } from '../src/tools.js';
import { wireMessages } from '../src/adapters/chat-completions.js';
import type { LLM } from '../src/ports.js';
import type { ObjectStorageProvider } from '../src/object-storage.js';
import { ChatFileFetcher, fileUrl } from '../src/web-chat-files.js';

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
test('file tool retains reasoning, sends vision parts, and links source', async t => {
  const store = new SQLiteStore(); t.after(()=>store.close());
  const source = {id:'file',server:'s',channel:'c',author:'a',text:'file',attachments:[{name:'a.png',url:'https://cdn.discordapp.com/a'}]};
  const request = {id:'request',server:'s',channel:'c',author:'a',text:'what is this',replyTo:'file'};
  await store.ingest(source); await store.ingest(request);
  let inspected = false;
  const llm: LLM = { outputTokenLimit: 32000, contextTokenLimit: 64000, async *stream(prompt) { inspected = true; assert.equal(prompt.maxOutputTokens,32000); assert.equal(prompt.purpose,'inspection'); assert.ok(Array.isArray(wireMessages(prompt)[1]!.content)); yield {kind:'reasoning',payload:{text:'retained'}}; yield {kind:'text',payload:{text:'Red image'}}; } };
  const registry = new ToolRegistry(store,async()=>false);
  registerFileTool(registry,{store,llm,resolve:async()=>source,fetcher:{fetch:async()=>new Uint8Array()},decoder:{read:async()=>({text:'still',images:[{url:'data:image/png;base64,AA==',label:'frame'}]})}});
  const result=await registry.invokeResult(request,'file_read',{},'inspection','agent');
  const answer=result.text;
  assert.ok(inspected); assert.match(answer,/Red image/); assert.match(answer,/\/s\/c\/file/);
  await store.startRun('reply',request,{prefixVersion:'v',prefix:[],history:[],inputs:[]});
  await store.recordSources('reply','s',['request',...(result.sources ?? []).flatMap(source=>source.kind==='message' ? [source.id] : [])]);
  const output={...request,id:'output',text:answer}; await store.ingest(output); await store.linkOutput(output,'reply','request');
  await store.remove('s','c','file'); assert.equal(store.canonicalMessage('s','output'),undefined);
  assert.ok(store.canonicalMessage('s','request'));
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
test('mention-only attachment requests select file inspection', () => {
  const store = new SQLiteStore();
  try {
    const registry=new ToolRegistry(store,async()=>false);
    registerFileTool(registry,{store,llm:{async *stream(){}},resolve:async message=>message});
    assert.equal(registry.suggest({id:'m',server:'s',channel:'c',author:'a',text:'[Attachment a.webp, type unknown: https://media.discordapp.net/a.webp; content not inspected]',attachments:[{name:'a.webp',url:'https://media.discordapp.net/a.webp'}]})?.arguments.question,'Describe this file and explain its likely meaning.');
  } finally {store.close();}
});

test('attachment save, send and sandbox requests reach the agent instead of stopping at an inspection shortcut', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const registry = new ToolRegistry(store, async () => false);
  registerFileTool(registry, { store, llm: { async *stream() {} }, resolve: async message => message });
  for (const text of ['save this attachment as reports/result.csv', 'summarize this and store the report', 'send this file back to me', 'import this into the sandbox', 'run this script']) {
    assert.equal(registry.suggest({ id: 'request', server: 's', channel: 'c', author: 'a', text, attachments: [{ name: 'file.csv', url: 'https://cdn.discordapp.com/file' }] }), undefined);
  }
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

function chatStorage(bytes: Uint8Array, keys: string[]): ObjectStorageProvider {
  return { put: async () => {}, get: async key => { keys.push(key); return bytes; }, delete: async () => {}, link: async () => '' };
}

test('file_read reads web-file text', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const fileId = `${'0'.repeat(32)}.txt`;
  const source = { id: 'file', server: 's', channel: 'c', author: 'a', text: 'file', attachments: [{ name: 'notes.txt', url: fileUrl('s', 'c', fileId), contentType: 'text/plain', size: 5 }] };
  const request = { id: 'request', server: 's', channel: 'c', author: 'a', text: 'what does it say', replyTo: 'file' };
  await store.ingest(source); await store.ingest(request);
  const keys: string[] = [], decoded: string[] = [];
  const llm: LLM = { outputTokenLimit: 32000, contextTokenLimit: 64000, async *stream() { yield { kind: 'text', payload: { text: 'It says hello.' } }; } };
  const registry = new ToolRegistry(store, async () => false);
  registerFileTool(registry, { store, llm, resolve: async () => source, fetcher: new ChatFileFetcher(chatStorage(new TextEncoder().encode('hello'), keys), { fetch: async () => { throw new Error('inner fetcher must not run for web-file'); } }), decoder: { read: async (_name, _mime, data) => { decoded.push(new TextDecoder().decode(data)); return { text: 'hello', images: [] }; } } });
  const result = await registry.invokeResult(request, 'file_read', {}, 'inspection', 'agent');
  assert.match(result.text, /It says hello\./);
  assert.deepEqual(keys, [`web-chat-files/s/c/${fileId}`]);
  assert.deepEqual(decoded, ['hello']);
});

test('file_read unknown type says use sandbox', async t => {
  const store = new SQLiteStore(); t.after(() => store.close());
  const fileId = `${'2'.repeat(32)}.zip`;
  const source = { id: 'file', server: 's', channel: 'c', author: 'a', text: 'file', attachments: [{ name: 'bundle.zip', url: fileUrl('s', 'c', fileId), contentType: 'application/zip', size: 5 }] };
  const request = { id: 'request', server: 's', channel: 'c', author: 'a', text: 'what is inside', replyTo: 'file' };
  await store.ingest(source); await store.ingest(request);
  const llm: LLM = { outputTokenLimit: 32000, contextTokenLimit: 64000, async *stream() { yield { kind: 'text', payload: { text: 'unused' } }; } };
  const registry = new ToolRegistry(store, async () => false);
  registerFileTool(registry, { store, llm, resolve: async () => source, fetcher: new ChatFileFetcher(chatStorage(new Uint8Array([80, 75]), []), { fetch: async () => new Uint8Array() }), decoder: { read: async () => { throw new Error('Unsupported file format. Use text, PDF, DOCX, XLSX, PNG, JPEG, WebP or GIF.'); } } });
  await assert.rejects(registry.invokeResult(request, 'file_read', {}, 'inspection', 'agent'), (error: unknown) => error instanceof ToolError && error.message === 'file_read cannot read this type. Use sandbox import_attachment.');
});
