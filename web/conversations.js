// Conversations tab: a chat view of channel and thread transcripts (read-only), private chats with a composer, Slopbot runs and the live stream.
// Uses globals from app.js: $, request, busy, fail, notice, state, csrf, showScreen.
const conv = { server: '', list: [], chats: [], chatNote: '', kind: 'channel', channel: null, blank: false, source: null, lastStream: 0, seen: 0, live: new Map(), frame: 0, folded: new Set(), renaming: null, filter: '', view: null, runs: new Map(), open: new Set(), run: null, timers: new Map(), inbox: false, inboxDone: false, inboxCount: 0 };
const NEW_CHAT = 'New chat';
const chatTitle = c => c.title || NEW_CHAT;
// Times may be a number or a date string. A missing time counts as 0.
const timeValue = v => (typeof v === 'number' ? v : Date.parse(v)) || 0;
// Fuzzy match, same rules as src/search/fuzzy.ts: words in any order, partial words, typos, no case or accents. 0 means no match.
const foldText = text => String(text).normalize('NFKD').replace(/\p{M}+/gu, '').toLowerCase();
const fuzzyWords = text => foldText(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
const typoLimit = length => (length <= 3 ? 0 : length <= 6 ? 1 : 2);
// Optimal string alignment distance. Returns limit + 1 when the distance is above the limit.
function editDistance(a, b, limit) {
  const n = a.length, m = b.length;
  if (Math.abs(n - m) > limit) return limit + 1;
  let before = [], previous = Array.from({ length: m + 1 }, (_, j) => j);
  for (let i = 1; i <= n; i++) {
    const row = [i];
    let low = i;
    for (let j = 1; j <= m; j++) {
      let value = Math.min(previous[j] + 1, row[j - 1] + 1, previous[j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) value = Math.min(value, before[j - 2] + 1);
      row.push(value);
      low = Math.min(low, value);
    }
    if (low > limit) return limit + 1;
    before = previous; previous = row;
  }
  return previous[m] > limit ? limit + 1 : previous[m];
}
function wordScore(query, word) {
  if (word === query) return 1;
  if (query.length >= 2 && word.startsWith(query)) return 0.9;
  if (query.length >= 4 && word.includes(query)) return 0.8;
  const limit = typoLimit(query.length);
  if (!limit) return 0;
  let best = editDistance(query, word, limit);
  for (const length of [query.length - 1, query.length, query.length + 1]) if (length > 0 && length < word.length) best = Math.min(best, editDistance(query, word.slice(0, length), limit));
  return best > limit ? 0 : Math.max(0.1, 0.75 - 0.15 * best);
}
function fuzzyScore(query, text) {
  const phrase = foldText(query).trim();
  if (!phrase) return 0;
  if (foldText(text).includes(phrase)) return 1;
  const terms = [...new Set(fuzzyWords(query))];
  if (!terms.length) return 0;
  const words = [...new Set(fuzzyWords(text).slice(0, 400))];
  let total = 0;
  for (const term of terms) {
    let best = 0;
    for (const word of words) { const score = wordScore(term, word); if (score > best) best = score; if (best === 1) break; }
    if (best === 0) return 0;
    total += best;
  }
  const ordered = fuzzyWords(text).join(' ').includes(terms.join(' '));
  return Math.min(1, total / terms.length + (terms.length > 1 && ordered ? 0.1 : 0));
}
const LOCK_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
const PENCIL_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M12 3H5a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.375 2.625a1 1 0 0 1 3 3l-9.013 9.014a2 2 0 0 1-.853.505l-2.873.84a.5.5 0 0 1-.62-.62l.84-2.873a2 2 0 0 1 .506-.852z"/></svg>';
const MORE_ICON = '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" aria-hidden="true" focusable="false"><circle cx="5" cy="12" r="1.6"/><circle cx="12" cy="12" r="1.6"/><circle cx="19" cy="12" r="1.6"/></svg>';
// The longest chat title. Same limit as PRIVATE_CHAT_TITLE_CHARS on the server.
const CHAT_TITLE_MAX = 60;
const enc = encodeURIComponent;
const GROUP_MS = 5 * 60 * 1000;
const DONE_STATUS = /^(completed|delegated|done|ok)$/;
const FAILED_STATUS = /^(failed|rejected|error)$/;
const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const timeLabel = ts => ts ? new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
const label = c => (c.kind === 'thread' ? 'Thread · ' : '#') + c.name;

// Short time for a message line: the clock time today, a date and time for older messages.
function msgTime(ts) {
  if (!ts) return '';
  const date = new Date(ts);
  if (date.toDateString() === new Date().toDateString()) return date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

// Relative time for the conversation list, such as "5m ago".
function relTime(ts) {
  if (!ts) return 'No messages yet';
  const diff = Date.now() - ts;
  if (diff < 60000) return 'just now';
  if (diff < 3600000) return `${Math.floor(diff / 60000)}m ago`;
  if (diff < 86400000) return `${Math.floor(diff / 3600000)}h ago`;
  if (diff < 7 * 86400000) return `${Math.floor(diff / 86400000)}d ago`;
  return new Date(ts).toLocaleDateString([], { month: 'short', day: 'numeric' });
}

// The chat view fills the page. Settings is a separate modal (web/app.js), so its title and sections are not touched here.
function setChatMode(on) {
  if (!on) setConversationDrawer(false);
  document.querySelector('main').classList.toggle('chat-mode', on);
  $('console').classList.toggle('chat-only', on);
}

// The server picker is shown in the Servers view only. It is the same picker as in Settings.
function renderChatServers() {
  const slot = $('chat-server');
  if (!slot) return;
  slot.hidden = conv.view !== 'servers' || !(state.servers || []).length;
  slot.classList.add('pick-slot');
  if (!slot.hidden) serverPicker(slot);
}

// Two views. Chats lists all private chats of the user. Servers lists the channels and threads of the chosen server.
// The view is kept in localStorage. A deep link to a chat or channel picks its view (see loadConversations).
const SEARCH_HINT = /Mac|iPhone|iPad/.test(navigator.platform || '') ? '⌘K' : 'Ctrl+K';
function paintViews() {
  const top = $('top-tabs');
  if (top) top.hidden = false;
  document.querySelectorAll('#top-tabs .top-tab').forEach(tab => {
    const on = tab.dataset.view === conv.view;
    tab.classList.toggle('selected', on);
    tab.setAttribute('aria-pressed', String(on));
  });
  placeTabPill();
  const search = $('conv-search');
  if (search) search.placeholder = `Filter · ${SEARCH_HINT} to search messages`;
}
// Moves the sliding pill behind the active tab. The first placement does not animate.
function placeTabPill() {
  const pill = $('tab-pill'), tab = document.querySelector(`#top-tabs .top-tab[data-view="${conv.view}"]`);
  if (!pill || !tab || $('top-tabs').hidden) return;
  const first = !pill.dataset.placed;
  if (first) pill.style.transition = 'none';
  pill.style.width = `${tab.offsetWidth}px`;
  pill.style.transform = `translateX(${tab.offsetLeft}px)`;
  if (first) { pill.dataset.placed = '1'; void pill.offsetWidth; pill.style.transition = ''; }
}
window.addEventListener('resize', placeTabPill);
function setView(view, redraw = true) {
  conv.view = view;
  conv.inbox = false;
  remember('slopbot-view', view);
  paintViews();
  renderChatServers();
  if (redraw) drawList();
}
// A tab switch keeps the open item only when it belongs to the new view. Otherwise Chats opens a new chat and Servers shows the pick hint.
function switchView(view) {
  const wasInbox = conv.inbox;
  if (view === conv.view && !wasInbox) return;
  animateViews(conv.view, view, () => {
    setView(view);
    if (view === 'chats') { if (!conv.blank && (conv.kind !== 'chat' || !conv.channel)) openBlankChat(); }
    else if (conv.kind === 'chat' || conv.blank || wasInbox) showPickPane();
  });
}
// Servers is to the right of Chats, so the slide goes left going forward and right going back.
const VIEW_ORDER = ['chats', 'servers'];
// The sidebar and the main pane cross-fade with a short slide (the view-transition CSS in chat.css). The update runs inside the transition, so the new list, including its skeleton, is in the animated layer.
// Without the View Transitions API, or with reduced motion, the view changes at once.
function animateViews(from, to, update) {
  if (!document.startViewTransition || reduceMotion()) return update();
  const root = document.documentElement;
  root.dataset.viewDir = VIEW_ORDER.indexOf(to) < VIEW_ORDER.indexOf(from) ? 'back' : 'forward';
  const transition = document.startViewTransition(update);
  transition.updateCallbackDone.catch(fail);
  transition.ready.catch(() => {});
  transition.finished.finally(() => delete root.dataset.viewDir).catch(() => {});
}
// The Servers view with no channel open: the URL loses its item part and the pane shows the pick hint.
function showPickPane() {
  closeConversation();
  clearItemHash();
  $('chat-private').hidden = true;
  $('conv-status').hidden = true;
  $('conv-share').hidden = true;
  $('conv-share').replaceChildren();
  setComposer(null);
  setHeading('');
  showPick();
  drawList();
}
// The address of a chat or channel: /chat/<id> or /team/<id>, with /run/<runId> for one conversation of a channel.
function itemPath(kind, id, run = null) {
  return `/${kind === 'chat' ? 'chat' : 'team'}/${enc(id)}${run ? `/run/${enc(run)}` : ''}`;
}
// The Servers view with no channel open is at /team.
function clearItemHash() {
  if (location.pathname !== '/team' || /^#(chat|channel)\b/.test(location.hash)) history.replaceState(null, '', '/team' + location.search);
}
document.querySelectorAll('#top-tabs [data-view]').forEach(tab => tab.addEventListener('click', () => switchView(tab.dataset.view)));

function renderConversations() {
  if (conv.server !== state.server.id) { closeConversation(); conv.inboxCount = 0; conv.server = state.server.id; conv.channel = null; conv.list = []; conv.chats = []; conv.chatNote = ''; conv.renaming = null; conv.runs = new Map(); conv.open = new Set(); for (const timer of conv.timers.values()) clearTimeout(timer); conv.timers = new Map(); refreshInboxCount(); }
  setChatMode(true);
  if (!conv.view) conv.view = recall('slopbot-view') === 'servers' ? 'servers' : 'chats';
  conv.blank = false;
  setPageTitle('Chat');
  $('chat-host').innerHTML = '<div id="chat-root" class="chat"><button id="chat-backdrop" class="chat-backdrop" type="button" aria-label="Close conversations" tabindex="-1"></button><aside id="chat-side" class="chat-side" aria-label="Conversations"><button id="chat-drawer-close" class="chat-drawer-close" type="button">Conversations <span aria-hidden="true">×</span></button><div id="chat-server" class="chat-server pick-slot" hidden></div><button id="chat-resize" class="chat-resize" type="button" role="separator" aria-orientation="vertical" aria-label="Resize conversations" title="Drag to resize. Double-click to reset."></button><input id="conv-search" class="chat-search" type="search" aria-label="Filter chats or channels"><div id="conv-list" class="chat-list"></div></aside><section id="conv-main" class="chat-pane"><header class="chat-head"><button id="chat-drawer" class="chat-drawer" type="button" aria-expanded="false" aria-controls="chat-side" aria-label="Open conversations" title="Conversations"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><path d="M4 6h16M4 12h16M4 18h16"/></svg></button><h2 id="chat-title" class="chat-title"></h2><div class="chat-tools"><span id="chat-private" class="chat-private" hidden>' + LOCK_ICON + '<span>Private</span></span><span id="conv-status" class="chat-status"></span><div id="conv-share" class="chat-share" hidden></div></div></header><div id="conv-view" class="chat-view"></div><div id="conv-reply" class="chat-composer" hidden></div></section></div>';
  // Typing filters the list of the open view live. Message search is in the Cmd+K palette.
  $('conv-search').oninput = () => { conv.filter = $('conv-search').value; drawList(); };
  $('chat-drawer').onclick = toggleDrawer;
  $('chat-drawer-close').onclick = () => setConversationDrawer(false, true);
  setupResize($('chat-root'), $('chat-resize'));
  $('chat-backdrop').onclick = () => setConversationDrawer(false, true);
  $('chat-root').onkeydown = event => {
    if (event.defaultPrevented || !$('chat-root').classList.contains('drawer-open')) return;
    if (event.key === 'Escape') { event.preventDefault(); setConversationDrawer(false, true); }
    if (event.key === 'Tab' && window.matchMedia('(max-width:760px)').matches) {
      const items = [...$('chat-side').querySelectorAll('button:not(:disabled),input:not(:disabled),[tabindex="0"]')].filter(node => node.getClientRects().length);
      const first = items[0], last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    }
  };
  paintViews();
  renderChatServers();
  drawList();
  if (conv.channel === null && (conv.list.length || conv.chats.length)) showPick(); else showView(busy('md', 'Loading…'));
  loadConversations().catch(fail);
}

function setConversationDrawer(open, refocus = false) {
  const root = $('chat-root');
  if (!root) return;
  const wasOpen = root.classList.contains('drawer-open');
  root.classList.toggle('drawer-open', open);
  $('chat-drawer').setAttribute('aria-expanded', String(open));
  const mobile = window.matchMedia('(max-width:760px)').matches;
  $('conv-main').inert = open && mobile;
  document.querySelector('.topbar').inert = open && mobile;
  const side = $('chat-side');
  if (open && mobile) { side.setAttribute('role', 'dialog'); side.setAttribute('aria-modal', 'true'); }
  else { side.removeAttribute('role'); side.removeAttribute('aria-modal'); }
  if (open) $('conv-search').focus();
  else if (mobile && wasOpen && (refocus || side.contains(document.activeElement))) $('chat-drawer').focus();
}
function toggleDrawer() { setConversationDrawer(!$('chat-root').classList.contains('drawer-open')); }
window.addEventListener('resize', () => {
  if ($('chat-root') && !window.matchMedia('(max-width:760px)').matches) setConversationDrawer(false);
});

// All private chats of the user, from every server, newest first. The list is the same on every device. The route returns a list.
async function fetchChats() {
  const result = await request('/api/chats');
  return Array.isArray(result) ? result.slice().sort((a, b) => timeValue(b.updated) - timeValue(a.updated)) : [];
}

async function loadConversations() {
  const id = state.server.id;
  const run = conv.loadRun = (conv.loadRun || 0) + 1;
  const stale = () => run !== conv.loadRun || conv.server !== id || !$('conv-list');
  // Private chats show first. The channel and thread list loads beside them and fills in later.
  conv.listLoading = true;
  const channels = request(`/api/conversations?server=${enc(id)}`);
  channels.catch(() => {});
  // A failed chat list (for example a 404 before the server routes exist) leaves the Private chats group empty. The channels still load.
  const privateChats = await fetchChats().catch(error => { if (error.status === 401) throw error; return []; });
  if (stale()) return;
  conv.chats = conv.ask && conv.ask.server === id && !privateChats.some(c => c.id === conv.ask.chat) ? [{ id: conv.ask.chat, title: '', updated: Date.now() }, ...privateChats] : privateChats;
  drawList();
  // A chat or channel named in the URL opens first, and its view shows. An id that is not listed falls back to the view's default.
  const item = takeHashItem();
  if (item) setView(item.kind === 'chat' ? 'chats' : 'servers', false);
  const openChat = chatId => openConversation(chatId, 'chat', true).catch(fail);
  if (item && item.kind === 'chat' && conv.chats.some(c => c.id === item.id)) openChat(item.id);
  else if (conv.view === 'chats') {
    if (item) history.replaceState(null, '', '/chat' + location.search);
    openBlankChat();
  }
  const before = { channel: conv.channel, blank: conv.blank };
  let result;
  try { result = await channels; } catch (error) { if (!stale()) { conv.listLoading = false; drawList(); } throw error; }
  if (stale()) return;
  conv.list = result.conversations;
  conv.listLoading = false;
  drawList();
  if (conv.view !== 'servers') return;
  // The user chose something else while the channels loaded, so the view stays.
  if (conv.channel !== before.channel || conv.blank !== before.blank) return;
  const named = item && item.kind === 'channel' && conv.list.find(c => c.id === item.id);
  if (named) return openConversation(named.id, 'channel', true, item.run || null);
  if (item) clearItemHash();
  if (conv.channel && conv.kind !== 'chat' && conv.list.some(c => c.id === conv.channel)) return openConversation(conv.channel, 'channel', true, conv.run);
  showPickPane();
}

// The list starts with New chat. Then come Private chats, Channels and Threads.
function drawList() {
  const list = $('conv-list');
  if (!list) return;
  const chatsView = conv.view !== 'servers';
  list.replaceChildren(inboxButton(), ...(chatsView ? [newChatButton()] : []));
  if (chatsView && conv.chatNote) list.append(textNode('p', conv.chatNote, 'small chat-none'));
  // The filter box narrows the list live. A row being renamed stays visible.
  const filter = (conv.filter || '').trim();
  const shown = (name, id) => !filter || id === conv.renaming || fuzzyScore(filter, name) > 0;
  const groups = [];
  if (chatsView) {
    const chats = conv.chats.filter(c => shown(chatTitle(c), c.id));
    if (chats.length) groups.push(['Private chats', chats.map(chatItem)]);
  } else {
    for (const [title, kind] of [['Channels', 'channel'], ['Threads', 'thread']]) {
      const items = conv.list.filter(c => (c.kind === 'thread' ? 'thread' : 'channel') === kind && shown(c.name, c.id));
      if (items.length) groups.push([title, items.map(convTree)]);
    }
    if (conv.listLoading && !conv.list.length) groups.push(['Channels', [1, 2, 3].map(() => textNode('div', '', 'chat-skel'))]);
  }
  if (!groups.length) { list.append(textNode('p', filter ? 'No conversation matches.' : 'Nothing to show yet.', 'small chat-none')); return; }
  for (const [title, nodes] of groups) {
    const group = document.createElement('section');
    group.className = 'chat-group';
    group.append(textNode('h3', title, 'chat-group-title'), ...nodes);
    list.append(group);
  }
}

function newChatButton() {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chat-new';
  button.innerHTML = PENCIL_ICON + '<span>New chat</span>';
  button.onclick = () => newChat();
  return button;
}

// The Inbox entry in the sidebar. Its badge counts the open items of the selected server. The items show in the main pane.
function inboxButton() {
  const count = conv.inboxCount || 0, shown = count >= 50 ? '50+' : String(count);
  const button = document.createElement('button');
  button.type = 'button';
  button.id = 'inbox-open';
  button.className = 'chat-new chat-inbox';
  button.setAttribute('aria-pressed', String(!!conv.inbox));
  button.setAttribute('aria-label', count ? `Inbox, ${shown} open` : 'Inbox');
  button.append(textNode('span', 'Inbox', 'chat-inbox-label'));
  if (count) button.append(textNode('span', shown, 'chat-inbox-count'));
  button.onclick = () => openInbox();
  return button;
}
// Opens the Inbox in the main pane. The open chat or channel is closed, as for the Servers view with no item.
async function openInbox() {
  closeConversation();
  conv.inbox = true;
  setConversationDrawer(false, true);
  $('chat-private').hidden = true;
  $('conv-status').hidden = true;
  $('conv-share').hidden = true;
  $('conv-share').replaceChildren();
  setComposer(null);
  setHeading('Inbox');
  drawList();
  showView(busy('md', 'Loading…'));
  await loadInbox();
}
// The open items of the server, or all items with Show done. Each route answers { items }.
const fetchInbox = (id, done) => request(`/api/servers/${enc(id)}/inbox${done ? '?done=1' : ''}`).then(result => Array.isArray(result.items) ? result.items : []);
// Draws the Inbox panel for the server it was opened for. A reply for another server or an old view is dropped.
async function loadInbox() {
  const id = state.server.id;
  const current = () => conv.inbox && conv.server === id;
  let items;
  try { items = await fetchInbox(id, conv.inboxDone); }
  catch (error) {
    if (error.status === 401) return fail(error);
    if (current()) { conv.inboxCount = 0; drawList(); showView(textNode('p', 'The inbox is not available right now.', 'small chat-none')); }
    return;
  }
  if (!current()) return;
  if (conv.inboxDone) await refreshInboxCount();
  else { conv.inboxCount = items.length; drawList(); }
  if (!current()) return;
  showView(inboxPanel(items));
}
// The badge only. It reads the open items, so Show done does not change it.
async function refreshInboxCount() {
  const id = conv.server;
  try {
    const items = await fetchInbox(id, false);
    if (conv.server !== id || !$('conv-list')) return;
    conv.inboxCount = items.length;
  } catch (error) {
    if (error.status === 401) return fail(error);
    if (conv.server !== id) return;
    conv.inboxCount = 0;
  }
  drawList();
}
// Marks items done (ids, or "all") and redraws the panel and the badge.
async function markInboxDone(ids, button) {
  const id = state.server.id;
  if (button) button.disabled = true;
  try { await sendJson('POST', `/api/servers/${enc(id)}/inbox/done`, { ids }); }
  catch (error) { if (button) button.disabled = false; return fail(error); }
  if (conv.inbox && conv.server === id) await loadInbox();
  else await refreshInboxCount();
}
function inboxPanel(items) {
  const section = document.createElement('section');
  section.className = 'inbox';
  const bar = document.createElement('div');
  bar.className = 'inbox-bar';
  const toggle = document.createElement('button');
  toggle.type = 'button';
  toggle.className = 'inbox-toggle';
  toggle.setAttribute('aria-pressed', String(conv.inboxDone));
  toggle.textContent = 'Show done';
  toggle.onclick = () => { conv.inboxDone = !conv.inboxDone; showView(busy('md', 'Loading…')); loadInbox(); };
  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'inbox-all';
  all.textContent = 'Mark all done';
  all.disabled = !items.some(item => !item.done_at);
  all.onclick = () => markInboxDone('all', all);
  bar.append(toggle, all);
  section.append(bar);
  if (!items.length) { section.append(textNode('p', 'Your inbox is empty.', 'inbox-empty')); return section; }
  const list = document.createElement('ol');
  list.className = 'inbox-list';
  list.onclick = event => { const button = event.target.closest('button[data-done]'); if (button) markInboxDone([button.dataset.done], button); };
  list.append(...items.map(inboxRow));
  section.append(list);
  return section;
}
// One summary: who asked, when, the text (as text, never HTML), a link to the first source message and a Done button.
function inboxRow(item) {
  const row = document.createElement('li');
  row.className = `inbox-item${item.done_at ? ' done' : ''}`;
  const head = document.createElement('div');
  head.className = 'inbox-head';
  const time = textNode('time', relTime(item.created_at), 'inbox-time');
  time.dateTime = new Date(item.created_at).toISOString();
  time.title = timeLabel(item.created_at);
  head.append(textNode('strong', item.sender, 'inbox-sender'), time);
  const summary = document.createElement('p');
  summary.className = 'inbox-summary';
  plainText(summary, String(item.summary));
  const actions = document.createElement('div');
  actions.className = 'inbox-actions';
  const source = item.sourceIds && item.sourceIds[0];
  if (source) {
    const link = document.createElement('a');
    link.href = `https://discord.com/channels/${enc(item.server)}/${enc(item.channel)}/${enc(source)}`;
    link.target = '_blank';
    link.rel = 'noopener noreferrer';
    link.textContent = 'Open in Discord';
    actions.append(link);
  }
  if (item.done_at) actions.append(textNode('span', 'Done', 'inbox-done-mark'));
  else { const done = document.createElement('button'); done.type = 'button'; done.dataset.done = item.id; done.textContent = 'Done'; actions.append(done); }
  row.append(head, summary, actions);
  return row;
}

// One private chat: a lock, the title, the relative time and the "⋯" menu. While the chat is renamed, the row holds the rename box.
function chatItem(c) {
  if (conv.renaming === c.id) return renameRow(c);
  const row = document.createElement('div');
  row.className = 'chat-row';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chat-item';
  button.setAttribute('aria-current', conv.kind === 'chat' && c.id === conv.channel ? 'true' : 'false');
  const lock = document.createElement('span');
  lock.className = 'chat-lock';
  lock.innerHTML = LOCK_ICON;
  button.append(lock, textNode('span', chatTitle(c), 'chat-item-name'), textNode('span', relTime(timeValue(c.updated)), 'chat-item-time'));
  button.onclick = () => openConversation(c.id, 'chat');
  row.append(button, ...chatMenu(c, row));
  return row;
}

// The "⋯" button and its menu, Rename and Delete. Escape closes the menu from anywhere in the row.
function chatMenu(c, row) {
  const more = document.createElement('button');
  more.type = 'button';
  more.className = 'chat-more';
  more.innerHTML = MORE_ICON;
  more.setAttribute('aria-label', `Options for ${chatTitle(c)}`);
  more.setAttribute('aria-haspopup', 'menu');
  more.setAttribute('aria-expanded', 'false');
  const menu = document.createElement('div');
  menu.className = 'chat-menu';
  menu.setAttribute('role', 'menu');
  menu.hidden = true;
  const del = menuItem('Delete', () => { closeMenu(row, true); deleteChat(c); });
  del.classList.add('danger');
  menu.append(menuItem('Rename', () => { closeMenu(row, false); startRename(c.id); }), del);
  more.onclick = () => (menu.hidden ? openMenu(row) : closeMenu(row, true));
  row.addEventListener('keydown', event => { if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); closeMenu(row, true); } });
  return [more, menu];
}

function menuItem(text, onClick) {
  const button = textNode('button', text, 'chat-menu-item');
  button.type = 'button';
  button.setAttribute('role', 'menuitem');
  button.onclick = onClick;
  return button;
}

// Only one menu is open at a time. Its first item takes focus.
function openMenu(row) {
  for (const other of document.querySelectorAll('.chat-menu:not([hidden])')) closeMenu(other.parentElement, false);
  row.querySelector('.chat-menu').hidden = false;
  row.querySelector('.chat-more').setAttribute('aria-expanded', 'true');
  row.querySelector('.chat-menu-item').focus();
}

// Closes a row's menu. Refocus puts the focus back on the "⋯" button.
function closeMenu(row, refocus) {
  const more = row.querySelector('.chat-more');
  row.querySelector('.chat-menu').hidden = true;
  more.setAttribute('aria-expanded', 'false');
  if (refocus) more.focus();
}

// A click or tap outside an open menu closes it.
document.addEventListener('pointerdown', event => {
  for (const menu of document.querySelectorAll('.chat-menu:not([hidden])')) {
    if (!menu.parentElement.contains(event.target)) closeMenu(menu.parentElement, false);
  }
});

// The rename box. Enter saves. Escape, or leaving the box, cancels.
function renameRow(c) {
  const row = document.createElement('div');
  row.className = 'chat-row';
  const field = document.createElement('input');
  field.type = 'text';
  field.className = 'chat-rename';
  field.maxLength = CHAT_TITLE_MAX;
  field.value = c.title || '';
  field.placeholder = NEW_CHAT;
  field.setAttribute('aria-label', 'Chat title');
  field.onkeydown = event => {
    if (event.isComposing) return;
    if (event.key === 'Enter') { event.preventDefault(); commitRename(c, field.value); }
    else if (event.key === 'Escape') { event.preventDefault(); endRename(c.id); }
  };
  field.onblur = () => endRename(c.id);
  row.append(field);
  return row;
}

function startRename(id) {
  conv.renaming = id;
  drawList();
  const field = document.querySelector('.chat-rename');
  if (field) { field.focus(); field.select(); }
}

function endRename(id) {
  if (conv.renaming !== id) return;
  conv.renaming = null;
  drawList();
}

// An empty or unchanged title is not sent. Otherwise the title is saved, then the list reloads for the new order.
async function commitRename(c, raw) {
  if (conv.renaming !== c.id) return;
  const title = raw.replace(/\s+/g, ' ').trim();
  if (!title || title === (c.title || '')) return endRename(c.id);
  conv.renaming = null;
  try {
    await sendJson('PATCH', `/api/chats/${enc(c.id)}`, { title });
    await refreshChats();
  } catch (error) { fail(error); }
  drawList();
}

// Deletes a private chat after a confirm. An open chat goes to the empty state.
async function deleteChat(c) {
  if (!await askConfirm({ title: 'Delete chat?', body: `"${chatTitle(c)}". Its messages and runs are removed. This cannot be undone.`, confirmLabel: 'Delete', danger: true })) return;
  try { await sendJson('DELETE', `/api/chats/${enc(c.id)}`); } catch (error) { return fail(error); }
  conv.chats = conv.chats.filter(item => item.id !== c.id);
  if (conv.kind === 'chat' && conv.channel === c.id) {
    closeConversation();
    history.replaceState(null, '', '/chat' + location.search);
    setHeading('');
    $('chat-private').hidden = true;
    $('conv-status').hidden = true;
    setComposer(null);
    showPick();
  }
  drawList();
}

// Shows a chat or channel in the URL, so a reload or Back opens it again. Replace is used for automatic opens, so they add no history entry.
function setItemHash(kind, id, replace, run = null) {
  const path = itemPath(kind, id, run);
  if (location.pathname === path && !location.hash) return;
  history[replace ? 'replaceState' : 'pushState'](null, '', path + location.search);
}

function convItem(c) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chat-item';
  button.dataset.id = c.id;
  button.setAttribute('aria-current', conv.kind !== 'chat' && c.id === conv.channel && !conv.run ? 'true' : 'false');
  // A channel with web transcripts off is muted and shows an "off" note instead of the time.
  if (c.enabled === false) button.classList.add('off');
  button.append(textNode('span', c.kind === 'thread' ? c.name : '#' + c.name, 'chat-item-name'),
    c.enabled === false ? textNode('span', 'off', 'chat-item-time chat-item-off') : textNode('span', relTime(c.newest), 'chat-item-time'));
  button.onclick = () => openConversation(c.id);
  return button;
}

// A channel or thread row. The chevron opens its conversations, which load the first time the row opens. Off channels have no chevron.
const CHEVRON_ICON = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false"><path d="M9 6l6 6-6 6"/></svg>';
const RUN_PAGE = 20;
const treeNode = id => document.querySelector(`.chat-tree[data-id="${CSS.escape(id)}"]`);
const runUrl = (id, run) => `/api/conversations/${enc(id)}/runs/${enc(run)}?server=${enc(state.server.id)}`;

function convTree(c) {
  const wrap = document.createElement('div');
  wrap.className = 'chat-tree';
  wrap.dataset.id = c.id;
  const row = document.createElement('div');
  row.className = 'chat-row';
  if (c.enabled !== false) {
    const open = conv.open.has(c.id);
    wrap.classList.toggle('open', open);
    const chevron = document.createElement('button');
    chevron.type = 'button';
    chevron.className = 'chat-chevron';
    chevron.innerHTML = CHEVRON_ICON;
    chevron.setAttribute('aria-expanded', String(open));
    chevron.setAttribute('aria-label', `Conversations in ${c.kind === 'thread' ? c.name : '#' + c.name}`);
    chevron.onclick = () => setChannelOpen(c.id, !conv.open.has(c.id));
    row.append(chevron);
  }
  row.append(convItem(c));
  wrap.append(row);
  if (c.enabled !== false) {
    const sub = document.createElement('div');
    sub.className = 'chat-sub';
    const inner = document.createElement('div');
    inner.className = 'chat-sub-inner';
    inner.append(...runRows(c));
    sub.append(inner);
    wrap.append(sub);
  }
  return wrap;
}

// The rows under a channel: All messages (the full history, as before), then its conversations and Show more.
function runRows(c) {
  if (!conv.open.has(c.id) && !conv.runs.has(c.id)) return [];
  const all = document.createElement('button');
  all.type = 'button';
  all.className = 'chat-item chat-run chat-run-all';
  all.setAttribute('aria-current', conv.channel === c.id && !conv.run ? 'true' : 'false');
  all.append(textNode('span', 'All messages', 'chat-item-name'));
  all.onclick = () => openConversation(c.id);
  const rows = [all];
  const state = conv.runs.get(c.id);
  if (!state || state.status === 'loading') return [...rows, textNode('p', 'Loading…', 'small chat-sub-note')];
  for (const item of state.items) rows.push(runButton(c, item));
  if (state.status === 'error') rows.push(textNode('p', 'Could not load conversations.', 'small chat-sub-note'));
  else if (!state.items.length) rows.push(textNode('p', 'No conversations yet.', 'small chat-sub-note'));
  if (state.hasMore) {
    const more = textNode('button', 'Show more', 'chat-item chat-sub-more');
    more.type = 'button';
    more.onclick = () => { more.disabled = true; loadRuns(c.id, { more: true }); };
    rows.push(more);
  }
  return rows;
}

// One conversation: its title and relative time. The title is the first message, so it does not change when runs join.
function runButton(c, item) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chat-item chat-run';
  button.dataset.run = item.id;
  button.setAttribute('aria-current', conv.channel === c.id && conv.run === item.id ? 'true' : 'false');
  button.title = `${item.messageCount} messages · ${timeLabel(item.end)}`;
  button.append(textNode('span', item.title, 'chat-item-name'), textNode('span', relTime(item.end), 'chat-item-time'));
  button.onclick = () => openConversation(c.id, 'channel', false, item.id);
  return button;
}

// Redraws the rows under one channel from the saved state. The row itself is kept, so the chevron animation still runs.
function paintRuns(id) {
  const inner = treeNode(id)?.querySelector('.chat-sub-inner');
  const c = conv.list.find(item => item.id === id);
  if (inner && c) inner.replaceChildren(...runRows(c));
}

function setChannelOpen(id, open) {
  if (open) conv.open.add(id); else conv.open.delete(id);
  const tree = treeNode(id);
  if (tree) {
    tree.classList.toggle('open', open);
    tree.querySelector('.chat-chevron')?.setAttribute('aria-expanded', String(open));
  }
  // Opening a row always reloads its list, so runs that arrived while it was closed show up.
  if (open) loadRuns(id);
}

// One page of a channel's conversations, newest first. More adds the next page. A refresh keeps the rows already shown.
async function loadRuns(id, { more = false } = {}) {
  const server = conv.server;
  const prev = conv.runs.get(id);
  const offset = more && prev ? prev.items.length : 0;
  const limit = more ? RUN_PAGE : Math.max(RUN_PAGE, prev ? prev.items.length : 0);
  if (!prev) conv.runs.set(id, { items: [], hasMore: false, status: 'loading' });
  paintRuns(id);
  try {
    const page = await request(`/api/conversations/${enc(id)}/runs?server=${enc(server)}&limit=${limit}&offset=${offset}`);
    if (conv.server !== server) return;
    const items = more && prev ? [...prev.items, ...page.conversations] : page.conversations;
    conv.runs.set(id, { items, hasMore: page.hasMore, status: 'ready' });
  } catch {
    if (conv.server !== server) return;
    conv.runs.set(id, { items: prev ? prev.items : [], hasMore: prev ? prev.hasMore : false, status: 'error' });
  }
  paintRuns(id);
}

// A new run in the open channel refreshes its list a moment later, so a burst of runs costs one request.
function scheduleRuns(id) {
  if (!conv.runs.has(id)) return;
  const key = `runs:${id}`;
  clearTimeout(conv.timers.get(key));
  conv.timers.set(key, setTimeout(() => { conv.timers.delete(key); loadRuns(id); }, 400));
}

// While a conversation is open, a new message or a finished run reloads only that conversation.
function scheduleView(id) {
  const key = `view:${id}`;
  clearTimeout(conv.timers.get(key));
  conv.timers.set(key, setTimeout(() => { conv.timers.delete(key); refreshView(id); }, 400));
}

async function refreshView(id) {
  const run = conv.run;
  if (!run || conv.channel !== id) return;
  try {
    const page = await request(runUrl(id, run));
    if (conv.channel !== id || conv.run !== run) return;
    const log = $('conv-log');
    const stick = !log || nearBottom(log);
    showView(transcriptView(id, page, null));
    const fresh = $('conv-log');
    if (fresh && stick) fresh.scrollTop = fresh.scrollHeight;
    syncJump();
  } catch (error) { fail(error); }
}

function showView(node) {
  const view = $('conv-view');
  if (view) view.replaceChildren(node);
}

// The sidebar width. Drag the handle or use the arrow keys. A double-click goes back to the default. The width is kept in this browser.
const SIDE_WIDTH = { key: 'slopbot.sideWidth', start: 240, min: 180, max: 520 };

function setupResize(root, handle) {
  const clamp = width => Math.round(Math.min(Math.max(width, SIDE_WIDTH.min), Math.min(SIDE_WIDTH.max, window.innerWidth - 320)));
  const apply = width => {
    const value = clamp(width);
    root.style.setProperty('--side-width', value + 'px');
    handle.setAttribute('aria-valuenow', String(value));
    return value;
  };
  const save = width => { try { localStorage.setItem(SIDE_WIDTH.key, String(width)); } catch { } };
  let saved = SIDE_WIDTH.start;
  try { saved = Number(localStorage.getItem(SIDE_WIDTH.key)) || SIDE_WIDTH.start; } catch { }
  handle.setAttribute('aria-valuemin', String(SIDE_WIDTH.min));
  handle.setAttribute('aria-valuemax', String(SIDE_WIDTH.max));
  apply(saved);
  handle.onpointerdown = event => {
    event.preventDefault();
    handle.setPointerCapture(event.pointerId);
    const left = root.getBoundingClientRect().left;
    root.classList.add('resizing');
    let width = saved;
    handle.onpointermove = move => { width = apply(move.clientX - left); };
    handle.onpointerup = handle.onpointercancel = () => {
      handle.onpointermove = handle.onpointerup = handle.onpointercancel = null;
      root.classList.remove('resizing');
      saved = width; save(width);
    };
  };
  handle.onkeydown = event => {
    const step = event.shiftKey ? 40 : 10;
    if (event.key === 'ArrowLeft') saved = apply(saved - step);
    else if (event.key === 'ArrowRight') saved = apply(saved + step);
    else return;
    event.preventDefault();
    save(saved);
  };
  handle.ondblclick = () => { saved = apply(SIDE_WIDTH.start); save(saved); };
}

function showPick() { showView(emptyNote('Pick a conversation', 'Choose a channel or thread on the left.')); }

function emptyNote(title, hint) {
  const box = document.createElement('div');
  box.className = 'chat-empty';
  box.append(textNode('h2', title, 'chat-empty-title'), textNode('p', hint, 'chat-empty-hint'));
  return box;
}

// The heading and the browser tab title show the open chat or channel. An empty heading means the plain Chat view.
function setHeading(text) { $('chat-title').textContent = text; setPageTitle(text || 'Chat'); }

function setComposer(node) {
  if (!node) conv.meter = null;
  const slot = $('conv-reply');
  if (!slot) return;
  slot.hidden = !node;
  slot.replaceChildren(...(node ? [node] : []));
}

// Opens a channel or thread (read-only), or a private chat (with a composer). The kind is 'channel' or 'chat'. Replace keeps the history entry.
// A run ID opens one conversation of the channel: only its messages. Without it the channel shows its full history.
async function openConversation(id, kind = 'channel', replace = false, run = null) {
  closeStream();
  setView(kind === 'chat' ? 'chats' : 'servers', false);
  conv.channel = id; conv.kind = kind; conv.run = kind === 'chat' ? null : run; conv.blank = false; dropLive();
  setItemHash(kind, id, replace, conv.run);
  const chat = kind === 'chat';
  drawList();
  setConversationDrawer(false, true);
  // A channel with web transcripts off has no messages to load. The server does not send them either.
  const listed = chat ? conv.chats.find(c => c.id === id) : conv.list.find(c => c.id === id);
  $('chat-private').hidden = !chat;
  if (!chat && listed && listed.enabled === false) return showOff(id, listed);
  // Opening a channel shows its conversations under it.
  if (!chat && listed) setChannelOpen(id, true);
  const shown = conv.run;
  $('conv-status').hidden = false;
  setStatus('Connecting…');
  setHeading(chat ? chatTitle(listed || {}) : '');
  $('conv-share').hidden = true;
  $('conv-share').replaceChildren();
  setComposer(null);
  showView(busy('md', 'Loading…'));
  try {
    const page = await request(shown ? runUrl(id, shown) : messagesUrl(id));
    if (conv.channel !== id || conv.run !== shown) return;
    if (chat) {
      // Only the owner opens a private chat, so the owner always gets the Share button here.
      if (window.SlopbotShares) { $('conv-share').hidden = false; window.SlopbotShares.renderChatShare($('conv-share'), id); }
      // A chat with no messages shows the greeting, with the composer under it. Otherwise the composer is at the bottom.
      const composer = chatComposer(id);
      const empty = !page.messages.length;
      showView(transcriptView(id, page, empty ? heroNode(composer) : null));
      if (empty) hideSlot(); else setComposer(composer);
      refreshUsage();
    } else {
      const info = listed || { kind: 'channel', name: page.channel.name };
      const name = info.name || page.channel.name;
      // A conversation's heading shows its title. Sharing stays on the whole channel, so it is not offered here.
      setHeading(shown && page.conversation ? `${label({ ...info, name })} · ${page.conversation.title}` : label({ ...info, name }));
      if (page.canShare && !shown && window.SlopbotShares) { $('conv-share').hidden = false; window.SlopbotShares.renderShareButton($('conv-share'), state.server.id, id); }
      showView(transcriptView(id, page, null));
      // Channels and threads have no composer. Replies are posted in Discord.
      setComposer(textNode('p', 'Read-only. Reply in Discord.', 'chat-readonly'));
    }
    conv.lastStream = page.streamId;
    conv.seen = page.streamId;
    const log = $('conv-log');
    log.scrollTop = log.scrollHeight;
    syncJump();
    openStream(id);
  } catch (error) {
    if (conv.channel === id) showView(textNode('p', error.message, 'small chat-none'));
    fail(error);
  }
}

// Used by the command palette (web/palette.js): the private chats and the channels and threads of the open server.
window.SlopbotChat = {
  // ts is the last activity in milliseconds (0 when unknown). The palette sorts Recents by it.
  items: () => [
    ...conv.chats.map(c => ({ kind: 'chat', id: c.id, name: chatTitle(c), ts: timeValue(c.updated) })),
    ...conv.list.map(c => ({ kind: 'channel', id: c.id, name: c.name, thread: c.kind === 'thread', ts: timeValue(c.newest) })),
  ],
  open: (kind, id) => openConversation(id, kind === 'chat' ? 'chat' : 'channel').catch(fail),
  view: switchView,
  // Message search for the palette. It covers the channels of the current server (the search route has no private chat search).
  searchMessages: async text => {
    if (!state.server) return [];
    const result = await request(`/api/conversations/search?server=${enc(state.server.id)}&q=${enc(text)}`);
    const names = new Map(result.channels.map(c => [c.id, c.name]));
    return result.messages.slice(0, 10).map(m => ({ id: m.id, channel: m.channel, name: names.get(m.channel) || 'Conversation', authorName: m.authorName, timestamp: m.timestamp, text: m.text }));
  },
  // Opens the channel and scrolls to the message when the loaded transcript has it. Older messages are not loaded for this.
  openMessage: (channel, id) => openConversation(channel, 'channel').then(() => focusMessage(id)).catch(fail),
};

// Scrolls to one message in the open transcript and flashes it briefly.
function focusMessage(id) {
  const node = document.querySelector(`#conv-log [data-id="${CSS.escape(id)}"]`);
  if (!node) return;
  node.scrollIntoView({ block: 'center' });
  node.classList.add('chat-msg-flash');
  setTimeout(() => node.classList.remove('chat-msg-flash'), 1600);
}

// The message page route for the open item. A private chat has its own route. Both return the same page shape.
function messagesUrl(id, before = '') {
  const query = `limit=50${before ? `&before=${enc(before)}` : ''}`;
  return conv.kind === 'chat' ? `/api/chats/${enc(id)}/messages?${query}` : `/api/conversations/${enc(id)}/messages?server=${enc(state.server.id)}&${query}`;
}

// A time-of-day greeting with the user's name when known, and a garden line chosen at random.
const GARDEN_LINES = ["What's growing today?", 'Plant a question.', 'What should we dig into?', 'Let an idea bloom.', 'What needs some sunlight?', 'Ready to sow something new?'];
function heroGreeting(line = GARDEN_LINES[Math.floor(Math.random() * GARDEN_LINES.length)]) {
  const hour = new Date().getHours(), part = hour < 5 ? 'Good evening' : hour < 12 ? 'Good morning' : hour < 18 ? 'Good afternoon' : 'Good evening';
  const name = (state.me?.displayName || state.profile?.name || '').trim();
  return `${name ? `${part}, ${name}` : part}. ${line}`;
}

// The name arrives with the full snapshot, after the greeting is drawn. This adds it and keeps the same garden line.
function refreshGreeting() {
  const title = document.querySelector('.chat-hero-title');
  const line = title && GARDEN_LINES.find(text => title.textContent.endsWith(text));
  if (line) title.textContent = heroGreeting(line);
}

// The greeting of a new chat. The composer sits under it until the first message arrives.
function heroNode(composer) {
  const hero = document.createElement('section');
  hero.className = 'chat-hero';
  const logo = document.createElement('img');
  logo.className = 'chat-hero-logo';
  logo.alt = ''; logo.width = 56; logo.height = 56;
  logo.src = document.documentElement.classList.contains('light') ? '/console/assets/logo-dark.svg' : '/console/assets/logo-light.svg';
  const slot = textNode('div', '', 'chat-hero-composer');
  slot.append(composer);
  hero.append(logo, textNode('h2', heroGreeting(), 'chat-hero-title'), slot);
  return hero;
}

// Moves the composer from the greeting to the bottom of the pane. A hero that is not on the page is ignored.
function leaveEmpty(hero = document.querySelector('.chat-hero')) {
  if (!hero || !hero.isConnected) return;
  const form = hero.querySelector('.chat-form');
  hero.remove();
  if (form) setComposer(form);
}

function hideSlot() {
  const slot = $('conv-reply');
  if (!slot) return;
  slot.replaceChildren();
  slot.hidden = true;
}

// New chat shows a blank chat with the composer. Nothing is saved on the server until the first message is sent.
// On a blank chat already, the button only focuses the composer.
function newChat() {
  if (conv.view !== 'chats') setView('chats');
  if (conv.blank) return focusComposer();
  openBlankChat();
}

// The landing page Ask box links to /console#ask=<text>. boot() keeps the text in sessionStorage, so it survives the Discord login.
// Longest text the chat API takes. It matches PRIVATE_CHAT_MAX_CHARS in src/private-chat.ts.
const ASK_MAX_CHARS = 8000;
function takeAsk() {
  let text = '';
  const match = /^#ask=(.*)$/s.exec(location.hash);
  if (match) {
    try { text = decodeURIComponent(match[1]); } catch { text = ''; }
    history.replaceState(null, '', location.pathname + location.search);
    try { if (text.trim()) sessionStorage.setItem('slopbot-ask', text); } catch { }
  }
  try { text = sessionStorage.getItem('slopbot-ask') || ''; } catch { }
  return [...text.trim()].slice(0, ASK_MAX_CHARS).join('');
}
function clearAsk() { try { sessionStorage.removeItem('slopbot-ask'); } catch { } }
const ASK_WARNING = 'Only send what you wrote yourself. A prompt from someone else can make Slopbot use tools or read data you did not mean to share.';
// Opens a new private chat on the current server (the last one used, or the first) with the linked text in the composer.
// The text is never sent for the user. A banner asks them to read it first.
async function resumeAsk() {
  const text = takeAsk();
  if (!text) return;
  clearAsk();
  if (!state.server) { notice('Slopbot is not in any of your servers yet, so it cannot answer your question.', true); return; }
  try {
    const id = (await sendJson('POST', '/api/chats', { server: state.server.id })).id;
    // The text stays with this chat until the user sends it or clears it. Any later open of the chat shows it again.
    conv.ask = { server: state.server.id, chat: id, text };
    conv.chats = [{ id, title: '', updated: Date.now() }, ...conv.chats];
    history.replaceState(null, '', itemPath('chat', id) + location.search);
    renderChat(true);
  } catch (error) {
    if (error.status === 401) { try { sessionStorage.setItem('slopbot-ask', text); } catch { } showScreen('login'); return; }
    notice(error.status === 404 ? 'Private chats are not available right now.' : error.message, true);
  }
}

// The shared page's Continue button sends a signed-out viewer to sign in first. Its share ID waits in sessionStorage.
// After the login, this copies the share into a new private chat and opens it.
async function resumeShare() {
  let id = '';
  try { id = sessionStorage.getItem('slopbot-share') || ''; sessionStorage.removeItem('slopbot-share'); } catch { }
  if (!/^[A-Za-z0-9_-]{22}$/.test(id)) return;
  try {
    const chat = await sendJson('POST', `/api/shares/${encodeURIComponent(id)}/continue`, {});
    conv.chats = [{ id: chat.id, title: chat.title || '', updated: Date.now() }, ...conv.chats];
    await openConversation(chat.id, 'chat', true);
  } catch (error) {
    notice(error.status === 404 ? 'That shared chat is no longer available.' : error.message, true);
  }
}

function focusComposer() { document.querySelector('.chat-form textarea')?.focus(); }

// Opens the blank chat. Its id comes with the first send (see chatComposer).
function openBlankChat() {
  closeConversation();
  conv.blank = true; conv.kind = 'chat'; conv.channel = null;
  conv.chatNote = '';
  if (location.pathname !== '/chat' || location.hash) history.pushState(null, '', '/chat' + location.search);
  drawList();
  setConversationDrawer(false, true);
  $('chat-private').hidden = false;
  $('conv-status').hidden = true;
  $('conv-share').hidden = true;
  $('conv-share').replaceChildren();
  setHeading(NEW_CHAT);
  const composer = chatComposer(null);
  showView(transcriptView(null, { messages: [], hasMore: false }, heroNode(composer)));
  hideSlot();
  refreshUsage();
  focusComposer();
}

// Removes a chat that was made for a send that failed before anything was saved. The error is not shown.
function discardChat(id) { sendJson('DELETE', `/api/chats/${enc(id)}`).catch(() => {}); }

// A JSON request with any method. Errors keep their status, as in request().
async function sendJson(method, path, body) {
  const response = await fetch(path, { method, headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: body === undefined ? undefined : JSON.stringify(body) });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) { const error = new Error(data.error || 'Request failed.'); error.status = response.status; error.resetAt = data.resetAt; throw error; }
  return data;
}

// A chat made or renamed on another device shows when the user comes back to this tab.
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible' && $('conv-list')) refreshChats(); });

// Reloads the private chat list, so the order and new titles show.
async function refreshChats() {
  const id = state.server?.id;
  if (!id) return;
  try {
    const chats = await fetchChats();
    if (conv.server !== id) return;
    conv.chats = chats;
    drawList();
    const open = conv.kind === 'chat' ? conv.chats.find(c => c.id === conv.channel) : null;
    if (open) setHeading(chatTitle(open));
  } catch (error) { if (error.status === 401) fail(error); }
}

// The empty state for a channel with web transcripts off. Only a user who can manage the server sees the button.
function showOff(id, info) {
  $('conv-status').hidden = true;
  setHeading(label(info));
  $('conv-share').hidden = true;
  $('conv-share').replaceChildren();
  setComposer(null);
  const box = document.createElement('div');
  box.className = 'chat-empty';
  box.append(textNode('h2', 'Web transcripts are off for this channel.', 'chat-empty-title'));
  if (state.admin) {
    const button = textNode('button', 'Turn on', 'chat-off-on');
    button.type = 'button';
    button.onclick = () => turnOn(button, id);
    box.append(button);
  }
  showView(box);
}

// Turns the switch on with the same route as the Settings switch, then reloads the list and opens the channel.
async function turnOn(button, id) {
  button.disabled = true;
  try {
    await request('/api/web-transcripts/channels', { server: state.server.id, channel: id, enabled: true });
    notice('Web transcripts on for this channel.');
    await loadConversations();
  } catch (error) {
    button.disabled = false;
    fail(error);
  }
}

// lead is an optional node put before the messages, such as the greeting of a new chat.
function transcriptView(id, page, lead) {
  const wrap = document.createElement('div');
  wrap.className = 'chat-transcript';
  const older = textNode('button', 'Load older messages', 'chat-older');
  older.type = 'button'; older.id = 'conv-older'; older.hidden = !page.hasMore;
  older.onclick = () => loadOlder(id);
  const log = document.createElement('div');
  log.id = 'conv-log'; log.className = 'chat-log';
  log.setAttribute('role', 'log'); log.setAttribute('aria-live', 'polite'); log.setAttribute('aria-relevant', 'additions');
  if (lead) log.append(lead);
  for (const m of page.messages) log.append(messageNode(m));
  regroup(log);
  const jump = textNode('button', '↓', 'chat-jump');
  jump.type = 'button'; jump.id = 'chat-jump'; jump.hidden = true;
  jump.setAttribute('aria-label', 'Scroll to the newest messages');
  jump.onclick = () => log.scrollTo({ top: log.scrollHeight, behavior: reduceMotion() ? 'auto' : 'smooth' });
  log.addEventListener('scroll', syncJump);
  log.addEventListener('click', spoilerClick);
  wrap.append(older, log, jump);
  return wrap;
}

async function loadOlder(id) {
  const log = $('conv-log'), first = log && log.querySelector('[data-id]');
  if (!first) return;
  const button = $('conv-older');
  button.disabled = true;
  try {
    const page = await request(messagesUrl(id, first.dataset.id));
    if (conv.channel !== id) return;
    const before = log.scrollHeight;
    for (const m of page.messages) if (!log.querySelector(`[data-id="${m.id}"]`)) log.insertBefore(messageNode(m), log.firstChild);
    regroup(log);
    log.scrollTop += log.scrollHeight - before;
    button.hidden = !page.hasMore;
    syncJump();
  } catch (error) { fail(error); }
  finally { button.disabled = false; }
}

// One message. Slopbot answers have no bubble. The signed-in user's own messages are right-aligned bubbles with no header.
function messageNode(m) {
  const kind = m.slopbot ? 'bot' : (state.user && m.author === state.user) ? 'mine' : 'human';
  const article = document.createElement('article');
  article.className = `chat-msg ${kind}`;
  article.dataset.id = m.id;
  article.dataset.kind = kind;
  // A live message is not known to be used until the run ends. Only an explicit false folds it.
  article.dataset.used = m.used === false ? 'false' : 'true';
  article.dataset.author = m.author || m.authorName || '';
  if (m.timestamp) article.dataset.time = String(m.timestamp);
  if (kind === 'mine') {
    const bubble = textNode('div', '', 'chat-text');
    if (m.timestamp) bubble.title = timeLabel(m.timestamp);
    renderText(bubble, m.text);
    if (m.images?.length || m.remoteImages?.length) article.append(imageStrip(m));
    if (m.files && m.files.length) article.append(fileChips(m));
    article.append(bubble);
    if (m.editedAt) article.append(textNode('span', 'edited', 'chat-edited'));
    return article;
  }
  const head = document.createElement('header');
  head.className = 'chat-msg-head';
  if (m.slopbot) head.append(slopMark(false), textNode('strong', 'Slopbot'));
  else {
    const name = textNode('strong', m.authorName || m.author || '');
    if (m.username) name.title = `@${m.username}`;
    head.append(avatarNode(m), name);
  }
  const time = textNode('time', msgTime(m.timestamp));
  if (m.timestamp) { time.dateTime = new Date(m.timestamp).toISOString(); time.title = timeLabel(m.timestamp); }
  head.append(time);
  if (m.editedAt) head.append(textNode('span', 'edited', 'chat-edited'));
  article.append(head);
  if (m.slopbot && m.runIds && m.runIds.length) article.append(runBlock(m.runIds));
  const body = textNode('div', '', 'chat-text');
  renderText(body, m.text);
  article.append(body);
  if (m.images?.length || m.remoteImages?.length) article.append(imageStrip(m));
  if (m.files?.length) article.append(fileChips(m));
  return article;
}

function avatarNode(m) {
  const name = String(m.authorName || m.author || '').trim();
  const pill = () => textNode('span', Array.from(name)[0]?.toUpperCase() || '?', 'chat-avatar chat-avatar-pill');
  // Only Discord's CDN is accepted, the same rule as the account avatar.
  if (typeof m.avatarUrl !== 'string' || !m.avatarUrl.startsWith(AVATAR_HOST)) return pill();
  const img = document.createElement('img');
  img.className = 'chat-avatar';
  img.width = 28; img.height = 28; img.alt = ''; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
  img.onerror = () => img.replaceWith(pill());
  img.src = m.avatarUrl;
  return img;
}

// The Slopbot petal mark. It is cloned from the loader template in index.html. It moves only while a run is live.
function slopMark(live, size = 'chat-mark') {
  const svg = loader(size);
  svg.setAttribute('aria-hidden', 'true');
  if (!live) svg.classList.add('still');
  return svg;
}

// Markdown comes from window.SlopbotMarkdown when it is loaded. Otherwise the text is shown as plain lines.
function renderText(node, text) {
  const value = String(text ?? '');
  const api = window.SlopbotMarkdown;
  if (api && typeof api.renderMarkdown === 'function') {
    try {
      const out = api.renderMarkdown(value);
      if (typeof out === 'string') { node.innerHTML = out; api.typeset?.(node); return; }
      if (out instanceof Node) { node.replaceChildren(out); return; }
    } catch { }
  }
  plainText(node, value);
}

function plainText(node, value) {
  node.replaceChildren();
  value.split('\n').forEach((line, index) => {
    if (index) node.append(document.createElement('br'));
    node.append(line);
  });
}

// Marks a message as a continuation when it has the same author and kind within 5 minutes of the one before.
function regroup(log) {
  let prev = null;
  for (const node of log.querySelectorAll('.chat-msg')) {
    const same = prev && prev.dataset.author && prev.dataset.author === node.dataset.author && prev.dataset.kind === node.dataset.kind
      && prev.dataset.time && node.dataset.time && Math.abs(Number(node.dataset.time) - Number(prev.dataset.time)) <= GROUP_MS;
    node.classList.toggle('cont', Boolean(same));
    prev = node;
  }
  foldUnused(log);
}

// Messages from other people that no reply used fold into one row. A click shows them, and a second click folds them again.
// Nothing folds from the trigger message of a live run onward.
function foldUnused(log) {
  for (const old of log.querySelectorAll('.chat-fold')) old.remove();
  const nodes = [...log.querySelectorAll('.chat-msg')];
  let guard = nodes.length;
  for (const card of conv.live.values()) guard = Math.min(guard, Math.max(0, nodes.findIndex(node => node.dataset.id === card.requestId)));
  let run = [];
  const flush = () => { if (run.length) placeFold(run); run = []; };
  nodes.forEach((node, index) => {
    node.classList.remove('chat-folded');
    if (index < guard && node.dataset.kind === 'human' && node.dataset.used === 'false') run.push(node);
    else flush();
  });
  flush();
}

function placeFold(run) {
  const key = run[0].dataset.id;
  const open = conv.folded.has(key);
  const button = textNode('button', `${run.length} ${run.length === 1 ? 'message' : 'messages'} Slopbot did not read ›`, 'chat-fold');
  button.type = 'button';
  button.setAttribute('aria-expanded', String(open));
  button.onclick = () => {
    const show = !conv.folded.has(key);
    if (show) conv.folded.add(key); else conv.folded.delete(key);
    button.setAttribute('aria-expanded', String(show));
    for (const node of run) node.classList.toggle('chat-folded', !show);
  };
  for (const node of run) node.classList.toggle('chat-folded', !open);
  run[0].before(button);
}

// After a run ends, the visible messages of other people are checked again. A reply run may have used them now.
async function refreshUsed(channel) {
  const log = $('conv-log');
  if (!log || conv.channel !== channel) return;
  const people = [...log.querySelectorAll('.chat-msg[data-kind="human"]')];
  const ids = people.slice(-200).map(node => node.dataset.id);
  if (!ids.length) return;
  try {
    const result = await request(`/api/conversations/${enc(channel)}/used?server=${enc(state.server.id)}&ids=${enc(ids.join(','))}`);
    if (conv.channel !== channel || $('conv-log') !== log) return;
    const found = new Set(result.used);
    for (const node of people) if (found.has(node.dataset.id)) node.dataset.used = 'true';
    regroup(log);
  } catch (error) { fail(error); }
}

function syncJump() {
  const log = $('conv-log'), jump = $('chat-jump');
  if (log && jump) jump.hidden = nearBottom(log);
}

// A run box under a Slopbot answer. The summary line is built from the run steps.
function runView(loader) {
  const wrap = document.createElement('div');
  wrap.className = 'chat-run';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chat-run-sum';
  button.setAttribute('aria-expanded', 'false');
  const text = textNode('span', 'Show run', 'chat-run-text');
  button.append(text, textNode('span', '›', 'chat-chev'));
  const box = textNode('div', '', 'chat-run-box');
  box.hidden = true;
  const view = { wrap, button, text, box };
  button.onclick = async () => {
    const open = box.hidden;
    box.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    if (open && loader && !wrap.dataset.loaded) { wrap.dataset.loaded = 'true'; await loader(view); }
  };
  wrap.append(button, box);
  return view;
}

function runBlock(runIds) {
  return runView(async view => {
    view.box.replaceChildren(busy('sm', 'Loading run…'));
    try {
      const runs = await Promise.all(runIds.map(id => request(`/api/runs/${enc(id)}`)));
      view.box.replaceChildren(...runs.flatMap(run => storedRunRows(run)));
      view.text.textContent = summarize(runs.flatMap(run => run.steps.filter(isShownStep))) || 'Run details';
    } catch (error) {
      view.wrap.dataset.loaded = '';
      view.box.replaceChildren(textNode('p', error.message, 'chat-run-error'));
      fail(error);
    }
  }).wrap;
}

// All steps of all rounds form one flat list. A text or thinking step with only spaces gets no row.
// Text after the last tool step is the answer. The message shows it, so the run box does not show it again.
function storedRunRows(run) {
  const rows = [];
  const steps = run.steps.filter(isShownStep);
  const lastTool = steps.findLastIndex(step => step.type === 'tool');
  for (const step of steps.filter((step, index) => step.type !== 'text' || index < lastTool)) {
    if (step.type === 'text') rows.push(textNode('div', step.text, 'chat-run-prose'));
    else if (step.type === 'thinking') rows.push(thinkRow(step.text));
    else rows.push(...toolStepRows(step));
  }
  if (run.error && run.error.trim()) rows.push(textNode('p', run.error, 'chat-run-error'));
  if (!rows.length) rows.push(textNode('p', 'No stored events for this run.', 'small chat-none'));
  return rows;
}

// A run_tools_code step shows its code in a closed Code block. Its child calls follow, indented. Child calls come from step.children.
function toolStepRows(step) {
  const row = toolRow(step.name, step.status, step.args, step.result, 'Result', false);
  const rows = [row];
  if (step.name === 'run_tools_code' && typeof step.code === 'string' && step.code.trim()) {
    const details = document.createElement('details');
    details.className = 'chat-tool-code';
    const body = textNode('div', '', 'chat-tool-code-body');
    renderText(body, '````js\n' + step.code + '\n````');
    details.append(textNode('summary', 'Code', 'chat-tool-code-label'), body);
    row.append(details);
  }
  for (const child of Array.isArray(step.children) ? step.children : []) {
    const childRow = toolRow(child.name, child.status, child.args, child.result, 'Result', false);
    childRow.classList.add('chat-tool-child');
    rows.push(childRow);
  }
  return rows;
}

// A saved step with text shows only when the text is not blank. Tool steps always show.
function isShownStep(step) {
  return step.type === 'tool' || Boolean(step.text && step.text.trim());
}

// The thinking label is the duration when it is known: "Thought for 12s", "Thought for 1m 5s", or "Thought".
// While a live thinking step is open it reads "Thinking…".
function thinkLabel(ms, open) {
  if (open) return 'Thinking…';
  if (ms === undefined) return 'Thought';
  return `Thought for ${formatDuration(ms)}`;
}

// Durations read as "12s" or "1m 5s". Under a second counts as 1s.
function formatDuration(ms) {
  const seconds = Math.max(1, Math.round(ms / 1000));
  const minutes = Math.floor(seconds / 60);
  return minutes ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

// A thinking row is one line, the same as a tool row: the label, the start of the text and a chevron. A click shows all of the text.
function thinkRow(text, ms, open) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chat-tool-line chat-think';
  button.setAttribute('aria-expanded', 'false');
  button.append(textNode('span', '', 'chat-tool-status'), textNode('span', thinkLabel(ms, open), 'chat-tool-name chat-think-label'), textNode('span', text, 'chat-tool-args chat-think-text'), textNode('span', '›', 'chat-chev'));
  button.onclick = () => button.setAttribute('aria-expanded', String(button.classList.toggle('open')));
  return button;
}

// One entry per tool name registered in src. Names match exactly, never by pattern.
// label is the row text, one and many build the summary line, doing is the status verb while the tool runs.
const times = phrase => n => `${phrase} ${n} times`;
const TOOL_KINDS = {
  web_search: { label: 'Searched the web', one: 'searched the web', many: times('searched the web'), doing: 'Searching the web…' },
  history_search: { label: 'Searched chat history', one: 'searched chat history', many: times('searched chat history'), doing: 'Searching chat history…' },
  history_read: { label: 'Read chat history', one: 'read chat history', many: times('read chat history'), doing: 'Reading chat history…' },
  read: { label: 'Read a file', one: 'read a file', many: n => `read ${n} files`, doing: 'Reading a file…' },
  write: { label: 'Wrote a file', one: 'wrote a file', many: n => `wrote ${n} files`, doing: 'Writing a file…' },
  edit: { label: 'Edited a file', one: 'edited a file', many: n => `edited ${n} files`, doing: 'Editing a file…' },
  shell: { label: 'Ran a command', one: 'ran a command', many: times('ran commands'), doing: 'Running a command…' },
  file_store: { label: 'Stored a file', one: 'stored a file', many: n => `stored ${n} files`, doing: 'Storing files…' },
  sandbox_manage: { label: 'Managed the sandbox', one: 'managed the sandbox', many: times('managed the sandbox'), doing: 'Managing the sandbox…' },
  memory: { label: 'Listed memories', one: 'listed memories', many: times('listed memories'), doing: 'Listing memories…' },
  memory_remember: { label: 'Saved a memory', one: 'saved a memory', many: n => `saved ${n} memories`, doing: 'Saving a memory…' },
  memory_forget: { label: 'Forgot a memory', one: 'forgot a memory', many: n => `forgot ${n} memories`, doing: 'Forgetting a memory…' },
  profile: { label: 'Checked a profile', one: 'checked a profile', many: n => `checked ${n} profiles`, doing: 'Checking profiles…' },
  decision_lookup: { label: 'Looked up a decision', one: 'looked up a decision', many: times('looked up decisions'), doing: 'Looking up a decision…' },
  conversation_summary: { label: 'Summarized a conversation', one: 'summarized a conversation', many: n => `summarized ${n} conversations`, doing: 'Summarizing the conversation…' },
  why: { label: 'Checked a decision', one: 'checked a decision', many: n => `checked ${n} decisions`, doing: 'Checking a decision…' },
  channel_find: { label: 'Searched channels', one: 'searched channels', many: times('searched channels'), doing: 'Searching channels…' },
  channels: { label: 'Managed channels', one: 'managed channels', many: times('managed channels'), doing: 'Managing channels…' },
  index: { label: 'Managed history index', one: 'managed history index', many: times('managed history index'), doing: 'Managing history index…' },
  status: { label: 'Checked status', one: 'checked status', many: times('checked status'), doing: 'Checking status…' },
  bot_info: { label: 'Checked bot info', one: 'checked bot info', many: times('checked bot info'), doing: 'Checking bot info…' },
  usage: { label: 'Checked usage', one: 'checked usage', many: times('checked usage'), doing: 'Checking usage…' },
  timing: { label: 'Set timing', one: 'set timing', many: times('set timing'), doing: 'Setting timing…' },
  timing_active: { label: 'Checked timing', one: 'checked timing', many: times('checked timing'), doing: 'Checking timing…' },
  timing_inspect: { label: 'Inspected timing', one: 'inspected timing', many: times('inspected timing'), doing: 'Inspecting timing…' },
  tool_display: { label: 'Set tool display', one: 'set tool display', many: times('set tool display'), doing: 'Setting tool display…' },
  monitoring: { label: 'Set monitoring', one: 'set monitoring', many: times('set monitoring'), doing: 'Setting monitoring…' },
  reactions: { label: 'Set reactions', one: 'set reactions', many: times('set reactions'), doing: 'Setting reactions…' },
  context: { label: 'Set context', one: 'set context', many: times('set context'), doing: 'Setting context…' },
  cooldown: { label: 'Set reply limits', one: 'set reply limits', many: times('set reply limits'), doing: 'Setting reply limits…' },
  task_start: { label: 'Started a task', one: 'started a task', many: times('started tasks'), doing: 'Starting a task…' },
  task_status: { label: 'Checked task status', one: 'checked task status', many: times('checked task status'), doing: 'Checking tasks…' },
  task_retry: { label: 'Retried a task', one: 'retried a task', many: times('retried tasks'), doing: 'Retrying a task…' },
  task_manage: { label: 'Managed tasks', one: 'managed tasks', many: times('managed tasks'), doing: 'Managing tasks…' },
  reminder: { label: 'Managed reminders', one: 'managed reminders', many: times('managed reminders'), doing: 'Managing reminders…' },
  poll_create: { label: 'Created a poll', one: 'created a poll', many: n => `created ${n} polls`, doing: 'Creating a poll…' },
  ui_publish: { label: 'Published a view', one: 'published a view', many: n => `published ${n} views`, doing: 'Publishing a view…' },
  run_tools_code: { label: 'Ran code', one: 'ran code', many: times('ran code'), doing: 'Running code…' },
};

// Garden words for the live status line, from the brand line "Where ideas bloom".
const GARDEN_WORDS = ['Blooming', 'Sprouting', 'Unfurling', 'Budding', 'Germinating', 'Photosynthesizing', 'Pollinating', 'Rooting', 'Blossoming', 'Cultivating', 'Pruning', 'Composting', 'Seeding', 'Flowering', 'Ripening'];

// An unknown name gets its words, so a new tool still reads as a phrase.
function toolKind(name) {
  const text = String(name || 'tool');
  if (Object.hasOwn(TOOL_KINDS, text)) return { key: text, ...TOOL_KINDS[text] };
  const words = text.replace(/[_-]+/g, ' ').trim() || 'tool';
  return { key: `tool:${text}`, label: `Used ${words}`, one: `used ${words}`, many: n => `used ${words} ${n} times`, doing: `Using ${words}…` };
}

// Builds one line such as "Thought for 8s, searched the web 2 times, searched chat history".
// Thinking steps may carry ms (live duration). Without it the line says only "Thought".
function summarize(steps) {
  const parts = [];
  const thinking = steps.filter(step => step.type === 'thinking');
  if (thinking.length) {
    const timed = thinking.filter(step => step.ms !== undefined);
    const total = timed.reduce((sum, step) => sum + step.ms, 0);
    parts.push(timed.length ? `thought for ${formatDuration(total)}` : 'thought');
  }
  const groups = new Map();
  for (const step of steps) {
    if (step.type !== 'tool') continue;
    const kind = toolKind(step.name);
    const group = groups.get(kind.key) || { kind, count: 0 };
    group.count++;
    groups.set(kind.key, group);
  }
  for (const { kind, count } of groups.values()) parts.push(count === 1 ? kind.one : kind.many(count));
  const line = parts.join(', ');
  return line ? line.charAt(0).toUpperCase() + line.slice(1) : '';
}

function statusMark(status) {
  if (DONE_STATUS.test(status)) return '✓';
  if (FAILED_STATUS.test(status)) return '✕';
  return '…';
}

function detailText(args, extra, extraLabel) {
  const parts = [`Arguments\n${args || ''}`];
  if (extra) parts.push(`${extraLabel}\n${extra}`);
  return parts.join('\n\n');
}

const MAIN_ARGS = ['query', 'q', 'url', 'channel', 'name', 'text', 'goal', 'topic', 'title', 'id', 'action'];

// The main argument of a tool call, shown next to its label. args is the JSON text saved with the event, and it may be cut short.
// Without a known key the compact JSON is shown.
function mainArg(args) {
  const text = String(args || '').trim();
  if (!text || text === '{}') return '';
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = undefined; }
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    for (const key of MAIN_ARGS) {
      const value = parsed[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
      if (typeof value === 'number' || typeof value === 'boolean') return String(value);
    }
    return text.slice(0, 160);
  }
  // A cut-off JSON text does not parse. Its first known string key is still read.
  for (const key of MAIN_ARGS) {
    const match = text.match(new RegExp(`"${key}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)`));
    if (match) {
      try { return JSON.parse(`"${match[1]}"`).trim() || text.slice(0, 160); } catch { return match[1]; }
    }
  }
  return text.slice(0, 160);
}

// One tool row: status, a muted action label, the main argument and a chevron. A click shows the details.
function toolRow(name, status, args, extra, extraLabel, open) {
  const row = textNode('div', '', 'chat-tool');
  const line = document.createElement('button');
  line.type = 'button';
  line.className = 'chat-tool-line';
  const mark = textNode('span', statusMark(status), 'chat-tool-status');
  mark.title = status || '';
  line.append(mark, textNode('span', toolKind(name).label, 'chat-tool-name'), textNode('span', mainArg(args), 'chat-tool-args'), textNode('span', '›', 'chat-chev'));
  const detail = textNode('pre', detailText(args, extra, extraLabel || 'Result'), 'chat-tool-detail');
  const setOpen = on => { detail.hidden = !on; row.dataset.open = String(on); line.setAttribute('aria-expanded', String(on)); };
  line.onclick = () => setOpen(detail.hidden);
  setOpen(Boolean(open));
  row.append(line, detail);
  return row;
}

function updateToolRow(row, name, status, args, extra, extraLabel) {
  const mark = row.querySelector('.chat-tool-status'), text = statusMark(status);
  if (mark.textContent !== text) mark.textContent = text;
  mark.title = status || '';
  row.querySelector('.chat-tool-name').textContent = toolKind(name).label;
  row.querySelector('.chat-tool-args').textContent = mainArg(args);
  row.querySelector('.chat-tool-detail').textContent = detailText(args, extra, extraLabel || 'Result');
}

function messageRow(id) { return document.querySelector(`[data-id="${id}"]`); }

function openStream(id) {
  const kind = conv.kind;
  const url = kind === 'chat' ? `/api/chats/${enc(id)}/stream?after=${conv.lastStream}` : `/api/conversations/${enc(id)}/stream?server=${enc(state.server.id)}&after=${conv.lastStream}`;
  const es = new EventSource(url);
  conv.source = es;
  // Stream IDs only go up. Skipping IDs already shown keeps a replayed event from showing twice.
  const on = (type, handler) => es.addEventListener(type, event => {
    const id = Number(event.lastEventId);
    if (id) { if (id <= conv.seen) return; conv.seen = id; }
    try { handler(JSON.parse(event.data)); } catch { }
  });
  // One conversation view shows only its own messages, so live events are not drawn into it. It reloads after each change instead.
  on('message', data => {
    if (conv.run) scheduleView(id); else if (data.action === 'delete') removeMessage(data.id); else upsertMessage(data.message);
    // The reply is linked to its run before it is saved, so it is the time to check again which messages a run used. run.end comes too soon.
    if (kind !== 'chat' && data.message?.slopbot) refreshUsed(id);
  });
  on('run.start', data => { scheduleRuns(id); if (!conv.run) startLive(data.ref, data.requestId); });
  on('run.delta', data => { if (!conv.run) delta(data.ref, data.part, data.text); });
  on('run.tool', data => { if (!conv.run) tool(data); });
  on('run.end', data => {
    if (conv.run) scheduleView(id); else endLive(data.ref);
    refreshUsage();
    if (kind === 'chat') refreshChats(); else { refreshUsed(id); scheduleRuns(id); }
  });
  // The server pruned events after this stream's position. Reload the messages from the newest page.
  es.addEventListener('reset', () => {
    if (conv.source !== es) return;
    closeStream();
    openConversation(id, kind, true, conv.run).catch(fail);
  });
  es.addEventListener('closed', event => {
    closeStream();
    let reason = 'access';
    try { reason = JSON.parse(event.data).reason; } catch { }
    setStatus(reason === 'access' ? 'Access ended. Reload to check again.' : 'Live updates stopped.');
  });
  es.onopen = () => setStatus('Live');
  es.onerror = () => setStatus(es.readyState === EventSource.CLOSED ? 'Disconnected' : 'Reconnecting…');
}

function closeStream() {
  if (conv.source) conv.source.close();
  conv.source = null;
}

function closeConversation() {
  closeStream();
  conv.inbox = false;
  dropLive();
  conv.channel = null;
  conv.run = null;
  conv.blank = false;
}

// The header shows a green dot and "Live" while the stream is open. Otherwise it shows a grey "Offline".
function setStatus(text) {
  const node = $('conv-status');
  if (!node) return;
  const live = text === 'Live';
  node.classList.toggle('on', live);
  node.textContent = live ? 'Live' : 'Offline';
  node.title = text;
}

function insertInOrder(log, node) {
  const time = Number(node.dataset.time || Infinity);
  const later = [...log.querySelectorAll('[data-id]')].find(item => Number(item.dataset.time || Infinity) > time);
  log.insertBefore(node, later || null);
}

function nearBottom(log) { return log.scrollHeight - log.scrollTop - log.clientHeight < 120; }

function upsertMessage(m) {
  const log = $('conv-log');
  // A private chat stream carries only that chat. A channel stream is checked against the open channel.
  if (!log || (conv.kind !== 'chat' && m.channel !== conv.channel)) return;
  leaveEmpty();
  const stick = nearBottom(log);
  const node = messageNode(m);
  let old = log.querySelector(`[data-id="${m.id}"]`);
  // The saved copy of a message that was shown before it was saved takes its place.
  if (!old && node.dataset.kind === 'mine') old = [...log.querySelectorAll('[data-pending]')].find(item => item.dataset.pending === m.text);
  if (old) old.replaceWith(node); else insertInOrder(log, node);
  for (const runId of m.runIds) finishLiveRun(runId);
  regroup(log);
  if (stick) log.scrollTop = log.scrollHeight;
  syncJump();
}

function removeMessage(id) {
  const log = $('conv-log');
  const node = log && messageRow(id);
  if (node) node.remove();
  if (log) regroup(log);
  syncJump();
}

// A live card shows one request while its runs stream. It is replaced by the saved reply.
// The status line on top has the pulsing mark, a verb, and the elapsed time and output tokens.
function liveFor(requestId) {
  let card = [...conv.live.values()].find(item => item.requestId === requestId);
  if (card) { if (requestId !== PENDING_CARD) dropPendingCard(); return card; }
  // A card shown before the run started takes the first real request id.
  const early = requestId !== PENDING_CARD && conv.live.get(PENDING_CARD);
  if (early) { conv.live.delete(PENDING_CARD); early.requestId = requestId; conv.live.set(requestId, early); unadopted = Math.max(0, unadopted - 1); return early; }
  const log = $('conv-log');
  if (!log) return undefined;
  const stick = nearBottom(log);
  const node = document.createElement('article');
  node.className = 'chat-msg bot live';
  node.dataset.kind = 'bot';
  node.dataset.author = '__live__';
  node.dataset.time = String(Date.now());
  const head = document.createElement('header');
  head.className = 'chat-msg-head';
  head.append(textNode('strong', 'Slopbot'));
  const view = runView(null);
  view.text.classList.add('chat-verb');
  const meta = textNode('span', '', 'chat-run-meta');
  view.text.after(meta);
  const mark = slopMark(true);
  view.button.prepend(mark);
  const text = textNode('div', '', 'chat-text live-text');
  node.append(head, view.wrap, text);
  log.append(node);
  // Thinking steps are rows in the run box, in order. seg is the open one. segs keeps every step of this card.
  card = {
    requestId, node, view, meta, mark, text,
    runs: new Set(), active: new Set(), buffers: { text: '', thinking: '' }, shown: { text: 0 }, seg: null, segs: [],
    toolState: new Map(), rows: new Map(), started: Date.now(), ticks: 0, timer: 0, tokens: 0, verb: '', verbAt: 0, verbTimer: 0,
    word: Math.floor(Math.random() * GARDEN_WORDS.length),
  };
  conv.live.set(requestId, card);
  startTimer(card);
  regroup(log);
  if (stick) log.scrollTop = log.scrollHeight;
  syncJump();
  return card;
}

// The timer ticks every second. It updates the elapsed time and, every 4 ticks, the garden word.
function startTimer(card) {
  card.node.classList.remove('done');
  card.mark.classList.remove('still');
  card.view.text.classList.add('chat-verb');
  if (!card.timer) card.timer = setInterval(() => liveTick(card), 1000);
  liveTick(card);
}

function liveTick(card) {
  card.ticks++;
  if (card.ticks % 4 === 0) card.word++;
  setMeta(card);
  setLiveSummary(card);
}

// The status meta: elapsed time and output tokens. The token count moves toward the estimate a little each frame, so it counts up smoothly.
function setMeta(card) {
  if (!card.timer) return;
  card.meta.textContent = `(${elapsedSeconds(card)}s · ↓ ${formatTokens(card.tokens)} tokens)`;
}

// Returns true while the shown token count is behind the estimate.
function stepTokens(card) {
  const target = outputTokens(card), gap = target - card.tokens;
  if (gap <= 0) return false;
  card.tokens += reduceMotion() ? gap : Math.max(1, Math.ceil(gap / 10));
  setMeta(card);
  return card.tokens < target;
}

function elapsedSeconds(card) { return Math.floor((Date.now() - card.started) / 1000); }

// The stream has no token counts, so output is estimated at about 4 characters per token.
function outputTokens(card) { return Math.ceil((card.buffers.text.length + card.buffers.thinking.length) / 4); }

function formatTokens(n) { return n < 1000 ? String(n) : `${(n / 1000).toFixed(1).replace(/\.0$/, '')}k`; }

function findRunCard(runId) { return [...conv.live.values()].find(item => item.runs.has(runId)); }

function startLive(runId, requestId) {
  const card = liveFor(requestId);
  if (!card) return;
  card.runs.add(runId);
  card.active.add(runId);
  startTimer(card);
}

function delta(runId, part, text) {
  const card = findRunCard(runId);
  if (!card || !text) return;
  if (part === 'thinking') {
    const seg = thinkDelta(card, text);
    if (reduceMotion()) revealSeg(seg, seg.buffer.length);
  } else {
    closeThink(card);
    card.buffers.text += text;
    if (reduceMotion()) revealText(card, card.buffers.text.length);
  }
  setLiveSummary(card);
  schedule();
}

// A thinking delta joins the open thinking step, or opens one. The step's row is added when it has visible text.
function thinkDelta(card, text) {
  if (!card.seg) {
    card.seg = { row: null, label: null, body: null, buffer: '', shown: 0, start: Date.now(), end: 0 };
    card.segs.push(card.seg);
  }
  const seg = card.seg;
  seg.buffer += text;
  card.buffers.thinking += text;
  if (!seg.row && seg.buffer.trim()) {
    seg.row = thinkRow('', undefined, true);
    seg.label = seg.row.querySelector('.chat-think-label');
    seg.body = seg.row.querySelector('.chat-think-text');
    seg.body.textContent = seg.buffer.slice(0, seg.shown);
    card.view.box.append(seg.row);
  }
  return seg;
}

// Thinking ends at the next text delta or tool call. Its duration is kept for the label and the summary.
function closeThink(card) {
  const seg = card.seg;
  if (!seg) return;
  card.seg = null;
  seg.end = Date.now();
  if (seg.label) seg.label.textContent = thinkLabel(seg.end - seg.start, false);
}

function tool(data) {
  const card = liveFor(data.requestId);
  if (!card) return;
  closeThink(card);
  const old = card.rows.get(data.id);
  // An update changes the row in place. Replacing it made fast tool calls flicker.
  if (old) updateToolRow(old, data.name, data.status, data.args, data.reason, 'Reason');
  else {
    const log = $('conv-log'), stick = log && !card.view.box.hidden && nearBottom(log);
    const row = toolRow(data.name, data.status, data.args, data.reason, 'Reason', false);
    card.view.box.append(row);
    card.rows.set(data.id, row);
    if (stick) log.scrollTop = log.scrollHeight;
  }
  card.toolState.set(data.id, { name: data.name, status: data.status || '' });
  setLiveSummary(card);
}

// The steps of the live card, for the summary line. A thinking step has ms once it is closed.
function liveSteps(card) {
  const thinking = card.segs.filter(seg => seg.row).map(seg => ({ type: 'thinking', ms: seg.end ? seg.end - seg.start : undefined }));
  return [...thinking, ...[...card.toolState.values()].map(item => ({ type: 'tool', name: item.name }))];
}

// The verb is the running tool's activity. Without a tool it is a garden word, or "Working…" with reduced motion.
function liveVerb(card) {
  const pending = [...card.toolState.values()].filter(item => !DONE_STATUS.test(item.status) && !FAILED_STATUS.test(item.status)).pop();
  if (pending) return toolKind(pending.name).doing;
  if (reduceMotion()) return 'Working…';
  return `${GARDEN_WORDS[card.word % GARDEN_WORDS.length]}…`;
}

// The verb stays at least VERB_HOLD_MS, so fast tool calls do not make it flicker. The newest verb shows when the hold ends.
const VERB_HOLD_MS = 800;
function setLiveSummary(card) {
  if (!card.timer) return;
  const verb = liveVerb(card), wait = card.verbAt + VERB_HOLD_MS - Date.now();
  if (verb === card.verb) return;
  if (wait > 0) {
    if (!card.verbTimer) card.verbTimer = setTimeout(() => { card.verbTimer = 0; setLiveSummary(card); }, wait);
    return;
  }
  card.verb = verb; card.verbAt = Date.now();
  card.view.text.textContent = verb;
}

// When every run of the card has ended, the status line becomes the run summary with the time.
function endLive(runId) {
  const card = findRunCard(runId);
  if (!card) return;
  card.active.delete(runId);
  if (card.active.size) return;
  clearInterval(card.timer);
  clearTimeout(card.verbTimer);
  card.timer = 0; card.verbTimer = 0;
  card.node.classList.add('done');
  card.mark.classList.add('still');
  closeThink(card);
  card.view.text.classList.remove('chat-verb');
  card.view.text.textContent = summarize(liveSteps(card)) || 'Run details';
  card.meta.textContent = `· ${elapsedSeconds(card)}s`;
}

function finishLiveRun(runId) {
  for (const [key, card] of conv.live) {
    if (card.runs.has(runId)) { clearInterval(card.timer); clearTimeout(card.verbTimer); card.node.remove(); conv.live.delete(key); }
  }
}

function dropLive() {
  for (const card of conv.live.values()) { clearInterval(card.timer); clearTimeout(card.verbTimer); }
  conv.live.clear(); unadopted = 0;
}

function revealText(card, to) {
  card.shown.text = to;
  card.text.textContent = card.buffers.text.slice(0, to);
}

// A thinking step shows its first `shown` characters. Its row may not exist yet. Then the text is set when the row is made.
function revealSeg(seg, to) {
  seg.shown = to;
  if (seg.body) seg.body.textContent = seg.buffer.slice(0, to);
}

function schedule() { if (!conv.frame) conv.frame = requestAnimationFrame(tick); }

// Reveal buffered text a little each frame. The step grows with the backlog, so the view never falls far behind.
// The view follows the newest text only when it is already near the bottom.
function tick() {
  conv.frame = 0;
  const log = $('conv-log');
  const stick = log ? nearBottom(log) : false;
  let more = false;
  const step = backlog => Math.min(backlog, Math.max(1, Math.ceil(backlog / 12)));
  for (const card of conv.live.values()) {
    if (stepTokens(card)) more = true;
    const textBacklog = card.buffers.text.length - card.shown.text;
    if (textBacklog > 0) {
      revealText(card, card.shown.text + step(textBacklog));
      if (card.shown.text < card.buffers.text.length) more = true;
    }
    for (const seg of card.segs) {
      const backlog = seg.buffer.length - seg.shown;
      if (backlog <= 0) continue;
      revealSeg(seg, seg.shown + step(backlog));
      if (seg.shown < seg.buffer.length) more = true;
    }
  }
  if (stick && log) log.scrollTop = log.scrollHeight;
  syncJump();
  if (more) schedule();
}

// Clicking a spoiler shows its text.
function spoilerClick(event) {
  const spoiler = event.target.closest && event.target.closest('.md-spoiler');
  if (spoiler && spoiler.closest('.chat-text')) spoiler.classList.toggle('revealed');
}

// The message box for a private chat. It posts to the chat's messages route. Slopbot's reply arrives on the chat stream.
// The composer of a chat. With id null it is the blank chat: the chat is made on the first send, then opened.
// A message that is not saved yet. The saved message from the stream replaces it (see upsertMessage).
let pendingSeq = 0;
function pendingBubble(text, shown = [], chatId = '') {
  const log = $('conv-log');
  const images = shown.filter(item => item.imageId), files = shown.filter(item => item.fileId);
  const node = messageNode({ id: `pending-${++pendingSeq}`, author: state.user, text, timestamp: Date.now(), ...(shown.length ? { images, files, channel: 'web:' + chatId } : {}) });
  node.dataset.pending = text;
  log.append(node);
  regroup(log);
  log.scrollTop = log.scrollHeight;
  syncJump();
  return node;
}

// The thinking card shows before the run starts. startLive gives it the real request id.
const PENDING_CARD = 'pending';
let unadopted = 0; // Sends whose run has not started yet.
function addPendingCard() {
  unadopted++;
  if (!conv.live.has(PENDING_CARD)) liveFor(PENDING_CARD);
}
// Removes the placeholder when no send waits for it. force counts one send as ended.
function dropPendingCard(force) {
  if (force) unadopted = Math.max(0, unadopted - 1);
  if (unadopted > 0) return;
  const card = conv.live.get(PENDING_CARD);
  if (!card) return;
  clearInterval(card.timer); clearTimeout(card.verbTimer); card.node.remove(); conv.live.delete(PENDING_CARD);
}

// The blank chat has its id now. The address changes without a new render and the stream starts from the first event.
function attachNewChat(chatId) {
  conv.channel = chatId; conv.kind = 'chat'; conv.blank = false;
  conv.lastStream = 0; conv.seen = 0;
  history.replaceState(null, '', itemPath('chat', chatId) + location.search);
  conv.chats = [{ id: chatId, title: '', updated: Date.now() }, ...conv.chats];
  drawList();
  if (window.SlopbotShares) { $('conv-share').hidden = false; window.SlopbotShares.renderChatShare($('conv-share'), chatId); }
  $('conv-status').hidden = false;
  openStream(chatId);
}

// The chat made for a send that failed is gone, so the view is a blank chat again.
function detachNewChat(chatId) {
  closeStream();
  conv.chats = conv.chats.filter(c => c.id !== chatId);
  conv.channel = null; conv.blank = true;
  history.replaceState(null, '', '/chat' + location.search);
  $('conv-status').hidden = true;
  $('conv-share').hidden = true; $('conv-share').replaceChildren();
  drawList();
}

function chatComposer(id) {
  // The id of a chat made for this blank composer (by the first send or the first attached image). It is kept when a send fails without a clear reason, so a retry reuses it.
  let made = null;
  const form = document.createElement('form');
  form.className = 'chat-form';
  const status = textNode('p', '', 'chat-status-line');
  status.setAttribute('aria-live', 'polite');
  const box = textNode('div', '', 'chat-input');
  const field = document.createElement('textarea');
  field.name = 'text'; field.rows = 1; field.maxLength = 8000;
  field.placeholder = 'Message Slopbot';
  field.setAttribute('aria-label', 'Message');
  const send = document.createElement('button');
  send.type = 'submit';
  send.className = 'chat-send';
  send.setAttribute('aria-label', 'Send message');
  send.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  const meter = usageMeter();
  conv.meter = meter;
  const effort = effortPicker(id, () => id || made);
  // Stop shows while a response runs. It stops the Slopbot response of this chat.
  const stop = document.createElement('button');
  stop.type = 'button';
  stop.className = 'chat-send chat-stop';
  stop.hidden = true;
  stop.setAttribute('aria-label', 'Stop response');
  stop.title = 'Stop response';
  stop.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><rect x="7" y="7" width="10" height="10" rx="1.5" fill="currentColor"/></svg>';
  stop.addEventListener('click', async () => {
    const chatId = id || made;
    if (!chatId) return;
    stop.disabled = true;
    try { await sendJson('POST', `/api/chats/${enc(chatId)}/stop`, {}); status.textContent = 'Response stopped.'; }
    catch { status.textContent = 'Could not stop the response. Try again.'; }
    finally { stop.disabled = false; }
  });
  const stopTimer = setInterval(() => {
    if (!form.isConnected) { clearInterval(stopTimer); return; }
    const running = conv.live.size > 0;
    stop.hidden = !running; send.hidden = running;
  }, 300);
  box.append(field, meter.wrap, effort, stop, send);
  const linked = conv.ask && conv.ask.chat === id ? conv.ask.text : '';
  if (linked) {
    field.value = linked;
    const banner = document.createElement('div');
    banner.className = 'chat-link-warning';
    banner.setAttribute('role', 'alert');
    banner.append(textNode('strong', 'This question came from a link. Read it before you send it.'), textNode('span', ' ' + ASK_WARNING));
    form.append(banner);
    field.addEventListener('input', () => { if (!field.value.trim()) { banner.remove(); conv.ask = null; } });
    // The user read the text and sent it, so the warning goes.
    form.addEventListener('submit', () => { if (field.value.trim()) { banner.remove(); conv.ask = null; } });
    requestAnimationFrame(() => { fitField(field); box.classList.add('has-text'); field.focus(); });
  }
  const pics = imageTray(form, box, field, status, ensureChat);
  form.append(status, pics.tray, box, textNode('p', 'Slopbot is AI and can make mistakes.', 'chat-foot'));
  const sync = () => { box.classList.toggle('has-text', field.value.trim() !== ''); fitField(field); };
  let sending = false;
  // The id of a chat made for this blank composer. It is kept when a send fails without a clear reason, so a retry reuses it.
  field.addEventListener('input', () => { sync(); status.textContent = ''; });
  field.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    const text = field.value.trim();
    if ((!text && !pics.ids().length) || sending) return;
    if (pics.uploading()) { status.textContent = 'Wait for the files to finish uploading.'; return; }
    const shown = pics.take();
    field.value = ''; sync(); status.textContent = '';
    deliver(text, shown);
  });
  // Makes the chat of a blank composer once, from the first attached image or the first send.
  let making = null;
  function ensureChat() {
    if (id || made) return Promise.resolve(id || made);
    if (!making) making = sendJson('POST', '/api/chats', { server: state.server.id }).then(chat => { made = chat.id; if (conv.blank) attachNewChat(chat.id); return chat.id; }).finally(() => { making = null; });
    return making;
  }
  // Shows the message and the thinking card at once, then saves and sends in the background.
  async function deliver(text, shown, again) {
    sending = true;
    // The first message moves the composer to the bottom.
    leaveEmpty(form.closest('.chat-hero'));
    const pending = again || pendingBubble(text, shown, id || made || '');
    pending.classList.remove('failed'); pending.classList.add('pending');
    pending.querySelector('.chat-retry')?.remove();
    addPendingCard();
    let chatId = id || made, fresh = false;
    try {
      if (!chatId) {
        chatId = await ensureChat(); fresh = true;
      }
      if (!id && effort.chosen) await sendJson('PATCH', `/api/chats/${enc(chatId)}`, { effort: effort.chosen }).catch(() => {});
      const response = await fetch(`/api/chats/${enc(chatId)}/messages`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ text, images: shown.filter(item => item.imageId).map(item => item.imageId), files: shown.filter(item => item.fileId).map(item => item.fileId) }) });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) { dropPendingCard(true); showScreen('login'); return; }
      if (!response.ok) {
        // A 4xx answer means nothing was saved, so a chat made just for this send is removed. A 5xx may have saved the message, so that chat is kept for a retry.
        if (!id && response.status < 500) { made = null; discardChat(chatId); if (conv.channel === chatId) detachNewChat(chatId); }
        failPending(pending, text, shown, response.status === 429 ? `Limit reached, resets ${new Date(data.resetAt).toLocaleString()}.` : (data.error || 'Message failed.'));
        return;
      }
      // The chat has a saved message now, so it is this composer's chat. Later sends use it and do not make a new chat.
      if (!id) { id = chatId; made = null; }
      // The stream may have shown the saved message already. Otherwise the pending bubble takes the saved id.
      if (pending.isConnected) { pending.classList.remove('pending'); pending.dataset.id = data.id; delete pending.dataset.pending; }
      if (conv.ask && conv.ask.chat === chatId) conv.ask = null;
      refreshChats();
    } catch (error) {
      if (error.status === 401) { dropPendingCard(true); return showScreen('login'); }
      if (!id && !made && conv.channel === chatId) detachNewChat(chatId);
      failPending(pending, text, shown, error.message);
    }
    finally { sending = false; }
  }
  // The failed bubble keeps a Retry button. The text is back in the field when it is empty.
  function failPending(pending, text, shown, message) {
    dropPendingCard(true);
    pending.classList.remove('pending'); pending.classList.add('failed');
    const retry = textNode('button', 'Retry', 'chat-retry');
    retry.type = 'button';
    retry.onclick = () => { if (!sending) { if (field.value.trim() === text) { field.value = ''; sync(); } deliver(text, shown, pending); } };
    pending.append(retry);
    status.textContent = message;
    if (!field.value) { field.value = text; sync(); field.focus(); }
  }
  return form;
}

// Grows the textarea to its content. CSS caps it at 8 lines.
function fitField(field) {
  field.style.height = 'auto';
  field.style.height = `${field.scrollHeight}px`;
}

// The usage meter in the composer. A ring fills to the larger window percent. The popover shows percents and reset times only.
function usageMeter() {
  const wrap = document.createElement('div');
  wrap.className = 'chat-usage';
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chat-usage-button';
  button.title = 'Usage';
  button.setAttribute('aria-label', 'Usage');
  button.setAttribute('aria-haspopup', 'dialog');
  button.setAttribute('aria-expanded', 'false');
  button.innerHTML = '<svg viewBox="0 0 18 18" width="18" height="18" aria-hidden="true" focusable="false"><circle cx="9" cy="9" r="7" fill="none" stroke="currentColor" stroke-opacity=".25" stroke-width="2.5"/><circle class="chat-usage-arc" cx="9" cy="9" r="7" fill="none" stroke="currentColor" stroke-width="2.5" pathLength="100" stroke-dasharray="0 100" transform="rotate(-90 9 9)"/></svg>';
  const pop = document.createElement('div');
  pop.className = 'chat-usage-pop';
  pop.setAttribute('role', 'dialog');
  pop.setAttribute('aria-label', 'Usage');
  pop.hidden = true;
  pop.append(textNode('p', 'Loading…', 'chat-usage-note'));
  const meter = { wrap, button, arc: button.querySelector('.chat-usage-arc'), pop };
  button.onclick = () => toggleUsage(meter);
  wrap.append(button, pop);
  return meter;
}

function toggleUsage(meter) {
  const open = meter.pop.hidden;
  meter.pop.hidden = !open;
  meter.button.setAttribute('aria-expanded', String(open));
}

function closeUsage() {
  const meter = conv.meter;
  if (!meter || meter.pop.hidden) return;
  meter.pop.hidden = true;
  meter.button.setAttribute('aria-expanded', 'false');
}

// Outside click closes the popover. Escape closes it and gives focus back to the button.
document.addEventListener('click', event => { if (conv.meter && !conv.meter.wrap.contains(event.target)) closeUsage(); });
document.addEventListener('keydown', event => {
  if (event.key !== 'Escape' || !conv.meter || conv.meter.pop.hidden) return;
  closeUsage();
  conv.meter.button.focus();
});

// Reset time with two units: "Resets in 3d 4h" over a day, else "Resets in 2h 15m".
function resetsLabel(ts) {
  const minutes = Math.max(1, Math.ceil((ts - Date.now()) / 60000));
  const days = Math.floor(minutes / 1440), hours = Math.floor(minutes % 1440 / 60), rest = minutes % 60;
  return `Resets in ${days ? `${days}d ${hours}h` : hours ? `${hours}h ${rest}m` : `${rest}m`}`;
}

// The usage color: blue below 50%, orange from 50%, red from 80%.
function usageLevel(percent) { return percent >= 80 ? 'high' : percent >= 50 ? 'mid' : 'low'; }

// Fills the ring to the larger window percent, and writes the popover rows. A window without a limit shows "No limit".
function paintUsage(meter, data) {
  const windows = data.windows || [];
  const most = Math.max(0, ...windows.map(item => item.percent ?? 0));
  meter.arc.setAttribute('stroke-dasharray', `${most} 100`);
  meter.button.dataset.level = usageLevel(most);
  const rows = [textNode('p', `Plan: ${data.plan} (free)`, 'chat-usage-plan')];
  for (const item of windows) {
    const title = item.kind === '5h' ? '5-hour limit' : 'Weekly limit';
    const row = document.createElement('div');
    row.className = 'chat-usage-row';
    row.append(textNode('p', item.percent === null ? `${title}: No limit` : `${title}: ${item.percent}% used`, 'chat-usage-line'));
    if (item.percent !== null) {
      const track = textNode('div', '', 'chat-usage-track');
      const fill = textNode('div', '', 'chat-usage-fill');
      fill.style.width = `${item.percent}%`;
      fill.dataset.level = usageLevel(item.percent);
      track.append(fill);
      row.append(track);
    }
    if (item.resetAt) row.append(textNode('p', resetsLabel(item.resetAt), 'chat-usage-note'));
    if (item.banked > 0) row.append(resetButton(meter, item));
    rows.push(row);
  }
  meter.pop.replaceChildren(...rows);
}

// Uses one banked reset on a window. The button shows how many are banked.
function resetButton(meter, item) {
  const label = item.kind === '5h' ? '5-hour' : 'full';
  const button = textNode('button', `Use a ${label} reset (${item.banked} left)`, 'chat-usage-reset');
  button.type = 'button';
  button.onclick = async event => {
    event.stopPropagation();
    if (!await askConfirm({ title: `Use a ${label} reset?`, body: item.kind === '5h' ? 'Your 5-hour usage goes back to 0%.' : 'Your 5-hour and weekly usage go back to 0%.', confirmLabel: 'Use reset' })) return;
    button.disabled = true;
    try {
      const data = await request('/api/usage/reset', { server: state.server.id, kind: item.kind });
      if (conv.meter === meter) paintUsage(meter, data);
      notice(`Your ${label} usage is reset.`);
    } catch (error) { button.disabled = false; fail(error); }
  };
  return button;
}

// Loads the meter for the open server. It runs when a conversation opens and after each run ends.
async function refreshUsage() {
  const meter = conv.meter;
  if (!meter || !meter.wrap.isConnected) return;
  try {
    const data = await request(`/api/usage?server=${enc(state.server.id)}`);
    if (conv.meter === meter) paintUsage(meter, data);
  } catch (error) {
    if (conv.meter !== meter) return;
    if (error.status === 401) return fail(error);
    meter.pop.replaceChildren(textNode('p', 'Usage is not available right now.', 'chat-usage-note'));
  }
}

function textNode(tag, text, className = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

// Reasoning effort of one chat. A small menu button next to Send. The choice is saved on the chat.
const EFFORT_LEVELS = [['low', 'Low'], ['medium', 'Medium'], ['xhigh', 'Extra high']];
function effortPicker(id, current_id = () => id) {
  const chat = () => conv.chats.find(c => c.id === id);
  const wrap = textNode('div', '', 'effort-pick');
  wrap.chosen = null;
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'effort-button';
  button.setAttribute('aria-haspopup', 'menu'); button.setAttribute('aria-expanded', 'false');
  const menu = document.createElement('div');
  menu.className = 'effort-menu'; menu.setAttribute('role', 'menu'); menu.setAttribute('aria-label', 'Reasoning effort'); menu.hidden = true;
  let current = (chat() && chat().effort) || 'medium';
  const label = value => EFFORT_LEVELS.find(item => item[0] === value)[1];
  const items = EFFORT_LEVELS.map(([value, name]) => {
    const item = textNode('button', name, 'effort-item');
    item.type = 'button'; item.setAttribute('role', 'menuitemradio');
    item.onclick = async () => {
      close(true);
      const before = current;
      current = value; paint(); wrap.chosen = value;
      // A blank chat has no id yet. The send saves the choice after it makes the chat.
      const target = current_id();
      if (!target) return;
      try {
        await sendJson('PATCH', `/api/chats/${enc(target)}`, { effort: value });
        if (conv.chats.find(c => c.id === target)) conv.chats.find(c => c.id === target).effort = value;
      } catch (error) { current = before; paint(); fail(error); }
    };
    return item;
  });
  menu.append(...items);
  function paint() {
    button.textContent = label(current);
    button.setAttribute('aria-label', `Reasoning effort: ${label(current)}`);
    items.forEach((item, index) => item.setAttribute('aria-checked', String(EFFORT_LEVELS[index][0] === current)));
  }
  function close(focus) { menu.hidden = true; button.setAttribute('aria-expanded', 'false'); document.removeEventListener('click', outside, true); if (focus) button.focus(); }
  function outside(event) { if (!wrap.contains(event.target)) close(false); }
  function open() {
    menu.hidden = false; button.setAttribute('aria-expanded', 'true');
    document.addEventListener('click', outside, true);
    (items.find(item => item.getAttribute('aria-checked') === 'true') || items[0]).focus();
  }
  button.onclick = () => menu.hidden ? open() : close(true);
  wrap.addEventListener('keydown', event => {
    if (event.key === 'Escape' && !menu.hidden) { event.preventDefault(); event.stopPropagation(); close(true); return; }
    if (menu.hidden || !['ArrowDown', 'ArrowUp'].includes(event.key)) return;
    event.preventDefault();
    const at = items.indexOf(document.activeElement), step = event.key === 'ArrowDown' ? 1 : -1;
    items[(at + step + items.length) % items.length].focus();
  });
  paint();
  wrap.append(button, menu);
  return wrap;
}

// Chat images and files. The server stores them privately. Images go to the image route and the model reads them. Other files go to the file route.
const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'];
const IMAGE_MAX_BYTES = 25 * 1024 * 1024;
const FILE_MAX_BYTES = 10 * 1024 * 1024;
const ATTACHMENT_MAX_COUNT = 10;
const imageUrl = (chat, imageId) => `/api/chats/${enc(chat)}/images/${enc(imageId)}`;
const fileUrl = (chat, fileId) => `/api/chats/${enc(chat)}/files/${enc(fileId)}`;
const attachmentUrl = (kind, chat, id) => kind === 'file' ? fileUrl(chat, id) : imageUrl(chat, id);
const sizeLabel = bytes => bytes >= 1048576 ? `${(bytes / 1048576).toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;

// Thumbnails of a sent message. After a reload they come from the stored image.
function imageStrip(m) {
  const strip = textNode('div', '', 'chat-images');
  const chat = String(m.channel || '').replace(/^web:/, '');
  for (const image of [...(m.images || []).map(image => ({ ...image, src: imageUrl(chat, image.imageId) })), ...(m.remoteImages || [])]) {
    const img = document.createElement('img');
    img.src = image.src; img.alt = image.name; img.loading = 'lazy'; img.referrerPolicy = 'no-referrer';
    img.title = `${image.name} (${sizeLabel(image.size)})`;
    const link = textNode('a', '', 'chat-image-link');
    link.href = image.src; link.target = '_blank'; link.rel = 'noopener noreferrer';
    img.addEventListener('error', () => img.replaceWith(textNode('span', `${image.name} (${sizeLabel(image.size)})`, 'chat-image-chip')));
    link.append(img); strip.append(link);
  }
  return strip;
}

// Chips of the files of a sent message. A chip with a fileId downloads the file. A chip without one (a share) is text only.
function fileChips(m) {
  const strip = textNode('div', '', 'chat-files');
  const chat = String(m.channel || '').replace(/^web:/, '');
  for (const file of m.files) {
    const label = `${file.name} (${sizeLabel(file.size)})`;
    if (!file.fileId || !chat) { strip.append(textNode('span', label, 'chat-file-chip')); continue; }
    const link = textNode('a', label, 'chat-file-chip');
    link.href = fileUrl(chat, file.fileId); link.download = file.name;
    strip.append(link);
  }
  return strip;
}

// Paste, drop and attach for the composer. Each file uploads at once; the message sends only the IDs.
function imageTray(form, box, field, status, ensure) {
  const tray = textNode('div', '', 'chat-tray');
  tray.hidden = true;
  const items = [];
  const input = document.createElement('input');
  input.type = 'file'; input.multiple = true; input.hidden = true;
  const attach = document.createElement('button');
  attach.type = 'button'; attach.className = 'chat-attach'; attach.textContent = '+';
  attach.setAttribute('aria-label', 'Attach files'); attach.title = 'Attach files';
  box.querySelector('textarea').after(attach);
  form.append(input);
  const show = () => { tray.hidden = items.length === 0; };
  const discard = item => fetch(attachmentUrl(item.kind, item.chat, item.id), { method: 'DELETE', headers: { 'X-CSRF-Token': csrf } }).catch(() => {});
  const remove = item => {
    items.splice(items.indexOf(item), 1); item.node.remove(); show();
    if (item.id) discard(item);
  };
  const add = async file => {
    const isImage = IMAGE_TYPES.includes(file.type);
    const kind = isImage ? 'image' : 'file';
    if (isImage && file.size > IMAGE_MAX_BYTES) { status.textContent = `${file.name || 'This image'} is larger than 25 MB.`; return; }
    if (!isImage && file.size > FILE_MAX_BYTES) { status.textContent = `${file.name || 'This file'} is larger than 10 MB.`; return; }
    if (items.length >= ATTACHMENT_MAX_COUNT) { status.textContent = `Attach ${ATTACHMENT_MAX_COUNT} files or images or fewer.`; return; }
    const item = { id: null, kind, chat: null, node: textNode('div', '', 'chat-thumb') };
    const label = textNode('span', `${file.name || kind} (uploading…)`, isImage ? 'chat-image-chip' : 'chat-file-chip');
    const close = document.createElement('button');
    close.type = 'button'; close.textContent = '\u00d7'; close.setAttribute('aria-label', `Remove ${file.name || kind}`);
    close.addEventListener('click', () => remove(item));
    item.node.append(label, close); items.push(item); tray.append(item.node); show();
    item.upload = (async () => {
      try {
        item.chat = await ensure();
        const chat = item.chat;
        const response = await fetch(`/api/chats/${enc(chat)}/${isImage ? 'images' : 'files'}?name=${enc(file.name || '')}`, { method: 'POST', headers: { 'Content-Type': file.type || 'application/octet-stream', 'X-CSRF-Token': csrf }, body: file });
        const data = await response.json().catch(() => ({}));
        if (!response.ok) throw new Error(response.status === 429 ? 'Limit reached.' : data.error || 'Upload failed.');
        item.id = isImage ? data.imageId : data.fileId; item.name = data.name; item.size = data.size;
        if (!items.includes(item)) { discard(item); return; }
        if (!isImage) { label.textContent = `${data.name} (${sizeLabel(data.size)})`; return; }
        const img = document.createElement('img');
        img.src = imageUrl(chat, item.id); img.alt = data.name; img.title = `${data.name} (${sizeLabel(data.size)})`;
        label.replaceWith(img);
      } catch (error) {
        status.textContent = error.message;
        if (items.includes(item)) { items.splice(items.indexOf(item), 1); item.node.remove(); show(); }
      } finally { item.done = true; }
    })();
  };
  const addAll = files => { for (const file of files) void add(file); };
  attach.addEventListener('click', () => input.click());
  input.addEventListener('change', () => { addAll([...input.files]); input.value = ''; });
  field.addEventListener('paste', event => {
    const files = [...(event.clipboardData ? event.clipboardData.files : [])];
    if (files.length) { event.preventDefault(); addAll(files); }
  });
  const hasFiles = event => event.dataTransfer && [...event.dataTransfer.types].includes('Files');
  const over = event => { if (!form.isConnected) return document.removeEventListener('dragover', over); if (hasFiles(event)) { event.preventDefault(); form.classList.add('dragging'); } };
  const drop = event => {
    if (!form.isConnected) return document.removeEventListener('drop', drop);
    form.classList.remove('dragging');
    if (!hasFiles(event)) return;
    event.preventDefault(); addAll([...event.dataTransfer.files]);
  };
  document.addEventListener('dragover', over); document.addEventListener('drop', drop);
  document.addEventListener('dragleave', event => { if (!event.relatedTarget) form.classList.remove('dragging'); });
  return {
    tray,
    ids: () => items.filter(item => item.id).map(item => item.id),
    uploading: () => items.some(item => !item.done),
    // The images and files of a send. The tray empties at once; the server keeps the uploads for the send.
    take: () => { const taken = items.filter(item => item.id).map(item => item.kind === 'file' ? { fileId: item.id, name: item.name, size: item.size } : { imageId: item.id, name: item.name, size: item.size }); items.splice(0); tray.replaceChildren(); show(); return taken; },
  };
}
