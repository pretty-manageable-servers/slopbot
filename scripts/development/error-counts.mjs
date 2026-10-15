import { createInterface } from 'node:readline';
import { pathToFileURL } from 'node:url';

const codes = new Set(['TOOL_BLOCKED', 'TOOL_FAILED', 'TOOL_ROUND_LIMIT', 'CONTEXT_BUDGET']);
export function errorCounts(lines, { since = -Infinity, until = Infinity, server } = {}) {
  const counts = new Map(); let undated = 0;
  for (const line of lines) {
    let item;
    try { item = JSON.parse(line); } catch { continue; }
    const envelopeTime = item.time ?? item.timestamp;
    if (typeof item.message === 'string' && !item.code) {
      try { item = JSON.parse(item.message); } catch { continue; }
    }
    if (!codes.has(item.code) || server && item.context?.server !== server) continue;
    const time = Date.parse(item.timestamp ?? envelopeTime);
    if (!Number.isFinite(time)) { undated++; continue; }
    if (time < since || time >= until) continue;
    const day = new Date(time).toISOString().slice(0, 10), tool = item.context?.tool ?? '(agent)', key = JSON.stringify([day, tool, item.code]);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  return { counts: [...counts].sort(([a], [b]) => a.localeCompare(b)).map(([key, count]) => {
    const [day, tool, code] = JSON.parse(key); return { day, tool, code, count };
  }), undated, scope: 'Counts cover only supplied logs. Agent-level failures without a tool attribution are grouped as (agent). Undated legacy lines are excluded.' };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    const args = process.argv.slice(2), options = {};
    for (let i = 0; i < args.length; i += 2) {
      const key = args[i], value = args[i + 1];
      if (!['--since', '--until', '--server'].includes(key) || !value) throw new Error('Use --since ISO_DATE --until ISO_DATE [--server SERVER_ID], with NDJSON logs on stdin');
      options[key.slice(2)] = key === '--server' ? value : Date.parse(value);
      if (key !== '--server' && !Number.isFinite(options[key.slice(2)])) throw new Error(`Invalid ${key}: use an ISO date`);
    }
    if (options.since >= options.until) throw new Error('--until must be later than --since');
    const lines = []; for await (const line of createInterface({ input: process.stdin })) lines.push(line);
    process.stdout.write(JSON.stringify(errorCounts(lines, options), null, 2) + '\n');
  } catch (error) { process.stderr.write(error.message + '\n'); process.exitCode = 1; }
}
