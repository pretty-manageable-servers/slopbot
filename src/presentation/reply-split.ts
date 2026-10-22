// Splits a reply into Discord pages. Cut order: paragraph, then sentence, then word.
// A word is cut inside only when it is longer than a page. Inline markers (**, ***, _, __, `) and code fences
// stay balanced: each page closes what it leaves open, and the next page reopens it. Footer goes on the last page.

interface Unit { text: string; kind: 'prose' | 'code' | 'fence-open' | 'fence-close' }
interface State { open: string[]; fence?: string }

const WORD = /[\p{L}\p{N}]/u;
const SPACE = /\s/;

function toggle(stack: string[], marker: string): void {
  const index = stack.lastIndexOf(marker);
  if (index >= 0) stack.splice(index, 1); else stack.push(marker);
}

/** Returns the inline markers still open after a piece of prose. A code span holds no markers, so it is skipped. */
export function scanInline(text: string, open: readonly string[]): string[] {
  const stack = [...open];
  for (let i = 0; i < text.length;) {
    const char = text[i]!;
    let run = i + 1;
    while (text[run] === char) run++;
    const count = run - i, before = text[i - 1] ?? ' ', after = text[run] ?? ' ';
    if (char === '`') {
      const marker = '`'.repeat(count), end = text.indexOf(marker, run);
      if (end >= 0) { i = end + count; continue; }
      toggle(stack, marker);
    } else if (char === '*' && count >= 2 && count <= 3) toggle(stack, '*'.repeat(count));
    else if (char === '_' && count <= 2) {
      // Underscores inside a word (file_name) are not markers. A marker opens before a word and closes after one.
      const marker = '_'.repeat(count), index = stack.lastIndexOf(marker);
      const opens = !WORD.test(before) && !SPACE.test(after), closes = !SPACE.test(before) && !WORD.test(after);
      if (index >= 0) { if (closes) stack.splice(index, 1); }
      else if (opens) stack.push(marker);
    }
    i = run;
  }
  return stack;
}

function transition(unit: Unit, state: State): State {
  if (unit.kind === 'fence-open') return { open: state.open, fence: unit.text };
  if (unit.kind === 'fence-close') return { open: state.open };
  if (unit.kind === 'code') return state;
  return { open: scanInline(unit.text, state.open) };
}

/** Text that closes a page: open markers in reverse, then the code fence. */
const closing = (state: State) => state.open.slice().reverse().join('') + (state.fence ? '\n```' : '');
/** A finished page: closing text goes before its trailing spaces, so a marker never follows a space. */
const finish = (page: string, state: State): string => {
  if (!state.open.length) return page + closing(state);
  const body = page.replace(/\s+$/, '');
  return body + closing(state) + page.slice(body.length);
};

/** Text that reopens the next page: the code fence, then the open markers. */
const reopening = (state: State) => (state.fence ?? '') + state.open.join('');

/** Cuts a string into pieces of at most `limit` characters: sentences first, then words, then code points. */
function fit(text: string, limit: number): string[] {
  if (text.length <= limit) return [text];
  const sentences = Array.from(new Intl.Segmenter(undefined, { granularity: 'sentence' }).segment(text), item => item.segment);
  if (sentences.length > 1) return sentences.flatMap(sentence => fit(sentence, limit));
  const pieces: string[] = [];
  for (const word of text.match(/\S+\s*|\s+/g) ?? []) {
    if (word.length <= limit) { pieces.push(word); continue; }
    let cut = '';
    for (const character of word) {
      if (cut.length + character.length > limit) { pieces.push(cut); cut = ''; }
      cut += character;
    }
    pieces.push(cut);
  }
  return pieces;
}

function units(text: string, limit: number): Unit[] {
  const out: Unit[] = [];
  let fence = false;
  for (const token of text.split(/(^```[^\n]*\n|^```$)/gm)) {
    if (!token) continue;
    if (/^```[^\n]*(?:\n|$)$/.test(token)) {
      out.push(fence ? { text: token, kind: 'fence-close' } : { text: token.endsWith('\n') ? token : token + '\n', kind: 'fence-open' });
      fence = !fence;
      continue;
    }
    if (fence) for (const line of token.match(/[^\n]*\n|[^\n]+$/g) ?? []) for (const text of fit(line, limit)) out.push({ text, kind: 'code' });
    else for (const paragraph of token.match(/[\s\S]*?\n\n+|[\s\S]+$/g) ?? []) for (const text of fit(paragraph, limit)) out.push({ text, kind: 'prose' });
  }
  return out;
}

/** `max` is the hard message size; the footer may use the room above `limit` that pages keep for closing markers. */
export function splitReply(text: string, limit = 1900, footer = '', max = limit): string[] {
  const queue = units(text, limit), pages: string[] = [];
  let state: State = { open: [] }, page = '', fresh = true;
  const flush = () => { pages.push(finish(page, state)); page = reopening(state); fresh = true; };
  while (queue.length) {
    const unit = queue.shift()!;
    const after = transition(unit, state);
    if (page.length + unit.text.length + closing(after).length > limit) {
      if (!fresh) { flush(); queue.unshift(unit); continue; }
      // A unit that does not fit even on a fresh page is cut again, sentence first, with room for its closing text.
      if (!unit.kind.startsWith('fence')) {
        const room = Math.max(1, limit - page.length - closing(after).length);
        queue.unshift(...fit(unit.text, room).map(text => ({ text, kind: unit.kind })));
        continue;
      }
    }
    page += unit.text; state = after; fresh = false;
  }
  if (!fresh) pages.push(finish(page, state));
  if (footer) {
    const last = pages.length - 1;
    if (last >= 0 && pages[last]!.length + footer.length <= max) pages[last] += footer;
    else pages.push(...splitReply(footer, limit));
  }
  return pages;
}
