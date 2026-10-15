import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import { parseHTML } from 'linkedom';

test('console status and notice text resolves channel links and never prints raw Discord mention tokens', () => {
  const source = readFileSync(new URL('../../web/app.js', import.meta.url), 'utf8');
  const code = source.match(/function renderConsoleText\([^]*?\n\}/)![0] + '\nrenderConsoleText';
  const { document } = parseHTML('<html><body></body></html>');
  const render = runInNewContext(code, { document, state: { server: { id: '123' }, channels: [{ id: '456', name: 'general' }] } });
  const node = document.createElement('p');
  render(node, 'Monitoring <#456>, <#789>, <@123>, <@!123> and <@&123>. <script>literal</script>');
  assert.match(node.textContent!, /#general, #channel 789, @user 123, @user 123 and @role 123/);
  assert.ok(!/<[#@]/.test(node.textContent!));
  assert.equal(node.querySelector('a')?.getAttribute('href'), 'https://discord.com/channels/123/456');
  assert.equal(node.querySelector('script'), null);
});
