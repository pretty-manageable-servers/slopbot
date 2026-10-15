import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';
import { transcriptMessage } from '../src/run-events.js';
import { remoteImageAttachments } from '../src/web-chat-images.js';

test('a bot attachment passes through transcript metadata and becomes a visible image in the real message renderer', () => {
  const message = { id: 'graph', server: 's', channel: 'c', author: 'bot', isBot: true, text: 'Earth temperatures', attachments: [{ name: 'earth.png', url: 'https://cdn.discordapp.com/attachments/earth.png', contentType: 'image/png' }] };
  const view = transcriptMessage(message, 'bot');
  assert.equal(view.remoteImages?.length, 1);
  const { document, window } = parseHTML('<html><body></body></html>');
  const source = readFileSync(new URL('../../web/conversations.js', import.meta.url), 'utf8');
  const textNode = (tag: string, text: string, className?: string) => { const node = document.createElement(tag); node.textContent = text; if (className) node.className = className; return node; };
  const code = ['messageNode', 'imageStrip'].map(name => source.match(new RegExp(`function ${name}\\([^]*?\\n\\}`))?.[0]).join('\n') + '\nmessageNode';
  const render = runInNewContext(code, { document, state: {}, textNode, slopMark: () => document.createElement('span'), msgTime: () => '', timeLabel: () => '', renderText: (node: HTMLElement, text: string) => { node.textContent = text; }, sizeLabel: () => '1 KB', imageUrl: () => '' });
  const node = render(view) as HTMLElement;
  const image = node.querySelector('img')!;
  assert.equal(image.getAttribute('src'), message.attachments[0]!.url); assert.equal(image.getAttribute('alt'), 'earth.png');
  image.dispatchEvent(new window.Event('error'));
  assert.equal(node.querySelector('img'), null); assert.equal(node.querySelector('a')?.getAttribute('href'), message.attachments[0]!.url);
});

test('remote image metadata excludes local, credentialed and executable attachment URLs', () => {
  const urls = ['http://example.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,abc', 'https://user:password@example.com/a.png'];
  assert.deepEqual(remoteImageAttachments(urls.map(url => ({ name: 'a.png', url, contentType: 'image/png' }))), []);
});
