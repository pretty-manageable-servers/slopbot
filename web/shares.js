// Share links for the web console. Load with <script src="/console/shares.js" defer>.
// Exposes window.SlopbotShares.renderShareButton, renderShareList and renderChatShare.
// Text is always set with textContent or text nodes, never innerHTML.
(() => {
  'use strict';
  let token = null;

  function el(tag, attrs = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(attrs)) {
      if (value === false || value === null || value === undefined) continue;
      node.setAttribute(key, value === true ? '' : String(value));
    }
    node.append(...children);
    return node;
  }

  async function request(path, options) {
    const response = await fetch(path, options);
    const data = await response.json().catch(() => ({}));
    if (!response.ok) {
      const error = new Error(data.error || 'Request failed.');
      error.status = response.status;
      throw error;
    }
    return data;
  }

  // The CSRF token comes with the settings snapshot. Read it once and keep it.
  async function post(path, body) {
    try {
      if (!token) token = (await request('/api/settings')).csrf;
      return await request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': token }, body: JSON.stringify(body) });
    } catch (error) {
      if (error instanceof TypeError || /token|Invalid request/i.test(error.message)) token = null;
      throw error;
    }
  }

  async function copy(text, button) {
    try {
      await navigator.clipboard.writeText(text);
      button.textContent = 'Copied';
    } catch {
      button.textContent = 'Copy failed';
    }
  }

  /**
   * Shows a Share button in container. It replaces the container's content.
   * range is optional: { from, to } message IDs. Without it, the newest messages are shared.
   */
  function renderShareButton(container, server, channel, range = {}) {
    const button = el('button', { type: 'button' }, 'Share');
    button.addEventListener('click', () => openDialog(server, channel, range));
    container.replaceChildren(button);
    return button;
  }

  function openDialog(server, channel, range) {
    const thinking = el('input', { type: 'checkbox', id: 'share-thinking' });
    const error = el('p', { class: 'error', role: 'alert' });
    const result = el('div');
    const create = el('button', { type: 'button' }, 'Create link');
    const close = el('button', { type: 'button' }, 'Close');
    const scope = range.from || range.to
      ? 'Shares the messages in the range you chose. The copy is frozen; later messages are not added.'
      : 'Shares the newest messages in this channel (up to 200). The copy is frozen; later messages are not added.';
    const dialog = el('dialog', { class: 'share-dialog', 'aria-labelledby': 'share-title' },
      el('h2', { id: 'share-title' }, 'Share this conversation'),
      el('p', { class: 'small' }, scope),
      el('label', {}, thinking, 'Include Slopbot thinking'),
      error, result,
      el('div', { class: 'actions' }, close, create));
    create.addEventListener('click', async () => {
      create.disabled = true;
      error.textContent = '';
      try {
        const data = await post('/api/shares', {
          server, channel, show_thinking: thinking.checked,
          ...(range.from ? { from: range.from } : {}), ...(range.to ? { to: range.to } : {}),
        });
        const url = `${location.origin}/s/${data.id}`;
        const copyButton = el('button', { type: 'button' }, 'Copy link');
        copyButton.addEventListener('click', () => copy(url, copyButton));
        result.replaceChildren(el('p', {}, 'Link ready. Anyone with the link can read this copy. It is not listed by search engines.'), el('p', { class: 'link' }, url), copyButton);
        create.hidden = true;
      } catch (failure) {
        error.textContent = failure.message;
      } finally {
        create.disabled = false;
      }
    });
    close.addEventListener('click', () => dialog.close());
    showModal(dialog);
  }

  // Escape and a click on the backdrop close the dialog. A click inside the box, or a keyboard click, does not.
  function showModal(dialog) {
    dialog.addEventListener('keydown', event => { if (event.key === 'Escape') { event.preventDefault(); dialog.close(); } });
    dialog.addEventListener('click', event => {
      const box = dialog.getBoundingClientRect();
      const outside = event.clientX < box.left || event.clientX > box.right || event.clientY < box.top || event.clientY > box.bottom;
      if (event.target === dialog && outside) dialog.close();
    });
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
  }

  /**
   * Shows a Share button for a private chat in container. Only the chat's owner sees its chat, so only the owner gets this button.
   * The dialog lists the chat's links, makes a new one (a frozen copy of the messages up to now) and revokes a link.
   */
  function renderChatShare(container, chatId) {
    const button = el('button', { type: 'button' }, 'Share');
    button.addEventListener('click', () => openChatDialog(chatId));
    container.replaceChildren(button);
    return button;
  }

  function openChatDialog(chatId) {
    const base = `/api/chats/${encodeURIComponent(chatId)}/shares`;
    const error = el('p', { class: 'error', role: 'alert' });
    const status = el('p', { class: 'small', role: 'status' }, 'Loading links...');
    const links = el('div', { class: 'share-list-box' });
    const create = el('button', { type: 'button' }, 'Create link');
    const close = el('button', { type: 'button' }, 'Close');
    const dialog = el('dialog', { class: 'share-dialog', 'aria-labelledby': 'share-title' },
      el('h2', { id: 'share-title' }, 'Share this chat'),
      el('p', { class: 'small' }, 'Anyone with a link can read a frozen copy of the messages up to now. Later messages are not added. Search engines do not list the link.'),
      error, status, links,
      el('div', { class: 'actions' }, close, create));

    async function load() {
      status.textContent = 'Loading links...';
      try {
        const data = await request(base);
        const active = data.shares.filter(share => !share.revoked);
        status.textContent = active.length ? '' : 'No links yet.';
        links.replaceChildren(...active.map(share => chatLinkRow(share)));
      } catch (failure) {
        status.textContent = failure.message;
      }
    }

    function chatLinkRow(share) {
      const url = `${location.origin}/s/${share.id}`;
      const copyButton = el('button', { type: 'button' }, 'Copy link');
      copyButton.addEventListener('click', () => copy(url, copyButton));
      const revoke = el('button', { type: 'button' }, 'Revoke');
      revoke.addEventListener('click', async () => {
        if (!await askConfirm({ title: 'Remove this link?', body: 'Anyone with it can no longer read this copy.', confirmLabel: 'Remove link', danger: true })) return;
        revoke.disabled = true;
        error.textContent = '';
        try {
          await post(`${base}/${encodeURIComponent(share.id)}/revoke`, {});
          notice('Link removed.');
          await load();
        } catch (failure) {
          error.textContent = failure.message;
          revoke.disabled = false;
        }
      });
      return el('div', { class: 'share-row' },
        el('div', {}, el('div', { class: 'link' }, url), el('div', { class: 'meta' }, new Date(share.created_at).toLocaleString())),
        el('div', { class: 'share-tools-row' }, copyButton, revoke));
    }

    create.addEventListener('click', async () => {
      create.disabled = true;
      error.textContent = '';
      try {
        await post(base, {});
        notice('Link ready. Copy it to share.');
        await load();
      } catch (failure) {
        error.textContent = failure.message;
        status.textContent = failure.message;
      } finally {
        create.disabled = false;
      }
    });
    close.addEventListener('click', () => dialog.close());
    showModal(dialog);
    void load();
  }

  /** Lists the server's share links with revoke buttons. It replaces the container's content. */
  async function renderShareList(container, server) {
    const status = el('p', { class: 'small', role: 'status' }, 'Loading share links...');
    const box = el('div', { class: 'share-list-box' });
    const revokeAll = el('button', { type: 'button' }, 'Revoke all links');
    container.replaceChildren(el('div', { class: 'share-tools-row' }, el('strong', {}, 'Share links'), revokeAll), status, box);

    async function load() {
      status.textContent = 'Loading share links...';
      const data = await request(`/api/shares?server=${encodeURIComponent(server)}`);
      status.textContent = data.shares.length ? '' : 'No share links yet.';
      box.replaceChildren(...data.shares.map(share => {
        const revoke = el('button', { type: 'button', ...(share.revoked ? { disabled: true } : {}) }, share.revoked ? 'Revoked' : 'Revoke');
        revoke.addEventListener('click', async () => {
          revoke.disabled = true;
          try { await post(`/api/shares/${encodeURIComponent(share.id)}/revoke`, {}); await load(); }
          catch (failure) { status.textContent = failure.message; revoke.disabled = false; }
        });
        const link = share.revoked ? el('span', { class: 'off' }, 'Link removed')
          : el('a', { href: `/s/${encodeURIComponent(share.id)}`, target: '_blank', rel: 'noopener noreferrer' }, `/s/${share.id}`);
        return el('div', { class: 'share-row' },
          el('div', {}, el('div', {}, 'Channel ', el('code', {}, share.channel)), link),
          revoke,
          el('div', { class: 'meta' }, new Date(share.created_at).toLocaleString(), share.revoked ? ' · revoked' : ''));
      }));
    }
    revokeAll.addEventListener('click', async () => {
      if (!await askConfirm({ title: 'Remove every share link?', body: 'Links in this server stop working at once.', confirmLabel: 'Remove all', danger: true })) return;
      try { await post('/api/shares/revoke-all', { server }); await load(); }
      catch (failure) { status.textContent = failure.message; }
    });
    try { await load(); } catch (failure) { status.textContent = failure.message; }
  }

  /* ---- Shared conversation page (/s/<id>). The page data is in #share-data, as JSON. ---- */

  const LOGO = { light: '/console/assets/logo-light.svg', dark: '/console/assets/logo-dark.svg' };
  const isLight = () => document.documentElement.classList.contains('light');

  function readTheme() {
    try { return localStorage.getItem('slopbot-theme') === 'light'; } catch { return false; }
  }

  function applyTheme(light) {
    document.documentElement.classList.toggle('light', light);
    const button = document.getElementById('share-theme');
    if (!button) return;
    button.textContent = light ? 'Dark' : 'Light';
    button.setAttribute('aria-label', light ? 'Switch to dark theme' : 'Switch to light theme');
  }

  // Markdown from web/markdown.js. It escapes all text before it adds tags, the same as in the chat.
  function setMarkdown(node, text) {
    const api = window.SlopbotMarkdown;
    if (api && typeof api.renderMarkdown === 'function') node.innerHTML = api.renderMarkdown(text);
    else node.textContent = text;
  }

  function shareMessage(message) {
    const bot = message.bot === true;
    const article = el('article', { class: `chat-msg ${bot ? 'bot' : 'mine'}` });
    if (bot) {
      // Slopbot's own line: one petal mark and the name, once.
      article.append(el('header', { class: 'chat-msg-head' },
        el('img', { class: 'chat-mark still', src: isLight() ? LOGO.dark : LOGO.light, alt: '', width: 18, height: 18 }),
        el('strong', {}, 'Slopbot'), messageTime(message.at)));
      if (message.tools.length) article.append(el('ul', { class: 'share-tools' }, ...message.tools.map(line => el('li', {}, line))));
      if (message.thinking) article.append(el('details', { class: 'share-thinking' }, el('summary', {}, 'Thinking'), el('div', { class: 'share-thinking-text' }, message.thinking)));
    } else {
      // Other people's messages keep their name above the bubble.
      article.append(el('header', { class: 'chat-msg-head' }, el('strong', {}, message.author), messageTime(message.at)));
    }
    if (message.images.length) {
      article.append(el('div', { class: 'chat-images' }, ...message.images.map(image => el('img', { src: image.src, alt: image.name, title: image.name, loading: 'lazy' }))));
    }
    if (message.text) {
      const body = el('div', { class: 'chat-text' });
      setMarkdown(body, message.text);
      article.append(body);
    }
    if (message.other) article.append(el('p', { class: 'share-att' }, `${message.other} attachment${message.other === 1 ? '' : 's'} not shown`));
    return article;
  }

  function messageTime(at) {
    if (!at) return el('time');
    const when = new Date(at);
    return el('time', { datetime: when.toISOString(), title: when.toLocaleString() }, when.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' }));
  }

  // Copies the share into a new private chat of the signed-in user, then opens it. Signed-out users sign in first; the share ID waits in sessionStorage.
  async function continueShare(id, button) {
    const status = document.getElementById('share-status');
    const show = text => { status.textContent = text; status.hidden = !text; };
    button.disabled = true;
    show('');
    try {
      let session = null;
      try { session = await request('/api/session'); }
      catch (failure) { if (failure.status !== 401) throw failure; }
      if (!session) {
        try { sessionStorage.setItem('slopbot-share', id); } catch { }
        location.href = '/auth/login';
        return;
      }
      const chat = await request(`/api/shares/${encodeURIComponent(id)}/continue`, { method: 'POST', headers: { 'X-CSRF-Token': session.csrf } });
      location.href = `/console#chat/${encodeURIComponent(chat.id)}`;
    } catch (failure) {
      show(failure.status === 404 ? 'This shared chat is no longer available.' : failure.message);
      button.disabled = false;
    }
  }

  function startSharePage() {
    const node = document.getElementById('share-data');
    if (!node) return;
    let data;
    try { data = JSON.parse(node.textContent); } catch { return; }
    applyTheme(readTheme());
    document.getElementById('share-theme').addEventListener('click', () => {
      const light = !isLight();
      try { localStorage.setItem('slopbot-theme', light ? 'light' : 'dark'); } catch { }
      applyTheme(light);
      document.querySelectorAll('img.chat-mark').forEach(img => { img.src = light ? LOGO.dark : LOGO.light; });
    });
    document.getElementById('share-log').replaceChildren(...data.messages.map(shareMessage));
    const status = document.getElementById('share-status');
    if (data.messages.some(message => message.images.length)) { status.textContent = 'Images are not copied when you continue.'; status.hidden = false; }
    const button = document.getElementById('share-continue');
    button.addEventListener('click', () => continueShare(data.id, button));
  }

  window.SlopbotShares = { renderShareButton, renderShareList, renderChatShare };
  startSharePage();
})();
