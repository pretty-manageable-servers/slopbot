let state, csrf, tab = 'server';
const $ = id => document.getElementById(id);
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const recall = key => { try { return localStorage.getItem(key); } catch { return null; } };
const remember = (key, value) => { try { localStorage.setItem(key, value); } catch { } };
function theme(light) { document.documentElement.classList.toggle('light', light); document.querySelectorAll('img[src*="logo-"]').forEach(img => img.src = `/assets/logo-${light ? 'dark' : 'light'}.svg`); $('theme').textContent = light ? 'Dark theme' : 'Light theme'; remember('slopbot-theme', light ? 'light' : 'dark'); }
theme(recall('slopbot-theme') === 'light');
$('theme').onclick = () => theme(!document.documentElement.classList.contains('light'));
function notice(text) { $('notice').textContent = text; }
function showScreen(name) { $('boot').hidden = name !== 'boot'; $('login').hidden = name !== 'login'; $('console').hidden = name !== 'console'; $('logout').hidden = name !== 'console'; }
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
  try { await task(); await refresh(); } catch (error) { fail(error); }
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
  document.querySelector('nav').hidden = !state.server;
  $('server-pick').hidden = !list.length;
  $('server').innerHTML = list.map(s => `<option value="${esc(s.id)}"${s.id === state.server?.id ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
  icon.hidden = !current?.icon; if (current?.icon) icon.src = current.icon;
  $('role').textContent = current ? (state.admin ? 'Admin' : 'Member') : '';
  render();
}
function channelAction(button) {
  const { channel: id, action } = button.dataset;
  if (action === 'remove' && !confirm('Stop monitoring this channel? This purges searchable content and dependent task context. Operational logs remain.')) return;
  run(button, () => (action === 'add' || action === 'remove') ? save('channels', { action, channel: id }, id) : save('index', { action }, id));
}
function channelRow(c) {
  const h = c.history || {}, id = esc(c.id), importing = h.paused ? 'Paused' : h.job ? 'Importing' : 'Idle';
  const actions = c.monitored
    ? `<button type="button" data-channel="${id}" data-action="more">Import older</button><button type="button" data-channel="${id}" data-action="${h.paused ? 'resume' : 'pause'}">${h.paused ? 'Resume import' : 'Pause import'}</button><button type="button" data-channel="${id}" data-action="remove">Stop monitoring…</button>`
    : `<button type="button" data-channel="${id}" data-action="add">Start monitoring</button>`;
  const chips = `<span class="chip${c.monitored ? ' on' : ''}">${c.monitored ? 'Monitored' : 'Not monitored'}</span>` + (c.monitored ? `<span class="chip">${importing}</span><span class="chip">${esc(h.days ?? '?')} days</span>` : '');
  const windowForm = c.monitored ? `<form class="chan-window" data-channel="${id}"><label>History window<input name="days" type="number" min="1" max="3650" value="${esc(h.days ?? '')}" required></label><span class="small">days</span><button>Set</button></form>` : '';
  return `<li class="chan" title="${id}"><div class="chan-info"><strong>#${esc(c.name)}</strong><span class="chips">${chips}</span></div><div class="chan-actions">${actions}</div>${windowForm}</li>`;
}
function render() {
  document.querySelectorAll('[data-tab]').forEach(button => { button.classList.toggle('selected', button.dataset.tab === tab); button.setAttribute('aria-current', button.dataset.tab === tab ? 'page' : 'false'); button.onclick = () => { tab = button.dataset.tab; render(); }; });
  if (tab !== 'conversations') closeConversation();
  if (!state.server) { $('breadcrumb').textContent = 'Settings'; $('title').textContent = 'No servers yet.'; $('description').textContent = ''; $('content').innerHTML = '<section class="card"><h2>Slopbot is not in any of your servers yet.</h2><p class="small">A server admin must invite Slopbot to a server you are in.</p></section>'; return; }
  if (tab === 'conversations') return renderConversations();
  $('breadcrumb').textContent = `Settings / ${tab === 'profile' ? 'My profile' : tab === 'channels' ? 'Channels' : tab === 'mcp' ? 'MCP connections' : 'Server'}`;
  $('title').textContent = {server:'Make room for good ideas.',channels:'Choose where Slopbot listens.',mcp:'Connect more tools.',profile:'Introduce yourself.'}[tab];
  $('description').textContent = {server:'Set how Slopbot participates in your server.',channels:'Manage monitored channels and their history imports.',mcp:'Add remote MCP servers and choose their tools. Changes apply without restarting or redeploying Slopbot.',profile:'Your profile is public to this Discord server. You control who can edit it.'}[tab];
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
    const draw = query => {
      const q = query.trim().toLowerCase();
      const rows = state.channels.filter(c => c.name.toLowerCase().includes(q)).sort((a, b) => Number(b.monitored) - Number(a.monitored) || a.name.localeCompare(b.name));
      list.innerHTML = !state.channels.length ? '<li class="small">No text channels are visible to both you and Slopbot.</li>' : (rows.map(channelRow).join('') || '<li class="small">No channels match this filter.</li>');
    };
    filter.hidden = state.channels.length <= 8;
    filter.oninput = () => draw(filter.value);
    list.onclick = event => { const button = event.target.closest('button[data-channel]'); if (button) channelAction(button); };
    list.onsubmit = event => { event.preventDefault(); const form = event.target; run(form.querySelector('button'), () => save('index',{action:'window',days:Number(new FormData(form).get('days'))},form.dataset.channel)); };
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
}
boot().catch(error => { if (error.status === 401) showScreen('login'); else { showScreen('none'); notice(error.message); } });
