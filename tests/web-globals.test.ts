import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

// The console scripts are classic scripts and share one global scope, so a name declared twice stops a whole file.
test("console scripts do not declare the same top-level name twice", () => {
  const seen = new Map<string, string>();
  for (const file of ["web/shares.js", "web/conversations.js", "web/app.js"]) {
    for (const line of readFileSync(file, "utf8").split("\n")) {
      const match = line.match(/^(?:const|let|var|function|async function|class)\s+([^=(]+)/);
      if (!match) continue;
      const names = /^(?:const|let|var)/.test(line) ? match[1]!.split(",").map(part => part.trim().split(/\s/)[0]!) : [match[1]!.trim()];
      for (const name of names) { assert.ok(!seen.has(name), `${name} is declared in ${seen.get(name)} and ${file}`); seen.set(name, file); }
    }
  }
});
