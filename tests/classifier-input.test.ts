import { test } from 'node:test';
import assert from 'node:assert/strict';
import { classifierInput } from '../src/classifier-input.js';

test('classifier state retains recent conversation cues within 8 KiB and omits heavyweight metadata', () => {
  const current = { server: 's', channel: 'c', id: 'current', author: 'a', text: 'do the second one', authorIdentity: { biography: 'x'.repeat(50000) }, modelImages: [{ url: 'huge-data-url'.repeat(10000), label: 'image' }] };
  const context = Array.from({ length: 100 }, (_, i) => ({ ...current, id: String(i), isBot: i === 99, text: 'old text '.repeat(10000), attachments: [{ name: 'plot.png', url: 'signed-private-url'.repeat(10000) }] }));
  const packed = classifierInput(current, [...context, { ...current, channel: 'foreign', id: 'foreign' }, current]);
  const value = JSON.parse(packed.state);
  assert.deepEqual(packed.preceding.map(item => item.id), ['95', '96', '97', '98', '99']);
  assert.equal(value.preceding[4].isBot, true); assert.equal(value.CURRENT.text, current.text);
  assert.ok(Buffer.byteLength(packed.state) <= 8192);
  assert.ok(!packed.state.includes('biography')); assert.ok(!packed.state.includes('huge-data-url')); assert.ok(!packed.state.includes('signed-private-url'));
});
