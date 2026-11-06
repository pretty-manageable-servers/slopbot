import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { runInNewContext } from "node:vm";

type Render = (text: string) => string;

// The root package is "type": "module", so require() would not see module.exports.
// Run the classic script in a fresh context instead, with the same globals a browser or CommonJS host gives it.
const source = readFileSync(new URL("../../share/markdown.js", import.meta.url), "utf8");

function loadAsModule(): Render {
  const box: { exports: Record<string, unknown> } = { exports: {} };
  runInNewContext(source, { module: box, URL });
  return (box.exports as { renderMarkdown: Render }).renderMarkdown;
}

const render = loadAsModule();

test('generated images and linked graph files render inline with safe URLs and escaped labels', () => {
  for (const text of ['![Earth temperature](https://s3.example/plot.png?signature=abc)', '[Earth temperature](https://s3.example/plot.png?signature=abc)']) {
    const { document } = parseHTML(render(text));
    assert.equal(document.querySelector('img')?.getAttribute('src'), 'https://s3.example/plot.png?signature=abc');
    assert.equal(document.querySelector('img')?.getAttribute('alt'), 'Earth temperature');
    assert.equal(document.querySelector('a')?.getAttribute('href'), 'https://s3.example/plot.png?signature=abc');
  }
  for (const url of ['javascript:alert(1)', 'data:image/svg+xml,evil', 'http://example.com/plot.png', 'https://user:password@example.com/plot.png']) assert.ok(!render(`![x](${url})`).includes('<img'));
  const hostile = render('![" onerror="alert(1)](https://example.com/plot.png)');
  const { document } = parseHTML(hostile); assert.equal(document.querySelector('img')?.getAttribute('onerror'), null);
});

test("browser build exposes window.SlopbotMarkdown and no top-level names", () => {
  const win: { SlopbotMarkdown?: { renderMarkdown: Render } } = {};
  runInNewContext(source, { window: win, URL });
  assert.equal(typeof win.SlopbotMarkdown?.renderMarkdown, "function");
  assert.equal(win.SlopbotMarkdown?.renderMarkdown("**a**"), "<p><strong>a</strong></p>");
});

test("hostile input is escaped or shown as plain text, never rendered as markup", () => {
  const cases: [string, RegExp][] = [
    ["<script>alert(1)</script>", /<script|<img/],
    ["<img src=x onerror=alert(1)>", /<img/],
    ["[click](javascript:alert(1))", /<a |href/],
    ["[x](data:text/html,<script>alert(1)</script>)", /<a |href|<script/],
  ];
  for (const [text, forbidden] of cases) assert.doesNotMatch(render(text), forbidden, text);
});

test("quotes in a link URL cannot break out of href", () => {
  assert.equal(
    render('[x](https://example.com/a"onmouseover="alert(1))'),
    '<p><a href="https://example.com/a%22onmouseover=%22alert(1)" target="_blank" rel="noopener noreferrer nofollow">x</a></p>',
  );
});

test("HTML inside inline code and fenced code is shown as text", () => {
  assert.equal(render("`<b>x</b>`"), "<p><code>&lt;b&gt;x&lt;/b&gt;</code></p>");
  assert.equal(
    render("```html\n<script>x</script>\n```"),
    '<div class="md-code"><div class="md-code-head"><div class="md-code-lang">html</div><button type="button" class="md-copy">Copy</button></div><pre><code>&lt;script&gt;x&lt;/script&gt;</code></pre></div>',
  );
});

test("bold, italic, underline, strike and spoiler", () => {
  assert.equal(
    render("**b** *i* _j_ __u__ ~~s~~ ||sp||"),
    '<p><strong>b</strong> <em>i</em> <em>j</em> <u>u</u> <s>s</s> <span class="md-spoiler">sp</span></p>',
  );
});

test("mentions, roles, channels and custom emoji show no IDs", () => {
  const out = render("<@123> <@!456> <#789> <@&111> <:wave:222>");
  assert.equal(
    out,
    '<p><span class="md-mention">@user</span> <span class="md-mention">@user</span> <span class="md-mention">#channel</span> <span class="md-mention">@role</span> :wave:</p>',
  );
  assert.doesNotMatch(out, /123|456|789|111|222/);
});

test("language label keeps only [a-z0-9+#-]", () => {
  assert.equal(
    render("```Py<img>\nx\n```"),
    '<div class="md-code"><div class="md-code-head"><div class="md-code-lang">pyimg</div><button type="button" class="md-copy">Copy</button></div><pre><code>x</code></pre></div>',
  );
});

test("no katex shows source", () => {
  assert.equal(
    render("x $a < b$ y"),
    '<p>x <span class="math" data-tex="a &lt; b"><code class="math-src">a &lt; b</code></span> y</p>',
  );
  assert.equal(
    render("$$\nc & d\n$$"),
    '<div class="math-block" data-tex="c &amp; d"><code class="math-src">c &amp; d</code></div>',
  );
});

test("typeset without katex keeps the source text", () => {
  const win: { SlopbotMarkdown?: { renderMarkdown: Render; typeset: (root: unknown) => void } } = {};
  runInNewContext(source, { window: win, URL });
  const lib = win.SlopbotMarkdown as { renderMarkdown: Render; typeset: (root: unknown) => void };
  const { document } = parseHTML("<!doctype html><html><body></body></html>");
  document.body.innerHTML = lib.renderMarkdown("$x<y$");
  lib.typeset(document.body);
  assert.equal(document.body.querySelector(".math")?.textContent, "x<y");
  assert.equal(document.body.querySelectorAll("[data-typeset]").length, 0);
});
