// Conversations tab: a chat view of channel and thread transcripts, Slopbot runs, the live stream and the reply box.
// Uses globals from app.js: $, request, busy, fail, notice, state, csrf, showScreen.
const conv = { server: '', list: [], channel: null, source: null, lastStream: 0, seen: 0, live: new Map(), frame: 0 };
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

// The chat view has no page title. The breadcrumb, title and description are hidden while it shows.
function setChatMode(on) {
  for (const id of ['breadcrumb', 'title', 'description']) $(id).hidden = on;
  document.querySelector('main').classList.toggle('chat-mode', on);
  $('console').classList.toggle('chat-only', on);
  markTopTabs();
}

// The top bar tab for the current view is highlighted. Chat is the Conversations tab.
function markTopTabs() {
  const view = tab === 'conversations' ? 'chat' : 'settings';
  for (const button of document.querySelectorAll('[data-view]')) {
    const on = button.dataset.view === view;
    button.classList.toggle('selected', on);
    button.setAttribute('aria-current', on ? 'page' : 'false');
  }
}

// A compact server picker at the top of the list. It uses the same change handler as the Settings picker.
function renderChatServers() {
  const slot = $('chat-server');
  if (!slot) return;
  const servers = state.servers || [];
  slot.hidden = !servers.length;
  const select = document.createElement('select');
  select.setAttribute('aria-label', 'Discord server');
  for (const s of servers) select.append(new Option(s.name, s.id, false, s.id === state.server?.id));
  select.onchange = () => { $('server').value = select.value; $('server').dispatchEvent(new Event('change')); };
  slot.replaceChildren(select);
}

function renderConversations() {
  if (conv.server !== state.server.id) { closeConversation(); conv.server = state.server.id; conv.channel = null; conv.list = []; }
  setChatMode(true);
  $('content').innerHTML = '<div id="chat-root" class="chat"><aside id="chat-side" class="chat-side"><div id="chat-server" class="chat-server" hidden></div><input id="conv-search" class="chat-search" type="search" placeholder="Search messages" aria-label="Search messages"><div id="conv-list" class="chat-list"></div></aside><section id="conv-main" class="chat-pane"><header class="chat-head"><button id="chat-drawer" class="chat-drawer" type="button" aria-expanded="false" aria-controls="chat-side">Conversations</button><h2 id="chat-title" class="chat-title"></h2><div class="chat-tools"><span id="conv-status" class="chat-status"></span><div id="conv-share" class="chat-share" hidden></div></div></header><div id="conv-view" class="chat-view"></div><div id="conv-reply" class="chat-composer" hidden></div></section></div>';
  $('conv-search').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); searchConversations($('conv-search').value); } };
  $('chat-drawer').onclick = toggleDrawer;
  renderChatServers();
  drawList();
  if (conv.channel === null && conv.list.length) showPick(); else showView(busy('md', 'Loading…'));
  loadConversations().catch(fail);
}

function toggleDrawer() {
  const open = $('chat-root').classList.toggle('drawer-open');
  $('chat-drawer').setAttribute('aria-expanded', String(open));
}

async function loadConversations() {
  const id = state.server.id;
  const result = await request(`/api/conversations?server=${enc(id)}`);
  if (conv.server !== id || !$('conv-list')) return;
  conv.list = result.conversations;
  drawList();
  if (conv.channel && conv.list.some(c => c.id === conv.channel)) return openConversation(conv.channel);
  if (conv.list.length) return openConversation(conv.list[0].id);
  // With no conversation to view, the default view falls back to Settings.
  if (viewAuto) return fallbackToSettings();
  showView(emptyNote('No conversations yet.', 'Turn on web transcripts for a channel in Server settings → Web transcripts.'));
}

// The list has two groups. Channels come first, then threads.
function drawList() {
  const list = $('conv-list');
  if (!list) return;
  list.replaceChildren();
  if (!conv.list.length) { list.append(textNode('p', 'Nothing to show yet.', 'small chat-none')); return; }
  for (const [title, kind] of [['Channels', 'channel'], ['Threads', 'thread']]) {
    const items = conv.list.filter(c => (c.kind === 'thread' ? 'thread' : 'channel') === kind);
    if (!items.length) continue;
    const group = document.createElement('section');
    group.className = 'chat-group';
    group.append(textNode('h3', title, 'chat-group-title'));
    for (const c of items) group.append(convItem(c));
    list.append(group);
  }
}

function convItem(c) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chat-item';
  button.dataset.id = c.id;
  button.setAttribute('aria-current', c.id === conv.channel ? 'true' : 'false');
  button.append(textNode('span', c.kind === 'thread' ? c.name : '#' + c.name, 'chat-item-name'), textNode('span', relTime(c.newest), 'chat-item-time'));
  button.onclick = () => openConversation(c.id);
  return button;
}

function showView(node) {
  const view = $('conv-view');
  if (view) view.replaceChildren(node);
}

function showPick() { showView(emptyNote('Pick a conversation', 'Choose a channel or thread on the left.')); }

function emptyNote(title, hint) {
  const box = document.createElement('div');
  box.className = 'chat-empty';
  box.append(textNode('h2', title, 'chat-empty-title'), textNode('p', hint, 'chat-empty-hint'));
  return box;
}

function setHeading(text) { $('chat-title').textContent = text; }

function setComposer(node) {
  const slot = $('conv-reply');
  if (!slot) return;
  slot.hidden = !node;
  slot.replaceChildren(...(node ? [node] : []));
}

async function openConversation(id) {
  closeStream();
  conv.channel = id; dropLive();
  drawList();
  $('chat-root')?.classList.remove('drawer-open');
  $('chat-drawer')?.setAttribute('aria-expanded', 'false');
  $('conv-status').hidden = false;
  setStatus('Connecting…');
  setHeading('');
  $('conv-share').hidden = true;
  $('conv-share').replaceChildren();
  setComposer(null);
  showView(busy('md', 'Loading…'));
  try {
    const page = await request(`/api/conversations/${enc(id)}/messages?server=${enc(state.server.id)}&limit=50`);
    if (conv.channel !== id) return;
    const info = conv.list.find(c => c.id === id) || { kind: 'channel', name: page.channel.name };
    const name = info.name || page.channel.name;
    setHeading(label({ ...info, name }));
    if (page.canShare && window.SlopbotShares) { $('conv-share').hidden = false; window.SlopbotShares.renderShareButton($('conv-share'), state.server.id, id); }
    showView(transcriptView(id, page));
    // The server says who may send. Sent replies arrive through the live stream, so the box adds nothing to the log.
    if (page.canSend) setComposer(chatComposer(state.server.id, id, info.kind === 'thread' ? `Message ${name}` : `Message #${name}`));
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

function transcriptView(id, page) {
  const wrap = document.createElement('div');
  wrap.className = 'chat-transcript';
  const older = textNode('button', 'Load older messages', 'chat-older');
  older.type = 'button'; older.id = 'conv-older'; older.hidden = !page.hasMore;
  older.onclick = () => loadOlder(id);
  const log = document.createElement('div');
  log.id = 'conv-log'; log.className = 'chat-log';
  log.setAttribute('role', 'log'); log.setAttribute('aria-live', 'polite'); log.setAttribute('aria-relevant', 'additions');
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
    const page = await request(`/api/conversations/${enc(id)}/messages?server=${enc(state.server.id)}&limit=50&before=${enc(first.dataset.id)}`);
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
  article.dataset.author = m.author || m.authorName || '';
  if (m.timestamp) article.dataset.time = String(m.timestamp);
  if (kind === 'mine') {
    const bubble = textNode('div', '', 'chat-text');
    if (m.timestamp) bubble.title = timeLabel(m.timestamp);
    renderText(bubble, m.text);
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
  return article;
}

function avatarNode(m) {
  const name = String(m.authorName || m.author || '').trim();
  const pill = () => textNode('span', Array.from(name)[0]?.toUpperCase() || '?', 'chat-avatar chat-avatar-pill');
  if (typeof m.avatarUrl !== 'string' || !m.avatarUrl) return pill();
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
      if (typeof out === 'string') { node.innerHTML = out; return; }
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
      view.box.replaceChildren(...runs.flatMap((run, index) => storedRunRows(run, runIds.length > 1 ? index + 1 : 0)));
      view.text.textContent = summarize(runs.flatMap(run => run.steps)) || 'Run details';
    } catch (error) {
      view.wrap.dataset.loaded = '';
      view.box.replaceChildren(textNode('p', error.message, 'chat-run-error'));
      fail(error);
    }
  }).wrap;
}

function storedRunRows(run, number) {
  const rows = [];
  if (number) rows.push(textNode('p', `Round ${number}`, 'chat-round'));
  for (const step of run.steps) {
    if (step.type === 'text') rows.push(textNode('div', step.text, 'chat-run-prose'));
    else if (step.type === 'thinking') rows.push(thinkRow(step.text));
    else rows.push(toolRow(step.name, step.status, step.args, step.result, 'Result', false));
  }
  if (run.error) rows.push(textNode('p', run.error, 'chat-run-error'));
  if (!run.steps.length) rows.push(textNode('p', 'No stored events for this run.', 'small chat-none'));
  return rows;
}

// Thinking is clamped to 3 lines. A click shows all of it.
function thinkRow(text) {
  const button = document.createElement('button');
  button.type = 'button';
  button.className = 'chat-think';
  button.append(textNode('span', 'Thinking', 'chat-think-label'), textNode('span', text, 'chat-think-text'));
  button.onclick = () => button.classList.toggle('open');
  return button;
}

// Tool names are shown as plain words. Known kinds get a short phrase.
// doing is the status verb shown while the tool runs.
const TOOL_KINDS = [
  { match: /search/i, key: 'search', label: 'Searched the web', one: 'searched the web', many: n => `searched the web ${n} times`, doing: 'Searching the web…' },
  { match: /fetch|browse|page|url|open/i, key: 'page', label: 'Read a web page', one: 'read a web page', many: n => `read ${n} web pages`, doing: 'Reading web pages…' },
  { match: /read|file|load/i, key: 'file', label: 'Read a file', one: 'read a file', many: n => `read ${n} files`, doing: 'Reading files…' },
  { match: /code|exec|python|shell|bash|sandbox|eval|script/i, key: 'code', label: 'Ran code', one: 'ran code', many: n => `ran code ${n} times`, doing: 'Running code…' },
];

// Garden words for the live status line, from the brand line "Where ideas bloom".
const GARDEN_WORDS = ['Blooming', 'Sprouting', 'Unfurling', 'Budding', 'Germinating', 'Photosynthesizing', 'Pollinating', 'Rooting', 'Blossoming', 'Cultivating', 'Pruning', 'Composting', 'Seeding', 'Flowering', 'Ripening'];

function toolKind(name) {
  const text = String(name || 'tool');
  const found = TOOL_KINDS.find(kind => kind.match.test(text));
  if (found) return found;
  const words = text.replace(/[_-]+/g, ' ').trim() || 'tool';
  return { key: `tool:${text}`, label: words, one: `used ${words}`, many: n => `used ${words} ${n} times`, doing: `Using ${words}…` };
}

// Builds one line such as "Thought, searched the web, read 2 files".
function summarize(steps) {
  const parts = [];
  if (steps.some(step => step.type === 'thinking')) parts.push('Thought');
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

// One tool row: status, a phrase, short arguments and a chevron. A click shows the details.
function toolRow(name, status, args, extra, extraLabel, open) {
  const kind = toolKind(name);
  const row = textNode('div', '', 'chat-tool');
  const line = document.createElement('button');
  line.type = 'button';
  line.className = 'chat-tool-line';
  const mark = textNode('span', statusMark(status), 'chat-tool-status');
  mark.title = status || '';
  line.append(mark, textNode('span', kind.label, 'chat-tool-name'), textNode('span', String(args || '').slice(0, 160), 'chat-tool-args'), textNode('span', '›', 'chat-chev'));
  const detail = textNode('pre', detailText(args, extra, extraLabel || 'Result'), 'chat-tool-detail');
  const setOpen = on => { detail.hidden = !on; row.dataset.open = String(on); line.setAttribute('aria-expanded', String(on)); };
  line.onclick = () => setOpen(detail.hidden);
  setOpen(Boolean(open));
  row.append(line, detail);
  return row;
}

function messageRow(id) { return document.querySelector(`[data-id="${id}"]`); }

function openStream(id) {
  const es = new EventSource(`/api/conversations/${enc(id)}/stream?server=${enc(state.server.id)}&after=${conv.lastStream}`);
  conv.source = es;
  // Stream IDs only go up. Skipping IDs already shown keeps a replayed event from showing twice.
  const on = (type, handler) => es.addEventListener(type, event => {
    const id = Number(event.lastEventId);
    if (id) { if (id <= conv.seen) return; conv.seen = id; }
    try { handler(JSON.parse(event.data)); } catch { }
  });
  on('message', data => data.action === 'delete' ? removeMessage(data.id) : upsertMessage(data.message));
  on('run.start', data => startLive(data.ref, data.requestId));
  on('run.delta', data => delta(data.ref, data.part, data.text));
  on('run.tool', data => tool(data));
  on('run.end', data => endLive(data.ref));
  // The server pruned events after this stream's position. Reload the messages from the newest page.
  es.addEventListener('reset', () => {
    if (conv.source !== es) return;
    closeStream();
    openConversation(id).catch(fail);
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
  dropLive();
  conv.channel = null;
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
  if (!log || m.channel !== conv.channel) return;
  const stick = nearBottom(log);
  const node = messageNode(m), old = log.querySelector(`[data-id="${m.id}"]`);
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
  if (card) return card;
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
  const think = thinkRow('');
  think.hidden = true;
  view.box.append(think);
  node.append(head, view.wrap, text);
  log.append(node);
  card = {
    requestId, node, view, meta, mark, text, think, thinkBody: think.querySelector('.chat-think-text'),
    runs: new Set(), active: new Set(), buffers: { text: '', thinking: '' }, shown: { text: 0, thinking: 0 },
    toolState: new Map(), rows: new Map(), started: Date.now(), ticks: 0, timer: 0,
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
  card.meta.textContent = `(${elapsedSeconds(card)}s · ↓ ${formatTokens(outputTokens(card))} tokens)`;
  setLiveSummary(card);
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
  if (part === 'thinking') card.think.hidden = false;
  card.buffers[part] += text;
  if (reduceMotion()) reveal(card, part, card.buffers[part].length);
  setLiveSummary(card);
  schedule();
}

function tool(data) {
  const card = liveFor(data.requestId);
  if (!card) return;
  const old = card.rows.get(data.id);
  const row = toolRow(data.name, data.status, data.args, data.reason, 'Reason', old ? old.dataset.open === 'true' : false);
  if (old) old.replaceWith(row); else card.view.box.append(row);
  card.rows.set(data.id, row);
  card.toolState.set(data.id, { name: data.name, status: data.status || '' });
  setLiveSummary(card);
}

function liveSteps(card) {
  return [...(card.buffers.thinking ? [{ type: 'thinking' }] : []), ...[...card.toolState.values()].map(item => ({ type: 'tool', name: item.name }))];
}

// The verb is the running tool's activity. Without a tool it is a garden word, or "Working…" with reduced motion.
function liveVerb(card) {
  const pending = [...card.toolState.values()].filter(item => !DONE_STATUS.test(item.status) && !FAILED_STATUS.test(item.status)).pop();
  if (pending) return toolKind(pending.name).doing;
  if (reduceMotion()) return 'Working…';
  return `${GARDEN_WORDS[card.word % GARDEN_WORDS.length]}…`;
}

function setLiveSummary(card) { card.view.text.textContent = liveVerb(card); }

// When every run of the card has ended, the status line becomes the run summary with the time.
function endLive(runId) {
  const card = findRunCard(runId);
  if (!card) return;
  card.active.delete(runId);
  if (card.active.size) return;
  clearInterval(card.timer);
  card.timer = 0;
  card.node.classList.add('done');
  card.mark.classList.add('still');
  card.view.text.classList.remove('chat-verb');
  card.view.text.textContent = summarize(liveSteps(card)) || 'Run details';
  card.meta.textContent = `· ${elapsedSeconds(card)}s`;
}

function finishLiveRun(runId) {
  for (const [key, card] of conv.live) {
    if (card.runs.has(runId)) { clearInterval(card.timer); card.node.remove(); conv.live.delete(key); }
  }
}

function dropLive() {
  for (const card of conv.live.values()) clearInterval(card.timer);
  conv.live.clear();
}

function reveal(card, part, to) {
  card.shown[part] = to;
  const node = part === 'text' ? card.text : card.thinkBody;
  node.textContent = card.buffers[part].slice(0, to);
}

function schedule() { if (!conv.frame) conv.frame = requestAnimationFrame(tick); }

// Reveal buffered text a little each frame. The step grows with the backlog, so the view never falls far behind.
// The view follows the newest text only when it is already near the bottom.
function tick() {
  conv.frame = 0;
  const log = $('conv-log');
  const stick = log ? nearBottom(log) : false;
  let more = false;
  for (const card of conv.live.values()) {
    for (const part of ['text', 'thinking']) {
      const backlog = card.buffers[part].length - card.shown[part];
      if (backlog <= 0) continue;
      reveal(card, part, card.shown[part] + Math.min(backlog, Math.max(1, Math.ceil(backlog / 12))));
      if (card.shown[part] < card.buffers[part].length) more = true;
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

// The reply box. It posts to the same route as renderReplyBox in app.js.
function chatComposer(server, channel, placeholder) {
  const form = document.createElement('form');
  form.className = 'chat-form';
  const status = textNode('p', '', 'chat-status-line');
  status.setAttribute('aria-live', 'polite');
  const note = textNode('p', 'Posted by Slopbot for you (it lacks Manage Webhooks)', 'chat-status-line');
  note.hidden = true;
  const box = textNode('div', '', 'chat-input');
  const field = document.createElement('textarea');
  field.name = 'text'; field.rows = 1; field.maxLength = 2000;
  field.placeholder = placeholder;
  field.setAttribute('aria-label', 'Message');
  const send = document.createElement('button');
  send.type = 'submit';
  send.className = 'chat-send';
  send.setAttribute('aria-label', 'Send message');
  send.innerHTML = '<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true" focusable="false"><path d="M12 19V5M5.5 11.5 12 5l6.5 6.5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>';
  box.append(field, send);
  form.append(status, note, box, textNode('p', 'Slopbot is AI and can make mistakes.', 'chat-foot'));
  const sync = () => { box.classList.toggle('has-text', field.value.trim() !== ''); fitField(field); };
  let sending = false;
  field.addEventListener('input', sync);
  field.addEventListener('keydown', event => {
    if (event.key === 'Enter' && !event.shiftKey && !event.isComposing) { event.preventDefault(); form.requestSubmit(); }
  });
  form.addEventListener('submit', async event => {
    event.preventDefault();
    const text = field.value.trim();
    if (!text || sending) return;
    sending = true; send.disabled = true; status.textContent = 'Sending…'; note.hidden = true;
    try {
      const response = await fetch(`/api/conversations/${enc(channel)}/reply`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrf }, body: JSON.stringify({ server, text }) });
      const data = await response.json().catch(() => ({}));
      if (response.status === 401) { status.textContent = ''; showScreen('login'); return; }
      if (response.status === 429) { status.textContent = `Limit reached, resets ${new Date(data.resetAt).toLocaleString()}.`; return; }
      if (!response.ok) throw new Error(data.error || 'Reply failed.');
      field.value = '';
      sync();
      status.textContent = data.status === 'posted' ? 'Sent. Slopbot will answer in the channel.' : 'Sent to Discord, but Slopbot did not pick it up in time, so it will not answer.';
      note.hidden = data.via !== 'bot';
    } catch (error) { status.textContent = error.message; }
    finally { sending = false; send.disabled = false; }
  });
  return form;
}

// Grows the textarea to its content. CSS caps it at 8 lines.
function fitField(field) {
  field.style.height = 'auto';
  field.style.height = `${field.scrollHeight}px`;
}

async function searchConversations(text) {
  const q = text.trim();
  if (q.length < 2) { notice('Search needs at least 2 characters.'); return; }
  closeStream();
  conv.channel = null; drawList();
  $('chat-root')?.classList.remove('drawer-open');
  $('conv-status').hidden = true;
  $('conv-share').hidden = true;
  $('conv-share').replaceChildren();
  setComposer(null);
  setHeading(`Results for “${q}”`);
  showView(busy('md', 'Searching…'));
  try {
    const result = await request(`/api/conversations/search?server=${enc(state.server.id)}&q=${enc(q)}`);
    const names = new Map(result.channels.map(c => [c.id, c.name]));
    const wrap = document.createElement('div');
    wrap.className = 'chat-results';
    if (!result.messages.length) wrap.append(textNode('p', 'No stored messages match in the conversations you can view.', 'small chat-none'));
    for (const m of result.messages) {
      const row = textNode('div', '', 'chat-hit');
      const open = textNode('button', `${names.get(m.channel) || 'Conversation'} · ${timeLabel(m.timestamp)}`, 'chat-hit-open');
      open.type = 'button';
      open.onclick = () => openConversation(m.channel);
      row.append(open, textNode('div', `${m.authorName}: ${m.text.slice(0, 280)}`, 'chat-hit-text'));
      wrap.append(row);
    }
    showView(wrap);
  } catch (error) { showView(textNode('p', error.message, 'small chat-none')); fail(error); }
}

function textNode(tag, text, className = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}
