import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const entry = resolve(root, 'src/web-main.js');
// discord-image-source.ts only has a Discord name: it imports no discord.js and the engine workspace uses it.
const NAME_ONLY = /\/src\/adapters\/discord-image-source(\.js)?$/;
const forbidden = (file: string) => /\/src\/clients\/discord\//.test(file) || (/\/src\/adapters\/discord-[^/]*$/.test(file) && !NAME_ONLY.test(file));
const SPECIFIER = /(?:^|[\s;}])(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|(?:^|[\s;}])import\s*['"]([^'"]+)['"]/g;

test('the local console entry reaches no Discord code', () => {
  assert.ok(existsSync(entry), 'dist/src/web-main.js is built');
  const parent = new Map<string, string>();
  const seen = new Set([entry]), queue = [entry];
  const chain = (file: string, leaf: string) => {
    const path = [leaf];
    for (let at: string | undefined = file; at; at = parent.get(at)) path.unshift(relative(root, at));
    return path.join(' -> ');
  };
  while (queue.length) {
    const file = queue.shift()!;
    const source = readFileSync(file, 'utf8');
    for (const match of source.matchAll(SPECIFIER)) {
      const specifier = (match[1] ?? match[2])!;
      if (specifier === 'discord.js' || specifier.startsWith('discord.js/')) assert.fail(`imports discord.js: ${chain(file, specifier)}`);
      if (!specifier.startsWith('.')) continue;
      const target = resolve(dirname(file), specifier);
      if (forbidden(target)) assert.fail(`imports Discord code: ${chain(file, relative(root, target))}`);
      if (!seen.has(target) && existsSync(target)) { seen.add(target); parent.set(target, file); queue.push(target); }
    }
  }
  assert.ok(seen.size > 20, 'the walk followed the import graph');
});
