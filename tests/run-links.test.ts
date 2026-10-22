import assert from 'node:assert/strict';
import { test } from 'node:test';
import { replyRunLink, showCodeRows } from '../src/adapters/discord-code.js';
import { runTranscriptUrl } from '../src/adapters/discord-tool-trace.js';
import { signInReturn } from '../src/web-console.js';
import type { ToolActivity } from '../src/tool-activity.js';

const activity: ToolActivity[] = [{ id: 'one', name: 'read', status: 'completed' }];
const ROUTE = /^\/(chat|team)\/([^/]+)(?:\/run\/([^/]+))?\/?$/; // The same path rule as web/app.js takeHashItem.

test('reply_has_link_button_to_run_when_web_enabled', () => {
  const link = replyRunLink('https://slopbot.example', 'guild1', 'chan1', ['run-a', 'run-b']);
  assert.equal(link, 'https://slopbot.example/team/chan1/run/run-b?server=guild1&steps=open');
  const rows = showCodeRows(activity, 'summary', undefined, link);
  assert.equal(rows.length, 1);
  const button = rows[0]!.toJSON().components[0] as { style: number; label: string; url: string; custom_id?: string };
  assert.equal(button.style, 5, 'Link style');
  assert.equal(button.label, 'Tool runs');
  assert.equal(button.url, link);
  assert.equal(button.custom_id, undefined, 'a link button sends no interaction');
});

test('reply_keeps_old_button_when_web_disabled', () => {
  assert.equal(replyRunLink(undefined, 'guild1', 'chan1', ['run-a']), undefined);
  assert.equal(replyRunLink('https://slopbot.example', 'guild1', 'chan1', []), undefined, 'no run to link keeps the old button too');
  const rows = showCodeRows(activity, 'full', 'trace-1');
  assert.equal((rows[0]!.toJSON().components[0] as { custom_id: string }).custom_id, 'sloptrace:trace-1');
  assert.deepEqual(showCodeRows(activity, 'none', 'trace-1', 'https://x/y'), []);
});

test('deep_link_route_parses_run', () => {
  const url = new URL(runTranscriptUrl('https://slopbot.example', 'guild1', 'chan1', 'run/x 1'));
  assert.equal(url.pathname, '/team/chan1/run/run%2Fx%201');
  const match = ROUTE.exec(url.pathname);
  assert.ok(match);
  assert.equal(match[1], 'team');
  assert.equal(match[2], 'chan1');
  assert.equal(decodeURIComponent(match[3]!), 'run/x 1');
  assert.equal(url.searchParams.get('server'), 'guild1');
  assert.equal(url.searchParams.get('steps'), 'open');
});

test('sign_in_returns_to_run_link_only_on_this_site', () => {
  assert.equal(signInReturn('/team/chan1/run/run-a?server=guild1&steps=open'), '/team/chan1/run/run-a?server=guild1&steps=open');
  assert.equal(signInReturn('/chat/abc'), '/chat/abc');
  assert.equal(signInReturn(null), '/console');
  assert.equal(signInReturn('https://evil.example/team/c'), '/console');
  assert.equal(signInReturn('//evil.example/team/c'), '/console');
  assert.equal(signInReturn('/team/c/../../console'), '/console');
  assert.equal(signInReturn('/console'), '/console');
});
