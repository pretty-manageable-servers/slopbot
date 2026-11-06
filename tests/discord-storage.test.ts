import assert from 'node:assert/strict';
import { test } from 'node:test';
import type { Client } from 'discord.js';
import { sendStoredFile } from '../src/adapters/discord-storage.js';
import type { ToolContext } from '../src/tools.js';
const file = { owner: 'owner', path: 'reports/file.bin', key: 'hidden', size: 3, contentType: 'application/octet-stream', public: true, updatedAt: 0 };
const context: ToolContext = { message: { server: 'server', channel: 'thread', id: 'request', author: 'requester', text: 'send it' }, operationId: 'operation', isAdmin: false, source: 'agent', toolName: 'file_store', arguments: { action: 'send' }, resource: null, assertActive: async () => {} };

test('file delivery DMs the requester with original bytes and a stable nonce, without mentioning anyone', async () => {
  const bytes = new Uint8Array([0, 255, 128]);
  const payloads: any[] = [];
  const client = { users: { fetch: async (id: string) => { assert.equal(id, 'requester'); return { send: async (payload: unknown) => { payloads.push(payload); } }; } } } as unknown as Client;
  await sendStoredFile(client, context, file, bytes);
  await sendStoredFile(client, context, file, bytes);
  assert.deepEqual(payloads[0].files[0].attachment, Buffer.from(bytes));
  assert.equal(payloads[0].files[0].name, 'file.bin'); assert.deepEqual(payloads[0].allowedMentions, { parse: [] });
  assert.equal(payloads[0].nonce, payloads[1].nonce); assert.equal(payloads[0].enforceNonce, true);
});

test('an interrupted request never fetches a Discord recipient or sends a file', async () => {
  const client = { users: { fetch: async () => { throw Error('must not fetch'); } } } as unknown as Client;
  await assert.rejects(sendStoredFile(client, { ...context, assertActive: async () => { throw Error('interrupted'); } }, file, new Uint8Array()), /interrupted/);
});
