import { test } from 'node:test';
import assert from 'node:assert/strict';
import { tablesToLists, discordPresentation, suppressLinkPreviews } from '../src/presentation/discord.js';

test('multiple links suppress previews while single links and code examples do not', () => {
  assert.equal(suppressLinkPreviews('See https://example.com'),false);
  assert.equal(suppressLinkPreviews('[One](https://example.com) and [Two](https://example.org)'),true);
  assert.equal(suppressLinkPreviews('https://example.com\n`https://example.org`'),false);
  assert.equal(suppressLinkPreviews('```\nhttps://example.com https://example.org\n```'),false);
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

test('Discord tables become labelled list rows and literal code stays unchanged', () => {
  const cases: [string, string][] = [
    ['| Item | Cost |\n| :--- | ---: |\n| A \\| B | $2 |\n| `x|y` | $3 |', '- **Item:** A | B; **Cost:** $2\n- **Item:** `x|y`; **Cost:** $3'],
    ['Name | Value\n--- | ---\nA |', '- **Name:** A; **Value:** (empty)'],
    ['```md\n| A | B |\n| --- | --- |\n| x | y |\n```\nUse a | b.\n~~~\nA | B\n--- | ---\nx | y\n~~~', '```md\n| A | B |\n| --- | --- |\n| x | y |\n```\nUse a | b.\n~~~\nA | B\n--- | ---\nx | y\n~~~'],
  ];
  for (const [input, expected] of cases) assert.equal(tablesToLists(input), expected);
});
