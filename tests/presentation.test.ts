import { test } from 'node:test';
import assert from 'node:assert/strict';
import { discordPresentation } from '../src/presentation/discord.js';

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
