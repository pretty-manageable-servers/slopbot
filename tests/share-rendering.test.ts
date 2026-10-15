import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { renderSharePage } from '../src/shares.js';

test('the share dialog visibly defaults details on and sends an explicit false when unchecked', async () => {
  const { window, document } = parseHTML('<html><body><div id="actions"></div></body></html>');
  Object.defineProperty(window.HTMLElement.prototype, 'showModal', { value() {}, configurable: true });
  const bodies: { show_thinking: boolean }[] = [];
  const fetcher = async (path: string, options?: { body?: string }) => {
    if (options?.body) bodies.push(JSON.parse(options.body));
    return Response.json(path === '/api/settings' ? { csrf: 'csrf-token' } : { id: 'created' });
  };
  runInNewContext(readFileSync(new URL('../../web/shares.js', import.meta.url), 'utf8'), { window, document, fetch: fetcher, location: { origin: 'https://slopbot.test' } });
  (window as unknown as { SlopbotShares: { renderShareButton(node: Element, server: string, channel: string): void } }).SlopbotShares.renderShareButton(document.getElementById('actions')!, 'server', 'channel');
  document.querySelector<HTMLButtonElement>('#actions button')!.click();
  const checkbox = document.querySelector<HTMLInputElement>('#share-thinking')!;
  assert.equal(checkbox.hasAttribute('checked'), true);
  assert.match(document.querySelector('label')!.textContent!, /reasoning and tool activity/);
  checkbox.checked = false;
  [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(button => button.textContent === 'Create link')!.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bodies[0]?.show_thinking, false);
});

test('the shared reply page renders markdown, reasoning and tool activity through its browser scripts', () => {
  const html = renderSharePage({ id: 'example', created_at: 1, options: { show_avatars: false, show_thinking: true }, messages: [{ author: 'Slopbot', bot: true, text: '**Bold**\n\n- One\n- Two\n\n`inline`\n\n```js\nconst n = 1;\n```\n\n[Source](https://example.com)', tools: [{ name: 'web_search', status: 'Searched the web' }], thinking: 'Reasoning included', attachments: 0 }] });
  const { window, document } = parseHTML(html);
  const context = { window, document, URL, localStorage: { getItem: () => null }, matchMedia: () => ({ matches: true }) };
  runInNewContext(readFileSync(new URL('../../web/markdown.js', import.meta.url), 'utf8'), context);
  runInNewContext(readFileSync(new URL('../../web/shares.js', import.meta.url), 'utf8'), context);
  const body = document.querySelector('#share-log .chat-text')!;
  assert.equal(body.querySelector('strong')?.textContent, 'Bold'); assert.equal(body.querySelectorAll('li').length, 2);
  assert.equal(body.querySelector('code')?.textContent, 'inline'); assert.match(body.querySelector('pre code')?.textContent ?? '', /const n = 1/);
  assert.equal(body.querySelector('a')?.getAttribute('href'), 'https://example.com/');
  assert.equal(document.querySelector('.share-thinking-text')?.textContent, 'Reasoning included');
  assert.equal(document.querySelector('.share-tools li')?.textContent, 'Searched the web');
});
