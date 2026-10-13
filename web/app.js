let state, csrf, tab = 'server', settingsOpen = false, settingsReturn = null, viewReady = false;
const $ = id => document.getElementById(id);
// The browser tab title follows the view: "<name> · Slopbot".
function setPageTitle(name) { document.title = `${name} · Slopbot`; }
const esc = value => String(value).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const recall = key => { try { return localStorage.getItem(key); } catch { return null; } };
const remember = (key, value) => { try { localStorage.setItem(key, value); } catch { } };
function theme(light) { document.documentElement.classList.toggle('light', light); document.querySelectorAll('img[src*="logo-"]').forEach(img => img.src = `/console/assets/logo-${light ? 'dark' : 'light'}.svg`); const next = light ? 'Switch to dark theme' : 'Switch to light theme'; $('theme').setAttribute('aria-label', next); $('theme').title = next; $('theme-sun').hidden = light; $('theme-moon').hidden = !light; remember('slopbot-theme', light ? 'light' : 'dark'); }
theme(recall('slopbot-theme') === 'light');
// Follow the visible viewport when a mobile keyboard opens.
function sizeConsoleViewport() {
  document.documentElement.style.setProperty('--viewport-height', `${window.visualViewport?.height || window.innerHeight}px`);
}
sizeConsoleViewport();
window.visualViewport?.addEventListener('resize', sizeConsoleViewport);
window.addEventListener('resize', sizeConsoleViewport);
// The switch cross-fades when the browser has View Transitions and motion is allowed.
function switchTheme() {
  const next = !document.documentElement.classList.contains('light');
  if (!document.startViewTransition || matchMedia('(prefers-reduced-motion: reduce)').matches) { theme(next); return; }
  document.startViewTransition(() => theme(next));
}
$('theme').onclick = switchTheme;
// Settings is a modal over the chat. Its section comes from the caller, else from the URL (#settings/<section> or ?tab=<section>).
const SECTIONS = ['server', 'channels', 'mcp', 'profile', 'bot', 'servers-admin'];
// Team tabs. Only team members see them. The old #settings/admin section opens Bot admin.
const ADMIN_TABS = ['bot', 'servers-admin'];
function settingsFromUrl() {
  const params = new URLSearchParams(location.search), match = /^#settings(?:\/([a-z]+))?$/.exec(location.hash);
  if (params.has('tab')) return { section: params.get('tab') };
  return match ? { section: match[1] || null } : null;
}
// The chat or channel named in the URL path: /chat/<id> or /team/<id>. Any other path gives null.
// Old links (#chat/<id>, #channel/<id>) still open. The address changes to the path form.
function takeHashItem() {
  // /team/<id>/run/<runId> opens one conversation of the channel. The run part is optional.
  const path = /^\/(chat|team)\/([^/]+)(?:\/run\/([^/]+))?\/?$/.exec(location.pathname);
  const old = !path && /^#(chat|channel)\/(.+?)(?:\/run\/([^/]+))?$/.exec(location.hash);
  const match = path || old;
  if (!match) return null;
  try {
    const item = { kind: match[1] === 'chat' ? 'chat' : 'channel', id: decodeURIComponent(match[2]), run: match[3] ? decodeURIComponent(match[3]) : null };
    if (old) history.replaceState(null, '', itemPath(item.kind, item.id, item.run) + location.search);
    return item;
  } catch { return null; }
}
// The chat is always the base view. A settings link in the URL opens the modal on that section.
function chooseView() {
  viewReady = true;
  const want = settingsFromUrl();
  if (want) openSettings(want.section);
}
// Back and forward: a chat or channel in the URL shows that item. The settings link opens or closes the modal.
window.addEventListener('popstate', () => {
  if (!viewReady || !state) return;
  const item = takeHashItem(), want = settingsFromUrl();
  if (item || !want) { if (!item) { conv.channel = null; conv.run = null; } renderChat(true); }
  if (want) openSettings(want.section); else closeSettings();
});
// A server picker: a button and a menu. The hidden #server select keeps the value and the change handler.
function serverPicker(slot) {
  if (!slot) return;
  const servers = state.servers || [], current = servers.find(s => s.id === state.server?.id) || servers[0];
  const pick = document.createElement('button');
  pick.type = 'button';
  pick.className = 'pick';
  pick.setAttribute('aria-label', 'Discord server');
  pick.setAttribute('aria-haspopup', 'menu');
  pick.setAttribute('aria-expanded', 'false');
  const name = document.createElement('span');
  name.className = 'pick-name';
  name.textContent = current?.name || '';
  pick.append(name);
  pick.disabled = servers.length < 2;
  const menu = document.createElement('div');
  menu.className = 'pick-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  const close = refocus => { menu.hidden = true; pick.setAttribute('aria-expanded', 'false'); if (refocus) pick.focus(); };
  for (const s of servers) {
    const item = document.createElement('button');
    item.type = 'button';
    item.className = 'pick-item';
    item.textContent = s.name;
    item.setAttribute('role', 'menuitemradio');
    item.setAttribute('aria-checked', String(s.id === current?.id));
    item.onclick = () => {
      close(true);
      if (s.id === current?.id) return;
      $('server').value = s.id;
      $('server').dispatchEvent(new Event('change'));
    };
    menu.append(item);
  }
  pick.onclick = () => {
    if (!menu.hidden) return close(true);
    menu.hidden = false;
    pick.setAttribute('aria-expanded', 'true');
    menu.querySelector('[aria-checked=true]')?.focus();
  };
  slot.onkeydown = event => { if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); close(true); } };
  slot.onfocusout = event => { if (!slot.contains(event.relatedTarget)) close(false); };
  slot.replaceChildren(pick, menu);
}
// A click or tap outside an open server menu closes it.
document.addEventListener('pointerdown', event => {
  for (const menu of document.querySelectorAll('.pick-menu:not([hidden])')) {
    if (!menu.parentElement.contains(event.target)) { menu.hidden = true; menu.parentElement.querySelector('.pick').setAttribute('aria-expanded', 'false'); }
  }
});
// The settings modal is a native dialog: focus stays inside while it is open, and Escape closes it.
// The chat stays under it. A click on the backdrop closes it. Closing gives focus back to the control that opened it.
function openSettings(section, returnTo = document.activeElement) {
  if (!state) return;
  const dialog = $('settings');
  const wanted = section === 'admin' ? 'bot' : section;
  tab = SECTIONS.includes(wanted) && (!ADMIN_TABS.includes(wanted) || admin) ? wanted : (state.admin ? 'server' : 'profile');
  if (!dialog.open) { settingsReturn = returnTo; dialog.showModal(); }
  settingsOpen = true;
  render();
}
function closeSettings() { const dialog = $('settings'); if (dialog.open) dialog.close(); }
// Removes the settings part of the URL, so a reload does not reopen the modal. The chat hash stays.
function clearSettingsUrl() {
  const url = new URL(location.href);
  if (!url.searchParams.has('tab') && !/^#settings/.test(url.hash)) return;
  url.searchParams.delete('tab');
  if (/^#settings/.test(url.hash)) url.hash = '';
  history.replaceState(history.state, '', url);
}
$('settings').addEventListener('close', () => {
  settingsOpen = false;
  const back = settingsReturn;
  settingsReturn = null;
  clearSettingsUrl();
  setPageTitle($('chat-title')?.textContent || 'Chat');
  if (back?.isConnected) back.focus();
});
$('settings').addEventListener('click', event => { if (event.target === event.currentTarget) closeSettings(); });
$('settings-close').onclick = closeSettings;
const accountButton = $('account-button'), accountMenu = $('account-menu');
$('open-settings').onclick = () => { setAccountMenu(false); openSettings(null, accountButton); };
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
// The bottom toast. A normal notice hides itself after 5 seconds. A sticky notice (an error) stays until it is dismissed.
// A new notice replaces the text and restarts the timer. The toast never takes focus.
let noticeTimer = 0;
function dismissNotice() {
  clearTimeout(noticeTimer);
  noticeTimer = 0;
  $('notice').hidden = true;
  $('notice-text').textContent = '';
}
function notice(text, sticky = false) {
  clearTimeout(noticeTimer);
  $('notice-text').textContent = text;
  $('notice').hidden = !text;
  noticeTimer = sticky || !text ? 0 : setTimeout(dismissNotice, 5000);
}
$('notice-close').onclick = dismissNotice;
$('notice').addEventListener('keydown', event => { if (event.key === 'Escape') { event.stopPropagation(); dismissNotice(); } });
// Asks a yes or no question in a styled dialog. It resolves true only when the confirm button is used. Cancel, Escape and a click on the backdrop resolve false.
// Text is set with textContent only. Clicks and keys inside the dialog do not reach page listeners, so an open usage popover stays open.
function askConfirm({ title, body = '', confirmLabel = 'Confirm', danger = false }) {
  return new Promise(resolve => {
    const dialog = document.createElement('dialog');
    dialog.className = 'confirm-dialog';
    dialog.setAttribute('aria-labelledby', 'confirm-title');
    const heading = document.createElement('h2');
    heading.id = 'confirm-title';
    heading.textContent = title;
    dialog.append(heading);
    if (body) {
      const text = document.createElement('p');
      text.id = 'confirm-body';
      text.textContent = body;
      dialog.setAttribute('aria-describedby', 'confirm-body');
      dialog.append(text);
    }
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    const ok = document.createElement('button');
    ok.type = 'button';
    ok.className = danger ? 'confirm-ok danger' : 'confirm-ok';
    ok.textContent = confirmLabel;
    const actions = document.createElement('div');
    actions.className = 'actions';
    actions.append(cancel, ok);
    dialog.append(actions);
    cancel.onclick = () => dialog.close();
    ok.onclick = () => dialog.close('confirm');
    // Escape closes the dialog through the native cancel. It does not reach the page, so a usage popover is not closed too.
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') event.stopPropagation(); });
    dialog.addEventListener('click', event => {
      event.stopPropagation();
      const box = dialog.getBoundingClientRect();
      const outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
      if (event.target === dialog && outside) dialog.close();
    });
    dialog.addEventListener('close', () => { resolve(dialog.returnValue === 'confirm'); dialog.remove(); });
    document.body.append(dialog);
    dialog.showModal();
    (danger ? cancel : ok).focus();
  });
}
function showScreen(name) { if (name !== 'console') { setConversationDrawer(false); closeSettings(); } $('boot').hidden = name !== 'boot'; $('login').hidden = name !== 'login'; $('console').hidden = name !== 'console'; $('account').hidden = name !== 'console'; }
const loader = size => { const svg = $('loader').content.firstElementChild.cloneNode(true); if (size) svg.classList.add(size); return svg; };
function busy(size, text) { const box = document.createElement('div'), label = document.createElement('p'); box.className = 'busy'; label.textContent = text; box.append(loader(size), label); return box; }
async function request(path, body) {
  const response = await fetch(path, body ? { method:'POST', headers:{'Content-Type':'application/json','X-CSRF-Token':csrf}, body:JSON.stringify(body) } : {});
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || 'Request failed.'); error.status = response.status; throw error; }
  return data;
}
const settingsFor = id => request(id ? `/api/settings?server=${encodeURIComponent(id)}` : '/api/settings');
function fail(error) { if (error.status === 401) showScreen('login'); else notice(error.message, true); }
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
const checkbox = (label, name, value) => `<label class="checkbox-field"><input name="${name}" type="checkbox" ${value ? 'checked' : ''}>${label}</label>`;
const card = (id, title, scope, body, button = 'Save changes') => `<form class="card" id="${id}"><h2>${title}</h2><p class="scope">${scope}</p>${body}<button class="primary">${button}</button></form>`;
function bind(id, handler) { const form = $(id); if (!form) return; form.onsubmit = event => { event.preventDefault(); run(form.querySelector('button'), () => handler(new FormData(form))); }; }
async function save(name, args, channel = state.channels[0]?.id) { if (!channel) throw new Error('You and Slopbot need access to a server text channel.'); const result = await request('/api/settings', { name, args, channel, server: state.server.id }); notice(result.text || 'Saved.'); }
function applySettings(result) {
  csrf = result.csrf; state = result.data;
  const list = state.servers || [], current = list.find(s => s.id === state.server?.id), icon = $('server-icon');
  if (state.server && !state.admin && tab === 'server') tab = 'profile';
  showScreen('console');
  $('settings-nav').hidden = !state.server;
  $('server-pick').hidden = !list.length;
  $('server').innerHTML = list.map(s => `<option value="${esc(s.id)}"${s.id === state.server?.id ? ' selected' : ''}>${esc(s.name)}</option>`).join('');
  serverPicker($('server-menu'));
  icon.hidden = !current?.icon; if (current?.icon) icon.src = current.icon;
  $('role').textContent = current ? (state.admin ? 'Admin' : 'Member') : '';
  if (!viewReady) chooseView();
  renderAccount();
  render();
}
async function channelAction(button) {
  const { channel: id, action } = button.dataset;
  if (action === 'remove' && !(await askConfirm({ title: 'Stop monitoring this channel?', body: 'This purges searchable content and dependent task context. Operational logs remain.', confirmLabel: 'Stop monitoring', danger: true }))) return;
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
const NO_SERVER_CARD = '<section class="card"><h2>Slopbot is not in any of your servers yet.</h2><p class="small">A server admin must invite Slopbot to a server you are in.</p></section>';
// The chat is the base view. It is drawn again only when forced, or when the server changed. Settings redraws do not touch it.
function renderChat(force = false) {
  if (!state.server) { if (!$('chat-host').querySelector('.base-note')) $('chat-host').innerHTML = `<div class="base-note">${NO_SERVER_CARD}</div>`; return; }
  if (force || !$('chat-root') || conv.server !== state.server.id) renderConversations();
}
function render() {
  renderChat();
  if (settingsOpen) renderSettings();
}
function renderSettings() {
  document.querySelectorAll('[data-tab]').forEach(button => { button.classList.toggle('selected', button.dataset.tab === tab); button.setAttribute('aria-current', button.dataset.tab === tab ? 'page' : 'false'); button.onclick = () => { tab = button.dataset.tab; render(); }; });
  $('content').classList.toggle('settings-cards', ['server', 'profile'].includes(tab) && !!state.server);
  setPageTitle('Settings');
  if (ADMIN_TABS.includes(tab) && admin) { renderAdmin(); return; }
  if (!state.server) { $('breadcrumb').textContent = 'Settings'; $('title').textContent = 'No servers yet.'; $('description').textContent = ''; $('content').innerHTML = NO_SERVER_CARD; return; }
  if (state.partial) { $('breadcrumb').textContent = 'Settings'; $('content').replaceChildren(busy('md', 'Loading…')); return; }
  $('breadcrumb').textContent = `Settings / ${tab === 'profile' ? 'My profile' : tab === 'channels' ? 'Channels' : tab === 'mcp' ? 'MCP connections' : 'Server'}`;
  $('title').textContent = {server:'Server settings',channels:'Channels & history',mcp:'MCP connections',profile:'My profile'}[tab];
  $('description').textContent = {server:'Set how Slopbot participates in your server.',channels:'Manage monitored channels and saved chat history. Only saved lessons and memories use embeddings.',mcp:'Add remote MCP servers and choose their tools. Changes apply without restarting or redeploying Slopbot.',profile:'Your profile is public to this Discord server. You control who can edit it.'}[tab];
  const s = state.settings;
  if (tab !== 'profile' && !state.admin) { $('content').innerHTML = '<p>Manage Server permission is required for these controls.</p>'; return; }
  if (tab === 'server') {
    $('content').innerHTML = card('monitoring','Join the conversation','Applies to this server',checkbox('Monitor unaddressed conversations','enabled',s.monitoring) + '<p class="small">Direct mentions and replies still work when monitoring is off.</p>' + (s.mock ? '<p>Mock mode disables automatic participation.</p>' : '')) + card('context','Conversation context','Applies to this server', '<div class="row">' + input('Participation context, messages','jev',s.classifier_context,100) + input('Reply context, messages','reply',s.reply_context,100) + '</div>') + card('cooldown','Automatic reply limits','Server policy, counted separately for each channel','<div class="row">' + input('Minimum interval, seconds','seconds',s.cooldown_seconds,3600) + input('Replies per hour','per_hour',s.max_unsolicited_per_hour,1000) + '</div><p class="small">Zero replies per hour disables unsolicited replies. Direct requests bypass these limits.</p>') + card('tool_display','Tool activity','Applies to completed replies in this server', '<label>Display<select name="mode">' + [['none','No tool calls'],['summary','Summary'],['full','Full expansion']].map(([value,label]) => `<option value="${value}" ${s.tool_display === value ? 'selected' : ''}>${label}</option>`).join('') + '</select></label><p class="small">Summary shows one grey line with counts. Full expansion adds failed calls and their reasons.</p>') + card('default_effort','Reasoning effort','Default for this server. Web chats can pick their own.', '<fieldset class="radios"><legend class="small">Default effort</legend>' + [['default','Provider default'],['low','Low'],['medium','Medium'],['xhigh','Extra high']].map(([value,label]) => `<label><input type="radio" name="level" value="${value}" ${(s.default_effort || 'default') === value ? 'checked' : ''}> ${label}</label>`).join(' ') + '</fieldset><p class="small">Web chats use medium when nothing is set. Models without effort support ignore this.</p>') + card('timing','Timing diagnostics','Applies to this server',checkbox('Show request timing in reply footers','enabled',s.timing_footer)) + '<section class="card"><h2>Web transcripts</h2><p class="scope">Per channel. Off by default. Turn a channel on to show its transcript in the web console. Discord permissions still decide who can see it.</p><ul id="transcripts" class="chan-list"><li class="small">Loading channels…</li></ul></section>';
    bind('monitoring', f => save('monitoring',{enabled:f.has('enabled')}));
    bind('context', async f => { await save('context',{messages:Number(f.get('jev')),target:'jev'}); try { await save('context',{messages:Number(f.get('reply')),target:'reply'}); } catch (error) { throw new Error(`Participation context saved. Reply context failed: ${error.message}`); } });
    bind('cooldown', f => save('cooldown',{seconds:Number(f.get('seconds')),per_hour:Number(f.get('per_hour'))}));
    bind('tool_display', f => save('tool_display',{mode:f.get('mode')}));
    bind('default_effort', f => save('default_effort',{level:f.get('level')}));
    bind('timing', f => save('timing',{enabled:f.has('enabled')}));
    loadTranscripts();
  } else if (tab === 'channels') {
    $('content').innerHTML = '<input id="filter" class="filter" type="search" placeholder="Filter channels" aria-label="Filter channels" hidden><ul id="channels" class="chan-list"></ul>';
    const list = $('channels'), filter = $('filter');
    filter.value = channelQuery;
    filter.hidden = state.channels.length <= 8;
    filter.oninput = () => { channelQuery = filter.value; drawChannels(); };
    list.onclick = event => { const button = event.target.closest('button[data-channel]'); if (button) channelAction(button); };
    list.onsubmit = async event => {
      event.preventDefault();
      const form = event.target, id = form.dataset.channel, days = Number(new FormData(form).get('days'));
      const channel = state.channels.find(c => c.id === id), current = channel?.history?.days;
      // A shorter window deletes saved messages. The user must confirm first; Cancel changes nothing.
      if (current !== undefined && days < current && !(await askConfirm({ title: 'Delete older messages?', body: `Delete saved messages older than ${days} days in #${channel.name}? This cannot be undone.`, confirmLabel: 'Delete', danger: true }))) return;
      run(form.querySelector('button'), () => save('index', { action: 'window', days }, id));
    };
    drawChannels();
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
  document.querySelectorAll('[data-mcp-action]').forEach(button => { button.onclick = async () => {
    if (button.dataset.mcpAction === 'remove' && !(await askConfirm({ title: 'Remove this connection?', body: 'Its saved credential is removed too.', confirmLabel: 'Remove', danger: true }))) return;
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
// Model prices. Each row shows the default (the configured price, or the fallback) and the saved override.
// Edit turns the row's cells into inputs. Enter saves, Escape cancels. Read-only members see no actions.
const PRICE_FIELDS = [['input', 'Input'], ['cached_input', 'Cached input'], ['output', 'Output']];
// Dollars per 1M tokens: two decimals at least, more only when needed.
const priceLabel = micros => { const value = Number((micros / 1000000).toFixed(6)), decimals = (String(value).split('.')[1] ?? '').length; return `$${value.toFixed(Math.max(2, decimals))}`; };
const priceNote = row => row.default.source === 'fallback' ? ' <span class="small">fallback</span>' : '';
// Read cell. Only a price that differs from the default shows the default struck through, then the override.
function priceCell(row, key) {
  if (!row.override || row.override[key] === row.default[key]) return `<td>${priceLabel(row.default[key])}</td>`;
  return `<td><s>${priceLabel(row.default[key])}</s> <strong>${priceLabel(row.override[key])}</strong></td>`;
}
// Edit cell: a number input, prefilled with the price in use.
function priceInputCell(row, key, label) {
  const price = row.override ?? row.default;
  return `<td><input type="number" min="0" max="1000" step="0.000001" required value="${priceText(price[key])}" data-price-field="${key}" aria-label="${label} for ${esc(row.model)}"></td>`;
}
function adminPrices(prices, edit, editing) {
  const rows = prices.models.map(row => {
    const on = edit && editing === row.model, model = esc(row.model);
    const cells = PRICE_FIELDS.map(([key, label]) => on ? priceInputCell(row, key, label) : priceCell(row, key)).join('');
    let actions = '';
    if (on) actions = `<div class="chan-actions"><button type="button" class="primary" data-price="save" data-model="${model}">Save</button><button type="button" data-price="cancel" data-model="${model}">Cancel</button></div>`;
    else if (edit) actions = `<div class="chan-actions"><button type="button" data-price="edit" data-model="${model}">Edit</button>${row.override ? `<button type="button" data-price="reset" data-model="${model}">Reset</button>` : ''}</div>`;
    return `<tr><td><code>${model}</code>${priceNote(row)}</td>${cells}${edit ? `<td>${actions}</td>` : ''}</tr>`;
  });
  const add = edit ? `<tr><td><input name="model" maxlength="200" required pattern="\\S+" placeholder="Add a model" aria-label="Model ID of the new model" data-price-new="model"></td>${PRICE_FIELDS.map(([key, label]) => `<td><input type="number" min="0" max="1000" step="0.000001" required aria-label="${label} price for the new model" data-price-new="${key}"></td>`).join('')}<td><div class="chan-actions"><button type="button" class="primary" data-price="add">Add</button></div></td></tr>` : '';
  const fallback = prices.fallback;
  return `<h2>Model prices</h2><p class="scope">Dollars per 1 million tokens, for all servers. Each model starts at its default: the configured price, or the fallback (${priceLabel(fallback.input)} input, ${priceLabel(fallback.cached_input)} cached input, ${priceLabel(fallback.output)} output) when none is set.${edit ? ' Edit to set an override. Reset returns to the default.' : ''}</p><div class="table-wrap"><table class="price-table"><thead><tr><th>Model</th><th>Input</th><th>Cached input</th><th>Output</th>${edit ? '<th></th>' : ''}</tr></thead><tbody>${rows.join('')}${add}</tbody></table></div>`;
}
// The price card keeps the last answer and the model being edited, so Edit and Cancel redraw only the card.
let priceState = { prices: null, edit: false, editing: '' };
function paintPrices() {
  $('admin-prices').innerHTML = adminPrices(priceState.prices, priceState.edit, priceState.editing);
  if (priceState.editing) $('admin-prices').querySelector('[data-price-field="input"]')?.focus();
}
// Reads the price inputs of one row. attr is data-price-field (an edit row) or data-price-new (the add row).
function priceInputs(tr, attr) {
  return Object.fromEntries(PRICE_FIELDS.map(([key]) => [key, tr.querySelector(`[${attr}="${key}"]`)]));
}
async function savePrice(button, model, inputs) {
  if (!Object.values(inputs).every(input => input.reportValidity())) return;
  adminRun(button, async () => { await request('/api/admin/prices', { model, input: toMicros(inputs.input.value), cached_input: toMicros(inputs.cached_input.value), output: toMicros(inputs.output.value) }); notice('Price saved.'); });
}
async function resetPrice(button, model) {
  if (!await askConfirm({ title: 'Reset the price?', body: `The override for ${model} is removed. The default price applies again.`, confirmLabel: 'Reset', danger: true })) return;
  adminRun(button, async () => { await request('/api/admin/prices', { model, remove: true }); notice('Price reset to the default.'); });
}
function priceCardClick(event) {
  const button = event.target.closest('button[data-price]');
  if (!button) return;
  const action = button.dataset.price, model = button.dataset.model, row = button.closest('tr');
  if (action === 'edit') { priceState.editing = model; paintPrices(); }
  else if (action === 'cancel') { priceState.editing = ''; paintPrices(); $('admin-prices').querySelector(`[data-price="edit"][data-model="${CSS.escape(model)}"]`)?.focus(); }
  else if (action === 'save') savePrice(button, model, priceInputs(row, 'data-price-field'));
  else if (action === 'add') { const name = row.querySelector('[data-price-new="model"]'); if (name.reportValidity()) savePrice(button, name.value.trim(), priceInputs(row, 'data-price-new')); }
  else if (action === 'reset') resetPrice(button, model);
}
// Enter saves the row being edited (or the add row). Escape cancels an edit.
function priceCardKey(event) {
  if (event.target.tagName !== 'INPUT') return;
  const row = event.target.closest('tr');
  const save = row?.querySelector('[data-price="save"], [data-price="add"]'), cancel = row?.querySelector('[data-price="cancel"]');
  if (event.key === 'Enter' && save) { event.preventDefault(); save.click(); }
  else if (event.key === 'Escape' && cancel) { event.preventDefault(); cancel.click(); }
}
function adminSystemPrompt(prompt, full, off) {
  // The field shows the saved text, or the default when nothing is saved.
  const text = prompt.text ?? prompt.default;
  return `<form class="card" id="admin-system-prompt"><h2>System prompt</h2><p class="scope">For all servers. Empty uses the default.</p><div class="prompt-tabs" role="group" aria-label="Editor view"><button type="button" class="prompt-tab" id="admin-prompt-write" aria-pressed="true">Write</button><button type="button" class="prompt-tab" id="admin-prompt-preview" aria-pressed="false">Preview</button></div><textarea id="admin-system-prompt-text" class="prompt-field" name="text" aria-label="Instructions" maxlength="${prompt.max}"${off}>${esc(text)}</textarea><div id="admin-system-prompt-preview" class="prompt-field prompt-preview" hidden></div><p class="prompt-count" id="admin-system-prompt-count" aria-live="polite"></p><div class="prompt-actions"><button class="primary" id="admin-system-prompt-save"${off}>Save prompt</button><button type="button" id="admin-system-prompt-default"${off}>Use default</button></div><details class="prompt-full"><summary>Full prompt the model gets</summary><p class="small">Read only. The saved or default prompt, then the presentation and tool rules. The tool list is sent as function definitions with their schemas. The schemas are not shown here.</p><pre id="admin-system-prompt-full">${esc(full)}</pre></details></form>`;
}
// Markdown for the preview. Falls back to escaped plain lines when the renderer is missing.
function renderPrompt(text) {
  if (!text.trim()) return '<p class="small">Nothing to preview.</p>';
  const api = window.SlopbotMarkdown;
  if (api && typeof api.renderMarkdown === 'function') {
    try { const out = api.renderMarkdown(text); if (typeof out === 'string') return out; } catch { }
  }
  return esc(text).replace(/\n/g, '<br>');
}
// Write and Preview tabs work for every member, also when the field is read-only.
function wireSystemPrompt(prompt) {
  const field = $('admin-system-prompt-text'), view = $('admin-system-prompt-preview'), count = $('admin-system-prompt-count');
  const write = $('admin-prompt-write'), preview = $('admin-prompt-preview');
  const updateCount = () => {
    count.textContent = `${field.value.length} / ${prompt.max}`;
    count.dataset.over = String(field.value.length > prompt.max);
  };
  const show = mode => {
    const previewing = mode === 'preview';
    if (previewing) {
      view.style.height = `${field.offsetHeight}px`;
      view.innerHTML = renderPrompt(field.value);
    }
    field.hidden = previewing;
    view.hidden = !previewing;
    write.setAttribute('aria-pressed', String(!previewing));
    preview.setAttribute('aria-pressed', String(previewing));
  };
  write.onclick = () => show('write');
  preview.onclick = () => show('preview');
  field.oninput = updateCount;
  view.onclick = event => { const spoiler = event.target.closest('.md-spoiler'); if (spoiler) spoiler.classList.toggle('revealed'); };
  updateCount();
}
function adminPerson(profile) {
  const src = typeof profile.avatarUrl === 'string' && profile.avatarUrl.startsWith(AVATAR_HOST) ? esc(profile.avatarUrl) : '';
  const letter = esc(String(profile.displayName || '?').trim().charAt(0).toUpperCase() || '?');
  const avatar = src ? `<img class="admin-avatar" src="${src}" alt="" width="24" height="24" loading="lazy">` : `<span class="admin-avatar admin-avatar-blank" aria-hidden="true">${letter}</span>`;
  return `<span class="admin-person" title="ID ${esc(profile.id)}">${avatar}<span class="admin-name">${esc(profile.displayName)}</span>${profile.username ? `<span class="admin-handle">@${esc(profile.username)}</span>` : ''}</span>`;
}
// Share of a bar. The width is set in JS, because the page CSP blocks inline style attributes.
function paintBars(root) {
  for (const bar of root.querySelectorAll('[data-pct]')) bar.style.width = `${bar.dataset.pct}%`;
}
const shortWhen = ms => new Date(ms).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
// Per-user table for one server: spend against each limit, reset times, banked resets and actions.
function adminUsage(users, name, off) {
  const pick = (item, kind) => item.windows.find(window => window.kind === kind) ?? { spent: 0, limit: 0, resetAt: null, banked: 0 };
  const spend = stat => {
    const pct = stat.limit ? Math.min(100, Math.round(stat.spent * 100 / stat.limit)) : 0;
    return `<span>${money(stat.spent)} / ${stat.limit ? money(stat.limit) : 'no limit'}</span><div class="progress" role="progressbar" aria-label="Share of the limit used" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${pct}"><span data-pct="${pct}"></span></div>`;
  };
  const resets = stat => stat.resetAt ? esc(shortWhen(stat.resetAt)) : '<span class="small">No window</span>';
  const button = (item, action, kind, text) => `<button type="button" data-action="${action}" data-user="${esc(item.user.id)}" data-kind="${kind}"${off}>${text}</button>`;
  const row = item => {
    const five = pick(item, '5h'), week = pick(item, 'week');
    return `<tr><td>${adminPerson(item.user)}</td><td>${spend(five)}</td><td>${resets(five)}</td><td>${spend(week)}</td><td>${resets(week)}</td><td>${five.banked} / ${week.banked}</td><td><div class="chan-actions">${button(item, 'reset', '5h', 'Reset 5h')}${button(item, 'reset', 'week', 'Reset full')}${button(item, 'grant', '5h', 'Grant 5h')}${button(item, 'grant', 'week', 'Grant full')}</div></td></tr>`;
  };
  const table = users.length
    ? `<table class="usage-table"><thead><tr><th>Member</th><th>5 hours</th><th>5h resets</th><th>Week</th><th>Week resets</th><th>Banked (5h / full)</th><th>Actions</th></tr></thead><tbody>${users.map(row).join('')}</tbody></table>`
    : '<p class="small">No users have spend or banked resets in this server yet.</p>';
  return `<section class="card"><h2>Usage</h2><p class="scope">${adminUser ? 'One user.' : `The ${users.length} users with the highest 5-hour spend in ${esc(name)}.`}</p><div class="admin-search"><label>Find a member<input id="admin-search-input" type="search" maxlength="100" autocomplete="off" placeholder="Name or @username"></label>${adminUser ? '<button type="button" id="admin-all">Show all users</button>' : ''}<div id="admin-matches" class="admin-matches" hidden></div></div><div id="admin-users" class="table-wrap">${table}</div></section>`;
}
// Bot admin: lifetime usage over all servers. One row for all servers, then the top 10 servers and models by cost.
// Same columns in all three tables. Numbers are right-aligned, with thousands separators; cost has two decimals.
function adminTotals(totals) {
  const count = value => value.toLocaleString();
  const costText = micros => (micros / 1000000).toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  const head = first => `<thead><tr><th>${first}</th><th class="num">Cost ($)</th><th class="num">Requests</th><th class="num">Total tokens</th><th class="num">Input (uncached)</th><th class="num">Input (cached)</th><th class="num">Output</th></tr></thead>`;
  const cells = item => `<td class="num">${costText(item.cost_micros)}</td><td class="num">${count(item.requests)}</td><td class="num">${count(item.total_tokens)}</td><td class="num">${count(item.input_tokens)}</td><td class="num">${count(item.cached_tokens)}</td><td class="num">${count(item.output_tokens)}</td>`;
  const table = (first, rows) => `<div class="table-wrap"><table class="usage-totals">${head(first)}<tbody>${rows.join('')}</tbody></table></div>`;
  // The server icon and name, as the Manage servers list shows them. The icon is set only from Discord's CDN.
  const server = item => {
    const icon = typeof item.icon === 'string' && item.icon.startsWith(AVATAR_HOST) ? `<img class="server-icon" src="${esc(item.icon)}" alt="" width="20" height="20" loading="lazy">` : `<span class="server-icon admin-avatar-blank" aria-hidden="true">${esc(String(item.name || '?').slice(0, 1).toUpperCase())}</span>`;
    return `<tr><td><div class="admin-server">${icon}<span>${esc(item.name)}</span></div></td>${cells(item)}</tr>`;
  };
  const lifetime = table('', [`<tr><td>All servers</td>${cells(totals.total)}</tr>`]);
  const servers = totals.servers.length ? table('Server', totals.servers.map(server)) : '<p class="small">No usage yet.</p>';
  const models = totals.models.length ? table('Model', totals.models.map(item => `<tr><td><code>${esc(item.model)}</code></td>${cells(item)}</tr>`)) : '<p class="small">No usage yet.</p>';
  return `<section class="card"><h2>Usage, all servers</h2><p class="scope">Lifetime totals for every server. Total tokens is input (uncached) plus input (cached) plus output. The server and model tables show the top 10 by cost.</p><p class="eyebrow">Lifetime</p>${lifetime}<p class="eyebrow">Top servers by cost</p>${servers}<p class="eyebrow">Top models by cost</p>${models}</section>`;
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
function adminTranscripts(server, channels, off) {
  return `<section class="card"><h2>Web transcripts</h2><p class="scope">Per channel. Off by default. Discord permissions still decide who can see a transcript.</p><div id="admin-transcripts">${channels.length ? `<ul class="chan-list">${channels.map(channel => `<li class="chan"><div class="chan-info"><strong>#${esc(channel.name)}</strong></div><div class="chan-actions"><label class="switch"><input type="checkbox" data-server="${esc(server)}" data-channel="${esc(channel.id)}"${channel.enabled ? ' checked' : ''}${off}><span>${channel.enabled ? 'On' : 'Off'}</span></label><button type="button" data-action="rotate" data-server="${esc(server)}" data-channel="${esc(channel.id)}" data-name="${esc(channel.name)}"${off}>Rotate webhook</button></div></li>`).join('')}</ul>` : '<p class="small">Slopbot serves no channels in this server yet.</p>'}</div></section>`;
}
// Web search keys. Every team member adds and removes keys; the owner or an editor removes a key. Editors also set the monthly cap of each provider.
// Slopbot spreads searches over all keys that have credits left this month. A saved key is never shown again: only its last four characters.
const WEB_KEY_PROVIDERS = [['tavily', 'Tavily'], ['firecrawl', 'Firecrawl']];
// Short time since a past moment in ms, for example "5 min ago".
function agoText(ms) {
  const minutes = Math.max(0, Math.round((Date.now() - ms) / 60000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  return hours < 48 ? `${hours} h ago` : `${Math.round(hours / 24)} days ago`;
}
function adminWebKeys(webKeys, edit) {
  const groups = WEB_KEY_PROVIDERS.map(([provider, name]) => {
    const keys = webKeys.keys.filter(key => key.provider === provider), cap = webKeys.caps[provider];
    const rows = keys.map(key => {
      const owner = key.mine ? 'You' : `<code>${esc(key.owner)}</code>`;
      const badge = key.exhausted ? ' <span class="chip">Out of credits</span>' : '';
      const remove = key.mine || edit ? `<button type="button" data-web-key-remove="${esc(key.id)}">Remove</button>` : '';
      const reset = edit && (key.exhausted || key.lastError) ? `<button type="button" data-web-key-reset="${esc(key.id)}">Reset</button>` : '';
      const error = key.lastError ? `<div class="web-key-error${key.lastError.exhausted ? ' bad' : ''}">${esc(`${key.lastError.status} · ${key.lastError.message} · ${agoText(key.lastError.at)}`)}</div>` : '';
      const actions = reset + remove;
      return `<tr><td>${esc(key.label || name)}${error}</td><td><code>••••${esc(key.last4)}</code></td><td>${owner}</td><td>${key.used} / ${cap} credits${badge}</td><td>${actions ? `<div class="chan-actions">${actions}</div>` : ''}</td></tr>`;
    }).join('');
    const table = keys.length ? `<div class="table-wrap"><table class="web-key-table"><thead><tr><th>Label</th><th>Key</th><th>Added by</th><th>Used this month</th><th></th></tr></thead><tbody>${rows}</tbody></table></div>` : '<p class="small">No keys yet.</p>';
    return `<div class="web-key-group"><h3>${name}</h3>${table}</div>`;
  }).join('');
  const off = webKeys.enabled ? '' : ' disabled';
  const offNote = webKeys.enabled ? '' : '<p class="web-key-off" role="status">Web search keys are off. The operator must set WEB_KEYS_SECRET on the server, then restart Slopbot. Until then no key can be added.</p>';
  const add = `<form id="admin-web-key-add" class="web-key-form"><h3>Add a key</h3><div class="row"><label>Service<select name="provider"${off}>${WEB_KEY_PROVIDERS.map(([id, name]) => `<option value="${id}">${name}</option>`).join('')}</select></label><label>Label (optional)<input name="label" maxlength="60" autocomplete="off"${off}></label></div><label>API key<input name="secret" type="password" required minlength="8" maxlength="200" pattern="[!-~]{8,200}" title="8 to 200 printable characters, no spaces" autocomplete="off" autocapitalize="off" spellcheck="false"${off}></label><p class="small">Only the last four characters show again. The key is not sent back to the browser.</p><button class="primary"${off}>Add key</button></form>`;
  const caps = edit
    ? `<form id="admin-web-key-caps" class="web-key-form"><h3>Monthly cap per key</h3><p class="small">Credits one key may use each month before Slopbot moves on to another key.</p><div class="row">${WEB_KEY_PROVIDERS.map(([id, name]) => `<label>${name} credits<input name="${id}" type="number" min="1" max="100000" step="1" value="${webKeys.caps[id]}" required></label>`).join('')}</div><button class="primary">Save caps</button></form>`
    : `<p class="small">Monthly cap per key: ${WEB_KEY_PROVIDERS.map(([id, name]) => `${name} ${webKeys.caps[id]} credits`).join(', ')}.</p>`;
  return `<section class="card" id="admin-web-keys"><h2>Web search keys</h2><p class="scope">Team keys for Tavily and Firecrawl. You can remove your own keys. Editors can remove any key.</p>${offNote}${groups}${add}${caps}</section>`;
}
function wireWebKeys(edit) {
  const card = $('admin-web-keys');
  card.onclick = async event => {
    const reset = event.target.closest('[data-web-key-reset]');
    if (reset) { const id = reset.dataset.webKeyReset; adminRun(reset, async () => { await request('/api/admin/web-keys/reset', { id }); notice('Key reset.'); }); return; }
    const button = event.target.closest('[data-web-key-remove]');
    if (!button || !(await askConfirm({ title: 'Remove this key?', body: 'Slopbot stops using it at once.', confirmLabel: 'Remove', danger: true }))) return;
    const id = button.dataset.webKeyRemove;
    adminRun(button, async () => { await request('/api/admin/web-keys/delete', { id }); notice('Key removed.'); });
  };
  $('admin-web-key-add').onsubmit = event => {
    event.preventDefault();
    const form = event.currentTarget, data = new FormData(form);
    const body = { provider: data.get('provider'), label: String(data.get('label') || '').trim(), secret: data.get('secret') };
    // The key leaves the field at once, so it does not stay in the page after the request.
    form.querySelector('[name=secret]').value = '';
    adminRun(form.querySelector('button'), async () => { await request('/api/admin/web-keys/add', body); notice('Key added.'); });
  };
  if (edit) $('admin-web-key-caps').onsubmit = event => {
    event.preventDefault();
    const form = event.currentTarget, data = new FormData(form);
    const body = Object.fromEntries(WEB_KEY_PROVIDERS.map(([id]) => [id, Number(data.get(id))]));
    adminRun(form.querySelector('button'), async () => { await request('/api/admin/web-keys/caps', body); notice('Key caps saved.'); });
  };
}
// Bot admin: usage over all servers, model prices, web search keys and the system prompt. Same for every team member; writes need canEdit, except the member's own keys.
async function renderBotAdmin() {
  const edit = admin.canEdit, off = edit ? '' : ' disabled';
  $('breadcrumb').textContent = 'Settings / Bot admin';
  $('title').textContent = 'Bot admin';
  $('description').textContent = 'Usage, model prices, web search keys and the system prompt for all servers. Read-only members can view everything and add their own web search keys.';
  $('content').replaceChildren(busy('md', 'Loading…'));
  try {
    const [totals, prices, webKeys, systemPrompt, full] = await Promise.all([
      request('/api/admin/usage/total'),
      request('/api/admin/prices'),
      request('/api/admin/web-keys'),
      request('/api/admin/system-prompt'),
      request('/api/admin/system-prompt/full'),
    ]);
    if (tab !== 'bot') return;
    priceState = { prices, edit, editing: '' };
    $('content').innerHTML = [adminTotals(totals), '<section class="card" id="admin-prices"></section>', adminWebKeys(webKeys, edit), adminSystemPrompt(systemPrompt, full.text, off)].join('');
    paintPrices();
    wireSystemPrompt(systemPrompt);
    wireWebKeys(edit);
    if (edit) {
      $('admin-prices').onclick = priceCardClick;
      $('admin-prices').onkeydown = priceCardKey;
      $('admin-system-prompt').onsubmit = event => {
        event.preventDefault();
        adminRun($('admin-system-prompt-save'), async () => { await request('/api/admin/system-prompt', { text: $('admin-system-prompt-text').value }); notice('System prompt saved.'); });
      };
      $('admin-system-prompt-default').onclick = async () => {
        if (!await askConfirm({ title: 'Use the default prompt?', body: 'The saved prompt is removed for all servers. The default applies to new replies.', confirmLabel: 'Use default', danger: true })) return;
        $('admin-system-prompt-text').value = systemPrompt.default;
        $('admin-system-prompt-text').dispatchEvent(new Event('input'));
        adminRun($('admin-system-prompt-default'), async () => { await request('/api/admin/system-prompt', { text: '' }); notice('The default system prompt is in use.'); });
      };
    }
  } catch (error) { fail(error); }
}
// Manage servers: a searchable, paged list. Opening a server shows its limits, usage and web transcripts.
const SERVER_PAGE = 20;
let serverQuery = '', serverOffset = 0, serverLoads = 0;
async function renderServersAdmin() {
  if (adminServer) return renderServerDetail();
  $('breadcrumb').textContent = 'Settings / Manage servers';
  $('title').textContent = 'Manage servers';
  $('description').textContent = 'Limits, usage and web transcripts for each server. Read-only members can view everything.';
  $('content').innerHTML = `<section class="card"><h2>Servers</h2><p class="scope" id="admin-server-count"></p><div class="admin-search"><label>Find a server<input id="admin-server-search" type="search" maxlength="100" autocomplete="off" placeholder="Server name" value="${esc(serverQuery)}"></label></div><div id="admin-server-list"></div></section>`;
  const search = $('admin-server-search');
  let timer = 0;
  const apply = query => { if (query === serverQuery) return; serverQuery = query; serverOffset = 0; loadServerList(); };
  search.oninput = () => { clearTimeout(timer); timer = setTimeout(() => apply(search.value.trim()), 250); };
  search.onkeydown = event => { if (event.key === 'Escape') { clearTimeout(timer); search.value = ''; apply(''); } };
  await loadServerList();
}
// Loads one page of the server list into #admin-server-list. Only that part is redrawn, so the search box keeps its focus.
async function loadServerList() {
  const list = $('admin-server-list');
  if (!list) return;
  const mine = ++serverLoads;
  list.replaceChildren(busy('md', 'Loading…'));
  try {
    const page = await request(`/api/admin/servers?q=${encodeURIComponent(serverQuery)}&offset=${serverOffset}&limit=${SERVER_PAGE}`);
    if (mine !== serverLoads || tab !== 'servers-admin' || adminServer) return;
    // A page can empty out when its last row goes; then show the page before it.
    if (!page.servers.length && serverOffset > 0) { serverOffset = Math.max(0, serverOffset - SERVER_PAGE); return loadServerList(); }
    $('admin-server-count').textContent = `${page.total} ${page.total === 1 ? 'server' : 'servers'}`;
    const pages = Math.max(1, Math.ceil(page.total / SERVER_PAGE)), current = Math.floor(serverOffset / SERVER_PAGE) + 1;
    list.innerHTML = page.servers.length
      ? `<ul class="chan-list">${page.servers.map(item => `<li class="chan"><div class="admin-server">${item.icon ? `<img class="server-icon" src="${esc(item.icon)}" alt="" width="20" height="20" loading="lazy">` : `<span class="server-icon admin-avatar-blank" aria-hidden="true">${esc((item.name || "?").slice(0, 1).toUpperCase())}</span>`}<div class="chan-info"><strong>${esc(item.name)}</strong><div class="chips"><span class="chip">${item.channelCount} ${item.channelCount === 1 ? 'channel' : 'channels'}</span><span class="chip${item.transcriptsOn ? ' on' : ''}">${item.transcriptsOn} transcripts on</span></div></div></div><div class="chan-actions"><button type="button" data-server="${esc(item.id)}">Open</button></div></li>`).join('')}</ul>`
      : '<p class="small">No servers match.</p>';
    if (page.total > SERVER_PAGE) list.innerHTML += `<div class="chan-actions"><button type="button" data-page="prev"${serverOffset === 0 ? ' disabled' : ''}>Previous</button><span class="small">Page ${current} of ${pages}</span><button type="button" data-page="next"${serverOffset + SERVER_PAGE >= page.total ? ' disabled' : ''}>Next</button></div>`;
    list.onclick = event => {
      const open = event.target.closest('button[data-server]'), step = event.target.closest('button[data-page]');
      if (open) { adminServer = open.dataset.server; adminUser = ''; renderAdmin(); return; }
      if (step) { serverOffset = Math.max(0, serverOffset + (step.dataset.page === 'next' ? SERVER_PAGE : -SERVER_PAGE)); loadServerList(); }
    };
  } catch (error) { if (mine === serverLoads) fail(error); }
}
// One server: back link, Limits, Usage, Web transcripts and shares. Its channels come from one call.
async function renderServerDetail() {
  const edit = admin.canEdit, off = edit ? '' : ' disabled', id = encodeURIComponent(adminServer);
  $('breadcrumb').textContent = 'Settings / Manage servers';
  $('content').replaceChildren(busy('md', 'Loading…'));
  try {
    const [channels, limits, usage] = await Promise.all([
      request(`/api/admin/servers/channels?server=${id}`),
      request(`/api/admin/limits?server=${id}`),
      request(`/api/admin/usage?server=${id}${adminUser ? `&user=${encodeURIComponent(adminUser)}` : ''}`),
    ]);
    if (tab !== 'servers-admin' || !adminServer) return;
    const users = adminUser ? [{ user: usage.user, windows: usage.windows }] : usage.users;
    $('title').textContent = channels.name;
    $('description').textContent = 'Limits and usage apply to this server. Web transcripts are set per channel.';
    $('content').innerHTML = [
      '<p><a href="#" id="admin-back">All servers</a></p>',
      adminLimits(limits, channels.name, edit, off),
      adminUsage(users, channels.name, off),
      adminTranscripts(adminServer, channels.channels, off),
      '<section class="card" id="admin-shares"></section>',
    ].join('');
    wireBack();
    if (edit) $('admin-limits').onsubmit = event => {
      event.preventDefault();
      const form = event.target, data = new FormData(form);
      adminRun(form.querySelector('button'), async () => { await request('/api/admin/limits', { server: adminServer, five_hour_cost_micros: toMicros(data.get('five')), week_cost_micros: toMicros(data.get('week')), grace_percent: Number(data.get('grace')) }); notice('Limits saved.'); });
    };
    wireAdminSearch(adminServer);
    if ($('admin-all')) $('admin-all').onclick = () => { adminUser = ''; renderAdmin(); };
    $('admin-users').onclick = event => {
      const button = event.target.closest('button[data-action]');
      if (!button) return;
      const { action, user, kind } = button.dataset;
      adminRun(button, async () => {
        if (action === 'reset') { await request('/api/admin/usage/reset', { server: adminServer, user, kind }); notice(kind === '5h' ? `The 5-hour window is cleared for ${user}.` : `The 5-hour and weekly windows are cleared for ${user}.`); }
        else { await request('/api/admin/usage/grant', { server: adminServer, user, kind, count: 1 }); notice(`Granted one ${kind === '5h' ? '5-hour' : 'full'} reset to ${user}.`); }
      });
    };
    paintBars($('admin-users'));
    $('admin-transcripts').onclick = async event => {
      const button = event.target.closest('button[data-action="rotate"]');
      if (!button || !edit) return;
      const { server, channel, name } = button.dataset;
      if (!await askConfirm({ title: 'Make a new web webhook?', body: `The old webhook for #${name} stops working at once.`, confirmLabel: 'Make new webhook', danger: true })) return;
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
    if (window.SlopbotShares) window.SlopbotShares.renderShareList($('admin-shares'), adminServer);
  } catch (error) {
    if (tab !== 'servers-admin') return;
    $('content').innerHTML = '<p><a href="#" id="admin-back">All servers</a></p>';
    wireBack();
    fail(error);
  }
}
function wireBack() {
  const link = $('admin-back');
  if (link) link.onclick = event => { event.preventDefault(); adminServer = ''; adminUser = ''; renderAdmin(); };
}
// The admin tabs share one entry point: Bot admin, or Manage servers (list or one server).
async function renderAdmin() {
  return tab === 'bot' ? renderBotAdmin() : renderServersAdmin();
}
$('server').onchange = async () => {
  const select = $('server'), id = select.value;
  select.disabled = true; $('content').replaceChildren(busy('md', 'Loading…'));
  try { applySettings(await settingsFor(id)); remember('slopbot-server', id); }
  catch (error) { fail(error); select.value = state.server?.id ?? ''; render(); }
  finally { select.disabled = false; }
};
$('server-icon').onerror = () => { $('server-icon').hidden = true; };
$('brand').onclick = event => { if ($('console').hidden) return; event.preventDefault(); closeSettings(); window.scrollTo(0, 0); };
$('logout').onclick = async () => { try { await request('/api/logout',{}); location.reload(); } catch (error) { notice(error.message, true); } };
// The page starts from the light /api/session answer: the user, the server list and the admin flag of each server.
// The chat view shows at once. The full snapshot (channels, settings, profile) and the admin data load in the background.
async function boot() {
  if (/^#ask=/.test(location.hash)) takeAsk();
  const remembered = recall('slopbot-server');
  let session;
  try { session = await request('/api/session'); }
  catch (error) { if (error.status !== 404) throw error; }
  if (!session) {
    // A backend without the light route: wait for the full snapshot.
    let result;
    try { result = await settingsFor(remembered); }
    catch (error) { if (!remembered || error.status === 401) throw error; result = await settingsFor(); }
    applySettings(result);
    await loadAdmin();
    await resumeAsk();
  await resumeShare();
    return;
  }
  const servers = session.servers || [], current = servers.find(s => s.id === remembered) || servers[0];
  applySettings({ csrf: session.csrf, data: { user: session.user, servers, server: current ? { id: current.id, name: current.name } : null, admin: Boolean(current?.admin), channels: [], partial: true } });
  const full = current ? settingsFor(current.id) : undefined;
  loadAdmin();
  const id = current?.id;
  full?.then(result => {
    // The user may have switched server meanwhile. That switch loads its own snapshot.
    if (!state.partial || state.server?.id !== id) return;
    finishSettings(result);
  }).catch(fail);
  await resumeAsk();
  await resumeShare();
}
// The full snapshot arrives after the light start. The open chat is not drawn again. A settings tab waiting for it is.
function finishSettings(result) {
  csrf = result.csrf; state = result.data;
  const current = (state.servers || []).find(s => s.id === state.server?.id);
  if (current?.icon) { $('server-icon').src = current.icon; $('server-icon').hidden = false; }
  $('role').textContent = current ? (state.admin ? 'Admin' : 'Member') : '';
  $('settings-nav').hidden = !state.server;
  renderAccount();
  render();
  refreshGreeting();
}
// The Slopbot build line in the settings side column. One fetch at boot. It needs no login. If the fetch fails, the line stays hidden.
async function loadVersion() {
  let version;
  try { const response = await fetch('/api/version'); if (!response.ok) return; version = await response.json(); }
  catch { return; }
  const line = $('version'), date = version.time ? new Date(version.time) : null;
  if (!version.sha) line.textContent = 'Slopbot · dev';
  else line.innerHTML = `Slopbot · <a href="${esc(version.url)}" target="_blank" rel="noopener">${esc(version.sha)}</a>` + (date && !Number.isNaN(date.getTime()) ? ` · ${esc(date.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' }))}` : '');
  line.hidden = false;
}
loadVersion();
boot().catch(error => { if (error.status === 401) { showScreen('login'); if (takeAsk()) notice('Sign in with Discord to send your question to Slopbot.'); } else { showScreen('none'); notice(error.message, true); } });

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
