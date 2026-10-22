import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';

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
  checkbox.checked = false;
  [...document.querySelectorAll<HTMLButtonElement>('dialog button')].find(button => button.textContent === 'Create link')!.click();
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(bodies[0]?.show_thinking, false);
});
