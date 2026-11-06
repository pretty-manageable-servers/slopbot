import { readFile, stat } from 'node:fs/promises';
import { extname, resolve, sep } from 'node:path';
import { json, notFound, type WebApp, type WebDeps } from '../env.js';

type StaticFile = { content: Buffer; type: string };
const contentTypes: Record<string, string> = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.ico': 'image/x-icon', '.webp': 'image/webp', '.woff2': 'font/woff2', '.woff': 'font/woff', '.ttf': 'font/ttf', '.txt': 'text/plain; charset=utf-8', '.json': 'application/json' };
export const consoleCsp = "default-src 'self'; script-src 'self'; style-src 'self'; font-src 'self'; img-src 'self' https:; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'";
// The Next static export uses inline scripts. Only the landing HTML gets this relaxation.
const landingCsp = consoleCsp.replace("script-src 'self'", "script-src 'self' 'unsafe-inline'");
// The new console (agentic-ui-kit) needs two more rules. Shiki highlights code with a WebAssembly regex engine,
// and the kit sets style attributes (code tokens, the composer height). No inline or eval'd script is allowed.
/**
 * The page the kit's show_widget frames load (WidgetHost.frameUrl). The kit posts the model's HTML into it, so
 * its scripts run in an opaque-origin sandbox and the console's own CSP keeps 'self' scripts only.
 */
export const WIDGET_FRAME_PATH = '/console/widget-frame.html';
const widgetFrameCsp = "default-src 'none'; script-src 'unsafe-inline' https:; style-src 'unsafe-inline' https:; img-src data: blob: https:; font-src data: https:; connect-src https:; frame-ancestors 'self'; base-uri 'none'";
export const nextCsp = consoleCsp.replace("script-src 'self'", "script-src 'self' 'wasm-unsafe-eval'").replace("style-src 'self'", "style-src 'self' 'unsafe-inline'").replace("img-src 'self'", "img-src 'self' blob:");
/** File of the public share page (/s/:id) for a /share path, or undefined. Only these names are served. */
const shareFile = (path: string) => {
  const name = path.startsWith('/share/') ? path.slice('/share/'.length) : '';
  return /^(markdown\.js|highlight\.min\.js|style\.css|chat\.css|shares\.js|shares\.css|assets\/(logo-(light|dark)\.svg|favicon\.svg|[a-z0-9-]+\.woff2)|katex\/katex\.min\.js|katex\/katex\.min\.css|katex\/fonts\/KaTeX_[A-Za-z0-9_-]+\.woff2)$/.test(name) ? name : undefined;
};
/** File of the console (the Vite build) for a /console path, or undefined. Paths without a file extension are pages of the app. */
const consoleFile = (path: string) => {
  if (path !== '/console' && !path.startsWith('/console/')) return undefined;
  const name = path.slice('/console/'.length);
  if (/^assets\/[A-Za-z0-9_.-]+$/.test(name)) return name;
  return /^[A-Za-z0-9_/-]*$/.test(name) ? 'index.html' : undefined;
};
/**
 * Old console addresses still in Discord messages and bookmarks: /chat/<id> (the "continue in web" link), /team/...
 * and /console/next/... (the new console before the swap). Gives the address in the console, or undefined.
 */
export const movedPath = (path: string): string | undefined => {
  const chat = /^\/chat(?:\/([^/]+))?\/?$/.exec(path);
  if (chat) return chat[1] ? `/console/chat/${chat[1]}` : '/console';
  if (/^\/team(\/.*)?$/.test(path)) return '/console';
  if (path === '/console/next' || path.startsWith('/console/next/')) return `/console${path.slice('/console/next'.length)}` || '/console';
  return undefined;
};
/** Landing file for a path: the home page, /_next/ files and top-level files such as /favicon.svg. */
// A path with no extension is a page of the export, for example /terms gives terms.html.
const landingFile = (path: string) => path === '/' ? 'index.html' : /^\/[a-z-]+$/.test(path) ? `${path.slice(1)}.html` : path.startsWith('/_next/') || /^\/[^/]+$/.test(path) ? path.slice(1) : undefined;
/** Reads a file under root. Missing files, folders, unknown types and paths that leave root give undefined. */
export async function readInside(root: string, name: string): Promise<StaticFile | undefined> {
  const base = resolve(root), file = resolve(base, name), type = contentTypes[extname(file)];
  if (name.includes('..') || !file.startsWith(base + sep) || !type) return undefined;
  const info = await stat(file).catch(() => undefined);
  return info?.isFile() ? { content: await readFile(file), type } : undefined;
}
/** Static files: the widget frame, old addresses, the share assets, the console build and the landing page. */
export function staticRoutes(app: WebApp, { options }: WebDeps, widgetFrame: string): void {
  app.all('*', async c => {
    if (c.req.method !== 'GET') return json(405, { error: 'Method not allowed.' });
    const path = c.req.path, out = c.get('out');
    if (path === WIDGET_FRAME_PATH) return new Response(widgetFrame, { headers: { 'Content-Security-Policy': widgetFrameCsp, 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-cache' } });
    const moved = movedPath(path);
    if (moved) return new Response(null, { status: 301, headers: { Location: moved + new URL(c.req.url).search } });
    const shareName = shareFile(path);
    if (shareName) return sendFile(await readInside('share', shareName));
    const consoleName = consoleFile(path);
    if (consoleName) { out.set('Content-Security-Policy', nextCsp); return sendFile(await readInside(options.nextDir ?? 'console/dist', consoleName)); }
    const landingName = landingFile(path);
    if (!landingName) return notFound();
    if (landingName.endsWith('.html')) out.set('Content-Security-Policy', landingCsp);
    return sendFile(await readInside(options.siteDir ?? 'site/out', landingName));
  });
}
const sendFile = (file: StaticFile | undefined) => file ? new Response(file.content as unknown as BodyInit, { headers: { 'Content-Type': file.type } }) : notFound();
