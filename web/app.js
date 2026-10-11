let state, csrf, tab = 'server';
const $ = id => document.getElementById(id);
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
function theme(light) { document.documentElement.classList.toggle('light', light); document.querySelectorAll('img[src*="logo-"]').forEach(img => img.src = `/assets/logo-${light ? 'dark' : 'light'}.svg`); $('theme').textContent = light ? 'Dark theme' : 'Light theme'; localStorage.setItem('slopbot-theme', light ? 'light' : 'dark'); }
theme(localStorage.getItem('slopbot-theme') === 'light');
$('theme').onclick = () => theme(!document.documentElement.classList.contains('light'));
function notice(text) { $('notice').textContent = text; }
async function request(path, body) {
  const response = await fetch(path, body ? { method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':csrf}, body:JSON.stringify(body) } : {});
  const data = await response.json();
  if (!response.ok) { if (response.status === 401) { $('login').hidden = false; $('console').hidden = true; } throw new Error(data.error || 'Request failed.'); }
  return data;
}
async function load() { const result = await request('/api/settings'); state = result.data; csrf = result.csrf; $('login').hidden = true; $('console').hidden = false; $('logout').hidden = false; $('server-name').textContent = state.server.name; if (!state.admin && tab === 'server') tab = 'profile'; render(); }
const input = (label, name, value, max, min = 0) => `<label>${label}<input name="${name}" type="number" min="${min}" max="${max}" value="${esc(value)}" required></label>`;
const checkbox = (label, name, value) => `<label><input name="${name}" type="checkbox" ${value ? 'checked' : ''}>${label}</label>`;
const card = (id, title, scope, body, button = 'Save changes') => `<form class="card" id="${id}"><h2>${title}</h2><p class="scope">${scope}</p>${body}<button class="primary">${button}</button></form>`;
function bind(id, handler) { const form = $(id); if (!form) return; form.onsubmit = async event => { event.preventDefault(); const button = form.querySelector('button'); button.disabled = true; try { await handler(new FormData(form)); await load(); } catch (error) { notice(error.message); } finally { button.disabled = false; } }; }
async function save(name, args, channel = state.channels[0]?.id) { if (!channel) throw new Error('You and Slopbot need access to a server text channel.'); const result = await request('/api/settings', { name, args, channel }); notice(result.text || 'Saved.'); }
function render() {
  document.querySelectorAll('[data-tab]').forEach(button => { button.classList.toggle('selected', button.dataset.tab === tab); button.setAttribute('aria-current', button.dataset.tab === tab ? 'page' : 'false'); button.onclick = () => { tab = button.dataset.tab; render(); }; });
  $('breadcrumb').textContent = `Settings / ${tab === 'profile' ? 'My profile' : tab === 'channels' ? 'Channels' : 'Server'}`;
  $('title').textContent = {server:'Make room for good ideas.',channels:'Choose where Slopbot listens.',profile:'Introduce yourself.'}[tab];
  $('description').textContent = {server:'Set how Slopbot participates in your server.',channels:'Manage monitored channels and their history imports.',profile:'Your profile is public to this Discord server. You control who can edit it.'}[tab];
  const s = state.settings;
  if (tab !== 'profile' && !state.admin) { $('content').innerHTML = '<p>Manage Server permission is required for these controls.</p>'; return; }
  if (tab === 'server') {
    $('content').innerHTML = card('monitoring','Join the conversation','Applies to this server',checkbox('Monitor unaddressed conversations','enabled',s.monitoring) + '<p class="small">Direct mentions and replies still work when monitoring is off.</p>' + (s.mock ? '<p>Mock mode disables automatic participation.</p>' : '')) + card('context','Conversation context','Applies to this server', '<div class="row">' + input('Participation context, messages','jev',s.classifier_context,100) + input('Reply context, messages','reply',s.reply_context,100) + '</div>') + card('cooldown','Automatic reply limits','Server policy, counted separately for each channel','<div class="row">' + input('Minimum interval, seconds','seconds',s.cooldown_seconds,3600) + input('Replies per hour','per_hour',s.max_unsolicited_per_hour,1000) + '</div><p class="small">Zero replies per hour disables unsolicited replies. Direct requests bypass these limits.</p>') + card('timing','Timing diagnostics','Applies to this server',checkbox('Show request timing in reply footers','enabled',s.timing_footer)) + `<div class="card"><h2>Reply model</h2><pre>${esc(s.model)}</pre><p class="small">Provider models, credentials, and token budgets are operator settings configured on the bot host.</p></div>`;
    bind('monitoring', f => save('monitoring',{enabled:f.has('enabled')}));
    bind('context', async f => { await save('context',{messages:Number(f.get('jev')),target:'jev'}); try { await save('context',{messages:Number(f.get('reply')),target:'reply'}); } catch (error) { throw new Error(`Participation context saved. Reply context failed: ${error.message}`); } });
    bind('cooldown', f => save('cooldown',{seconds:Number(f.get('seconds')),per_hour:Number(f.get('per_hour'))}));
    bind('timing', f => save('timing',{enabled:f.has('enabled')}));
  } else if (tab === 'channels') {
    $('content').innerHTML = state.channels.map(c => `<section class="card"><h2>#${esc(c.name)}</h2><p class="scope">Channel · <code>${esc(c.id)}</code></p><p>${c.monitored ? 'Monitored. Live messages are indexed.' : 'Not monitored.'}</p><button data-channel="${esc(c.id)}" data-action="${c.monitored ? 'remove' : 'add'}">${c.monitored ? 'Stop monitoring…' : 'Start monitoring'}</button>${c.monitored ? `<form id="history-${c.id}"><label>History action<select name="action"><option value="status">View status</option><option value="window">Set initial history window</option><option value="more">Import older messages</option><option value="pause">Pause import</option><option value="resume">Resume import</option></select></label>${input('History window, days','days',c.history.days,3650,1)}<p class="small">Imports ${c.history.paused ? 'paused' : c.history.job ? 'running' : 'idle'}. Pausing imports keeps live ingestion on.</p><button class="primary">Apply to this channel</button></form>` : ''}</section>`).join('') || '<p>No text channels are visible to both you and Slopbot.</p>';
    document.querySelectorAll('[data-channel]').forEach(button => { button.onclick = async () => { if (button.dataset.action === 'remove' && !confirm('Stop monitoring this channel? This purges searchable content and dependent task context. Operational logs remain.')) return; button.disabled = true; try { await save('channels',{action:button.dataset.action,channel:button.dataset.channel},button.dataset.channel); await load(); } catch (error) { notice(error.message); button.disabled = false; } }; });
    state.channels.filter(c=>c.monitored).forEach(c => bind(`history-${c.id}`, f => { const action = f.get('action'); return save('index',{action,...(action === 'window' ? {days:Number(f.get('days'))} : {})},c.id); }));
  } else {
    $('content').innerHTML = card('lock','Profile ownership','Your profile in this server',checkbox('Allow other members to edit my profile','allow_edits',state.profile.allowEdits)) + '<section class="card"><h2>Saved profile fields</h2>' + (state.profile.fields.map(f=>`<div class="field"><strong>${esc(f.field)}</strong><pre>${esc(JSON.stringify(f.value))}</pre><p class="small">${f.editor === state.user ? 'Self-reported' : 'Added by another member'}</p><button data-remove="${esc(f.field)}">Remove</button></div>`).join('') || '<p>No custom fields yet.</p>') + '</section>' + card('profile','Add or update a field','Your profile in this server','<label>Field name<input name="field" placeholder="interests" maxlength="100" required></label><label>Value<input name="value" placeholder="What would you like your team to know?" maxlength="2000" required></label>');
    bind('lock',f=>save('profile',{action:'lock',allow_edits:f.has('allow_edits')}));
    bind('profile',f=>save('profile',{action:'set',field:f.get('field'),value:f.get('value')}));
    document.querySelectorAll('[data-remove]').forEach(button=>{button.onclick=async()=>{button.disabled=true;try{await save('profile',{action:'remove',field:button.dataset.remove});await load();}catch(error){notice(error.message);button.disabled=false;}};});
  }
}
$('logout').onclick = async () => { try { await request('/api/logout',{}); location.reload(); } catch (error) { notice(error.message); } };
load().catch(error => { if (!error.message.startsWith('Sign in')) notice(error.message); });
