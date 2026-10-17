import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import { EventEmitter } from 'node:events';
import { ActionRowBuilder, ButtonBuilder, ChannelType, Collection, type AttachmentBuilder, type ButtonInteraction, type Client } from 'discord.js';
import { VoiceConnectionStatus, type joinVoiceChannel } from '@discordjs/voice';
import OpusScript from 'opusscript';
import { pcmWav } from '../src/adapters/audio.js';
import { DiscordVoice, type VoicePoster } from '../src/adapters/discord-voice.js';
import { UsageMeter } from '../src/usage-meter.js';
import { UserLimiter } from '../src/user-limiter.js';
import type { ToolDefinition, ToolRegistry, ToolContext } from '../src/tools.js';
import { loadConfig } from '../src/config.js';
import { VOICE_FILLER_GAP_MS, VOICE_FILLER_TEXTS, VOICE_INSTRUCTIONS_KEY, voiceInstructions } from '../src/voice-rules.js';


function thunderWav(): Buffer {
  const wav = pcmWav(Buffer.from([1, 0, 254, 255]));
  wav.writeUInt16LE(1, 22); wav.writeUInt32LE(24000, 24); wav.writeUInt32LE(48000, 28); wav.writeUInt16LE(2, 32);
  return wav;
}

/** Waits for a condition by yielding to the event loop. It uses no timers. */
async function until(condition: () => boolean): Promise<void> {
  for (let index = 0; index < 1000; index++) {
    if (condition()) return;
    await new Promise(resolve => setImmediate(resolve));
  }
  assert.fail('condition was not reached');
}

/** Lets pending async work finish, for checks that something did NOT happen. */
async function settle(): Promise<void> {
  for (let index = 0; index < 50; index++) await new Promise(resolve => setImmediate(resolve));
}

interface Speech { input: string; instructions?: string | undefined }
interface Sent { content?: string; files?: AttachmentBuilder[]; components?: unknown[] }

/**
 * A voice server with fake Discord objects and a stubbed AI provider. `settings` is the server store.
 * `sent` records every message the bot sends in the channel. One speaker, `user`, is in the voice channel.
 */
function rig(t: TestContext, transcript = 'Hello') {
  const speeches: Speech[] = [];
  const previous = globalThis.fetch;
  globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
    if (String(url).endsWith('transcriptions')) return Response.json({ text: transcript });
    const body = JSON.parse(String(init?.body)) as { input: string; instructions?: string };
    speeches.push({ input: body.input, instructions: body.instructions });
    return new Response(new Uint8Array(thunderWav()));
  }) as typeof fetch;
  t.after(() => { globalThis.fetch = previous; });

  const settings = new Map<string, unknown>();
  const sent: Sent[] = [];
  const posts: unknown[] = [];
  const poster: VoicePoster = { reply: async input => { posts.push(input); return { id: `web-${posts.length}`, messageId: `message-${posts.length}`, status: 'posted', via: 'bot' }; } };
  const channel = { id: 'channel', type: ChannelType.GuildVoice, isTextBased: () => true, isSendable: () => true, members: new Collection([['user', { user: { bot: false } }]]), permissionsFor: () => ({ has: () => true }), send: async (payload: Sent) => { sent.push(payload); return {}; } };
  const member = { user: { bot: false }, displayName: 'Human', voice: { channelId: channel.id, channel } };
  const guild = { id: 'guild', members: { fetch: async () => member, fetchMe: async () => ({}), cache: new Map([['user', member]]) }, channels: { cache: new Map([[channel.id, channel]]) } };
  const client = Object.assign(new EventEmitter(), { user: { id: 'bot' }, guilds: { fetch: async () => guild }, channels: { fetch: async () => channel } }) as unknown as Client;
  // Eight 20 ms frames are 160 ms of speech, which passes the 100 ms minimum.
  const codec = new OpusScript(48000, 2, OpusScript.Application.VOIP);
  const packet = codec.encode(Buffer.alloc(3840), 960);
  codec.delete();
  const receiver = Object.assign(new EventEmitter(), { speaking: new EventEmitter(), subscribe: () => {
    const stream = Object.assign(new EventEmitter(), { destroy: () => {} });
    queueMicrotask(() => { for (let index = 0; index < 8; index++) stream.emit('data', packet); stream.emit('end'); });
    return stream;
  } });
  const connection = Object.assign(new EventEmitter(), { state: { status: VoiceConnectionStatus.Ready }, receiver, subscribe: () => {}, destroy: () => {} });
  const connect = (() => connection) as unknown as typeof joinVoiceChannel;
  const config = loadConfig({ DISCORD_BOT_TOKEN: 'test', LLM_API_KEY: 'test' });
  let saves = 0;
  const voice = new DiscordVoice(client, 'guild', config, poster, new UsageMeter({ check: async () => ({ allowed: true as const }), record: async () => {}, overGrace: async () => false } as unknown as UserLimiter, () => ({}), { input: 0, output: 0, cached_input: 0 }), () => false,
    () => voiceInstructions(settings.get(VOICE_INSTRUCTIONS_KEY) as string | undefined, config.voice?.instructions),
    value => { saves++; settings.set(VOICE_INSTRUCTIONS_KEY, value); }, connect);
  t.after(() => voice.stop());
  let tool!: ToolDefinition;
  voice.register({ register: (definition: ToolDefinition) => { tool = definition; } } as unknown as ToolRegistry);
  const context = (isAdmin: boolean): ToolContext => ({ message: { author: 'user', channel: channel.id }, isAdmin } as ToolContext);
  const talk = () => connection.receiver.speaking.emit('start', 'user');
  return { voice, tool, context, speeches, settings, sent, posts, talk, join: () => tool.execute(context(false), { action: 'join' }), saves: () => saves, client, channel };
}

function click(r: ReturnType<typeof rig>, action: 'apply' | 'cancel', options: { admin: boolean; user?: string }) {
  const post = r.sent.filter(payload => payload.content?.startsWith('Proposed voice:')).at(-1)!;
  const buttons = (post.components![0] as ActionRowBuilder<ButtonBuilder>).toJSON().components as { custom_id: string }[];
  const replies: { content: string }[] = [], updates: { content?: string; components?: unknown[] }[] = [];
  const interaction = {
    customId: buttons.find(button => button.custom_id.endsWith(`:${action}`))!.custom_id, guildId: 'guild', user: { id: options.user ?? 'user' },
    memberPermissions: { has: () => options.admin },
    reply: async (value: { content: string }) => { replies.push(value); }, update: async (value: { content?: string; components?: unknown[] }) => { updates.push(value); },
  } as unknown as ButtonInteraction;
  return { interaction, replies, updates };
}

test('style by non-admin fails', async t => {
  const r = rig(t);
  await assert.rejects(r.tool.execute(r.context(false), { action: 'style', instructions: 'A deep voice.' }), /Only server admins can change the voice\./);
  assert.equal(r.settings.has(VOICE_INSTRUCTIONS_KEY), false);
  assert.equal(r.speeches.length, 0);
  assert.equal(r.saves(), 0);
});

test('style rejects text over the limit', async t => {
  const r = rig(t);
  await assert.rejects(r.tool.execute(r.context(true), { action: 'style', instructions: 'x'.repeat(1001) }), /1000 characters/);
  assert.equal(r.saves(), 0);
});

test('apply by non-admin is refused', async t => {
  const r = rig(t);
  await r.tool.execute(r.context(false), { action: 'propose', instructions: 'A bright young woman.' });
  const apply = click(r, 'apply', { admin: false });
  await r.voice.button(apply.interaction);
  assert.equal(apply.replies[0]?.content, 'Only server admins can apply a voice.');
  assert.equal(apply.updates.length, 0);
  assert.equal(r.saves(), 0);
  // The proposal is still open for an admin.
  const admin = click(r, 'apply', { admin: true, user: 'admin' });
  await r.voice.button(admin.interaction);
  assert.equal(r.saves(), 1);
});

test('cancel by a stranger is refused; cancel by proposer closes proposal', async t => {
  const r = rig(t);
  await r.tool.execute(r.context(false), { action: 'propose', instructions: 'A calm voice.' });
  const stranger = click(r, 'cancel', { admin: false, user: 'someone' });
  await r.voice.button(stranger.interaction);
  assert.match(stranger.replies[0]!.content, /Only server admins or the proposer/);
  const proposer = click(r, 'cancel', { admin: false, user: 'user' });
  await r.voice.button(proposer.interaction);
  assert.deepEqual(proposer.updates[0], { content: 'Proposal cancelled.', components: [] });
  assert.equal(r.saves(), 0);
});

test('proposal expires after 15 minutes', async t => {
  t.mock.timers.enable({ apis: ['Date'] });
  const r = rig(t);
  await r.tool.execute(r.context(false), { action: 'propose', instructions: 'A calm voice.' });
  t.mock.timers.tick(15 * 60_000 + 1);
  const apply = click(r, 'apply', { admin: true, user: 'admin' });
  await r.voice.button(apply.interaction);
  assert.equal(apply.updates[0]?.content, 'Voice proposal expired.');
  assert.equal(r.saves(), 0);
});

test('filler cache follows instructions change', async t => {
  const r = rig(t);
  r.settings.set(VOICE_INSTRUCTIONS_KEY, 'Voice A.');
  await r.join();
  r.talk();
  await until(() => r.posts.length === 1);
  r.voice.checkFiller('channel', Date.now() + VOICE_FILLER_GAP_MS);
  await settle();
  await r.voice.speak('channel', 'Done.');
  // The setting changes. The next filler is made again with the new voice.
  r.settings.set(VOICE_INSTRUCTIONS_KEY, 'Voice B.');
  r.talk();
  await until(() => r.posts.length === 2);
  r.voice.checkFiller('channel', Date.now() + VOICE_FILLER_GAP_MS);
  await settle();
  assert.deepEqual(r.speeches.map(speech => `${speech.input}|${speech.instructions}`), [`${VOICE_FILLER_TEXTS[0]}|Voice A.`, 'Done.|Voice A.', `${VOICE_FILLER_TEXTS[0]}|Voice B.`]);
});
