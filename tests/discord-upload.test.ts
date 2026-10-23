import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { REST } from 'discord.js';

// The bot sends uploads through discord.js REST (multipart). A local server stands in for the Discord API.
test('discord_upload_with_file_builds_formdata', async () => {
  const requests: { url: string | undefined; contentType: string | undefined; body: Buffer }[] = [];
  const server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', chunk => chunks.push(chunk));
    req.on('end', () => {
      requests.push({ url: req.url, contentType: req.headers['content-type'], body: Buffer.concat(chunks) });
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id: '111111111111111111', channel_id: '222222222222222222', content: 'hi', attachments: [] }));
    });
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const rest = new REST({ api: `http://127.0.0.1:${port}`, version: '10' }).setToken('test-only');
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);
    const reply = await rest.post('/channels/222222222222222222/messages', {
      body: { content: 'with file' },
      files: [{ name: 'shot.png', data: bytes, contentType: 'image/png' }],
    }) as { id: string };
    assert.equal(reply.id, '111111111111111111');
    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.equal(request!.url, '/v10/channels/222222222222222222/messages');
    assert.match(request!.contentType ?? '', /^multipart\/form-data; boundary=/);
    assert.ok(request!.body.includes(bytes), 'the file bytes are in the multipart body');
    assert.ok(request!.body.includes('filename="shot.png"'));
    assert.ok(request!.body.includes('with file'));
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
