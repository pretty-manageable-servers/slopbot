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

test("script tags and event handlers are escaped, never rendered", () => {
  assert.equal(render("<script>alert(1)</script>"), "<p>&lt;script&gt;alert(1)&lt;/script&gt;</p>");
  const img = render("<img src=x onerror=alert(1)>");
  assert.doesNotMatch(img, /<img/);
  assert.equal(img, "<p>&lt;img src=x onerror=alert(1)&gt;</p>");
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

// Math. The placeholders come from the plain render. typeset() gets a fake katex and a DOM from linkedom.
type KatexCall = { tex: string; displayMode: boolean; opts: Record<string, unknown> };


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

test("markdown syntax renders to the expected HTML", () => {
  const link = (href: string, label: string) => `<a href="${href}" target="_blank" rel="noopener noreferrer nofollow">${label}</a>`;
  const math = (tex: string) => `<span class="math" data-tex="${tex}"><code class="math-src">${tex}</code></span>`;
  const mathBlock = (tex: string) => `<div class="math-block" data-tex="${tex}"><code class="math-src">${tex}</code></div>`;
  const code = (body: string, lang = "") => `<div class="md-code"><div class="md-code-head">${lang ? `<div class="md-code-lang">${lang}</div>` : ""}<button type="button" class="md-copy">Copy</button></div><pre><code>${body}</code></pre></div>`;
  const cases: [string, string][] = [
    ["**b** *i* _j_ __u__ ~~s~~ ||sp||", '<p><strong>b</strong> <em>i</em> <em>j</em> <u>u</u> <s>s</s> <span class="md-spoiler">sp</span></p>'],
    ["snake_case_name", "<p>snake_case_name</p>"],
    ["2 * 3 * 4", "<p>2 * 3 * 4</p>"],
    ["`**x** ~~y~~`", "<p><code>**x** ~~y~~</code></p>"],
    ["# A", "<h3>A</h3>"],
    ["- a\n  - b\n- c", "<ul><li>a<ul><li>b</li></ul></li><li>c</li></ul>"],
    ["1. one\n2. two", "<ol><li>one</li><li>two</li></ol>"],
    ["3. c\n4. d", '<ol start="3"><li>c</li><li>d</li></ol>'],
    ["> hi\n> there", "<blockquote><p>hi<br>there</p></blockquote>"],
    ["a\n\nb", "<p>a</p><p>b</p>"],
    ["", ""],
    ["[site](https://example.com/a?b=1&c=2)", `<p>${link("https://example.com/a?b=1&amp;c=2", "site")}</p>`],
    ["see https://en.wikipedia.org/wiki/Foo_(bar).", `<p>see ${link("https://en.wikipedia.org/wiki/Foo_(bar)", "https://en.wikipedia.org/wiki/Foo_(bar)")}.</p>`],
    ["<@123> <#789> <@&111> <:wave:222>", '<p><span class="md-mention">@user</span> <span class="md-mention">#channel</span> <span class="md-mention">@role</span> :wave:</p>'],
    ["```js\nconst a = 1 < 2; **x**\n```", code("const a = 1 &lt; 2; **x**", "js")],
    ["```\n**not bold**\nmore", code("**not bold**\nmore")],
    ["```Py<img>\nx\n```", code("x", "pyimg")],
    ['word \\"ok\\" and \\*not italic\\* and \\_x\\_', "<p>word &quot;ok&quot; and *not italic* and _x_</p>"],
    ["Euler: $e^{i\\pi}+1=0$ ok", `<p>Euler: ${math("e^{i\\pi}+1=0")} ok</p>`],
    ["It costs $5 and $10 each.", "<p>It costs $5 and $10 each.</p>"],
    ["$x$5 and $ y$", "<p>$x$5 and $ y$</p>"],
    ["before\n$$\na^2\n+ b^2\n$$\nafter", `<p>before</p>${mathBlock("a^2\n+ b^2")}<p>after</p>`],
    ["see \\(a_1\\) now", `<p>see ${math("a_1")} now</p>`],
    ["$a_1 + b_2$ and _c_", `<p>${math("a_1 + b_2")} and <em>c</em></p>`],
    ["`$x$`", "<p><code>$x$</code></p>"],
    ["```\n$$x$$\n```", code("$$x$$")],
    ["cost \\$5 and \\$6", "<p>cost $5 and $6</p>"],
    ["$$\nc & d\n$$", mathBlock("c &amp; d")],
    ["$$\\frac{d\\,KE}{dt} = \\rho\\int_{-\\infty}^{\\infty} u_t\\,u_{tt}\\,dx.$$", mathBlock("\\frac{d\\,KE}{dt} = \\rho\\int_{-\\infty}^{\\infty} u_t\\,u_{tt}\\,dx.")],
  ];
  for (const [input, expected] of cases) assert.equal(render(input), expected, input);
});
