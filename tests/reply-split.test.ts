import assert from 'node:assert/strict';
import { test } from 'node:test';
import { splitReply } from '../src/presentation/reply-split.js';

const words = (count: number) => Array.from({ length: count }, (_, i) => `word${i}${'x'.repeat(i % 7)}`).join(' ');

test('split_never_mid_word', () => {
  const text = `${words(300)}. The end of the first part.\n\n${words(120)}`;
  const pages = splitReply(text, 60);
  assert.equal(pages.join(''), text);
  assert.ok(pages.every(page => page.length <= 60));
  for (const page of pages.slice(0, -1)) {
    assert.ok(/\s$/.test(page), `page ends at a word boundary: ${JSON.stringify(page.slice(-12))}`);
  }
});

test('split_keeps_markdown_balanced', () => {
  const text = `Intro with **${words(25)}** and _an italic phrase_ plus \`a code span\`.\n\n`
    + 'Next **bold paragraph** with a snake_case_name and more words to fill the page ' + words(40) + '.\n\n'
    + 'Last _emphasis that runs over the page edge and comes back_ here.';
  const pages = splitReply(text, 90);
  assert.ok(pages.length > 3);
  assert.equal(pages.join('').replace(/\*\*|_/g, ''), text.replace(/\*\*|_/g, '').replace(/\n\n/g, '\n\n'), 'no text is lost');
  for (const page of pages) {
    assert.equal((page.match(/\*\*/g) ?? []).length % 2, 0, `bold balanced on page: ${JSON.stringify(page)}`);
    assert.equal((page.replace(/`[^`]*`/g, '').match(/(^|[\s(])_(?=\S)/g) ?? []).length - (page.replace(/`[^`]*`/g, '').match(/(?<=\S)_($|[\s.,;:!?)])/g) ?? []).length, 0, `italic balanced on page: ${JSON.stringify(page)}`);
    assert.equal((page.match(/`/g) ?? []).length % 2, 0, `code span balanced on page: ${JSON.stringify(page)}`);
  }
  // A bold run that crosses a page edge is closed at the end of one page and opened again at the start of the next.
  const crossing = pages.findIndex(page => /\*\*\s*$/.test(page));
  assert.ok(crossing >= 0 && /^\*\*/.test(pages[crossing + 1] ?? ''), 'the bold run is closed and reopened across the page edge');
});

test('split_keeps_code_fences_balanced_with_markers', () => {
  const text = `**Steps**\n\n\`\`\`sh\n${Array.from({ length: 30 }, (_, i) => `echo line ${i}`).join('\n')}\n\`\`\`\n\nDone **now**.`;
  const pages = splitReply(text, 120);
  for (const page of pages) {
    assert.equal((page.match(/```/g) ?? []).length % 2, 0, 'fences balanced');
    assert.equal((page.match(/\*\*/g) ?? []).length % 2, 0, 'bold balanced');
  }
});

test('footer_on_last_page_only', () => {
  const footer = '\n\n-# searched history 3× · 12s';
  const pages = splitReply(words(200), 100, footer);
  assert.ok(pages.length > 2);
  assert.ok(pages.at(-1)!.endsWith(footer));
  for (const page of pages.slice(0, -1)) assert.ok(!page.includes('-# searched'), 'no footer on earlier pages');
  assert.ok(pages.every(page => page.length <= 100));
  // A footer that does not fit on the last page gets a page of its own.
  const full = 'x'.repeat(95) + ' ';
  const extra = splitReply(full, 100, '\n\n-# footer that does not fit here');
  assert.equal(extra.length, 2);
  assert.ok(extra[1]!.endsWith('-# footer that does not fit here'));
  // Discord pages keep room for closing markers; a short footer may use it instead of a page of its own.
  assert.equal(splitReply('y'.repeat(1874), 1900, '\n\n-# searched history 2× · read 1 message · 14s', 2000).length, 1);
});
