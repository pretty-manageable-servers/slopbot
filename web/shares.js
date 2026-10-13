// Share links for the web console. Load with <script src="/shares.js" defer>.
// Exposes window.SlopbotShares.renderShareButton and renderShareList.
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
    if (!response.ok) throw new Error(data.error || 'Request failed.');
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
    dialog.addEventListener('close', () => dialog.remove());
    document.body.append(dialog);
    dialog.showModal();
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
      if (!confirm('Remove every share link in this server? Links stop working at once.')) return;
      try { await post('/api/shares/revoke-all', { server }); await load(); }
      catch (failure) { status.textContent = failure.message; }
    });
    try { await load(); } catch (failure) { status.textContent = failure.message; }
  }

  window.SlopbotShares = { renderShareButton, renderShareList };
})();
