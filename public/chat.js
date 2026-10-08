// Chat with the agent: a floating panel (expandable) with a list of chats. Only active when the server runs with --agents.
import { renderMarkdown } from './md.js';

const store = {
  get: (k) => { try { return localStorage.getItem(`sanvi.chat.${k}`); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(`sanvi.chat.${k}`, v); } catch { /* private window: just not remembered */ } },
};

export function initChat({ el, show, api, toast, button, project = () => '' }) {
  let chats = [];     // list entries: { id, title, state }
  let chat = null;    // the open chat, as last fetched
  let drafts = {};    // unsent text per chat id
  let info = { dirs: {} }; // from GET agent: the default directory and the remembered directory per project
  let isOpen = false;
  let wide = store.get('wide') === '1';
  const panel = el('aside', { class: 'chatpanel', 'aria-label': 'Chat with Claude', hidden: true });
  document.body.append(panel);

  const mark = (s) => (s === 'running' ? '… ' : s === 'failed' ? '! ' : '');
  const paintButton = () => {
    const n = chats.filter((c) => c.state === 'running').length;
    button.textContent = n ? `Chat (${n}…)` : 'Chat';
  };

  async function refreshList() { chats = await api('GET', 'agent/chats'); paintButton(); }

  async function openChat(id) {
    if (chat) drafts[chat.id] = panel.querySelector('textarea')?.value ?? drafts[chat.id] ?? '';
    chat = id ? await api('GET', `agent/chats/${id}`) : await api('POST', 'agent/chats', { project: project() });
    store.set('current', chat.id);
    await refreshList();
    paint();
  }

  async function toggle(force) {
    isOpen = force ?? !isOpen;
    panel.hidden = !isOpen;
    if (!isOpen) return;
    try {
      await refreshList();
      const want = store.get('current');
      if (!chat) await openChat(chats.find((c) => c.id === want)?.id ?? chats[0]?.id ?? null);
      else paint();
    } catch (e) { toast(`Chat failed: ${e.message}`); }
  }

  async function onEvent(msg) {
    try {
      await refreshList();
      if (!isOpen) return;
      if (chat && msg.id === chat.id) {
        if (!chats.some((c) => c.id === chat.id)) { chat = null; return openChat(chats[0]?.id ?? null); } // deleted elsewhere
        chat = await api('GET', `agent/chats/${chat.id}`);
      }
      paint();
    } catch { /* the next event retries */ }
  }

  function bubble(m) {
    const body = el('div', { class: 'md' });
    if (m.role === 'user') body.textContent = m.text;
    else body.innerHTML = m.text ? renderMarkdown(m.text) : '';
    return el('div', { class: `msg ${m.role}` },
      el('div', { class: 'who' }, m.role === 'user' ? 'You' : 'Claude'),
      body,
      m.tools?.length ? el('div', { class: 'tools' }, `used: ${m.tools.join(', ')}`) : null);
  }

  async function submit(input) {
    const text = input.value.trim();
    if (!text || chat.state === 'running') return;
    try { chat = await api('POST', `agent/chats/${chat.id}/messages`, { text }); drafts[chat.id] = ''; await refreshList(); paint(); } catch (e) { toast(`Not sent: ${e.message}`); }
  }

  async function changeDir() {
    const dir = prompt('Directory this chat runs in (absolute path or ~/...):', chat.cwd);
    if (dir === null || dir.trim() === chat.cwd) return;
    try { chat = await api('PUT', `agent/chats/${chat.id}`, { dir }); } catch (e) { toast(`Directory not changed: ${e.message}`); return; }
    const proj = project();
    if (proj && info.dirs[proj] !== chat.cwd && confirm(`Start new chats of project "${proj}" in\n${chat.cwd} ?`)) {
      try { info.dirs = await api('PUT', 'agent/dirs', { project: proj, dir: chat.cwd }); } catch (e) { toast(`Not remembered: ${e.message}`); }
    }
    paint();
  }

  async function remove() {
    if (!confirm(`Delete the chat "${chat.title}"?`)) return;
    try { await api('DELETE', `agent/chats/${chat.id}`, {}); } catch (e) { toast(`Not deleted: ${e.message}`); return; }
    delete drafts[chat.id];
    chat = null;
    await refreshList();
    await openChat(chats[0]?.id ?? null);
  }

  function paint() {
    if (!chat) return;
    const running = chat.state === 'running';
    const keep = panel.querySelector('textarea');
    const typed = keep ? keep.value : drafts[chat.id] ?? '';
    const hadFocus = keep && document.activeElement === keep;
    const input = el('textarea', {
      rows: 3, placeholder: 'Message Claude (Ctrl+Enter to send)', 'aria-label': 'Message',
      onkeydown: (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(input); }
        else if (e.key === 'Escape') { e.stopPropagation(); toggle(false); }
      },
    });
    input.value = typed;
    const select = el('select', { 'aria-label': 'Chat', onchange: (e) => openChat(e.target.value).catch((err) => toast(err.message)) },
      chats.map((c) => el('option', { value: c.id, selected: c.id === chat.id }, `${mark(c.state)}${c.title}`)));
    const log = el('div', { class: 'chatlog' },
      chat.messages.length ? chat.messages.map(bubble) : el('p', { class: 'muted' }, 'Claude runs on this machine with read access to the project and permission to edit files there.'));
    panel.classList.toggle('wide', wide);
    show(panel,
      el('div', { class: 'chathead' }, select,
        el('button', { type: 'button', title: 'New chat', onclick: () => openChat(null).catch((e) => toast(e.message)) }, '+'),
        el('button', { type: 'button', title: chat.messages.length ? 'The directory is fixed once a chat has started' : 'Change the directory this chat runs in', disabled: !!chat.messages.length, onclick: changeDir }, '📁'),
        el('button', { type: 'button', title: 'Delete this chat', disabled: running, onclick: remove }, '🗑'),
        el('button', { type: 'button', title: wide ? 'Smaller' : 'Larger', onclick: () => { wide = !wide; store.set('wide', wide ? '1' : '0'); paint(); } }, wide ? '▢' : '⤢'),
        el('button', { type: 'button', title: 'Close (Esc)', onclick: () => toggle(false) }, '×')),
      el('div', { class: 'chatmeta muted', title: chat.cwd }, `${chat.cwd.split('/').slice(-2).join('/')} · ${running ? 'answering…' : chat.costUsd ? `$${chat.costUsd.toFixed(3)} so far` : 'ready'}`),
      log,
      chat.error ? el('div', { class: 'banner err' }, chat.error) : null,
      el('div', { class: 'chatinput' }, input,
        running
          ? el('button', { type: 'button', onclick: () => api('POST', `agent/chats/${chat.id}/cancel`, {}).catch((e) => toast(e.message)) }, 'Cancel')
          : el('button', { type: 'button', class: 'primary', onclick: () => submit(input) }, 'Send')));
    log.scrollTop = log.scrollHeight;
    if (hadFocus || (!keep && !running)) input.focus();
  }

  button.addEventListener('click', () => toggle());
  return { toggle, onEvent, start: () => Promise.all([refreshList(), api('GET', 'agent').then((a) => { info = a; })]).catch(() => {}) };
}
