import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parseHTML } from "linkedom";
import { runInNewContext } from "node:vm";

type Render = (text: string) => string;

// The root package is "type": "module", so require() would not see module.exports.
// Run the classic script in a fresh context instead, with the same globals a browser or CommonJS host gives it.
const source = readFileSync(new URL("../../web/markdown.js", import.meta.url), "utf8");

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

test("script tags and event handlers are escaped, never rendered", () => {
  assert.equal(render("<script>alert(1)</script>"), "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  const img = render("<img src=x onerror=alert(1)>");
  assert.doesNotMatch(img, /<img/);
  assert.equal(img, "<p>&lt;img src=x onerror=alert(1)&gt;</p>");
});

test("quotes and ampersands are escaped in text", () => {
  assert.equal(render(`a & "b" 'c'`), "<p>a &amp; &quot;b&quot; &#39;c&#39;</p>");
});

test("javascript: and data: links render as plain text", () => {
  const js = render("[click](javascript:alert(1))");
  assert.doesNotMatch(js, /<a |href/);
  assert.equal(js, "<p>[click](javascript:alert(1))</p>");
  const data = render("[x](data:text/html,<script>alert(1)</script>)");
  assert.doesNotMatch(data, /<a |href|<script/);
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

test("snake_case words and lone asterisks are not italic", () => {
  assert.equal(render("snake_case_name"), "<p>snake_case_name</p>");
  assert.equal(render("2 * 3 * 4"), "<p>2 * 3 * 4</p>");
});

test("no formatting inside inline code", () => {
  assert.equal(render("`**x** ~~y~~`"), "<p><code>**x** ~~y~~</code></p>");
});

test("headings and small text", () => {
  assert.equal(render("# A"), "<h3>A</h3>");
  assert.equal(render("## B"), "<h4>B</h4>");
  assert.equal(render("### C"), "<h5>C</h5>");
  assert.equal(render("-# small text"), '<small class="md-sub">small text</small>');
});

test("unordered and ordered lists", () => {
  assert.equal(render("- a\n- b"), "<ul><li>a</li><li>b</li></ul>");
  assert.equal(render("* a"), "<ul><li>a</li></ul>");
  assert.equal(render("1. one\n2. two"), "<ol><li>one</li><li>two</li></ol>");
});

test("one level of nested list", () => {
  assert.equal(
    render("- a\n  - b\n- c"),
    "<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>",
  );
});

test("bold inside a list item", () => {
  assert.equal(render("- **x** y"), "<ul><li><strong>x</strong> y</li></ul>");
});

test("block quotes, single and to the end with >>>", () => {
  assert.equal(render("> hi\n> there"), "<blockquote><p>hi<br>there</p></blockquote>");
  assert.equal(render(">>> a\nb\n\nc"), "<blockquote><p>a<br>b</p><p>c</p></blockquote>");
});

test("markdown link with a query string", () => {
  assert.equal(
    render("[site](https://example.com/a?b=1&c=2)"),
    '<p><a href="https://example.com/a?b=1&amp;c=2" target="_blank" rel="noopener noreferrer nofollow">site</a></p>',
  );
});

test("bare URL keeps its parenthesis and drops trailing punctuation", () => {
  const out = render("see https://en.wikipedia.org/wiki/Foo_(bar).");
  assert.equal(
    out,
    '<p>see <a href="https://en.wikipedia.org/wiki/Foo_(bar)" target="_blank" rel="noopener noreferrer nofollow">https://en.wikipedia.org/wiki/Foo_(bar)</a>.</p>',
  );
  assert.equal(
    render("(https://example.com)"),
    '<p>(<a href="https://example.com/" target="_blank" rel="noopener noreferrer nofollow">https://example.com</a>)</p>',
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

test("timestamp becomes a time element with an ISO datetime", () => {
  assert.match(render("<t:1700000000:R>"), /^<p><time datetime="2023-11-14T22:13:20\.000Z">[^<]+<\/time><\/p>$/);
});

test("paragraphs and line breaks", () => {
  assert.equal(render("a\n\nb"), "<p>a</p><p>b</p>");
  assert.equal(render("a\nb"), "<p>a<br>b</p>");
});

test("fenced code block with a language keeps its text unformatted", () => {
  assert.equal(
    render("```js\nconst a = 1 < 2; **x**\n```"),
    '<div class="md-code"><div class="md-code-head"><div class="md-code-lang">js</div><button type="button" class="md-copy">Copy</button></div><pre><code>const a = 1 &lt; 2; **x**</code></pre></div>',
  );
});

test("fenced code block without a language has no label", () => {
  assert.equal(render("```\nx\n```"), '<div class="md-code"><div class="md-code-head"><button type="button" class="md-copy">Copy</button></div><pre><code>x</code></pre></div>');
});

test("language label keeps only [a-z0-9+#-]", () => {
  assert.equal(
    render("```Py<img>\nx\n```"),
    '<div class="md-code"><div class="md-code-head"><div class="md-code-lang">pyimg</div><button type="button" class="md-copy">Copy</button></div><pre><code>x</code></pre></div>',
  );
});

test("unclosed fence treats the rest as code", () => {
  assert.equal(
    render("```\n**not bold**\nmore"),
    '<div class="md-code"><div class="md-code-head"><button type="button" class="md-copy">Copy</button></div><pre><code>**not bold**\nmore</code></pre></div>',
  );
});

test("empty input gives empty output", () => {
  assert.equal(render(""), "");
  assert.equal(render("\n\n"), "");
});

test("Discord backslash escapes show the plain character", () => {
  assert.equal(render('word \\"ok\\" and \\*not italic\\* and \\_x\\_'), '<p>word &quot;ok&quot; and *not italic* and _x_</p>');
  assert.equal(render('`\\*kept*`'), '<p><code>\\*kept*</code></p>');
  assert.equal(render('a \\\\ b \\n'), '<p>a \\ b \\n</p>');
});

// Math. The placeholders come from the plain render. typeset() gets a fake katex and a DOM from linkedom.
type KatexCall = { tex: string; displayMode: boolean; opts: Record<string, unknown> };

const ENTITY: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', "#39": "'" };
const decode = (text: string) => text.replace(/&(amp|lt|gt|quot|#39);/g, (_, name: string) => ENTITY[name] ?? "");
// The raw TeX in data-tex, decoded the way the HTML parser decodes attribute values.
const dataTex = (html: string) => decode(html.match(/data-tex="([^"]*)"/)?.[1] ?? "<missing>");

test("inline dollar math", () => {
  const out = render("Euler: $e^{i\\pi}+1=0$ ok");
  assert.equal(out, '<p>Euler: <span class="math" data-tex="e^{i\\pi}+1=0"><code class="math-src">e^{i\\pi}+1=0</code></span> ok</p>');
  assert.equal(dataTex(out), "e^{i\\pi}+1=0");
});

test("price dollars are not math", () => {
  assert.equal(render("It costs $5 and $10 each."), "<p>It costs $5 and $10 each.</p>");
  assert.equal(render("$x$5 and $ y$"), "<p>$x$5 and $ y$</p>");
});

test("block math across lines", () => {
  assert.equal(
    render("before\n$$\na^2\n+ b^2\n$$\nafter"),
    '<p>before</p><div class="math-block" data-tex="a^2\n+ b^2"><code class="math-src">a^2\n+ b^2</code></div><p>after</p>',
  );
});

test("backslash paren and bracket", () => {
  assert.equal(
    render("see \\(a_1\\) now"),
    '<p>see <span class="math" data-tex="a_1"><code class="math-src">a_1</code></span> now</p>',
  );
  assert.equal(render("\\[\nb_2\n\\]"), '<div class="math-block" data-tex="b_2"><code class="math-src">b_2</code></div>');
});

test("underscores in math are not italics", () => {
  assert.equal(
    render("$a_1 + b_2$ and _c_"),
    '<p><span class="math" data-tex="a_1 + b_2"><code class="math-src">a_1 + b_2</code></span> and <em>c</em></p>',
  );
});

test("math in code is not math", () => {
  assert.equal(render("`$x$`"), "<p><code>$x$</code></p>");
  assert.equal(
    render("```\n$$x$$\n```"),
    '<div class="md-code"><div class="md-code-head"><button type="button" class="md-copy">Copy</button></div><pre><code>$$x$$</code></pre></div>',
  );
});

test("escaped dollar", () => {
  assert.equal(render("cost \\$5 and \\$6"), "<p>cost $5 and $6</p>");
  assert.equal(render("\\$x$"), "<p>$x$</p>");
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

test("display math from a real document keeps \\, and has no em", () => {
  const tex = "\\frac{d\\,KE}{dt} = \\rho\\int_{-\\infty}^{\\infty} u_t\\,u_{tt}\\,dx.";
  const out = render(`$$${tex}$$`);
  assert.equal(out, `<div class="math-block" data-tex="${tex}"><code class="math-src">${tex}</code></div>`);
  assert.equal(dataTex(out), tex);
  assert.match(out, /\\,/);
  assert.doesNotMatch(out, /<em>/);
});

test("ordered list keeps start number", () => {
  assert.equal(render("3. c\n4. d"), '<ol start="3"><li>c</li><li>d</li></ol>');
  assert.equal(
    render("1. a\n2. b\n$$\nx\n$$\n3. c"),
    '<ol><li>a</li><li>b</li></ol><div class="math-block" data-tex="x"><code class="math-src">x</code></div><ol start="3"><li>c</li></ol>',
  );
});

test("typeset draws each math placeholder once with katex.render", () => {
  const calls: KatexCall[] = [];
  const katex = {
    render(tex: string, el: { textContent: string | null }, opts: Record<string, unknown>) {
      calls.push({ tex, displayMode: opts.displayMode === true, opts: JSON.parse(JSON.stringify(opts)) as Record<string, unknown> });
      el.textContent = `drawn:${tex}`;
    },
  };
  const win: { katex?: unknown; SlopbotMarkdown?: { renderMarkdown: Render; typeset: (root: unknown) => void } } = { katex };
  runInNewContext(source, { window: win, URL });
  const lib = win.SlopbotMarkdown as { renderMarkdown: Render; typeset: (root: unknown) => void };

  const { document } = parseHTML("<!doctype html><html><body></body></html>");
  const body = document.body;
  body.innerHTML = lib.renderMarkdown("x $a_1$ and\n\n$$\nb\n$$");
  lib.typeset(body);
  lib.typeset(body);

  assert.equal(calls.length, 2);
  assert.deepEqual(calls[0], {
    tex: "a_1",
    displayMode: false,
    opts: { displayMode: false, throwOnError: false, output: "html", trust: false, maxSize: 20, maxExpand: 1000 },
  });
  assert.equal(calls[1]?.tex, "b");
  assert.equal(calls[1]?.displayMode, true);
  assert.equal(body.querySelector(".math")?.textContent, "drawn:a_1");
  assert.equal(body.querySelectorAll("[data-typeset]").length, 2);
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
