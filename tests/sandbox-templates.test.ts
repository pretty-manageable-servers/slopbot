import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SQLiteStore } from '../src/adapters/sqlite.js';
import { TemplateCatalog, sandboxTool, templateCacheMs, type SandboxProvider } from '../src/sandbox.js';

const fiveMinutes = 5 * 60 * 1000;
const settle = () => new Promise(resolve => setImmediate(resolve));

function clock(start = 1_000_000) {
  let time = start;
  return { now: () => time, advance: (ms: number) => { time += ms; } };
}

function provider(list: () => Promise<string[]>, defaultTemplate: string | undefined = 'slopbot'): SandboxProvider {
  return {
    defaultTemplate,
    listTemplates: list,
    create: async () => { throw new Error('not used'); },
    connect: async () => { throw new Error('not used'); },
  };
}

function templateField(sandboxProvider?: SandboxProvider) {
  const tool = sandboxTool(new SQLiteStore(), sandboxProvider);
  return { tool, description: () => tool.fields.template!.description };
}

test('template cache refreshes at most every five minutes', async () => {
  const time = clock();
  let loads = 0;
  const catalog = new TemplateCatalog(async () => { loads++; return ['slopbot', 'base']; }, time.now);
  assert.equal(templateCacheMs, fiveMinutes);
  assert.deepEqual(await catalog.refresh(), ['base', 'slopbot']);
  await catalog.refresh();
  assert.equal(loads, 1, 'a fresh cache must not call the API again');
  time.advance(fiveMinutes - 1);
  await catalog.refresh();
  assert.equal(loads, 1, 'still inside the five minute window');
  time.advance(1);
  await catalog.refresh();
  assert.equal(loads, 2, 'a stale cache loads again');
});

test('template cache reloads after invalidate, such as after a build', async () => {
  const time = clock();
  let names = ['base'];
  const catalog = new TemplateCatalog(async () => names, time.now);
  assert.deepEqual(await catalog.refresh(), ['base']);
  names = ['base', 'slopbot'];
  catalog.invalidate();
  assert.deepEqual(await catalog.refresh(), ['base', 'slopbot']);
});

test('template cache sorts names, drops duplicates and drops names that are not template names', async () => {
  const catalog = new TemplateCatalog(async () => ['slopbot', 'base', 'slopbot', 'bad name', '../x', 'py:v2']);
  assert.deepEqual(await catalog.refresh(), ['base', 'py:v2', 'slopbot']);
});

test('current starts a background load and returns the names once loaded', async () => {
  const catalog = new TemplateCatalog(async () => ['slopbot']);
  assert.equal(catalog.current(), undefined, 'nothing is known before the first load');
  await settle();
  assert.deepEqual(catalog.current(), ['slopbot']);
});

test('a failed reload keeps the last good names and waits before trying again', async () => {
  const time = clock();
  let loads = 0, failing = false;
  const catalog = new TemplateCatalog(async () => {
    loads++;
    if (failing) throw new Error('PMServers is down');
    return ['slopbot'];
  }, time.now);
  await catalog.refresh();
  time.advance(fiveMinutes);
  failing = true;
  await assert.rejects(catalog.refresh(), /PMServers is down/);
  assert.equal(loads, 2);
  assert.deepEqual(await catalog.refresh(), ['slopbot'], 'inside the retry window the last good names are returned');
  assert.equal(loads, 2, 'no new API call inside the retry window');
  assert.deepEqual(catalog.current(), ['slopbot']);
  time.advance(fiveMinutes);
  failing = false;
  assert.deepEqual(await catalog.refresh(), ['slopbot']);
  assert.equal(loads, 3);
});

test('a project with no template list yet rejects instead of guessing names', async () => {
  const catalog = new TemplateCatalog(async () => { throw new Error('unreachable'); });
  await assert.rejects(catalog.refresh(), /unreachable/);
  assert.equal(catalog.current(), undefined);
});

test('template field description lists sorted names, the default and the slopbot note', async () => {
  const { description } = templateField(provider(async () => ['slopbot', 'base', 'py-data']));
  description();
  await settle();
  const text = description();
  assert.match(text, /Omit it for the default: slopbot\./);
  assert.match(text, /Templates in this project: base, py-data, slopbot\./);
  assert.match(text, /slopbot: Python 3 with pip, venv and common data packages/);
  assert.match(text, /Do not guess names/);
});

test('template field description is the same on every call while the list is unchanged', async () => {
  const { description } = templateField(provider(async () => ['slopbot', 'base']));
  description();
  await settle();
  const first = description();
  const second = description();
  assert.equal(first, second);
});

test('template field description leaves out the slopbot note when slopbot is not a template', async () => {
  const { description } = templateField(provider(async () => ['base'], 'base'));
  description();
  await settle();
  const text = description();
  assert.match(text, /Omit it for the default: base\./);
  assert.match(text, /Templates in this project: base\./);
  assert.doesNotMatch(text, /slopbot/);
});

test('template field description says the list is unavailable when the API fails', async () => {
  const { description } = templateField(provider(async () => { throw new Error('down'); }));
  description();
  await settle();
  const text = description();
  assert.match(text, /Omit it for the default: slopbot\. The template list is unavailable right now\./);
  assert.match(text, /slopbot: Python 3/, 'the default is slopbot, so its note stays');
});

test('template field description reports an empty project without guessing', async () => {
  const { description } = templateField(provider(async () => []));
  description();
  await settle();
  assert.match(description(), /This project has no ready templates yet\./);
});

test('template field description is a fixed text for a provider without template listing', () => {
  const { description } = templateField(undefined);
  assert.match(description(), /Omit it for the default: base\. This sandbox provider does not list templates\./);
});

test('provider lists ready template names and aliases across pages', async () => {
  const { createServer } = await import('node:http');
  const { E2BSandboxProvider } = await import('../src/adapters/e2b-sandbox.js');
  const seen: Array<{ path: string; key: string | undefined; token: string | null }> = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    seen.push({ path: url.pathname, key: request.headers['x-api-key'] as string | undefined, token: url.searchParams.get('nextToken') });
    response.setHeader('content-type', 'application/json');
    if (url.searchParams.get('nextToken') === 'page-2') {
      response.end(JSON.stringify([{ templateID: 't3', buildStatus: 'ready', names: ['py-data:v1'], aliases: [] }, { templateID: 't4', buildStatus: 'building', names: ['not-yet'], aliases: [] }]));
      return;
    }
    response.setHeader('X-Next-Token', 'page-2');
    response.end(JSON.stringify([{ templateID: 't1', buildStatus: 'ready', names: ['slopbot:latest', 'slopbot'], aliases: ['slopbot'] }, { templateID: 't2', buildStatus: 'error', names: ['broken'], aliases: [] }]));
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  try {
    const port = (server.address() as { port: number }).port;
    const provider = new E2BSandboxProvider({ apiKey: 'test-only', apiUrl: `http://127.0.0.1:${port}/sandboxes`, sandboxUrl: `http://127.0.0.1:${port}` });
    const names = await provider.listTemplates();
    assert.deepEqual(names.sort(), ['py-data:v1', 'slopbot', 'slopbot:latest']);
    assert.deepEqual(seen.map(item => item.path), ['/sandboxes/v2/templates', '/sandboxes/v2/templates']);
    assert.ok(seen.every(item => item.key === 'test-only'));
    assert.deepEqual(seen.map(item => item.token), [null, 'page-2']);
  } finally {
    await new Promise(resolve => server.close(resolve));
  }
});
