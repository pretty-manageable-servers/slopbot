import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";

// The console scripts are classic scripts and share one global scope, so a name declared twice stops a whole file.
test("console scripts do not declare the same top-level name twice", () => {
  const seen = new Map<string, string>();
  // web/markdown.js comes from another branch. It is skipped until it exists here.
  for (const file of ["web/shares.js", "web/markdown.js", "web/conversations.js", "web/app.js", "web/palette.js"].filter(item => existsSync(item))) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const match = line.match(/^(?:const|let|var|function|async function|class)\s+([^=(]+)/);
      if (!match) continue;
      const names = /^(?:const|let|var)/.test(line) ? match[1]!.split(",").map(part => part.trim().split(/\s/)[0]!) : [match[1]!.trim()];
      for (const name of names) { assert.ok(!seen.has(name), `${name} is declared in ${seen.get(name)} and ${file}`); seen.set(name, file); }
    }
  }
});

// After a refresh the settings and user dialogs open without a user click, so Chrome groups their close watchers and one native Escape
// closes both. The user dialog must handle Escape itself, in the capture phase, and stop the native close with preventDefault.
// A browser check is in the e2e run; this test only guards the handler in Node.
test("the user dialog handles Escape itself, so settings stays open", () => {
  const source = readFileSync("web/app.js", "utf8");
  const start = source.indexOf("document.addEventListener('keydown', event => {\n  const dialog = $('user-dialog');");
  assert.ok(start >= 0, "missing the document keydown handler for the user dialog");
  const handler = source.slice(start, source.indexOf("}, true);", start) + "}, true);".length);
  assert.match(handler, /event\.key !== 'Escape' \|\| !dialog\.open/);
  assert.match(handler, /event\.preventDefault\(\)/);
  assert.match(handler, /dialog\.close\(\)/);
  assert.ok(handler.endsWith("}, true);"), "the handler must run in the capture phase");
});
