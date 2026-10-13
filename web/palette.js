// Command palette: Cmd+K on Mac, Ctrl+K elsewhere. A dialog with a borderless search field, filter pills, and sections of chats, channels, servers, actions and message hits.
// Uses globals from app.js (state, admin, theme, openSettings, closeSettings, $), conversations.js (newChat, relTime, msgTime, fuzzyScore, renderText) and window.SlopbotChat.
(() => {
  const SECTION_NAMES = [['server', 'Server settings'], ['channels', 'Channels & history'], ['mcp', 'MCP connections'], ['profile', 'My profile'], ['admin', 'Team admin']];
  // Filter pills in order. Each key is also a section key. The section titles keep the order of the typed-search sections.
  const FILTERS = [['all', 'All'], ['chats', 'Chats'], ['channels', 'Channels'], ['servers', 'Servers'], ['messages', 'Messages'], ['actions', 'Actions']];
  const TITLES = { chats: 'Chats', channels: 'Channels', servers: 'Servers', actions: 'Actions', messages: 'Messages' };
  const RECENT_MAX = 6;
  const MESSAGE_HINT = 'Type two or more letters to search messages.';
  const svg = (body, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${body}</svg>`;
  // Stroke icons in the style of web/index.html.
  const ICONS = {
    chat: svg('<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>'),
    channel: svg('<line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/>'),
    thread: svg('<polyline points="15 10 20 15 15 20"/><path d="M4 4v7a4 4 0 0 0 4 4h12"/>'),
    server: svg('<rect x="2" y="3" width="20" height="8" rx="2"/><rect x="2" y="13" width="20" height="8" rx="2"/><line x1="6" y1="7" x2="6.01" y2="7"/><line x1="6" y1="17" x2="6.01" y2="17"/>'),
    plus: svg('<circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="16"/><line x1="8" y1="12" x2="16" y2="12"/>'),
    gear: svg('<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>'),
    sun: svg('<circle cx="12" cy="12" r="4"/><path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M6.34 17.66l-1.41 1.41M19.07 4.93l-1.41 1.41"/>'),
    moon: svg('<path d="M21 12.8A9 9 0 1 1 11.2 3a7 7 0 0 0 9.8 9.8z"/>'),
    book: svg('<path d="M2 4h6a4 4 0 0 1 4 4v12a3 3 0 0 0-3-3H2z"/><path d="M22 4h-6a4 4 0 0 0-4 4v12a3 3 0 0 1 3-3h7z"/>'),
    logout: svg('<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>'),
    message: svg('<path d="M4 4h16v12H5.17L4 17.17V4z"/><line x1="8" y1="9" x2="16" y2="9"/><line x1="8" y1="13" x2="13" y2="13"/>'),
    enter: svg('<path d="M9 10l-5 5 5 5"/><path d="M20 4v7a4 4 0 0 1-4 4H4"/>', 14),
  };
  let dialog = null, input = null, list = null, emptyNote = null, filterBar = null;
  let shown = [], active = 0, returnFocus = null, filter = 'all';

  // Action matching is strict. A word start or a substring ranks first, by position. Letters in order, with gaps, count only for a query of 3+ characters, and only when the letters stay close: no gap over 2 characters, and the whole match at most 3 characters longer than the query. Lower is better. -1 means no match.
  function score(query, text) {
    const q = query.trim().toLowerCase(), t = text.toLowerCase();
    if (!q) return 0;
    const at = t.indexOf(q);
    if (at >= 0) return at === 0 || !/[a-z0-9]/.test(t[at - 1]) ? at : 50 + at;
    if (q.length < 3) return -1;
    let pos = -1, first = -1;
    for (const ch of q) {
      const found = t.indexOf(ch, pos + 1);
      if (found < 0 || (pos >= 0 && found - pos - 1 > 2)) return -1;
      if (first < 0) first = found;
      pos = found;
    }
    const span = pos - first + 1;
    return span > q.length + 3 ? -1 : 100 + span - q.length;
  }
  // Lower is better. Actions use the strict score. Chats, channels and servers use the same fuzzy match as the sidebar filter.
  function rank(item, query) {
    if (item.group === 'actions') return score(query, item.name);
    const found = fuzzyScore(query, item.name);
    return found > 0 ? 1 - found : -1;
  }

  function switchServer(id) {
    if (id === state.server?.id) return;
    const select = $('server');
    select.value = id;
    select.dispatchEvent(new Event('change'));
  }

  // The full item list. Each item has a group (a section key), a name, an icon, a run function, and optional meta and ts (for Recents).
  function collect() {
    const items = [];
    const add = (group, name, icon, run, extra = {}) => items.push({ group, name, icon, run, ...extra });
    add('actions', 'New chat', ICONS.plus, () => { closeSettings(); newChat(); });
    add('actions', 'Go to Chats', ICONS.chat, () => { closeSettings(); window.SlopbotChat.view('chats'); });
    add('actions', 'Go to Servers', ICONS.server, () => { closeSettings(); window.SlopbotChat.view('servers'); });
    add('actions', 'Open settings', ICONS.gear, () => openSettings(null, returnFocus));
    const dark = !document.documentElement.classList.contains('light');
    add('actions', dark ? 'Switch to light theme' : 'Switch to dark theme', dark ? ICONS.sun : ICONS.moon, () => theme(dark));
    add('actions', 'Docs', ICONS.book, () => window.open('https://docs.pmservers.org', '_blank', 'noopener'));
    add('actions', 'Sign out', ICONS.logout, () => $('logout').click());
    for (const [section, name] of SECTION_NAMES) {
      if (section === 'admin' && !admin) continue;
      add('actions', name, ICONS.gear, () => openSettings(section, returnFocus));
    }
    for (const item of window.SlopbotChat?.items() || []) {
      const group = item.kind === 'chat' ? 'chats' : 'channels';
      const icon = item.kind === 'chat' ? ICONS.chat : item.thread ? ICONS.thread : ICONS.channel;
      add(group, item.name, icon, () => { closeSettings(); window.SlopbotChat.open(item.kind, item.id); }, { ts: item.ts, meta: item.ts ? relTime(item.ts) : '' });
    }
    for (const server of state.servers || []) {
      add('servers', server.name, ICONS.server, () => switchServer(server.id), { meta: server.id === state.server?.id ? 'Current' : '' });
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
  // One message hit: the snippet rendered as chat markdown, with the channel and author under it.
  function hitNodes(hit, query) {
    const text = document.createElement('span');
    text.className = 'palette-hit-text';
    renderText(text, snippetOf(hit.text, query));
    highlight(text, query);
    const meta = document.createElement('span');
    meta.className = 'palette-hit-meta';
    meta.textContent = `${hit.name} · ${hit.authorName || ''}`;
    return [text, meta];
  }
  function messageItems() {
    return hits.map(hit => ({ group: 'messages', name: hit.text, icon: ICONS.message, hit, meta: msgTime(hit.timestamp), run: () => { closeSettings(); window.SlopbotChat.openMessage(hit.channel, hit.id); } }));
  }
  // The status line under the Messages heading: a loading note, an error, or no hits.
  function hitStatus() {
    if (hitState === 'loading') return 'Searching messages…';
    if (hitState === 'error') return hitError;
    return hits.length ? '' : 'No messages match';
  }

  // One row. The icon, the name or the message hit, the meta on the right, and a return glyph that shows on the selected row.
  function optionNode(item, index, query) {
    const option = document.createElement('li');
    option.id = `palette-opt-${index}`;
    option.className = 'palette-item';
    option.setAttribute('role', 'option');
    option.dataset.index = String(index);
    const icon = document.createElement('span');
    icon.className = 'palette-icon';
    icon.innerHTML = item.icon;
    const main = document.createElement('span');
    main.className = 'palette-main';
    if (item.hit) {
      option.classList.add('palette-hit');
      main.append(...hitNodes(item.hit, query));
    } else {
      const name = document.createElement('span');
      name.className = 'palette-name';
      name.textContent = item.name;
      main.append(name);
    }
    const meta = document.createElement('span');
    meta.className = 'palette-meta';
    meta.textContent = item.meta || '';
    const enter = document.createElement('span');
    enter.className = 'palette-return';
    enter.innerHTML = ICONS.enter;
    option.append(icon, main, meta, enter);
    return option;
  }

  // Builds the sections for the field and the filter, then draws them. A section is { title, items, status }.
  // Empty field: under All, Recents (the newest six chats and channels) and Actions. Under a filter, that filter's section.
  // With text: the matching sections in the order Chats, Channels, Servers, Actions, Messages. Messages search from two letters.
  function sections(query) {
    const all = collect();
    const messagesOn = query.length >= 2;
    const groups = [];
    if (!query) {
      if (filter === 'all') {
        const recents = all.filter(item => (item.group === 'chats' || item.group === 'channels') && item.ts).sort((a, b) => b.ts - a.ts).slice(0, RECENT_MAX);
        groups.push({ title: 'Recents', items: recents }, { title: TITLES.actions, items: all.filter(item => item.group === 'actions') });
      } else if (filter === 'messages') {
        groups.push({ title: TITLES.messages, items: [], status: MESSAGE_HINT });
      } else {
        groups.push({ title: TITLES[filter], items: all.filter(item => item.group === filter) });
      }
      return groups.filter(group => group.items.length || group.status);
    }
    for (const key of filter === 'all' ? Object.keys(TITLES) : [filter]) {
      if (key === 'messages') {
        if (messagesOn) groups.push({ title: TITLES.messages, items: messageItems(), status: hitStatus() });
        else if (filter === 'messages') groups.push({ title: TITLES.messages, items: [], status: MESSAGE_HINT });
        continue;
      }
      const matched = all.filter(item => item.group === key).map(item => ({ item, s: rank(item, query) })).filter(entry => entry.s >= 0).sort((a, b) => a.s - b.s).map(entry => entry.item);
      if (matched.length) groups.push({ title: TITLES[key], items: matched });
    }
    return groups;
  }

  // Draws the sections. Each section has a muted heading. Its rows are numbered in order, so the arrow keys follow the screen.
  function refresh() {
    const query = input.value.trim();
    const groups = sections(query);
    shown = [];
    list.replaceChildren();
    for (const group of groups) {
      const heading = document.createElement('li');
      heading.className = 'palette-group';
      heading.setAttribute('role', 'presentation');
      heading.textContent = group.title;
      list.append(heading);
      for (const item of group.items) {
        shown.push(item);
        list.append(optionNode(item, shown.length - 1, query));
      }
      if (group.status) {
        const status = document.createElement('li');
        status.className = 'palette-status';
        status.setAttribute('role', 'presentation');
        status.textContent = group.status;
        list.append(status);
      }
    }
    emptyNote.hidden = shown.length > 0 || groups.some(group => group.status);
    setActive(0);
  }

  // The filter pills: the one for the current filter is pressed.
  function paintFilters() {
    filterBar?.querySelectorAll('[data-filter]').forEach(button => button.setAttribute('aria-pressed', String(button.dataset.filter === filter)));
  }
  function setFilter(next) {
    filter = next;
    paintFilters();
    refresh();
  }
  // Left or Right moves to the next or previous filter, and wraps at the ends.
  function stepFilter(step) {
    const at = FILTERS.findIndex(([key]) => key === filter);
    setFilter(FILTERS[(at + step + FILTERS.length) % FILTERS.length][0]);
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
    filter = 'all';
    paintFilters();
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
    // The header: a borderless search field and a close button.
    const head = document.createElement('div');
    head.className = 'palette-head';
    input = document.createElement('input');
    input.type = 'text';
    input.className = 'palette-input';
    input.placeholder = 'Search';
    input.setAttribute('aria-label', 'Search');
    input.setAttribute('role', 'combobox');
    input.setAttribute('aria-expanded', 'true');
    input.setAttribute('aria-controls', 'palette-list');
    input.setAttribute('aria-autocomplete', 'list');
    input.autocomplete = 'off';
    input.spellcheck = false;
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'palette-close';
    close.setAttribute('aria-label', 'Close');
    close.title = 'Close';
    close.innerHTML = svg('<path d="M6 6l12 12M18 6L6 18"/>');
    close.onclick = closeDialog;
    head.append(input, close);
    // The filter pills. Clicking one sets the filter and gives the focus back to the field.
    filterBar = document.createElement('div');
    filterBar.className = 'palette-filters';
    filterBar.setAttribute('role', 'group');
    filterBar.setAttribute('aria-label', 'Filter');
    for (const [key, name] of FILTERS) {
      const button = document.createElement('button');
      button.type = 'button';
      button.className = 'palette-filter';
      button.dataset.filter = key;
      button.textContent = name;
      button.onclick = () => { setFilter(key); input.focus(); };
      filterBar.append(button);
    }
    const divider = document.createElement('div');
    divider.className = 'palette-divider';
    divider.setAttribute('role', 'presentation');
    list = document.createElement('ul');
    list.id = 'palette-list';
    list.className = 'palette-list';
    list.setAttribute('role', 'listbox');
    list.setAttribute('aria-label', 'Results');
    emptyNote = document.createElement('p');
    emptyNote.className = 'palette-empty';
    emptyNote.textContent = 'No matches.';
    const foot = document.createElement('div');
    foot.className = 'palette-foot';
    foot.innerHTML = '<span>Close <kbd>Esc</kbd></span><span>Change type <kbd>←</kbd><kbd>→</kbd></span><span>Open <kbd>↵</kbd></span>';
    shell.append(head, filterBar, divider, list, emptyNote, foot);
    dialog.append(shell);
    document.body.append(dialog);
    paintFilters();

    input.addEventListener('input', () => { scheduleSearch(); refresh(); });
    input.addEventListener('keydown', event => {
      if (event.isComposing) return;
      if (event.key === 'ArrowDown') { event.preventDefault(); if (shown.length) setActive((active + 1) % shown.length); }
      else if (event.key === 'ArrowUp') { event.preventDefault(); if (shown.length) setActive((active - 1 + shown.length) % shown.length); }
      else if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
        // Left and Right change the filter only when the field is empty or the caret is at its start (Left) or end (Right).
        const collapsed = input.selectionStart === input.selectionEnd;
        const atEdge = event.key === 'ArrowLeft' ? input.selectionStart === 0 : input.selectionEnd === input.value.length;
        if (!input.value || (collapsed && atEdge)) { event.preventDefault(); stepFilter(event.key === 'ArrowLeft' ? -1 : 1); }
      }
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
