import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

test('the container test stage includes every script test input', () => {
  const docker = readFileSync('Dockerfile', 'utf8').split('RUN npm test')[0];
  const copies = [...docker.matchAll(/^COPY (\S+) /gm)].map(match => match[1]);
  const command = JSON.parse(readFileSync('package.json', 'utf8')).scripts.test;
  const scripts = [...command.matchAll(/node --test (scripts\/\S+)/g)].map(match => match[1]);
  for (const script of scripts) assert.ok(copies.some(source => script === source || script.startsWith(source.replace(/\/$/, '') + '/')), `Container test input is not copied: ${script}`);
});
