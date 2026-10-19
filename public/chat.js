// Chat with the agent: a floating panel (expandable) with a list of chats. Only active when the server runs with --agents.
import { renderMarkdown } from './md.js';

const store = {
  get: (k) => { try { return localStorage.getItem(`sanvi.chat.${k}`); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(`sanvi.chat.${k}`, v); } catch { /* private window: just not remembered */ } },
};

export function initChat({ el, show, api, toast, button, project = () => '' }) {
  let usage = {};     // cost per provider, e.g. { claude: { costUsd } }
  let chats = [];     // list entries: { id, title, state }
  let chat = null;    // the open chat, as last fetched
  let drafts = {};    // unsent text per chat id
  let isOpen = false;
  let wide = store.get('wide') === '1';
  const panel = el('aside', { class: 'chatpanel', 'aria-label': 'Chat with Claude', hidden: true });
  document.body.append(panel);

  // Keyboard navigation. Input: Ctrl+Up leaves for the messages. Messages: j/k or Down/Up step, g/G first/last,
  // i, Enter or Ctrl+Down return to the input. Anywhere in the panel: Alt+Left/Right switch chat, Esc closes.
  const HINT = 'Ctrl+Enter send · Ctrl+↑ messages · in messages: j/k step, g/G ends, i input · Alt+←/→ chat · Esc close';
  const msgs = () => [...panel.querySelectorAll('.chatlog .msg')];
  const focusInput = () => panel.querySelector('textarea')?.focus();
  function focusMsg(to) {
    const all = msgs();
    if (!all.length) return false;
    const cur = all.indexOf(document.activeElement);
    const i = to === 'first' ? 0 : to === 'last' ? all.length - 1 : Math.min(all.length - 1, Math.max(0, cur < 0 ? all.length - 1 : cur + to));
    all[i].focus();
    all[i].scrollIntoView({ block: 'nearest' });
    return true;
  }
  function stepChat(d) {
    const i = chats.findIndex((c) => c.id === chat?.id);
    const next = chats[i + d];
    if (next) openChat(next.id).catch((err) => toast(err.message));
  }
  panel.addEventListener('keydown', (e) => {
    const inLog = document.activeElement?.classList.contains('msg');
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    let handled = true;
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) stepChat(e.key === 'ArrowLeft' ? -1 : 1);
    else if (e.target.tagName === 'TEXTAREA' && e.ctrlKey && e.key === 'ArrowUp') handled = focusMsg('last');
    else if (inLog && plain && (e.key === 'j' || e.key === 'ArrowDown')) { if (!focusMsg(1)) handled = false; }
    else if (inLog && plain && (e.key === 'k' || e.key === 'ArrowUp')) focusMsg(-1);
    else if (inLog && plain && e.key === 'g') focusMsg('first');
    else if (inLog && (e.key === 'G' || (e.ctrlKey && e.key === 'End'))) focusMsg('last');
    else if (inLog && ((plain && (e.key === 'i' || e.key === 'Enter')) || (e.ctrlKey && e.key === 'ArrowDown'))) focusInput();
    else if (inLog && e.key === 'Escape') toggle(false);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  });

  const mark = (c) => {
    if (c.state === 'running') return '… ';
    if (c.state === 'queued') return '⏳ ';
    if (c.state === 'failed') return '! ';
    if (c.kind !== 'refine') return '';
    return c.outcome === 'problems' ? '⚠ ' : c.outcome === 'questions' ? '? ' : '✓ ';
  };
  const changed = [];  // callbacks: the set of tickets being refined may have changed
  const active = (c) => c.state === 'running' || c.state === 'queued';
  const paintButton = () => {
    const n = chats.filter(active).length;
    button.textContent = n ? `Chat · ${n} running` : 'Chat';
    const cost = usage.claude?.costUsd;
    button.title = `Chat with Claude${cost == null ? '' : `\nClaude usage so far: $${cost.toFixed(2)} (cost recorded by Sanvi)`}`;
  };

  async function refreshList() {
    chats = await api('GET', 'agent/chats');
    usage = await api('GET', 'agent/usage').catch(() => usage);
    paintButton();
    for (const fn of changed) fn();
  }

  async function openChat(id) {
    if (chat) drafts[chat.id] = panel.querySelector('textarea')?.value ?? drafts[chat.id] ?? '';
    chat = id ? await api('GET', `agent/chats/${id}`) : await api('POST', 'agent/chats', { project: project() });
    store.set('current', chat.id);
    await refreshList();
    paint();
  }

  // A new read-only "ask about the board" chat, optionally with the first question already sent.
  async function ask(question) {
    const c = await api('POST', 'agent/ask', { question: question || '' });
    if (chat) drafts[chat.id] = panel.querySelector('textarea')?.value ?? drafts[chat.id] ?? '';
    chat = c;
    store.set('current', c.id);
    await toggle(true);
    await refreshList();
    paint();
  }

  async function refine(file) {
    const c = await api('POST', 'agent/refine', { file });
    await refreshList();
    toast(`Refining: ${c.title}`);
  }

  async function implement(file) {
    const c = await api('POST', 'agent/implement', { file });
    await refreshList();
    toast(`Implementing: ${c.title}`);
  }

  async function refineAll() {
    const r = await api('POST', 'agent/refine-all', {});
    await refreshList();
    toast(r.started ? `Refining ${r.started} design ticket${r.started > 1 ? 's' : ''}${r.skipped ? ` (${r.skipped} already running)` : ''}` : r.skipped ? 'All design tickets are already being refined' : 'No design tickets to refine');
  }

  async function toggle(force) {
    isOpen = force ?? !isOpen;
    panel.hidden = !isOpen;
    if (!isOpen) return;
    try {
      await refreshList();
      const want = store.get('current');
      if (!chat) await openChat(chats.find((c) => c.id === want)?.id ?? chats[0]?.id ?? null);
      else { chat = await api('GET', `agent/chats/${chat.id}`); paint(); }
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
    return el('div', { class: `msg ${m.role}`, tabindex: '0' },
      el('div', { class: 'who' }, m.role === 'user' ? 'You' : 'Claude'),
      body,
      m.tools?.length ? el('div', { class: 'tools' }, `used: ${m.tools.join(', ')}`) : null);
  }

  async function submit(input) {
    const text = input.value.trim();
    if (!text || chat.state === 'running') return;
    try { chat = await api('POST', `agent/chats/${chat.id}/messages`, { text }); drafts[chat.id] = ''; await refreshList(); paint(); } catch (e) { toast(`Not sent: ${e.message}`); }
  }

  async function changeDir(input) {
    const dir = input.value.trim();
    if (!dir || dir === chat.cwd) return;
    try { chat = await api('PUT', `agent/chats/${chat.id}`, { dir }); } catch (e) { toast(`Directory not changed: ${e.message}`); input.value = chat.cwd; return; }
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
    const running = chat.state === 'running' || chat.state === 'queued';
    const keep = panel.querySelector('textarea');
    const typed = keep ? keep.value : drafts[chat.id] ?? '';
    const hadFocus = keep && document.activeElement === keep;
    const input = el('textarea', {
      rows: 3, placeholder: chat.kind === 'ask' ? 'Ask about the board (read-only; Ctrl+Enter to send)' : 'Message Claude (Ctrl+Enter to send)', 'aria-label': 'Message',
      onkeydown: (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(input); }
        else if (e.key === 'Escape') { e.stopPropagation(); toggle(false); }
      },
    });
    input.value = typed;
    const select = el('select', { 'aria-label': 'Chat', onchange: (e) => openChat(e.target.value).catch((err) => toast(err.message)) },
      chats.map((c) => el('option', { value: c.id, selected: c.id === chat.id }, `${mark(c)}${c.title}`)));
    const log = el('div', { class: 'chatlog' },
      chat.messages.length ? chat.messages.map(bubble) : el('p', { class: 'muted' }, chat.kind === 'ask' ? 'Ask about tickets and what changed. Claude can only read the tickets and the change log here; it cannot edit anything.' : chat.kind === 'refine' ? 'Refine run: Claude may edit only this ticket.' : 'Claude runs on this machine with read access to the project and permission to edit files there.'));
    panel.classList.toggle('wide', wide);
    show(panel,
      el('div', { class: 'chathead' }, select,
        el('button', { type: 'button', title: 'New read-only question about the board', onclick: () => ask().catch((e) => toast(e.message)) }, '?'),
        el('button', { type: 'button', title: 'New chat', onclick: () => openChat(null).catch((e) => toast(e.message)) }, '+'),
        el('button', { type: 'button', title: 'Delete this chat', disabled: running, onclick: remove }, '🗑'),
        el('button', { type: 'button', title: wide ? 'Smaller' : 'Larger', onclick: () => { wide = !wide; store.set('wide', wide ? '1' : '0'); paint(); } }, wide ? '▢' : '⤢'),
        el('button', { type: 'button', title: 'Close (Esc)', onclick: () => toggle(false) }, '×')),
      chat.messages.length || chat.kind !== 'chat'
        ? el('div', { class: 'chatmeta muted', title: `${chat.cwd}\nThe cost is the Claude CLI's own estimate at API prices. On a subscription login it is not charged to you; it counts against your plan limits. With ANTHROPIC_API_KEY set it is real spend.` }, `${chat.cwd.split('/').slice(-2).join('/')} · ${running ? 'answering…' : chat.state === 'queued' ? 'waiting for a free slot…' : chat.costUsd ? `≈ $${chat.costUsd.toFixed(3)} at API rates` : 'ready'}`)
        : el('label', { class: 'chatmeta muted dirrow', title: 'Directory this chat runs in (a path on the machine running Sanvi). Fixed after the first message; set per project on the Projects page.' }, 'Directory ',
          el('input', { value: chat.cwd, spellcheck: 'false', 'aria-label': 'Directory', onchange: (e) => changeDir(e.target), onkeydown: (e) => { if (e.key === 'Enter') e.target.blur(); } })),
      log,
      chat.error ? el('div', { class: 'banner err' }, chat.error) : null,
      chat.warning ? el('div', { class: 'banner' }, chat.warning) : null,
      el('div', { class: 'chathint muted', title: 'Keyboard shortcuts in the chat panel' }, HINT),
      usage.claude ? el('div', { class: 'chathint muted', title: 'Summed over all known chats and runs, as recorded by Sanvi (not your plan quota)' }, `Claude usage: ≈ $${usage.claude.costUsd.toFixed(2)} at API rates`) : null,
      el('div', { class: 'chatinput' }, input,
        running
          ? el('button', { type: 'button', onclick: () => api('POST', `agent/chats/${chat.id}/cancel`, {}).catch((e) => toast(e.message)) }, 'Cancel')
          : el('button', { type: 'button', class: 'primary', onclick: () => submit(input) }, 'Send')));
    log.scrollTop = log.scrollHeight;
    if (hadFocus || (!keep && !running)) input.focus();
  }

  button.addEventListener('click', () => toggle());
  return {
    toggle, isOpen: () => isOpen, close: () => toggle(false), onEvent, ask, refine, implement, refineAll, onChange: (fn) => changed.push(fn),
    refining: (file) => chats.some((c) => c.ticket === file && c.kind === 'refine' && active(c)),
    // The most recent chat linked to a ticket (the list is newest first), or null.
    forTicket: (id, proj = '') => (id && chats.find((c) => c.ticketId === id && (c.project || '') === proj)) || null,
    open: async (id) => { await toggle(true); await openChat(id); },
    start: () => refreshList().catch(() => {}),
  };
}
