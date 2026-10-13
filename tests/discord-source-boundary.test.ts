import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChannelType, type Client, type Message as DiscordMessage } from 'discord.js';
import { DiscordServer } from '../src/adapters/discord.js';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { loadConfig } from '../src/config.js';
import { describeError } from '../src/errors.js';

const guild = '1528063444874432734', channel = '1528064977913647236', bot = '1514413259522838528';
function fixture(fresh: { content: string; url: string; size?: number; author?: string }) {
  const message = { id: 'source', content: fresh.content, guildId: guild, channelId: channel,
    author: { id: fresh.author ?? 'person', username: 'person', bot: fresh.author === bot }, member: null, guild: { name: 'Server' }, createdTimestamp: 1,
    attachments: new Map([['file', { name: 'sample.txt', url: fresh.url, size: fresh.size ?? 13, contentType: 'text/plain' }]]), embeds: [], reference: null };
  const permissions = { has: () => true };
  const target = { type: ChannelType.GuildText, guildId: guild, isThread: () => false, isTextBased: () => true, isSendable: () => true, send: async () => ({...message, id:'reply', author:{...message.author,id:bot,bot:true}}), permissionsFor: () => permissions, messages: { fetch: async () => message } };
  const client = Object.assign(new EventEmitter(), { user: { id: bot }, channels: { fetch: async () => target }, guilds: { fetch: async () => ({ members: { fetch: async () => ({ permissions }), fetchMe: async () => ({ permissions }) } }) } });
  const config = loadConfig({ DISCORD_BOT_TOKEN: 'test-only', DISCORD_GUILD_ID: guild, DISCORD_CHANNEL_IDS: channel, LLM_MODE: 'mock' });
  const store = new SQLiteStore(); let generations = 0;
  const adapter = new DiscordServer(config, store, { async *stream() { generations++; yield { kind: 'text', payload: { text: 'File report.' } }; } }, client as unknown as Client, guild, undefined);
  return { adapter, store, message, target, generations: () => generations };
}

for (const changed of ['caption', 'attachment']) test(`file source ${changed} change alone stops the stale inspection before generation`, async t => {
  const oldFetch = globalThis.fetch;
  globalThis.fetch = async () => new Response('safe evidence');
  const f = fixture({ content: changed === 'caption' ? 'new caption' : 'original caption', url: 'https://cdn.discordapp.com/attachments/a/old.txt', size: changed === 'attachment' ? 24 : 13 });
  t.after(() => { f.store.close(); globalThis.fetch = oldFetch; });
  const original = { id: 'source', server: guild, channel, author: 'person', text: 'original caption\n[Attachment sample.txt, type text/plain: https://cdn.discordapp.com/attachments/a/old.txt; content not inspected]', timestamp: 1,
    attachments: [{ name: 'sample.txt', url: 'https://cdn.discordapp.com/attachments/a/old.txt', size: 13, contentType: 'text/plain' }] };
  await f.store.ingest(original);
  const request = { ...original, id: 'request', text: 'Inspect the file', replyTo: 'source', attachments: [] };
  await f.store.ingest(request);
  await assert.rejects(f.adapter['tools'].invokeResult(request, 'file_read', {}, 'inspect', 'agent'), error => describeError(error).code === 'CONTEXT_CHANGED');
  assert.equal(f.generations(), 0);
});

test('Discord normalization marks its own progress UI transient and keeps human text semantic', t => {
  const f = fixture({ content: '**Working**\n1. `history_read`: running', url: 'https://cdn.discordapp.com/a/file.txt', author: bot });
  t.after(() => f.store.close());
  const normalized = f.adapter['normalize'](f.message as unknown as DiscordMessage);
  assert.ok('transient' in normalized && normalized.transient === true);
  const human = f.adapter['normalize']({ ...f.message, author: { ...f.message.author, id: 'person', bot: false } } as unknown as DiscordMessage);
  assert.ok(!('transient' in human) || human.transient !== true);
});

test('an automatic image preview does not invalidate unchanged human instructions', async t => {
  const f = fixture({ content: 'See https://example.com/image', url: 'https://cdn.discordapp.com/attachments/a/file.txt' });
  t.after(() => f.store.close());
  const original = f.adapter['normalize'](f.message as unknown as DiscordMessage);
  await f.store.ingest(original); const turn = f.store.addAgentTurn(original, '', [{ name: 'read', arguments: {} }]);
  const enriched = { ...f.message, embeds: [{ type: 'image', image: { url: 'https://cdn.discordapp.com/preview.png' } }] };
  await f.store.revise(f.adapter['normalize'](enriched as unknown as DiscordMessage));
  assert.equal(f.store.agentTurns(original)[0]?.id, turn.id);
});

test('final error reply removes progress even without activity footer', async t => {
 const f=fixture({content:'request',url:'https://cdn.discordapp.com/a.txt'}); t.after(()=>f.store.close());
 let finished=false; f.adapter['toolProgress'].finish=async()=>{finished=true;};
 await f.adapter.reply({id:'request',server:guild,channel,author:'person',text:'request'},'[CONTEXT_CHANGED] source changed');
 assert.equal(finished,true);
});


for (const id of ['task-seed:source', 'command:reminder:source', 'source']) test(`live status uses valid reply references for ${id}`, async t => {
  const f = fixture({content:'request',url:'https://cdn.discordapp.com/a.txt'});
  t.after(() => f.store.close());
  const thread = '1528064977913647299';
  f.adapter['bot']['tasks'].add(thread);
  const payloads: {content:string; reply?:unknown}[] = [];
  t.mock.method(f.target, 'send', async (payload: {content:string; reply?:unknown}) => {
    payloads.push(payload);
    return {async edit() {}, async delete() {}};
  });
  const observer = f.adapter['app']['runner']['services'].onToolActivity!;
  await observer({id,server:guild,channel:thread,author:'person',text:'request',taskId:thread},
    {id:'call',name:'web_search',status:'running',arguments:{query:'weather'}});
  assert.equal(payloads.length, 1);
  assert.match(payloads[0]!.content, /"query": "weather"/);
  assert.equal(Boolean(payloads[0]!.reply), id === 'source');
});
