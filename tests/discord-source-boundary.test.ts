import { test } from 'node:test';
import { readdirSync, readFileSync } from 'node:fs';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { ChannelType, type Client, type Message as DiscordMessage } from 'discord.js';
import { DiscordServer } from '../src/clients/discord/discord.js';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { loadConfig } from '../src/config.js';

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


const srcRoot = new URL('../../src/', import.meta.url);

/** Every import/export/dynamic-import specifier in the .ts files under src/<dir>, as [file, specifier]. */
function specifiers(dir: string): Array<[string, string]> {
  const out: Array<[string, string]> = [];
  for (const entry of readdirSync(new URL(dir, srcRoot), { recursive: true, encoding: 'utf8' })) {
    if (!entry.endsWith('.ts')) continue;
    const file = `${dir}${entry}`;
    const text = readFileSync(new URL(file, srcRoot), 'utf8');
    for (const m of text.matchAll(/(?:from\s+|import\s*\(\s*|import\s+)['"]([^'"]+)['"]/g)) out.push([file, m[1]!]);
  }
  return out;
}

/** Repo-relative path (under src/) a relative specifier points at, or undefined for packages. */
function target(file: string, specifier: string): string | undefined {
  if (!specifier.startsWith('.')) return undefined;
  return new URL(specifier, new URL(file, srcRoot)).href.slice(srcRoot.href.length);
}

test('the engine imports nothing from the clients, discord.js or node:http', () => {
  const imports = specifiers('engine/');
  assert.ok(imports.length > 0);
  for (const [file, spec] of imports) {
    assert.doesNotMatch(spec, /^(?:discord\.js|node:http|http)$/, `${file} imports ${spec}`);
    assert.ok(!target(file, spec)?.startsWith('clients/'), `${file} imports ${spec}`);
  }
});

test('the Discord and web clients do not import each other', () => {
  const found = new Set<string>();
  for (const [from, other] of [['clients/discord/', 'clients/web/'], ['clients/web/', 'clients/discord/']] as const) {
    for (const [file, spec] of specifiers(from)) {
      const to = target(file, spec);
      if (to?.startsWith(other)) found.add(`${file} -> ${to}`);
    }
  }
  assert.deepEqual([...found].sort(), []);
});
