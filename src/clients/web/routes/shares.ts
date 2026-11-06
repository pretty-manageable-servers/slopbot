import { readInside, nextCsp } from './static.js';
import { readInput } from '../body.js';
import { isShareId } from '../../../shares.js';
import { json, notFound, userOf, type WebApp, type WebDeps } from '../env.js';

const SHARE_IMAGE = /^[0-9a-f]{32}\.(?:png|jpg|gif|webp)$/;

/** Public share pages, images and snapshots. They never need a login and are never indexed. */
export function publicShareRoutes(app: WebApp, { options, backend }: WebDeps): void {
  const { shares } = backend;
  if (!shares) return;
  app.get('/s/:id/images/:file', async (c, next) => {
    const { id, file } = c.req.param();
    if (!isShareId(id) || !SHARE_IMAGE.test(file)) return next();
    c.get('out').set('X-Robots-Tag', 'noindex');
    const image = await shares.image(id, file);
    if (!image) return notFound();
    return new Response(image.bytes as BodyInit, { headers: { 'Content-Type': image.contentType, 'Content-Length': String(image.bytes.length), 'Cache-Control': 'private, no-store', 'X-Content-Type-Options': 'nosniff' } });
  });
  app.get('/s/:id', async (c, next) => {
    const id = c.req.param('id');
    if (!isShareId(id)) return next();
    c.get('out').set('X-Robots-Tag', 'noindex');
    // The page is the console's share entry (console/share.html), so it gets the console's CSP.
    const template = await readInside(options.nextDir ?? 'console/dist', 'share.html');
    if (!template) return json(503, { error: 'The share page is not built.' });
    const html = await shares.page(id, template.content.toString('utf8'));
    if (!html) return notFound();
    c.get('out').set('Content-Security-Policy', nextCsp);
    return new Response(html, { headers: { 'Content-Type': 'text/html; charset=utf-8' } });
  });
  app.get('/api/shares/:id', async (c, next) => {
    const id = c.req.param('id');
    if (!isShareId(id)) return next();
    c.get('out').set('X-Robots-Tag', 'noindex');
    const snapshot = await shares.snapshot(id);
    return snapshot ? json(200, snapshot) : notFound();
  });
}

/** The signed-in user's share links: list, create, revoke, and copying a share into a private chat. */
export function shareRoutes(app: WebApp, { backend, guard }: WebDeps): void {
  app.get('/api/shares', async c => {
    if (!backend.shares) return notFound();
    return json(200, await backend.shares.list(userOf(c), c.req.query('server') ?? ''));
  });
  app.post('/api/shares/:id/continue', guard(), async c => {
    // Needs no body. The guard already ran; the body is dropped unread.
    const id = c.req.param('id');
    if (!isShareId(id)) return notFound();
    if (!backend.continueShare) return notFound();
    return json(201, await backend.continueShare(userOf(c), id));
  });
  app.post('/api/shares', guard(), async c => {
    const body = await readInput(c, 16384);
    if ('error' in body) return body.error;
    if (!backend.shares) return notFound();
    return json(200, await backend.shares.create(userOf(c), body.value));
  });
  app.post('/api/shares/revoke-all', guard(), async c => {
    const body = await readInput(c, 16384);
    if ('error' in body) return body.error;
    if (!backend.shares) return notFound();
    const server = body.value && typeof body.value === 'object' ? (body.value as { server?: unknown }).server : undefined;
    return json(200, await backend.shares.revokeAll(userOf(c), server));
  });
  app.post('/api/shares/:id/revoke', guard(), async c => {
    const id = c.req.param('id');
    if (!isShareId(id)) return notFound();
    const body = await readInput(c, 16384);
    if ('error' in body) return body.error;
    if (!backend.shares) return notFound();
    return json(200, await backend.shares.revoke(userOf(c), id));
  });
}
