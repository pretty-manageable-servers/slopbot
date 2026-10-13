// Command palette: Cmd+K on Mac, Ctrl+K elsewhere. A centered dialog with a filter field and a list of actions, settings sections, chats, channels and servers.
// Uses globals from app.js (state, admin, theme, openSettings, closeSettings, $), conversations.js (newChat) and window.SlopbotChat.
(() => {
  const SECTION_NAMES = [['server', 'Server settings'], ['channels', 'Channels & history'], ['mcp', 'MCP connections'], ['profile', 'My profile'], ['admin', 'Team admin']];
  let dialog = null, input = null, list = null, emptyNote = null;
  let shown = [], active = 0, returnFocus = null;

  // Letters of the query must appear in the text, in order. A substring ranks first, by its position. Lower is better. -1 means no match.
  function score(query, text) {
    const q = query.trim().toLowerCase(), t = text.toLowerCase();
    if (!q) return 0;
    const at = t.indexOf(q);
    if (at >= 0) return at;
    let pos = -1, gaps = 0;
    for (const ch of q) {
      const found = t.indexOf(ch, pos + 1);
      if (found < 0) return -1;
      gaps += found - pos - 1;
      pos = found;
    }
    return 1000 + gaps;
  }

  function switchServer(id) {
    if (id === state.server?.id) return;
    const select = $('server');
    select.value = id;
    select.dispatchEvent(new Event('change'));
  }

  // The full item list. Each item has a group, a name, a hint and a run function.
  function collect() {
    const items = [];
    const add = (group, name, run, hint = '') => items.push({ group, name, run, hint });
    add('Actions', 'New chat', () => { closeSettings(); newChat(); });
    add('Actions', 'Go to Chats', () => { closeSettings(); window.SlopbotChat.view('chats'); }, 'Private chats');
    add('Actions', 'Go to Servers', () => { closeSettings(); window.SlopbotChat.view('servers'); }, 'Channels and threads');
    add('Actions', 'Open settings', () => openSettings(null, returnFocus));
    const dark = !document.documentElement.classList.contains('light');
    add('Actions', dark ? 'Switch to light theme' : 'Switch to dark theme', () => theme(dark));
    add('Actions', 'Docs', () => window.open('https://docs.pmservers.org', '_blank', 'noopener'), 'docs.pmservers.org');
    add('Actions', 'Sign out', () => $('logout').click());
    for (const [section, name] of SECTION_NAMES) {
      if (section === 'admin' && !admin) continue;
      add('Settings', name, () => openSettings(section, returnFocus));
    }
    for (const item of window.SlopbotChat?.items() || []) {
      const group = item.kind === 'chat' ? 'Private chats' : item.thread ? 'Threads' : 'Channels';
      const hint = item.kind === 'chat' ? 'Private chat' : item.thread ? 'Thread' : 'Channel';
      add(group, item.name, () => { closeSettings(); window.SlopbotChat.open(item.kind, item.id); }, hint);
    }
    for (const server of state.servers || []) {
      add('Servers', server.name, () => switchServer(server.id), server.id === state.server?.id ? 'Current' : 'Switch');
    }
    return items;
  }

  function setActive(index) {
    active = index;
    const options = list.querySelectorAll('[role=option]');
    options.forEach((node, i) => node.setAttribute('aria-selected', String(i === active)));
    const current = options[active];
    if (current) { input.setAttribute('aria-activedescendant', current.id); current.scrollIntoView({ block: 'nearest' }); }
    else input.removeAttribute('aria-activedescendant');
  }

  // Message search. The query waits 250 ms after the last key. Each new query gets a new run number, so an older answer is dropped.
  let hits = [], hitState = 'idle', hitError = '', searchTimer = 0, searchRun = 0;
  function cancelSearch() { clearTimeout(searchTimer); searchRun++; hits = []; hitState = 'idle'; }
  function scheduleSearch() {
    clearTimeout(searchTimer);
    const run = ++searchRun;
    hits = [];
    const query = input.value.trim();
    if (query.length < 2) { hitState = 'idle'; return; }
    hitState = 'loading';
    searchTimer = setTimeout(() => runSearch(query, run), 250);
  }
  async function runSearch(query, run) {
    try {
      const found = await window.SlopbotChat.searchMessages(query);
      if (run !== searchRun) return;
      hits = found; hitState = 'done';
    } catch (error) {
      if (run !== searchRun) return;
      hits = []; hitState = 'error'; hitError = error.message || 'Search failed.';
    }
    refresh();
  }
  // The text of a hit: the words around the first match, about 240 characters, with "…" when it starts later.
  function snippetOf(text, query) {
    const flat = String(text || '').replace(/\s+/g, ' ').trim();
    const at = Math.max(0, flat.toLowerCase().indexOf(query.split(/\s+/)[0].toLowerCase()));
    const start = Math.max(0, at - 60);
    return (start ? '…' : '') + flat.slice(start, start + 240);
  }
  // Marks each word of the query in the text nodes of the snippet. The markdown structure stays.
  function highlight(root, query) {
    const words = query.split(/\s+/).filter(Boolean).map(word => word.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!words.length) return;
    const pattern = new RegExp(words.join('|'), 'gi');
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const nodes = [];
    while (walker.nextNode()) nodes.push(walker.currentNode);
    for (const node of nodes) {
      const text = node.nodeValue;
      const frag = document.createDocumentFragment();
      let last = 0, found;
      pattern.lastIndex = 0;
      while ((found = pattern.exec(text))) {
        if (found.index > last) frag.append(text.slice(last, found.index));
        const mark = document.createElement('mark');
        mark.textContent = found[0];
        frag.append(mark);
        last = found.index + found[0].length;
      }
      if (last === 0) continue;
      if (last < text.length) frag.append(text.slice(last));
      node.replaceWith(frag);
    }
  }
  // One message hit: the channel, author and time, then the snippet rendered as chat markdown.
  function hitNodes(hit, query) {
    const meta = document.createElement('span');
    meta.className = 'palette-hit-meta';
    meta.textContent = `${hit.name} · ${hit.authorName || ''} · ${timeLabel(hit.timestamp)}`;
    const text = document.createElement('span');
    text.className = 'palette-hit-text';
    renderText(text, snippetOf(hit.text, query));
    highlight(text, query);
    return [meta, text];
  }
  function messageItems() {
    return hits.map(hit => ({ group: 'Messages', name: hit.text, hit, run: () => { closeSettings(); window.SlopbotChat.openMessage(hit.channel, hit.id); } }));
  }

  // Draws the list for the text in the field. With no text, the groups show as headings. With text, the matches sort by score.
  // Messages come last, under their own heading, with a row while they load or when none match.
  function refresh() {
    const query = input.value.trim();
    const messagesOn = query.length >= 2;
    const all = collect();
    const matched = query
      ? all.map(item => ({ item, s: score(query, item.name) })).filter(entry => entry.s >= 0).sort((a, b) => a.s - b.s).map(entry => entry.item)
      : all;
    const found = messagesOn ? messageItems() : [];
    shown = matched.concat(found);
    list.replaceChildren();
    const heading = name => {
      const node = document.createElement('li');
      node.className = 'palette-group';
      node.setAttribute('role', 'presentation');
      node.textContent = name;
      list.append(node);
    };
    let group = null;
    shown.forEach((item, index) => {
      if (item.group !== group && (!query || item.group === 'Messages')) {
        group = item.group;
        heading(group);
      }
      const option = document.createElement('li');
      option.id = `palette-opt-${index}`;
      option.className = 'palette-item';
      option.setAttribute('role', 'option');
      option.dataset.index = String(index);
      if (item.hit) {
        option.classList.add('palette-hit');
        option.append(...hitNodes(item.hit, query));
      } else {
        const name = document.createElement('span');
        name.className = 'palette-name';
        name.textContent = item.name;
        const hint = document.createElement('span');
        hint.className = 'palette-hint';
        hint.textContent = item.hint || (query ? item.group : '');
        option.append(name, hint);
      }
      list.append(option);
    });
    if (messagesOn && !found.length) {
      if (group !== 'Messages') heading('Messages');
      const status = document.createElement('li');
      status.className = 'palette-status';
      status.setAttribute('role', 'presentation');
      status.textContent = hitState === 'loading' ? 'Searching messages…' : hitState === 'error' ? hitError : 'No messages match';
      list.append(status);
    }
    emptyNote.hidden = shown.length > 0 || messagesOn;
    setActive(0);
  }

  function runActive() {
    const item = shown[active];
    if (!item) return;
    closeDialog();
    item.run();
  }

  function closeDialog() { if (dialog?.open) dialog.close(); }

  function openDialog() {
    if (!state || $('console').hidden) return;
    ensure();
    if (dialog.open) return;
    returnFocus = document.activeElement;
    input.value = '';
    cancelSearch();
    refresh();
    dialog.showModal();
    input.focus();
  }

  function ensure() {
    if (dialog) return;
    dialog = document.createElement('dialog');
    dialog.className = 'palette-dialog';
    dialog.setAttribute('aria-label', 'Command palette');
    const shell = document.createElement('div');
    shell.className = 'palette-shell';
    input = document.createElement('input');
    input.type = 'text';
    input.className = 'palette-input';
    input.placeholder = 'Type a command, chat, channel, server or message';
    input.setAttribute('aria-label', 'Command or search');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', 'palette-list');
    input.setAttribute('aria-autocomplete', 'list');
    input.autocomplete = 'off';
    input.spellcheck = false;
    list = document.createElement('ul');
    list.id = 'palette-list';
    list.className = 'palette-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Results');
    emptyNote = document.createElement('p');
    emptyNote.className = 'palette-empty';
    emptyNote.textContent = 'No matches.';
    shell.append(input, list, emptyNote);
    dialog.append(shell);
    document.body.append(dialog);

    input.addEventListener('input', () => { scheduleSearch(); refresh(); });
    input.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'ArrowDown') { event.preventDefault(); if (shown.length) setActive((active + 1) % shown.length); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); if (shown.length) setActive((active - 1 + shown.length) % shown.length); }
      else if (event.key === 'Enter') { event.preventDefault(); runActive(); }
    });
    list.addEventListener('click', event => {
      const option = event.target.closest('[role=option]');
      if (!option) return;
      setActive(Number(option.dataset.index));
      runActive();
    });
    list.addEventListener('pointermove', event => {
      const option = event.target.closest('[role=option]');
      if (option && Number(option.dataset.index) !== active) setActive(Number(option.dataset.index));
    });
    // A click on the backdrop closes the palette. Escape closes it through the native dialog cancel.
    dialog.addEventListener('click', event => { if (event.target === dialog) closeDialog(); });
    dialog.addEventListener('close', () => { cancelSearch(); if (returnFocus?.isConnected) returnFocus.focus(); });
  }

  // Cmd+K or Ctrl+K toggles the palette. It also works while focus is in a text field.
  document.addEventListener('keydown', event => {
    if ((event.key || '').toLowerCase() !== 'k' || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    event.preventDefault();
    if (dialog?.open) closeDialog();
    else openDialog();
  });
})();
