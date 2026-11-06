// Discord-flavoured Markdown to HTML. All text is escaped before any markup is added.
(function () {
  'use strict';

  const ENTITIES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const UNESCAPES = { amp: '&', lt: '<', gt: '>', quot: '"', '#39': "'" };
  const CONTROL = /[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g;
  const LIST_ITEM = /^( *)([-*]|\d+\.) (.*)$/;
  const HEADING_TAGS = ['h3', 'h4', 'h5'];

  const esc = (text) => text.replace(/[&<>"']/g, (ch) => ENTITIES[ch]);
  const unesc = (text) => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, name) => UNESCAPES[name]);

  // Only http and https links are allowed. Returns the normalised URL or null.
  function safeHref(url) {
    try {
      const parsed = new URL(url);
      return parsed.protocol === 'http:' || parsed.protocol === 'https:' ? parsed.href : null;
    } catch {
      return null;
    }
  }

  const anchor = (href, label) =>
    `<a href="${esc(href)}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`;

  // Drop punctuation that ends a bare URL, but keep a ")" that closes a "(" in the URL.
  function trimUrl(url) {
    for (;;) {
      const next = url.replace(/(?:[.,!?:]|(?<!&amp);|&gt;|&quot;|&#39;)$/, '');
      if (next !== url) {
        url = next;
      } else if (url.endsWith(')') && url.split('(').length < url.split(')').length) {
        url = url.slice(0, -1);
      } else {
        return url;
      }
    }
  }

  // Math. KaTeX draws it when window.katex exists. Otherwise the source shows as code.
  // KaTeX gets the raw source, so callers unescape it first.
  const MATH_BLOCKS = [['$$', '$$'], ['\\[', '\\]']];
  // Inline math, in this order: \(…\), \[…\], a backslash pair (skipped, so \$ is not math), $$…$$, $…$.
  // Pandoc rule for $: no space after the opening $, no space before the closing $, no digit after the closing $.
  const MATH_INLINE = /\\\(((?:\\[\s\S]|[^\\\u0001\u0002])+?)\\\)|\\\[((?:\\[\s\S]|[^\\\u0001\u0002])+?)\\\]|\\[\s\S]|\$\$((?:\\[\s\S]|[^\\$\u0001\u0002])+?)\$\$|\$(?!\s|\$)((?:\\[\s\S]|[^\\$\u0001\u0002])+?)(?<!\s)\$(?!\d)/g;

  // Math is a placeholder with the source in data-tex. The page's CSP has no 'unsafe-inline' for styles,
  // so KaTeX output is not put in as HTML. typeset() draws it with katex.render after the markup is in the page.
  // Until then, or without KaTeX, the escaped source shows as text.
  function mathHtml(tex, displayMode) {
    const attr = `data-tex="${esc(tex)}"`;
    const src = `<code class="math-src">${esc(tex)}</code>`;
    return displayMode ? `<div class="math-block" ${attr}>${src}</div>` : `<span class="math" ${attr}>${src}</span>`;
  }

  // Draws every math placeholder under root that is not drawn yet. Does nothing without window.katex.
  function typeset(root) {
    const katex = typeof window !== 'undefined' ? window.katex : undefined;
    if (!katex || typeof katex.render !== 'function' || !root || typeof root.querySelectorAll !== 'function') return;
    for (const el of root.querySelectorAll('[data-tex]:not([data-typeset])')) {
      const tex = el.getAttribute('data-tex') ?? '';
      const displayMode = el.classList.contains('math-block');
      el.setAttribute('data-typeset', '');
      try {
        el.textContent = '';
        katex.render(tex, el, { displayMode, throwOnError: false, output: 'html', trust: false, maxSize: 20, maxExpand: 1000 });
      } catch {
        el.textContent = tex;
      }
    }
  }

  // A display block opens with $$ or \[ and closes on a line that ends with the matching closer.
  // A blank line ends the search. Returns the TeX and the index after the block, or null.
  function mathBlockAt(lines, i) {
    const t = lines[i].trim();
    for (const [open, close] of MATH_BLOCKS) {
      if (!t.startsWith(open)) continue;
      const first = t.slice(open.length);
      if (first.includes(close)) {
        // One line. Text after the closer means it is not a block.
        const tex = first.endsWith(close) ? first.slice(0, -close.length).trim() : '';
        return tex ? { tex, end: i + 1 } : null;
      }
      const body = [first];
      for (let j = i + 1; j < lines.length; j++) {
        const rest = lines[j].trim();
        if (rest === '') break;
        if (rest.endsWith(close)) {
          body.push(rest.slice(0, -close.length));
          const tex = body.join('\n').trim();
          return tex ? { tex, end: j + 1 } : null;
        }
        body.push(lines[j]);
      }
      return null;
    }
    return null;
  }

  // Runs on one line. Finished HTML is held in `held` and put back last, so later rules never touch it.
  function inline(raw) {
    const held = [];
    const hold = (html) => `\u0001${held.push(html) - 1}\u0002`;
    let s = esc(raw);

    s = s.replace(/`([^`]+)`/g, (_, code) => hold(`<code>${code}</code>`));
    // Math runs after code spans, so code is never math.
    s = s.replace(MATH_INLINE, (match, paren, bracket, dbl, dollar) => {
      const tex = paren ?? bracket ?? dbl ?? dollar;
      return tex === undefined ? match : hold(mathHtml(unesc(tex), false));
    });
    // Discord escapes: a backslash before punctuation shows the punctuation as plain text.
    s = s.replace(/\\(&(?:amp|lt|gt|quot|#39);|[!-\/:-@\[-`{-~])/g, (_, ch) => hold(ch));
    s = s.replace(/(!?)\[([^\]\u0001\u0002]+)\]\(((?:[^\s()\u0001\u0002]|\([^\s()\u0001\u0002]*\))+)\)/g, (match, image, label, url) => {
      const href = safeHref(unesc(url));
      if (href) {
        const parsed = new URL(href);
        if ((image || /\.(?:png|jpe?g|gif|webp|avif)$/i.test(parsed.pathname)) && parsed.protocol === 'https:' && !parsed.username && !parsed.password) {
          return hold(anchor(href, `<img src="${esc(href)}" alt="${label}" loading="lazy" referrerpolicy="no-referrer">`));
        }
      }
      return href ? hold(anchor(href, label)) : match;
    });
    s = s.replace(/&lt;(@&amp;|@!?|#)\d+&gt;/g, (_, kind) => {
      const name = kind === '#' ? '#channel' : kind === '@&amp;' ? '@role' : '@user';
      return hold(`<span class="md-mention">${name}</span>`);
    });
    s = s.replace(/&lt;a?:(\w+):\d+&gt;/g, (_, name) => hold(`:${name}:`));
    s = s.replace(/&lt;t:(-?\d+)(?::[a-zA-Z])?&gt;/g, (match, secs) => {
      const when = new Date(Number(secs) * 1000);
      if (Number.isNaN(when.getTime())) return match;
      return hold(`<time datetime="${when.toISOString()}">${esc(when.toLocaleString())}</time>`);
    });
    s = s.replace(/https?:\/\/[^\s\u0001\u0002]+/g, (match) => {
      const url = trimUrl(match);
      const href = safeHref(unesc(url));
      return href ? hold(anchor(href, url)) + match.slice(url.length) : match;
    });

    s = s.replace(/\|\|(.+?)\|\|/g, '<span class="md-spoiler">$1</span>')
      .replace(/~~(.+?)~~/g, '<s>$1</s>')
      .replace(/__(.+?)__/g, '<u>$1</u>')
      .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
      .replace(/\*(?!\s)([^*]+?)\*/g, '<em>$1</em>')
      .replace(/(^|\W)_([^_]+?)_(?!\w)/g, '$1<em>$2</em>');

    return s.replace(/\u0001(\d+)\u0002/g, (_, n) => held[n]);
  }

  // Highlighting uses window.hljs from web/highlight.min.js. It runs only when the fence names a known language.
  // hljs escapes the code itself, so its output is safe to put in the page. Big blocks, failures and a missing
  // library leave the code plain. Results are cached, so a reloaded chat does not highlight the same code again.
  const HIGHLIGHT_MAX = 20000;
  const HIGHLIGHT_CACHE_MAX = 200;
  const highlightCache = new Map();

  function highlightCode(lang, code) {
    const hl = typeof window !== 'undefined' ? window.hljs : undefined;
    if (!lang || !hl || code.length > HIGHLIGHT_MAX) return undefined;
    const key = `${lang}\u0000${code}`;
    if (highlightCache.has(key)) return highlightCache.get(key);
    let out;
    try {
      if (hl.getLanguage(lang)) out = hl.highlight(code, { language: lang, ignoreIllegals: true }).value;
    } catch {
      out = undefined;
    }
    if (typeof out === 'string') {
      highlightCache.set(key, out);
      if (highlightCache.size > HIGHLIGHT_CACHE_MAX) highlightCache.delete(highlightCache.keys().next().value);
    }
    return out;
  }

  function codeBlock(info, body) {
    const lang = info.trim().split(/\s+/)[0].toLowerCase().replace(/[^a-z0-9+#-]/g, '');
    const code = body.join('\n');
    const highlighted = highlightCode(lang, code);
    const head = `<div class="md-code-head">${lang ? `<div class="md-code-lang">${lang}</div>` : ''}<button type="button" class="md-copy">Copy</button></div>`;
    const attrs = highlighted === undefined ? '' : ` class="hljs language-${lang}"`;
    return `<div class="md-code">${head}<pre><code${attrs}>${highlighted === undefined ? esc(code) : highlighted}</code></pre></div>`;
  }

  // Copy buttons. One document listener serves every code block, so the markup has no inline script.
  function copyCode(button) {
    const block = button.closest('.md-code');
    const codeNode = block ? block.querySelector('pre code') : null;
    const text = codeNode ? codeNode.textContent : '';
    const showLabel = (label) => {
      button.textContent = label;
      setTimeout(() => { button.textContent = 'Copy'; }, 1500);
    };
    try {
      navigator.clipboard.writeText(text).then(() => showLabel('Copied'), () => showLabel('Copy failed'));
    } catch {
      showLabel('Copy failed');
    }
  }

  if (typeof document !== 'undefined') {
    document.addEventListener('click', (event) => {
      const button = event.target && event.target.closest ? event.target.closest('.md-copy') : null;
      if (button) copyCode(button);
    });
  }

  // Groups runs of the same kind (ordered or not) into one list each.
  function listHtml(items) {
    const runs = [];
    for (const item of items) {
      const run = runs[runs.length - 1];
      if (run && run[0].ordered === item.ordered) run.push(item);
      else runs.push([item]);
    }
    return runs.map((run) => {
      const tag = run[0].ordered ? 'ol' : 'ul';
      const start = run[0].ordered && run[0].num !== 1 ? ` start="${run[0].num}"` : '';
      const rows = run.map((item) => `<li>${inline(item.text)}${item.subs.length ? listHtml(item.subs) : ''}</li>`);
      return `<${tag}${start}>${rows.join('')}</${tag}>`;
    }).join('');
  }

  // Reads list lines from `start`. Returns the HTML and the index of the first line not used.
  function renderList(lines, start) {
    const items = [];
    let i = start;
    for (; i < lines.length; i++) {
      const match = lines[i].match(LIST_ITEM);
      if (!match) break;
      const item = { ordered: /\d/.test(match[2]), num: Number.parseInt(match[2], 10), text: match[3], subs: [] };
      const parent = items[items.length - 1];
      if (match[1].length >= 2 && parent) parent.subs.push(item);
      else items.push(item);
    }
    return [listHtml(items), i];
  }

  function renderBlocks(lines) {
    const html = [];
    let para = [];
    const flush = () => {
      if (para.length) html.push(`<p>${para.map((line) => inline(line)).join('<br>')}</p>`);
      para = [];
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const fence = line.match(/^```([^`]*)$/);
      const heading = line.match(/^(#{1,3}) (.+)$/);
      const math = mathBlockAt(lines, i);

      if (fence) {
        flush();
        const body = [];
        for (i++; i < lines.length && !/^```\s*$/.test(lines[i]); i++) body.push(lines[i]);
        html.push(codeBlock(fence[1], body));
      } else if (math) {
        flush();
        html.push(mathHtml(math.tex, true));
        i = math.end - 1;
      } else if (line.startsWith('-# ')) {
        flush();
        html.push(`<small class="md-sub">${inline(line.slice(3))}</small>`);
      } else if (heading) {
        flush();
        const tag = HEADING_TAGS[heading[1].length - 1];
        html.push(`<${tag}>${inline(heading[2])}</${tag}>`);
      } else if (line.startsWith('>>> ')) {
        flush();
        html.push(`<blockquote>${renderBlocks([line.slice(4), ...lines.slice(i + 1)])}</blockquote>`);
        break;
      } else if (line.startsWith('> ')) {
        flush();
        const quote = [];
        for (; i < lines.length && lines[i].startsWith('> '); i++) quote.push(lines[i].slice(2));
        i--;
        html.push(`<blockquote>${renderBlocks(quote)}</blockquote>`);
      } else if (LIST_ITEM.test(line)) {
        flush();
        const [listMarkup, next] = renderList(lines, i);
        html.push(listMarkup);
        i = next - 1;
      } else if (line.trim() === '') {
        flush();
      } else {
        para.push(line);
      }
    }
    flush();
    return html.join('');
  }

  const renderMarkdown = (text) =>
    renderBlocks(String(text ?? '').replace(/\r\n?/g, '\n').replace(CONTROL, '').split('\n'));

  if (typeof window !== 'undefined') window.SlopbotMarkdown = { renderMarkdown, typeset };
  if (typeof module !== 'undefined') module.exports = { renderMarkdown, typeset };
})();
