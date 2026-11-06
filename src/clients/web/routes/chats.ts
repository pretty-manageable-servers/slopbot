import { Hono } from 'hono';
import { z } from 'zod';
import { logError } from '../../../errors.js';
import { ShareError } from '../../../shares.js';
import { ChatError, type WebChatService } from '../web-chats.js';
import { CHAT_FILE_MAX_BYTES } from '../../../web-chat-files.js';
import { declaredTooLarge, looseBody, readBytes, readJson } from '../body.js';
import { alreadySent, applyOut, failure, json, notFound, userOf, type WebEnv } from '../env.js';

/** The private chat routes, mounted at /api/chats. The console checks the session, the Origin and the CSRF token before them. */
export type ChatRoutes = Hono<WebEnv>;

const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const JSON_MAX_BYTES = 65536;
const record = z.record(z.string(), z.unknown());
const patchBody = z.object({ effort: z.unknown().optional(), title: z.unknown().optional() });
const createBody = z.object({ server: z.unknown().optional() });
const sendBody = z.object({ text: z.unknown().optional(), images: z.unknown().optional(), files: z.unknown().optional() });

export function chatRoutes(service: WebChatService): ChatRoutes {
  const app = new Hono<WebEnv>();
  app.onError((error, c) => failure(c, () => {
    if (error instanceof ChatError) return json(error.status, { error: error.message, ...(error.resetAt !== undefined ? { resetAt: error.resetAt } : {}) });
    if (error instanceof ShareError) return json(error.status, { error: error.message });
    logError('web_chat_failed', error, { stage: 'web chats' });
    return json(502, { error: 'Could not complete this chat request.' });
  }));

  // Reads the body of a write once: raw bytes for the upload routes, JSON for the others, nothing for DELETE.
  app.use('*', async (c, next) => {
    if (c.req.method === 'GET') return next();
    const path = c.req.path;
    const upload = c.req.method === 'POST' ? /^\/api\/chats\/[^/]+\/(images|files)$/.exec(path)?.[1] : undefined;
    if (upload) {
      const images = upload === 'images', limit = images ? IMAGE_MAX_BYTES : CHAT_FILE_MAX_BYTES;
      const tooLarge = json(413, { error: images ? 'Images can be 25 MB or smaller.' : 'Files can be 10 MB or smaller.' });
      if (images && !c.req.header('content-type')?.startsWith('image/')) return json(415, { error: 'Send an image.' });
      if (declaredTooLarge(c, limit)) return tooLarge;
      // Past the limit nothing is kept. The rest of the body is read and dropped, so the 413 reaches the client.
      const bytes = await readBytes(c, limit, true);
      if (bytes === 'too-large') return tooLarge;
      c.set('body', bytes);
    } else if (c.req.method !== 'DELETE') {
      const body = await readJson(c, JSON_MAX_BYTES, true);
      if ('error' in body) return body.error;
      c.set('body', body.value);
    }
    return next();
  });

  app.get('/', async c => json(200, await service.list(userOf(c))));
  app.post('/', async c => json(201, await service.create(userOf(c), String(createBody.parse(looseBody(c.get('body'))).server ?? ''))));

  app.post('/:id/images', async c => json(201, await service.uploadImage(userOf(c), c.req.param('id'), c.get('body') as Buffer, c.req.query('name') ?? null)));
  app.delete('/:id/images/:image', async c => { await service.discardImage(userOf(c), c.req.param('id'), c.req.param('image')); return json(200, { ok: true }); });
  app.get('/:id/images/:image', async c => {
    const image = await service.readImage(userOf(c), c.req.param('id'), c.req.param('image'));
    return new Response(image.bytes as BodyInit, { headers: { 'Content-Type': image.contentType, 'Content-Length': String(image.bytes.length), 'Cache-Control': 'private, max-age=600', 'X-Content-Type-Options': 'nosniff' } });
  });

  // The file type is the request Content-Type, read by the service with fileContentType.
  app.post('/:id/files', async c => json(201, await service.uploadFile(userOf(c), c.req.param('id'), c.get('body') as Buffer, c.req.query('name') ?? null, c.req.header('content-type') ?? null)));
  app.delete('/:id/files/:file', async c => { await service.discardFile(userOf(c), c.req.param('id'), c.req.param('file')); return json(200, { ok: true }); });
  app.get('/:id/files/:file', async c => {
    const file = await service.readFile(userOf(c), c.req.param('id'), c.req.param('file'));
    // Never inline: the browser saves the file, and the type is not sniffed.
    return new Response(file.bytes as BodyInit, { headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.bytes.length), 'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(file.name)}`, 'Cache-Control': 'private, max-age=600', 'X-Content-Type-Options': 'nosniff' } });
  });

  app.patch('/:id', async c => {
    const input = patchBody.parse(looseBody(c.get('body'))), id = c.req.param('id');
    if ('effort' in input) await service.setEffort(userOf(c), id, input.effort);
    if ('title' in input || !('effort' in input)) await service.rename(userOf(c), id, input.title);
    return json(200, { ok: true });
  });
  app.delete('/:id', async c => { await service.remove(userOf(c), c.req.param('id')); return json(200, { ok: true }); });

  app.get('/:id/messages', async c => {
    const raw = c.req.query('limit');
    const limit = raw === undefined || raw === '' ? 50 : Number(raw);
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ChatError(400, 'Invalid limit.');
    return json(200, await service.messages(userOf(c), c.req.param('id'), limit, c.req.query('before') || null));
  });
  app.post('/:id/messages', async c => {
    const input = sendBody.parse(looseBody(c.get('body')));
    return json(201, await service.send(userOf(c), c.req.param('id'), input.text, input.images, input.files));
  });
  app.post('/:id/stop', async c => json(200, await service.stop(userOf(c), c.req.param('id'))));
  app.post('/:id/ui/:card/act', async c => json(200, await service.act(userOf(c), c.req.param('id'), c.req.param('card'), record.parse(looseBody(c.get('body'))))));
  app.get('/:id/stream', async c => {
    applyOut(c);
    await service.openStream(c.env.incoming, c.env.outgoing, userOf(c), c.req.param('id'));
    return alreadySent();
  });

  app.get('/:id/events', async c => {
    applyOut(c);
    await service.openEvents(c.env.incoming, c.env.outgoing, userOf(c), c.req.param('id'));
    return alreadySent();
  });
  app.get('/:id/turns/:turn/events', async c => json(200, await service.turnEvents(userOf(c), c.req.param('id'), c.req.param('turn'))));

  app.get('/:id/shares', async c => json(200, await service.shareList(userOf(c), c.req.param('id'))));
  app.post('/:id/shares', async c => json(201, await service.shareCreate(userOf(c), c.req.param('id'))));
  app.post('/:id/shares/:share/revoke', async c => json(200, await service.shareRevoke(userOf(c), c.req.param('id'), c.req.param('share'))));

  app.all('*', () => notFound());
  return app;
}
