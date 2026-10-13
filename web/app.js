let state, csrf, tab = 'server', viewAuto = false, viewReady = false;
const $ = id => document.getElementById(id);
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const recall = key => { try { return localStorage.getItem(key); } catch { return null; } };
const remember = (key, value) => { try { localStorage.setItem(key, value); } catch { } };
function theme(light) { document.documentElement.classList.toggle('light', light); document.querySelectorAll('img[src*="logo-"]').forEach(img => img.src = `/assets/logo-${light ? 'dark' : 'light'}.svg`); const next = light ? 'Switch to dark theme' : 'Switch to light theme'; $('theme').setAttribute('aria-label', next); $('theme').title = next; $('theme-sun').hidden = light; $('theme-moon').hidden = !light; remember('slopbot-theme', light ? 'light' : 'dark'); }
theme(recall('slopbot-theme') === 'light');
$('theme').onclick = () => theme(!document.documentElement.classList.contains('light'));
// Top bar: Chat or Settings, and the account menu. Chat is the default when the user can view a conversation.
function setView(view) {
  if (view === 'chat') tab = 'conversations';
  else if (tab === 'conversations') tab = state.admin ? 'server' : 'profile';
  viewAuto = false;
  remember('slopbot-view', view);
  history.replaceState(null, '', '#' + view);
  render();
}
function chooseView() {
  viewReady = true;
  const hash = location.hash.slice(1), saved = recall('slopbot-view');
  const want = ['chat', 'settings'].includes(hash) ? hash : ['chat', 'settings'].includes(saved) ? saved : '';
  if (want === 'settings' || (!want && !state.server)) tab = state.admin ? 'server' : 'profile';
  else { tab = 'conversations'; viewAuto = !want; }
}
// Used when the user has no conversation to view. The view then falls back to Settings.
function fallbackToSettings() {
  viewAuto = false;
  tab = state.admin ? 'server' : 'profile';
  history.replaceState(null, '', '#settings');
  render();
}
document.querySelectorAll('[data-view]').forEach(button => { button.onclick = () => setView(button.dataset.view); });
const accountButton = $('account-button'), accountMenu = $('account-menu');
function setAccountMenu(open) { accountMenu.hidden = !open; accountButton.setAttribute('aria-expanded', String(open)); }
accountButton.onclick = event => { event.stopPropagation(); setAccountMenu(accountMenu.hidden); };
document.addEventListener('click', event => { if (!$('account').contains(event.target)) setAccountMenu(false); });
document.addEventListener('keydown', event => { if (event.key === 'Escape' && !accountMenu.hidden) { setAccountMenu(false); accountButton.focus(); } });
// Avatars come only from Discord's CDN. Any other URL is dropped, and a letter pill shows instead.
const AVATAR_HOST = 'https://cdn.discordapp.com/';
// The signed-in user's avatar: the image when it loads, else a pill with the first letter of the name.
function accountAvatar(url, name) {
  const pill = () => Object.assign(document.createElement('span'), { className: 'avatar-pill', textContent: Array.from(String(name).trim())[0]?.toUpperCase() || '?' });
  if (typeof url !== 'string' || !url.startsWith(AVATAR_HOST)) return pill();
  const img = Object.assign(document.createElement('img'), { className: 'avatar-img', alt: '', width: 24, height: 24, src: url, referrerPolicy: 'no-referrer' });
  img.onerror = () => img.replaceWith(pill());
  return img;
}
function renderAccount() {
  const name = state.me?.displayName || state.profile?.name || state.user || '';
  const avatarUrl = state.me?.avatarUrl || state.profile?.avatarUrl;
  accountButton.replaceChildren(accountAvatar(avatarUrl, name));
  $('account-name').replaceChildren(accountAvatar(avatarUrl, name), document.createTextNode(name));
}
function notice(text) { $('notice').textContent = text; }
function showScreen(name) { $('top-tabs').hidden = name !== 'console'; $('boot').hidden = name !== 'boot'; $('login').hidden = name !== 'login'; $('console').hidden = name !== 'console'; $('account').hidden = name !== 'console'; }
const loader = size => { const svg = $('loader').content.firstElementChild.cloneNode(true); if (size) svg.classList.add(size); return svg; };
function busy(size, text) { const box = document.createElement('div'), label = document.createElement('p'); box.className = 'busy'; label.textContent = text; box.append(loader(size), label); return box; }
async function request(path, body) {
  const response = await fetch(path, body ? { method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':csrf}, body:JSON.stringify(body) } : {});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || 'Request failed.'); error.status = response.status; throw error; }
  return data;
}
const settingsFor = id => request(id ? `/api/settings?server=${encodeURIComponent(id)}` : '/api/settings');
function fail(error) { if (error.status === 401) showScreen('login'); else notice(error.message); }
async function run(button, task) {
  const label = button.textContent;
  button.disabled = true; button.setAttribute('aria-busy', 'true'); button.replaceChildren(loader('sm'));
  // The settings are reloaded after the action, even when it failed, so the page shows what the server holds.
  try { await task(); } catch (error) { fail(error); }
  try { await refresh(); } catch (error) { fail(error); }
  finally { button.disabled = false; button.removeAttribute('aria-busy'); button.textContent = label; }
}
const refresh = async () => applySettings(await settingsFor(state.server.id));
const input = (label, name, value, max, min = 0) => `<label>${label}<input name="${name}" type="number" min="${min}" max="${max}" value="${esc(value)}" required></label>`;
const checkbox = (label, name, value) => `<label><input name="${name}" type="checkbox" ${value ? 'checked' : ''}>${label}</label>`;
const card = (id, title, scope, body, button = 'Save changes') => `<form class="card" id="${id}"><h2>${title}</h2><p class="scope">${scope}</p>${body}<button class="primary">${button}</button></form>`;
function bind(id, handler) { const form = $(id); if (!form) return; form.onsubmit = event => { event.preventDefault(); run(form.querySelector('button'), () => handler(new FormData(form))); }; }
async function save(name, args, channel = state.channels[0]?.id) { if (!channel) throw new Error('You and Slopbot need access to a server text channel.'); const result = await request('/api/settings', { name, args, channel, server: state.server.id }); notice(result.text || 'Saved.'); }
function applySettings(result) {
  csrf = result.csrf; state = result.data;
  const list = state.servers || [], current = list.find(s => s.id === state.server?.id), icon = $('server-icon');
  if (state.server && !state.admin && tab === 'server') tab = 'profile';
  showScreen('console');
  document.querySelector('nav').hidden = !state.server && !admin;
  $('server-pick').hidden = !list.length;
  $('server').innerHTML = list.map(s => `<option value="${esc(s.id)}"${s.id === state.server?.id ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
  icon.hidden = !current?.icon; if (current?.icon) icon.src = current.icon;
  $('role').textContent = current ? (state.admin ? 'Admin' : 'Member') : '';
  if (!viewReady) chooseView();
  renderAccount();
  render();
}
function channelAction(button) {
  const { channel: id, action } = button.dataset;
  if (action === 'remove' && !confirm('Stop monitoring this channel? This purges searchable content and dependent task context. Operational logs remain.')) return;
  run(button, () => (action === 'add' || action === 'remove') ? save('channels', { action, channel: id }, id) : save('index', { action }, id));
}
// The import progress of a running job. A window job shows the share of its time window it has reached.
// The bar width is set after the rows are drawn, because the page allows no inline styles.
function historyProgress(h) {
  const job = h.job;
  if (!job) return '';
  const count = `${job.scanned.toLocaleString()} scanned · ${job.added.toLocaleString()} added`;
  if (job.kind !== 'window') return `<p class="small chan-progress">Importing older messages… ${count}</p>`;
  const span = job.started - job.cutoff, pct = job.reachedAt == null || span <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((job.started - job.reachedAt) * 100 / span)));
  return `<div class="chan-progress"><div class="progress" role="progressbar" aria-label="Import progress" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span data-pct="${pct}"></span></div><p class="small">Importing… ${pct}% · ${count}</p></div>`;
}
function channelRow(c) {
  const h = c.history || {}, id = esc(c.id);
  const status = h.error ? `Error: ${esc(h.errorReason || 'import failed')}` : h.paused ? 'Paused' : h.job ? 'Importing' : 'Idle';
  const actions = c.monitored
    ? `<button type="button" data-channel="${id}" data-action="${h.paused ? 'resume' : 'pause'}">${h.paused ? 'Resume import' : 'Pause import'}</button><button type="button" data-channel="${id}" data-action="remove">Stop monitoring…</button>`
    : `<button type="button" data-channel="${id}" data-action="add">Start monitoring</button>`;
  const chips = `<span class="chip${c.monitored ? ' on' : ''}">${c.monitored ? 'Monitored' : 'Not monitored'}</span>` + (c.monitored ? `<span class="chip">${status}</span><span class="chip">${esc(h.days ?? '?')} days</span>` : '');
  const windowForm = c.monitored ? `<form class="chan-window" data-channel="${id}"><label>History window<input name="days" type="number" min="1" max="3650" value="${esc(h.days ?? '')}" required></label><span class="small">days</span><button>Set</button><p class="small chan-note">Lowering the window deletes saved messages older than the new window.</p></form>${historyProgress(h)}` : '';
  return `<li class="chan" title="${id}"><div class="chan-info"><strong>#${esc(c.name)}</strong><span class="chips">${chips}</span></div><div class="chan-actions">${actions}</div>${windowForm}</li>`;
}
// Draws the channel rows from state.channels, with the filter text kept between redraws.
let channelQuery = '', historyTimer = 0;
function drawChannels() {
  const list = $('channels');
  if (!list) return;
  const q = channelQuery.trim().toLowerCase();
  const rows = state.channels.filter(c => c.name.toLowerCase().includes(q)).sort((a, b) => Number(b.monitored) - Number(a.monitored) || a.name.localeCompare(b.name));
  list.innerHTML = !state.channels.length ? '<li class="small">No text channels are visible to both you and Slopbot.</li>' : (rows.map(channelRow).join('') || '<li class="small">No channels match this filter.</li>');
  for (const bar of list.querySelectorAll('[data-pct]')) bar.style.width = `${bar.dataset.pct}%`;
  scheduleHistoryPoll();
}
// While an import runs on the open Channels tab, the channel data is read again every 2 seconds.
// The poll stops when no import runs or the tab changes.
function scheduleHistoryPoll() {
  clearTimeout(historyTimer); historyTimer = 0;
  if (tab !== 'channels' || !state.channels.some(c => c.history?.job)) return;
  historyTimer = setTimeout(pollChannels, 2000);
}
async function pollChannels() {
  historyTimer = 0;
  if (tab !== 'channels' || !state.server) return;
  const id = state.server.id;
  try {
    const result = await settingsFor(id);
    if (tab !== 'channels' || state.server?.id !== id) return;
    csrf = result.csrf;
    state.channels = result.data.channels;
    drawChannels();
  } catch (error) {
    if (error.status === 401) fail(error); else scheduleHistoryPoll();
  }
}
function render() {
  document.querySelectorAll('[data-tab]').forEach(button => { button.classList.toggle('selected', button.dataset.tab === tab); button.setAttribute('aria-current', button.dataset.tab === tab ? 'page' : 'false'); button.onclick = () => { tab = button.dataset.tab; render(); }; });
  setChatMode(tab === 'conversations' && !!state.server);
  if (tab === 'admin' && admin) { renderAdmin(); return; }
  if (tab !== 'conversations') closeConversation();
  if (!state.server) { $('breadcrumb').textContent = 'Settings'; $('title').textContent = 'No servers yet.'; $('description').textContent = ''; $('content').innerHTML = '<section class="card"><h2>Slopbot is not in any of your servers yet.</h2><p class="small">A server admin must invite Slopbot to a server you are in.</p></section>'; return; }
  if (tab === 'conversations') return renderConversations();
  $('breadcrumb').textContent = `Settings / ${tab === 'profile' ? 'My profile' : tab === 'channels' ? 'Channels' : tab === 'mcp' ? 'MCP connections' : 'Server'}`;
  $('title').textContent = {server:'Make room for good ideas.',channels:'Choose where Slopbot listens.',mcp:'Connect more tools.',profile:'Introduce yourself.'}[tab];
  $('description').textContent = {server:'Set how Slopbot participates in your server.',channels:'Manage monitored channels and saved chat history. Only saved lessons and memories use embeddings.',mcp:'Add remote MCP servers and choose their tools. Changes apply without restarting or redeploying Slopbot.',profile:'Your profile is public to this Discord server. You control who can edit it.'}[tab];
  const s = state.settings;
  if (tab !== 'profile' && !state.admin) { $('content').innerHTML = '<p>Manage Server permission is required for these controls.</p>'; return; }
  if (tab === 'server') {
    $('content').innerHTML = card('monitoring','Join the conversation','Applies to this server',checkbox('Monitor unaddressed conversations','enabled',s.monitoring) + '<p class="small">Direct mentions and replies still work when monitoring is off.</p>' + (s.mock ? '<p>Mock mode disables automatic participation.</p>' : '')) + card('context','Conversation context','Applies to this server', '<div class="row">' + input('Participation context, messages','jev',s.classifier_context,100) + input('Reply context, messages','reply',s.reply_context,100) + '</div>') + card('cooldown','Automatic reply limits','Server policy, counted separately for each channel','<div class="row">' + input('Minimum interval, seconds','seconds',s.cooldown_seconds,3600) + input('Replies per hour','per_hour',s.max_unsolicited_per_hour,1000) + '</div><p class="small">Zero replies per hour disables unsolicited replies. Direct requests bypass these limits.</p>') + card('tool_display','Tool activity','Applies to completed replies in this server', '<label>Display<select name="mode">' + [['none','No tool calls'],['summary','Summary'],['full','Full expansion']].map(([value,label]) => `<option value="${value}" ${s.tool_display === value ? 'selected' : ''}>${label}</option>`).join('') + '</select></label><p class="small">Summary shows one grey line with counts. Full expansion adds failed calls and their reasons.</p>') + card('timing','Timing diagnostics','Applies to this server',checkbox('Show request timing in reply footers','enabled',s.timing_footer)) + '<section class="card"><h2>Web transcripts</h2><p class="scope">Per channel. Off by default. Turn a channel on to show its transcript in the web console. Discord permissions still decide who can see it.</p><ul id="transcripts" class="chan-list"><li class="small">Loading channels…</li></ul></section>' + `<div class="card"><h2>Reply model</h2><pre>${esc(s.model)}</pre><p class="small">Provider models, credentials, and token budgets are operator settings configured on the bot host.</p></div>`;
    bind('monitoring', f => save('monitoring',{enabled:f.has('enabled')}));
    bind('context', async f => { await save('context',{messages:Number(f.get('jev')),target:'jev'}); try { await save('context',{messages:Number(f.get('reply')),target:'reply'}); } catch (error) { throw new Error(`Participation context saved. Reply context failed: ${error.message}`); } });
    bind('cooldown', f => save('cooldown',{seconds:Number(f.get('seconds')),per_hour:Number(f.get('per_hour'))}));
    bind('tool_display', f => save('tool_display',{mode:f.get('mode')}));
    bind('timing', f => save('timing',{enabled:f.has('enabled')}));
    loadTranscripts();
  } else if (tab === 'channels') {
    $('content').innerHTML = '<input id="filter" class="filter" type="search" placeholder="Filter channels" aria-label="Filter channels" hidden><ul id="channels" class="chan-list"></ul>';
    const list = $('channels'), filter = $('filter');
    filter.value = channelQuery;
    filter.hidden = state.channels.length <= 8;
    filter.oninput = () => { channelQuery = filter.value; drawChannels(); };
    list.onclick = event => { const button = event.target.closest('button[data-channel]'); if (button) channelAction(button); };
    list.onsubmit = event => {
      event.preventDefault();
      const form = event.target, id = form.dataset.channel, days = Number(new FormData(form).get('days'));
      const channel = state.channels.find(c => c.id === id), current = channel?.history?.days;
      // A shorter window deletes saved messages. The user must confirm first; Cancel changes nothing.
      if (current !== undefined && days < current && !confirm(`Delete saved messages older than ${days} days in #${channel.name}? This cannot be undone.`)) return;
      run(form.querySelector('button'), () => save('index', { action: 'window', days }, id));
    };
    drawChannels();
    draw('');
  } else if (tab === 'mcp') {
    renderMcp();
  } else {
    $('content').innerHTML = card('lock','Profile ownership','Your profile in this server',checkbox('Allow other members to edit my profile','allow_edits',state.profile.allowEdits)) + '<section class="card"><h2>Saved profile fields</h2>' + (state.profile.fields.map(f=>`<div class="field"><strong>${esc(f.field)}</strong><pre>${esc(JSON.stringify(f.value))}</pre><p class="small">${f.editor === state.user ? 'Self-reported' : 'Added by another member'}</p><button data-remove="${esc(f.field)}">Remove</button></div>`).join('') || '<p>No custom fields yet.</p>') + '</section>' + card('profile','Add or update a field','Your profile in this server','<label>Field name<input name="field" placeholder="interests" maxlength="100" required></label><label>Value<input name="value" placeholder="What would you like your team to know?" maxlength="2000" required></label>');
    bind('lock',f=>save('profile',{action:'lock',allow_edits:f.has('allow_edits')}));
    bind('profile',f=>save('profile',{action:'set',field:f.get('field'),value:f.get('value')}));
    document.querySelectorAll('[data-remove]').forEach(button=>{button.onclick=() => run(button, () => save('profile',{action:'remove',field:button.dataset.remove}));});
  }
}
async function loadTranscripts() {
  const id = state.server.id, list = $('transcripts');
  list.onchange = async event => {
    const box = event.target;
    box.disabled = true;
    try { const result = await request('/api/web-transcripts/channels', { server: id, channel: box.dataset.transcript, enabled: box.checked }); box.nextElementSibling.textContent = result.enabled ? 'On' : 'Off'; notice(`Web transcripts ${result.enabled ? 'on' : 'off'} for this channel.`); }
    catch (error) { box.checked = !box.checked; fail(error); }
    finally { box.disabled = false; }
  };
  try {
    const result = await request(`/api/web-transcripts/channels?server=${encodeURIComponent(id)}`);
    if (!$('transcripts') || state.server?.id !== id) return;
    $('transcripts').innerHTML = result.channels.map(c => `<li class="chan"><div class="chan-info"><strong>#${esc(c.name)}</strong></div><div class="chan-actions"><label class="switch"><input type="checkbox" data-transcript="${esc(c.id)}" ${c.enabled ? 'checked' : ''}><span>${c.enabled ? 'On' : 'Off'}</span></label></div></li>`).join('') || '<li class="small">Slopbot serves no channels in this server yet.</li>';
  } catch (error) { if ($('transcripts')) $('transcripts').innerHTML = `<li class="small">${esc(error.message)}</li>`; fail(error); }
}
function renderMcp() {
  const connections = state.mcp.connections;
  const endpointFields = connection => `<label>MCP endpoint<input name="url" type="url" maxlength="2048" value="${esc(connection?.url || '')}" placeholder="https://example.com/mcp" required></label><label>Transport<select name="transport"><option value="http">Streamable HTTP</option><option value="sse" ${connection?.transport === 'sse' ? 'selected' : ''}>Legacy SSE</option></select></label>`;
  const credentials = connection => `<label>Bearer token<input name="token" type="password" autocomplete="new-password" maxlength="8192" ${state.mcp.credentialsEnabled ? '' : 'disabled'} placeholder="${connection?.hasToken ? 'Saved securely. Leave blank to keep.' : 'Optional'}"></label>${connection?.hasToken ? checkbox('Remove saved token','remove_token',false) : ''}${state.mcp.credentialsEnabled ? '' : '<p class="small">The operator must configure MCP_SECRET_KEY once before tokens can be saved. Public servers can be connected without a token.</p>'}`;
  const policyFields = connection => connection.tools.map((tool, index) => `<section class="field">${checkbox(esc(tool.name),`tool-${index}`,tool.enabled)}<p class="small"><code>${esc(tool.registeredName)}</code></p><p>${esc(tool.description || '')}</p>${tool.needsReview ? '<p>Definition changed. Review and select this tool again to enable it.</p>' : ''}<div class="row"><label>Access<select name="access-${index}"><option value="admin">Server admins</option><option value="member" ${tool.access === 'member' ? 'selected' : ''}>Server members</option></select></label><label>Operation<select name="effect-${index}"><option value="write">Write, requires a task thread</option><option value="read" ${tool.effect === 'read' ? 'selected' : ''}>Read only, safe to retry</option></select></label></div><details><summary>Tool schemas</summary><pre>${esc(JSON.stringify({input:tool.inputSchema,output:tool.outputSchema || null},null,2))}</pre></details></section>`).join('') || '<p>No tools discovered yet. Refresh this connection to discover tools. Newly discovered tools are disabled until selected.</p>';
  $('content').innerHTML = card('mcp-add','Add a connection','Applies to this server','<label>Connection ID<input name="id" pattern="[a-z][a-z0-9_]{0,11}" maxlength="12" placeholder="github" required></label>' + endpointFields() + credentials(), 'Connect and discover')
    + '<p class="small">Enabled tools use the connection account. Member access allows server members to use that account through Slopbot. Mark an operation read-only only when it cannot change remote state.</p>'
    + connections.map(connection => `<section class="card"><h2>${esc(connection.id)}</h2><p class="scope">${esc(connection.status)}${connection.error ? ` · ${esc(connection.error)}` : ''}</p><form id="mcp-${connection.id}">${endpointFields(connection)}${credentials(connection)}${checkbox('Enable connection','enabled',connection.enabled)}<div class="row">${input('Call timeout, milliseconds','timeoutMs',connection.timeoutMs,60000,1000)}${input('Concurrent calls','concurrency',connection.concurrency,16,1)}</div>${policyFields(connection)}<button class="primary">Apply connection and tools</button></form><div class="row"><button type="button" data-mcp-action="refresh" data-mcp-id="${esc(connection.id)}">Refresh tools / reconnect</button><button type="button" data-mcp-action="disable" data-mcp-id="${esc(connection.id)}">Disable connection</button><button type="button" data-mcp-action="remove" data-mcp-id="${esc(connection.id)}">Remove connection</button></div></section>`).join('');
  const configure = async body => { const result = await request('/api/mcp', { ...body, server: state.server.id }); notice(result.text); };
  bind('mcp-add', f => configure({action:'save',id:f.get('id'),url:f.get('url'),transport:f.get('transport'),enabled:true,tools:[],...(f.get('token') ? {token:f.get('token')} : {})}));
  for (const connection of connections) bind(`mcp-${connection.id}`, f => configure({action:'save',id:connection.id,url:f.get('url'),transport:f.get('transport'),enabled:f.has('enabled'),timeoutMs:Number(f.get('timeoutMs')),concurrency:Number(f.get('concurrency')),
    ...(f.has('remove_token') ? {token:''} : f.get('token') ? {token:f.get('token')} : {}),
    tools:connection.tools.flatMap((tool,index) => f.has(`tool-${index}`) ? [{name:tool.name,schemaHash:tool.schemaHash,access:f.get(`access-${index}`),effect:f.get(`effect-${index}`)}] : [])}));
  document.querySelectorAll('[data-mcp-action]').forEach(button => { button.onclick = () => {
    if (button.dataset.mcpAction === 'remove' && !confirm('Remove this connection and its saved credential?')) return;
    run(button, () => configure({action:button.dataset.mcpAction,id:button.dataset.mcpId}));
  }; });
}
let admin = null, adminServer = '', adminUser = '';
const dollars = micros => (micros / 1000000).toFixed(2);
const money = micros => `$${dollars(micros)}`;
const priceText = micros => String(Number((micros / 1000000).toFixed(6)));
const toMicros = amount => Math.round(Number(amount) * 1000000);
const when = ms => new Date(ms).toLocaleString();
async function loadAdmin() {
  try { admin = await request('/api/admin/me'); } catch { admin = null; }
  $('admin-tab').hidden = !admin;
  if (admin) document.querySelector('nav').hidden = false;
}
async function adminRun(button, task) {
  const label = button.textContent;
  button.disabled = true; button.setAttribute('aria-busy', 'true'); button.replaceChildren(loader('sm'));
  try { await task(); await renderAdmin(); } catch (error) { fail(error); }
  finally { button.disabled = false; button.removeAttribute('aria-busy'); button.textContent = label; }
}
function adminLimits(limits, name, edit, off) {
  return `<form class="card" id="admin-limits"><h2>Limits</h2><p class="scope">Per user, in ${esc(name)}. Zero means no limit.</p><div class="row"><label>5-hour limit ($)<input name="five" type="number" min="0" max="1000000" step="0.01" value="${dollars(limits.five_hour_cost_micros)}" required${off}></label><label>Weekly limit ($)<input name="week" type="number" min="0" max="1000000" step="0.01" value="${dollars(limits.week_cost_micros)}" required${off}></label></div><label>Grace percent<input name="grace" type="number" min="0" max="1000" step="1" value="${limits.grace_percent}" required${off}></label><p class="small">Defaults: ${money(limits.defaults.five_hour_cost_micros)} for 5 hours, ${money(limits.defaults.week_cost_micros)} for a week, ${limits.defaults.grace_percent}% grace.</p>${edit ? '<button class="primary">Save limits</button>' : ''}</form>`;
}
function adminPrices(prices, names, edit) {
  const row = model => { const price = prices.prices[model], saved = prices.saved_models.includes(model); return `<tr><td><code>${esc(model)}</code></td>${price ? `<td>$${priceText(price.input)}</td><td>$${priceText(price.cached_input)}</td><td>$${priceText(price.output)}</td>` : '<td colspan="3" class="small">Fallback price</td>'}<td>${edit ? `<div class="chan-actions"><button type="button" data-price="edit" data-model="${esc(model)}">Edit</button>${saved ? `<button type="button" data-price="remove" data-model="${esc(model)}">Remove</button>` : ''}</div>` : ''}</td></tr>`; };
  return `<section class="card"><h2>Model prices</h2><p class="scope">Dollars per 1 million tokens, for all servers. A model without a price uses the fallback: $${priceText(prices.fallback.input)} input, $${priceText(prices.fallback.cached_input)} cached input, $${priceText(prices.fallback.output)} output.</p><div class="table-wrap"><table><thead><tr><th>Model</th><th>Input</th><th>Cached input</th><th>Output</th><th></th></tr></thead><tbody>${names.map(row).join('')}</tbody></table></div>${edit ? '<form id="admin-price" class="price-form"><label>Model<input name="model" maxlength="200" required></label><div class="row"><label>Input ($ per 1M)<input name="input" type="number" min="0" max="1000" step="0.000001" required></label><label>Cached input ($ per 1M)<input name="cached" type="number" min="0" max="1000" step="0.000001" required></label></div><label>Output ($ per 1M)<input name="output" type="number" min="0" max="1000" step="0.000001" required></label><button class="primary">Save price</button></form>' : ''}</section>`;
}
function adminPerson(profile) {
  const src = typeof profile.avatarUrl === 'string' && profile.avatarUrl.startsWith(AVATAR_HOST) ? esc(profile.avatarUrl) : '';
  const letter = esc(String(profile.displayName || '?').trim().charAt(0).toUpperCase() || '?');
  const avatar = src ? `<img class="admin-avatar" src="${src}" alt="" width="24" height="24" loading="lazy">` : `<span class="admin-avatar admin-avatar-blank" aria-hidden="true">${letter}</span>`;
  return `<span class="admin-person" title="ID ${esc(profile.id)}">${avatar}<span class="admin-name">${esc(profile.displayName)}</span>${profile.username ? `<span class="admin-handle">@${esc(profile.username)}</span>` : ''}</span>`;
}
function adminUsage(users, name, off) {
  const row = item => {
    const pick = kind => item.windows.find(window => window.kind === kind) ?? { spent: 0, limit: 0, resetAt: null, banked: 0 };
    const line = (label, stat) => `<p class="small">${label}: ${money(stat.spent)} of ${stat.limit ? money(stat.limit) : 'no limit'}. ${stat.resetAt ? `Resets ${esc(when(stat.resetAt))}` : 'No window running'}. Banked resets: ${stat.banked}.</p>`;
    const button = (action, kind, text) => `<button type="button" data-action="${action}" data-user="${esc(item.user.id)}" data-kind="${kind}"${off}>${text}</button>`;
    return `<div class="admin-user"><div class="admin-head">${adminPerson(item.user)}</div>${line('5 hours', pick('5h'))}${line('Week', pick('week'))}<div class="chan-actions">${button('reset', '5h', 'Reset 5h')}${button('reset', 'week', 'Reset week')}${button('grant', '5h', 'Grant 5h reset')}${button('grant', 'week', 'Grant week reset')}</div></div>`;
  };
  return `<section class="card"><h2>Usage</h2><p class="scope">${adminUser ? 'One user.' : `The ${users.length} users with the highest 5-hour spend in ${esc(name)}.`}</p><div class="admin-search"><label>Find a member<input id="admin-search-input" type="search" maxlength="100" autocomplete="off" placeholder="Name or @username"></label>${adminUser ? '<button type="button" id="admin-all">Show all users</button>' : ''}<div id="admin-matches" class="admin-matches" hidden></div></div><div id="admin-users">${users.map(row).join('') || '<p class="small">No users have spend or banked resets in this server yet.</p>'}</div></section>`;
}
// Member picker: typing (250 ms pause) lists matching members. Choosing one loads that user's usage by ID.
function wireAdminSearch(server) {
  const input = $('admin-search-input'), list = $('admin-matches');
  let timer = 0, latest = 0;
  const hide = () => { latest++; list.hidden = true; list.replaceChildren(); };
  const search = async query => {
    const mine = ++latest;
    try {
      const result = await request(`/api/admin/members?server=${encodeURIComponent(server)}&q=${encodeURIComponent(query)}`);
      if (mine !== latest || server !== adminServer) return;
      list.innerHTML = result.members.map(item => `<button type="button" class="admin-match" data-user="${esc(item.id)}">${adminPerson(item)}</button>`).join('') || '<p class="small admin-none">No member matches.</p>';
      list.hidden = false;
    } catch (error) {
      if (mine !== latest) return;
      list.innerHTML = `<p class="small admin-none">${esc(error.message)}</p>`;
      list.hidden = false;
    }
  };
  input.oninput = () => {
    clearTimeout(timer);
    const query = input.value.trim();
    if (!query) return hide();
    timer = setTimeout(() => search(query), 250);
  };
  input.onkeydown = event => { if (event.key === 'Escape') { clearTimeout(timer); input.value = ''; hide(); } };
  list.onclick = event => {
    const button = event.target.closest('button[data-user]');
    if (!button) return;
    adminUser = button.dataset.user;
    renderAdmin();
  };
}
function adminTranscripts(servers, off) {
  return `<section class="card"><h2>Web transcripts</h2><p class="scope">Per channel, for every server. Off by default. Discord permissions still decide who can see a transcript.</p><div id="admin-transcripts">${servers.map(server => `<p class="eyebrow">${esc(server.name)}</p><ul class="chan-list">${server.channels.map(channel => `<li class="chan"><div class="chan-info"><strong>#${esc(channel.name)}</strong></div><div class="chan-actions"><label class="switch"><input type="checkbox" data-server="${esc(server.id)}" data-channel="${esc(channel.id)}"${channel.enabled ? ' checked' : ''}${off}><span>${channel.enabled ? 'On' : 'Off'}</span></label><button type="button" data-action="rotate" data-server="${esc(server.id)}" data-channel="${esc(channel.id)}" data-name="${esc(channel.name)}"${off}>Rotate webhook</button></div></li>`).join('') || '<li class="small">Slopbot serves no channels in this server yet.</li>'}</ul>`).join('') || '<p class="small">Slopbot is not running in any server yet.</p>'}</div></section>`;
}
async function renderAdmin() {
  const edit = admin.canEdit, off = edit ? '' : ' disabled';
  $('breadcrumb').textContent = 'Settings / Team admin';
  $('title').textContent = 'Run Slopbot for your team.';
  $('description').textContent = 'Limits, model prices, usage and web transcripts. Read-only members can view everything.';
  $('content').replaceChildren(busy('md', 'Loading…'));
  try {
    const servers = (await request('/api/admin/servers')).servers;
    if (!servers.some(item => item.id === adminServer)) adminServer = servers.find(item => item.id === state.server?.id)?.id ?? servers[0]?.id ?? '';
    const current = servers.find(item => item.id === adminServer), id = encodeURIComponent(adminServer);
    const [limits, usage, prices] = await Promise.all([
      adminServer ? request(`/api/admin/limits?server=${id}`) : null,
      adminServer ? request(`/api/admin/usage?server=${id}${adminUser ? `&user=${encodeURIComponent(adminUser)}` : ''}`) : null,
      request('/api/admin/prices'),
    ]);
    if (tab !== 'admin') return;
    const users = !adminServer ? [] : adminUser ? [{ user: usage.user, windows: usage.windows }] : usage.users;
    const names = [...new Set([...prices.models, ...Object.keys(prices.prices)])].sort();
    $('content').innerHTML = [
      `<section class="card"><label for="admin-pick">Server</label><select id="admin-pick"${servers.length ? '' : ' disabled'}>${servers.map(item => `<option value="${esc(item.id)}"${item.id === adminServer ? ' selected' : ''}>${esc(item.name)}</option>`).join('') || '<option value="">No servers yet</option>'}</select><p class="small">Limits and usage apply to the selected server. Model prices and web transcripts apply to all servers.</p></section>`,
      limits ? adminLimits(limits, current.name, edit, off) : '<p class="small">Slopbot is not running in any server yet.</p>',
      adminPrices(prices, names, edit),
      adminServer ? adminUsage(users, current.name, off) : '',
      adminTranscripts(servers, off),
      adminServer ? '<section class="card" id="admin-shares"></section>' : '',
    ].join('');
    $('admin-pick').onchange = () => { adminServer = $('admin-pick').value; adminUser = ''; renderAdmin(); };
    if (adminServer && window.SlopbotShares) window.SlopbotShares.renderShareList($('admin-shares'), adminServer);
    if (limits && edit) $('admin-limits').onsubmit = event => {
      event.preventDefault();
      const form = event.target, data = new FormData(form);
      adminRun(form.querySelector('button'), async () => { await request('/api/admin/limits', { server: adminServer, five_hour_cost_micros: toMicros(data.get('five')), week_cost_micros: toMicros(data.get('week')), grace_percent: Number(data.get('grace')) }); notice('Limits saved.'); });
    };
    if (edit) {
      $('admin-price').onsubmit = event => {
        event.preventDefault();
        const form = event.target, data = new FormData(form);
        adminRun(form.querySelector('button'), async () => { await request('/api/admin/prices', { model: data.get('model').trim(), input: toMicros(data.get('input')), cached_input: toMicros(data.get('cached')), output: toMicros(data.get('output')) }); notice('Price saved.'); });
      };
      document.querySelectorAll('[data-price="edit"]').forEach(button => { button.onclick = () => {
        const form = $('admin-price'), price = prices.prices[button.dataset.model] ?? prices.fallback;
        form.elements.model.value = button.dataset.model; form.elements.input.value = priceText(price.input); form.elements.cached.value = priceText(price.cached_input); form.elements.output.value = priceText(price.output);
        form.scrollIntoView({ block: 'center' });
      }; });
      document.querySelectorAll('[data-price="remove"]').forEach(button => { button.onclick = () => {
        const model = button.dataset.model;
        if (confirm(`Remove the saved price for ${model}? The configured price applies again.`)) adminRun(button, async () => { await request('/api/admin/prices', { model, remove: true }); notice('Saved price removed.'); });
      }; });
    }
    if (adminServer) {
      wireAdminSearch(adminServer);
      if ($('admin-all')) $('admin-all').onclick = () => { adminUser = ''; renderAdmin(); };
      $('admin-users').onclick = event => {
        const button = event.target.closest('button[data-action]');
        if (!button) return;
        const { action, user, kind } = button.dataset, label = kind === '5h' ? '5-hour' : 'weekly';
        adminRun(button, async () => {
          if (action === 'reset') { await request('/api/admin/usage/reset', { server: adminServer, user, kind }); notice(`The ${label} window is cleared for ${user}.`); }
          else { await request('/api/admin/usage/grant', { server: adminServer, user, kind, count: 1 }); notice(`Granted one ${label} reset to ${user}.`); }
        });
      };
    }
    $('admin-transcripts').onclick = event => {
      const button = event.target.closest('button[data-action="rotate"]');
      if (!button || !edit) return;
      const { server, channel, name } = button.dataset;
      if (!confirm(`Make a new web webhook for #${name}? The old webhook stops working at once.`)) return;
      adminRun(button, async () => { await request('/api/admin/web-webhooks/rotate', { server, channel }); notice(`Web webhook rotated for #${name}.`); });
    };
    $('admin-transcripts').onchange = async event => {
      const box = event.target;
      if (!box.dataset.channel) return;
      box.disabled = true;
      try { const result = await request('/api/admin/transcripts', { server: box.dataset.server, channel: box.dataset.channel, enabled: box.checked }); box.nextElementSibling.textContent = result.enabled ? 'On' : 'Off'; notice(`Web transcripts ${result.enabled ? 'on' : 'off'} for this channel.`); }
      catch (error) { box.checked = !box.checked; fail(error); }
      finally { box.disabled = false; }
    };
  } catch (error) { fail(error); }
}
$('server').onchange = async () => {
  const select = $('server'), id = select.value;
  select.disabled = true; $('content').replaceChildren(busy('md', 'Loading…'));
  try { applySettings(await settingsFor(id)); remember('slopbot-server', id); }
  catch (error) { fail(error); select.value = state.server?.id ?? ''; render(); }
  finally { select.disabled = false; }
};
$('server-icon').onerror = () => { $('server-icon').hidden = true; };
$('brand').onclick = event => { if ($('console').hidden) return; event.preventDefault(); tab = state.admin ? 'server' : 'profile'; render(); window.scrollTo(0, 0); };
$('logout').onclick = async () => { try { await request('/api/logout',{}); location.reload(); } catch (error) { notice(error.message); } };
async function boot() {
  const remembered = recall('slopbot-server');
  let result;
  try { result = await settingsFor(remembered); }
  catch (error) { if (!remembered || error.status === 401) throw error; result = await settingsFor(); }
  applySettings(result);
  await loadAdmin();
}
boot().catch(error => { if (error.status === 401) showScreen('login'); else { showScreen('none'); notice(error.message); } });

// Reply box for one conversation. A transcript view calls renderReplyBox(container, server, channel).
// The server sends the reply as the signed-in user through a channel webhook, or as Slopbot when the bot lacks Manage Webhooks.
function renderReplyBox(container, server, channel) {
  const box = document.createElement('form');
  box.className = 'card reply-box';
  box.innerHTML = '<label>Reply<textarea name="text" rows="3" maxlength="2000" required></textarea></label><p class="small reply-status" aria-live="polite"></p><p class="small reply-note" hidden>Posted by Slopbot for you (it lacks Manage Webhooks)</p><button class="primary" type="submit">Send reply</button>';
  const field = box.elements.text, status = box.querySelector('.reply-status'), note = box.querySelector('.reply-note'), button = box.querySelector('button');
  box.onsubmit = async event => {
    event.preventDefault();
    const text = field.value.trim();
    if (!text) return;
    button.disabled = true; status.textContent = 'Sending…'; note.hidden = true;
    try {
      const response = await fetch(`/api/conversations/${encodeURIComponent(channel)}/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ server, text }) });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) { showScreen('login'); return; }
      if (response.status === 429) { status.textContent = `Limit reached, resets ${new Date(data.resetAt).toLocaleString()}.`; return; }
      if (!response.ok) throw new Error(data.error || 'Reply failed.');
      field.value = '';
      status.textContent = data.status === 'posted' ? 'Sent. Slopbot will answer in the channel.' : 'Sent to Discord, but Slopbot did not pick it up in time, so it will not answer.';
      note.hidden = data.via !== 'bot';
    } catch (error) { status.textContent = error.message; }
    finally { button.disabled = false; }
  };
  container.replaceChildren(box);
  return box;
}
