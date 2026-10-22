import { test } from 'node:test';
import assert from 'node:assert/strict';

import { remoteImageAttachments } from '../src/web-chat-images.js';

test('remote image metadata excludes local, credentialed and executable attachment URLs', () => {
  const urls = ['http://example.com/a.png', 'javascript:alert(1)', 'data:image/png;base64,abc', 'https://user:password@example.com/a.png'];
  assert.deepEqual(remoteImageAttachments(urls.map(url => ({ name: 'a.png', url, contentType: 'image/png' }))), []);
});
