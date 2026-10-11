import { E2BSandboxProvider } from '../dist/src/adapters/e2b-sandbox.js';
if (!process.env.E2B_API_KEY) throw new Error('Set E2B_API_KEY to a PMServers project token.');
const provider = new E2BSandboxProvider({
  apiKey: process.env.E2B_API_KEY,
  apiUrl: process.env.E2B_API_URL ?? 'https://api.pmservers.org/sandboxes',
  sandboxUrl: process.env.E2B_SANDBOX_URL ?? 'https://sandbox.pmservers.org',
  ...(process.env.E2B_TEMPLATE ? { template: process.env.E2B_TEMPLATE } : {}),
});
let sandbox;
try {
  sandbox = await provider.create({ application: 'slopbot', purpose: 'smoke-test' }, 120000);
  await sandbox.write('/tmp/slopbot-smoke.txt', 'slopbot sandbox smoke test');
  if (await sandbox.read('/tmp/slopbot-smoke.txt') !== 'slopbot sandbox smoke test') throw new Error('Sandbox file check failed.');
  const result = await sandbox.run('cat /tmp/slopbot-smoke.txt; echo; echo $((2+2))', 30000);
  if (result.exitCode !== 0 || !result.stdout.includes('4')) throw new Error('Sandbox command check failed.');
  await sandbox.renew(120000);
  const connected = await provider.connect(sandbox.id);
  if (await connected.read('/tmp/slopbot-smoke.txt') !== 'slopbot sandbox smoke test') throw new Error('Sandbox reconnect check failed.');
  console.log('Remote creation, file write/read, commands, lease renewal and reconnect passed.');
} finally {
  if (sandbox) { await sandbox.close(); console.log('Smoke-test sandbox destroyed.'); }
}
