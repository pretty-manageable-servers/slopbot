// Builds the "slopbot" sandbox template on PMServers.
// Run: npm run sandbox:template (reads E2B_API_KEY from .env.development).
import { Template } from 'e2b';

const name = 'slopbot';
const pollMs = 5000;
const deadlineMs = 25 * 60 * 1000;

const apiKey = process.env.E2B_API_KEY;
if (!apiKey) throw new Error('Set E2B_API_KEY to a PMServers project token.');
const connection = { apiKey, apiUrl: process.env.E2B_API_URL ?? 'https://api.pmservers.org/sandboxes' };

const aptPackages = [
  'ca-certificates', 'curl', 'wget', 'git', 'jq', 'ripgrep', 'fd-find', 'unzip', 'zip', 'tar', 'xz-utils',
  'build-essential', 'sqlite3', 'iproute2', 'less', 'file', 'tree', 'python3', 'python3-pip', 'python3-venv',
];
const pipHeavy = ['numpy', 'pandas', 'matplotlib', 'openpyxl'];
const pipLight = ['requests', 'httpx', 'pillow', 'beautifulsoup4', 'lxml', 'pyyaml', 'python-dateutil', 'tabulate'];
// Sandbox commands run with the default PATH (/usr/local/bin first), not the image ENV. So the template puts
// everything on that PATH: the Python packages go into the base python3, and the old base Node links are removed
// so NodeSource Node in /usr/bin is used.
const pip = 'python3 -m pip install --no-cache-dir --no-compile --disable-pip-version-check';

// Each RUN step cleans its own caches. The pip steps use --no-cache-dir to stay under the 1 GiB build memory.
const template = Template()
  .runCmd(`apt-get update && apt-get install -y --no-install-recommends ${aptPackages.join(' ')} && ln -sf /usr/bin/fdfind /usr/local/bin/fd && apt-get clean && rm -rf /var/lib/apt/lists/* /usr/share/doc /usr/share/man`, { user: 'root' })
  .runCmd('curl -fsSL https://deb.nodesource.com/setup_lts.x -o /tmp/nodesource-setup.sh && bash /tmp/nodesource-setup.sh && rm -f /tmp/nodesource-setup.sh && apt-get install -y --no-install-recommends nodejs && apt-get clean && rm -rf /var/lib/apt/lists/* && rm -f /usr/local/bin/node /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack', { user: 'root' })
  .runCmd(`(python3 -m pip --version || python3 -m ensurepip) && ${pip} ${pipHeavy.join(' ')}`, { user: 'root' })
  .runCmd(`${pip} ${pipLight.join(' ')} && python3 -c "import numpy, pandas, requests; print('python ok')" && node -v`, { user: 'root' });

const started = Date.now();
const info = await Template.buildInBackground(template, name, connection);
console.log(`Build started. Template: ${name}. Template ID: ${info.templateId}. Build ID: ${info.buildId}.`);

// Poll the build status until it is ready or failed. Only customer-facing log entries are printed.
const printEntries = entries => {
  for (const entry of entries) if (['info', 'warn', 'error'].includes(entry.level)) console.log(`  [${entry.level}] ${entry.message}`);
};
// A status request can fail on a gateway error. Retry it a few times before giving up.
const fetchStatus = async () => {
  for (let attempt = 1; ; attempt++) {
    try {
      return await Template.getBuildStatus({ templateId: info.templateId, buildId: info.buildId }, { ...connection, logsOffset: offset });
    } catch (error) {
      if (attempt >= 5) throw error;
      console.log(`  Status request failed (attempt ${attempt}). Retrying in 10 s.`);
      await new Promise(resolve => setTimeout(resolve, 10000));
    }
  }
};
let offset = 0;
let status;
while (true) {
  status = await fetchStatus();
  offset += status.logEntries.length;
  printEntries(status.logEntries);
  if (status.status === 'ready' || status.status === 'error') {
    // Drain the remaining log entries after a final status.
    let tail = status;
    while (tail.logEntries.length > 0) {
      tail = await fetchStatus();
      offset += tail.logEntries.length;
      printEntries(tail.logEntries);
    }
    break;
  }
  if (Date.now() - started > deadlineMs) break;
  await new Promise(resolve => setTimeout(resolve, pollMs));
}

const seconds = ((Date.now() - started) / 1000).toFixed(1);
if (status?.status === 'ready') {
  console.log(`Final status: ready. Build ID: ${info.buildId}. Build time: ${seconds} s.`);
} else {
  console.log(`Final status: ${status?.status ?? 'unknown'}. Build ID: ${info.buildId}. Build time: ${seconds} s.`);
  console.log(`Build failed: ${status?.reason?.message ?? 'no reason reported'}`);
  if (status?.reason?.step) console.log(`Failed step: ${status.reason.step}`);
  printEntries(status?.reason?.logEntries ?? []);
  process.exitCode = 1;
}
