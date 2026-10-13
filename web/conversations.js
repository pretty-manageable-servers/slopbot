// Conversations tab: channel transcripts, Slopbot run views and the live stream.
// Uses globals from app.js: $, request, busy, fail, state, notice.
const conv = { server: '', list: [], channel: null, source: null, lastStream: 0, seen: 0, live: new Map(), frame: 0 };
const enc = encodeURIComponent;
const reduceMotion = () => window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
const timeLabel = ts => ts ? new Date(ts).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' }) : '';
const label = c => (c.kind === 'thread' ? 'Thread · ' : '#') + c.name;

function renderConversations() {
  if (conv.server !== state.server.id) { closeConversation(); conv.server = state.server.id; conv.channel = null; conv.list = []; }
  $('breadcrumb').textContent = 'Conversations';
  $('title').textContent = 'Read the conversation.';
  $('description').textContent = 'Channels and threads that you can view and that a server admin has turned on. Live answers from Slopbot appear as they are written.';
  $('content').innerHTML = '<div class="conv"><aside class="conv-side"><input id="conv-search" class="filter" type="search" placeholder="Search messages" aria-label="Search messages"><ul id="conv-list" class="conv-items"></ul></aside><section id="conv-main" class="conv-main"></section></div>';
  $('conv-search').onkeydown = event => { if (event.key === 'Enter') { event.preventDefault(); searchConversations($('conv-search').value); } };
  $('conv-main').replaceChildren(busy('md', 'Loading…'));
  loadConversations().catch(fail);
}

async function loadConversations() {
  const id = state.server.id;
  const result = await request(`/api/conversations?server=${enc(id)}`);
  if (conv.server !== id || !$('conv-list')) return;
  conv.list = result.conversations;
  drawList();
  if (conv.channel && conv.list.some(c => c.id === conv.channel)) return;
  if (conv.list.length) openConversation(conv.list[0].id);
  else $('conv-main').innerHTML = '<p class="small">No conversations are on yet. A server admin turns a channel on under Settings / Channels, in Web transcripts.</p>';
}

function drawList() {
  const list = $('conv-list');
  if (!list) return;
  list.innerHTML = '';
  if (!conv.list.length) { list.innerHTML = '<li class="small">Nothing to show yet.</li>'; return; }
  for (const c of conv.list) {
    const item = document.createElement('li'), button = document.createElement('button');
    button.type = 'button'; button.className = 'conv-item'; button.dataset.id = c.id;
    button.setAttribute('aria-current', c.id === conv.channel ? 'true' : 'false');
    const name = document.createElement('strong'); name.textContent = label(c);
    const date = document.createElement('span'); date.className = 'small'; date.textContent = c.newest ? timeLabel(c.newest) : 'No messages yet';
    button.append(name, date);
    button.onclick = () => openConversation(c.id);
    item.append(button); list.append(item);
  }
}

async function openConversation(id) {
  closeStream();
  conv.channel = id; conv.live.clear();
  drawList();
  const main = $('conv-main');
  main.replaceChildren(busy('md', 'Loading…'));
  try {
    const page = await request(`/api/conversations/${enc(id)}/messages?server=${enc(state.server.id)}&limit=50`);
    if (conv.channel !== id) return;
    const info = conv.list.find(c => c.id === id) || { kind: 'channel', name: page.channel.name };
    main.innerHTML = `<header class="conv-head"><h2></h2><div class="conv-tools"><p class="small" id="conv-status">Connecting…</p><div id="conv-share" hidden></div></div></header><button id="conv-older" class="older" type="button" hidden>Load older messages</button><div id="conv-log" class="conv-log" role="log" aria-live="polite" aria-relevant="additions"></div><div id="conv-reply" hidden></div>`;
    main.querySelector('h2').textContent = label({ ...info, name: info.name || page.channel.name });
    const log = $('conv-log');
    for (const m of page.messages) log.append(messageNode(m));
    $('conv-older').hidden = !page.hasMore;
    $('conv-older').onclick = () => loadOlder(id);
    // The server says who may share and who may send. Sent replies arrive through the live stream, so the box adds nothing to the log.
    if (page.canShare && window.SlopbotShares) { $('conv-share').hidden = false; window.SlopbotShares.renderShareButton($('conv-share'), state.server.id, id); }
    if (page.canSend) { $('conv-reply').hidden = false; renderReplyBox($('conv-reply'), state.server.id, id); }
    conv.lastStream = page.streamId;
    conv.seen = page.streamId;
    log.scrollTop = log.scrollHeight;
    openStream(id);
  } catch (error) {
    if (conv.channel === id) main.innerHTML = `<p class="small">${esc(error.message)}</p>`;
    fail(error);
  }
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
    log.scrollTop += log.scrollHeight - before;
    button.hidden = !page.hasMore;
  } catch (error) { fail(error); }
  finally { button.disabled = false; }
}

function messageNode(m) {
  const article = document.createElement('article');
  article.className = 'msg' + (m.slopbot ? ' bot' : '');
  article.dataset.id = m.id;
  if (m.timestamp) article.dataset.time = String(m.timestamp);
  const head = document.createElement('header');
  const who = document.createElement('strong'); who.textContent = m.authorName;
  const time = document.createElement('time'); time.textContent = timeLabel(m.timestamp);
  if (m.timestamp) time.dateTime = new Date(m.timestamp).toISOString();
  head.append(who, time);
  if (m.editedAt) { const edited = document.createElement('span'); edited.className = 'chip'; edited.textContent = 'edited'; head.append(edited); }
  const text = document.createElement('div'); text.className = 'msg-text'; text.textContent = m.text;
  article.append(head, text);
  if (m.slopbot && m.runIds.length) article.append(runToggle(m.runIds));
  return article;
}

function runToggle(runIds) {
  const wrap = document.createElement('div'); wrap.className = 'run';
  const button = document.createElement('button');
  button.type = 'button'; button.className = 'run-toggle'; button.textContent = 'Show run'; button.setAttribute('aria-expanded', 'false');
  const panel = document.createElement('div'); panel.className = 'run-panel'; panel.hidden = true;
  button.onclick = async () => {
    const open = panel.hidden;
    panel.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    button.textContent = open ? 'Hide run' : 'Show run';
    if (open && !panel.dataset.loaded) {
      panel.dataset.loaded = 'true';
      panel.replaceChildren(busy('sm', 'Loading run…'));
      try {
        const runs = await Promise.all(runIds.map(id => request(`/api/runs/${enc(id)}`)));
        panel.replaceChildren(...runs.flatMap((run, index) => runNodes(run, runIds.length > 1 ? index + 1 : 0)));
      } catch (error) { panel.replaceChildren(textNode('p', error.message, 'small')); fail(error); }
    }
  };
  wrap.append(button, panel);
  return wrap;
}

function textNode(tag, text, className = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}

function runNodes(run, number) {
  const nodes = [];
  if (number) nodes.push(textNode('p', `Round ${number}`, 'small run-round'));
  for (const step of run.steps) {
    if (step.type === 'text') nodes.push(textNode('div', step.text, 'run-text'));
    else if (step.type === 'thinking') {
      const details = document.createElement('details'); details.className = 'run-think';
      details.append(textNode('summary', 'Thinking'), textNode('pre', step.text));
      nodes.push(details);
    } else nodes.push(toolNode(step));
  }
  if (run.error) nodes.push(textNode('p', run.error, 'small run-error'));
  if (!run.steps.length) nodes.push(textNode('p', 'No stored events for this run.', 'small'));
  return nodes;
}

function toolNode(step) {
  const box = document.createElement('div'); box.className = 'run-tool';
  const line = document.createElement('div'); line.className = 'run-tool-line';
  line.append(textNode('strong', step.name), textNode('span', step.status, 'chip'));
  const args = document.createElement('details');
  args.append(textNode('summary', 'Arguments'), textNode('pre', step.args));
  box.append(line, args);
  if (step.result !== undefined) {
    const result = document.createElement('details');
    result.append(textNode('summary', 'Result'), textNode('pre', step.result));
    box.append(result);
  }
  return box;
}

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
  conv.live.clear();
  conv.channel = null;
}

function setStatus(text) { const node = $('conv-status'); if (node) node.textContent = text; }

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
  if (stick) log.scrollTop = log.scrollHeight;
}

function removeMessage(id) {
  const node = $('conv-log') && $('conv-log').querySelector(`[data-id="${id}"]`);
  if (node) node.remove();
}

// A live card shows one request while its runs stream. It is replaced by the saved reply.
function liveFor(requestId) {
  let card = [...conv.live.values()].find(item => item.requestId === requestId);
  if (card) return card;
  const log = $('conv-log');
  if (!log) return undefined;
  const node = document.createElement('article');
  node.className = 'msg bot live';
  const head = document.createElement('header');
  head.append(textNode('strong', 'Slopbot'), textNode('span', 'working', 'chip live-chip'));
  const text = textNode('div', '', 'msg-text');
  const think = document.createElement('details'); think.className = 'run-think'; think.hidden = true;
  think.append(textNode('summary', 'Thinking'), textNode('pre', ''));
  const tools = document.createElement('div'); tools.className = 'live-tools';
  node.append(head, text, think, tools);
  log.append(node);
  card = { requestId, node, head, text, think, tools, runs: new Set(), buffers: { text: '', thinking: '' }, shown: { text: 0, thinking: 0 }, tool: new Map() };
  conv.live.set(requestId, card);
  if (nearBottom(log)) log.scrollTop = log.scrollHeight;
  return card;
}

function startLive(runId, requestId) {
  const card = liveFor(requestId);
  if (!card) return;
  card.runs.add(runId);
}

function delta(runId, part, text) {
  const card = [...conv.live.values()].find(item => item.runs.has(runId));
  if (!card || !text) return;
  if (part === 'thinking') card.think.hidden = false;
  card.buffers[part] += text;
  if (reduceMotion()) reveal(card, part, card.buffers[part].length);
  schedule();
}

function tool(data) {
  const card = liveFor(data.requestId);
  if (!card) return;
  let row = card.tool.get(data.id);
  if (!row) {
    row = document.createElement('div'); row.className = 'run-tool';
    row.append(textNode('div', '', 'run-tool-line'));
    card.tool.set(data.id, row);
    card.tools.append(row);
  }
  const line = row.firstChild;
  line.replaceChildren(textNode('strong', data.name), textNode('span', data.status, 'chip'));
  if (data.reason) line.append(textNode('span', data.reason, 'small'));
}

function endLive(runId) {
  const card = [...conv.live.values()].find(item => item.runs.has(runId));
  if (card) card.head.lastChild.textContent = 'done';
}

function finishLiveRun(runId) {
  for (const [key, card] of conv.live) {
    if (card.runs.has(runId)) { card.node.remove(); conv.live.delete(key); }
  }
}

function reveal(card, part, to) {
  card.shown[part] = to;
  const node = part === 'text' ? card.text : card.think.querySelector('pre');
  node.textContent = card.buffers[part].slice(0, to);
}

function schedule() { if (!conv.frame) conv.frame = requestAnimationFrame(tick); }

// Reveal buffered text a little each frame. The step grows with the backlog, so the view never falls far behind.
function tick() {
  conv.frame = 0;
  let more = false;
  for (const card of conv.live.values()) {
    for (const part of ['text', 'thinking']) {
      const backlog = card.buffers[part].length - card.shown[part];
      if (backlog <= 0) continue;
      reveal(card, part, card.shown[part] + Math.min(backlog, Math.max(1, Math.ceil(backlog / 12))));
      if (card.shown[part] < card.buffers[part].length) more = true;
    }
  }
  if (more) schedule();
}

async function searchConversations(text) {
  const q = text.trim();
  if (q.length < 2) { notice('Search needs at least 2 characters.'); return; }
  closeStream();
  conv.channel = null; drawList();
  const main = $('conv-main');
  main.replaceChildren(busy('md', 'Searching…'));
  try {
    const result = await request(`/api/conversations/search?server=${enc(state.server.id)}&q=${enc(q)}`);
    const names = new Map(result.channels.map(c => [c.id, c.name]));
    main.innerHTML = '<header class="conv-head"><h2></h2></header>';
    main.querySelector('h2').textContent = `Results for “${q}”`;
    if (!result.messages.length) main.append(textNode('p', 'No stored messages match in the conversations you can view.', 'small'));
    for (const m of result.messages) {
      const row = document.createElement('div'); row.className = 'search-hit';
      const open = document.createElement('button');
      open.type = 'button'; open.className = 'link-button'; open.textContent = `${names.get(m.channel) || 'Conversation'} · ${timeLabel(m.timestamp)}`;
      open.onclick = () => { conv.channel = m.channel; openConversation(m.channel); };
      row.append(open, textNode('div', `${m.authorName}: ${m.text.slice(0, 280)}`, 'msg-text'));
      main.append(row);
    }
  } catch (error) { main.replaceChildren(textNode('p', error.message, 'small')); fail(error); }
}

