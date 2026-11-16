import { Hono } from 'hono';
import { logError } from '../../../errors.js';
import { ProjectError, type ProjectService } from '../../../project-service.js';
import { CHAT_FILE_MAX_BYTES } from '../../../web-chat-files.js';
import { declaredTooLarge, looseBody, readBytes, readJson } from '../body.js';
import { failure, json, notFound, userOf, type WebEnv } from '../env.js';

/** The project routes, mounted at /api/projects. The console checks the session, the Origin and the CSRF token before them. */
export type ProjectRoutes = Hono<WebEnv>;

/** Caps the JSON body of a write. Instructions are at most 8000 characters, so this only stops abuse. */
const JSON_MAX_BYTES = 256 * 1024;
const noContent = () => new Response(null, { status: 204 });

export function projectRoutes(service: ProjectService): ProjectRoutes {
  const app = new Hono<WebEnv>();
  app.onError((error, c) => failure(c, () => {
    if (error instanceof ProjectError) return json(error.status, { error: error.code });
    logError('project_failed', error, { stage: 'projects' });
    return json(502, { error: 'project_failed' });
  }));

  // Reads the body of a write once: raw bytes for the file upload, JSON for the others, nothing for DELETE.
  app.use('*', async (c, next) => {
    if (c.req.method === 'GET') return next();
    const upload = c.req.method === 'POST' && /^\/api\/projects\/[^/]+\/files$/.test(c.req.path);
    if (upload) {
      const tooLarge = json(413, { error: 'file_too_large' });
      if (declaredTooLarge(c, CHAT_FILE_MAX_BYTES)) return tooLarge;
      // Past the limit nothing is kept. The rest of the body is read and dropped, so the 413 reaches the client.
      const bytes = await readBytes(c, CHAT_FILE_MAX_BYTES, true);
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
  app.post('/', async c => json(201, await service.create(userOf(c), looseBody(c.get('body')))));
  app.get('/:id', async c => json(200, await service.detail(userOf(c), c.req.param('id'))));
  app.patch('/:id', async c => json(200, await service.update(userOf(c), c.req.param('id'), looseBody(c.get('body')))));
  app.delete('/:id', async c => { await service.delete(userOf(c), c.req.param('id')); return noContent(); });

  // A rejected text is 422 with the reason. Saved text is returned as the project.
  app.post('/:id/instructions', async c => {
    const result = await service.saveInstructions(userOf(c), c.req.param('id'), looseBody(c.get('body')).text);
    return json(result.ok ? 200 : 422, result);
  });

  // The file bytes are the body. The name and type come from the query and the Content-Type header, as in the chat upload.
  app.post('/:id/files', async c => json(201, await service.addFile(userOf(c), c.req.param('id'), c.req.query('name') ?? null, c.req.header('content-type') ?? null, c.get('body') as Buffer)));
  // A redirect to a short-lived link. The file is never served through the console.
  app.get('/:id/files/:file', async c => new Response(null, { status: 302, headers: { Location: await service.fileLink(userOf(c), c.req.param('id'), c.req.param('file')) } }));
  app.delete('/:id/files/:file', async c => { await service.deleteFile(userOf(c), c.req.param('id'), c.req.param('file')); return noContent(); });

  app.get('/:id/memories', async c => json(200, { memories: await service.memories(userOf(c), c.req.param('id')) }));
  app.patch('/:id/memories/:memory', async c => {
    const input = looseBody(c.get('body'));
    // A missing content is sent as "", which the memory check rejects as a bad request.
    return json(200, await service.editMemory(userOf(c), c.req.param('id'), c.req.param('memory'), typeof input.content === 'string' ? input.content : ''));
  });
  app.delete('/:id/memories/:memory', async c => { await service.deleteMemory(userOf(c), c.req.param('id'), c.req.param('memory')); return noContent(); });

  app.all('*', () => notFound());
  return app;
}
