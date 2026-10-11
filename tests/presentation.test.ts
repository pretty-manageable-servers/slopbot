import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tablesToLists, discordPresentation, suppressLinkPreviews } from '../src/presentation/discord.js';
import { ReplyRenderer } from '../src/reply-renderer.js';
import { formatReply, presentationInstructions } from '../src/presentation/policy.js';

test('multiple links suppress previews while single links and code examples do not', () => {
  assert.equal(suppressLinkPreviews('See https://example.com'),false);
  assert.equal(suppressLinkPreviews('[One](https://example.com) and [Two](https://example.org)'),true);
  assert.equal(suppressLinkPreviews('https://example.com\n`https://example.org`'),false);
  assert.equal(suppressLinkPreviews('```\nhttps://example.com https://example.org\n```'),false);
});

test('Discord tables become labelled list rows, including aligned columns and escaped pipes', () => {
  const result=tablesToLists('| Item | Cost |\n| :--- | ---: |\n| A \\| B | $2 |\n| `x|y` | $3 |');
  assert.equal(result,'- **Item:** A | B; **Cost:** $2\n- **Item:** `x|y`; **Cost:** $3');
});
test('literal code and ordinary pipe text are preserved', () => {
  const text='```md\n| A | B |\n| --- | --- |\n| x | y |\n```\nUse a | b.\n~~~\nA | B\n--- | ---\nx | y\n~~~';
  assert.equal(tablesToLists(text),text);
});
test('tables without outer pipes and empty cells retain their labels', () => {
  assert.equal(tablesToLists('Name | Value\n--- | ---\nA |'),'- **Name:** A; **Value:** (empty)');
});
test('format rules compose, while verbatim replies bypass presentation', async () => {
  const table='| A | B |\n| --- | --- |\n| x | y |';
  const renderer=new ReplyRenderer(undefined,discordPresentation);
  assert.match(await renderer.render('server',table),/^- \*\*A:/);
  assert.equal(await renderer.render('server',table,true),table);
  const policy={id:'custom',rules:[{id:'first',instruction:'First',apply:(text:string)=>text+'1'},{id:'second',instruction:'Second',apply:(text:string)=>text+'2'}]};
  assert.equal(formatReply('x',policy),'x12');assert.equal(presentationInstructions(policy),'First\nSecond');
});

test('Discord presentation guidance stays in the stable prompt prefix', async () => {
  const {Application}=await import('../src/application.js');
  const {SQLiteStore}=await import('../src/adapters/sqlite.js');
  const prefixes:string[]=[];
  const store=new SQLiteStore();
  try {
    const app=new Application(store,{async *stream(prompt){prefixes.push(JSON.stringify(prompt.prefix));yield {kind:'text',payload:{text:'OK'}};}},{allowedChannels:[{server:'s',channel:'c'}]},undefined,{presentation:discordPresentation});
    for(const id of ['one','two']) await app.handle({server:'s',channel:'c',author:'person',id,text:'Compare options',addressed:true});
    assert.match(prefixes[0]!,/Markdown tables do not render/);
    assert.equal(prefixes[0],prefixes[1]);
  } finally {store.close();}
});
