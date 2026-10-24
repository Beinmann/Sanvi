// Chat with the agent: a full-screen panel with a list of chats. Only active when the server runs with --agents.
import { renderMarkdown } from './md.js';

const store = {
  get: (k) => { try { return localStorage.getItem(`sanvi.chat.${k}`); } catch { return null; } },
  set: (k, v) => { try { localStorage.setItem(`sanvi.chat.${k}`, v); } catch { /* private window: just not remembered */ } },
};

export function initChat({ el, show, api, toast, button, project = () => '' }) {
  let usage = {};     // cost per provider, e.g. { claude: { costUsd } }
  let chats = [];     // list entries: { id, title, state }
  let queued = [];    // ticket files whose implementation waits for their refine run
  let chat = null;    // the open chat, as last fetched
  let drafts = {};    // unsent text per chat id
  let isOpen = false;
  let quiet = false;  // opened by the hotkey: leave the focus alone
  const panel = el('aside', { class: 'chatpanel', 'aria-label': 'Chat with Claude', hidden: true });
  document.body.append(panel);

  // Keyboard navigation (in the panel; while it is open, also anywhere outside input fields, taking precedence over the page hotkeys). Input: Esc (or Ctrl+Up) leaves for the messages. Messages: j/k scroll (hold to keep scrolling), Down/Up step message by message,
  // g/G first/last, i, Enter or Ctrl+Down return to the input, Esc closes. Anywhere in the panel: Alt+Left/Right (in the messages also plain h/l) switch chat.
  const HINT = '+ type · Esc: input → messages → close · a: open/close · j/k scroll, ↑/↓ step, g/G ends, i input · h/l chat · Ctrl+Enter send';
  const msgs = () => [...panel.querySelectorAll('.chatlog .msg')];
  const focusInput = () => panel.querySelector('textarea')?.focus();
  function focusMsg(to) {
    const all = msgs();
    if (!all.length) { const log = panel.querySelector('.chatlog'); if (!log) return false; log.focus(); return true; } // empty chat: the list itself takes focus
    const cur = all.indexOf(document.activeElement);
    const i = to === 'first' ? 0 : to === 'last' ? all.length - 1 : Math.min(all.length - 1, Math.max(0, cur < 0 ? all.length - 1 : cur + to));
    all[i].focus();
    all[i].scrollIntoView({ block: 'nearest' });
    return true;
  }
  // j/k in the messages: like on the ticket page, a tap nudges, holding scrolls at a steady speed per frame
  let hold = null; // { key, raf, t }
  function scrollHold(dir, e) {
    const log = panel.querySelector('.chatlog');
    if (!log) return false;
    if (e.repeat || hold) return true;
    hold = { key: e.key, raf: 0, t: performance.now() };
    log.scrollBy({ top: dir * 24, behavior: 'instant' });
    const step = (now) => {
      if (!hold) return;
      log.scrollBy({ top: dir * 0.8 * Math.min(now - hold.t, 50), behavior: 'instant' }); // ~800 px/s
      hold.t = now;
      hold.raf = requestAnimationFrame(step);
    };
    hold.raf = requestAnimationFrame(step);
    return true;
  }
  const stopHold = () => { if (hold) { cancelAnimationFrame(hold.raf); hold = null; } };
  document.addEventListener('keyup', (e) => { if (hold && e.key === hold.key) stopHold(); });
  window.addEventListener('blur', stopHold);
  function stepChat(d) {
    const list = visible();
    const i = list.findIndex((c) => c.id === chat?.id);
    const next = list[i + d];
    if (next) openChat(next.id).catch((err) => toast(err.message));
  }
  // typing in or activating something outside the panel: leave the key alone
  const isField = (n) => !!n && (['INPUT', 'TEXTAREA', 'SELECT', 'BUTTON', 'A', 'SUMMARY'].includes(n.tagName) || n.isContentEditable);
  function onKey(e) {
    const loose = !panel.contains(document.activeElement) && !isField(document.activeElement); // focus outside the panel: act as if in the messages
    const inLog = loose || document.activeElement?.classList.contains('msg') || document.activeElement?.classList.contains('chatlog');
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    let handled = true;
    if (e.altKey && !e.ctrlKey && !e.metaKey && (e.key === 'ArrowLeft' || e.key === 'ArrowRight')) stepChat(e.key === 'ArrowLeft' ? -1 : 1);
    else if (e.target.tagName === 'TEXTAREA' && ((e.ctrlKey && e.key === 'ArrowUp') || (e.key === 'Escape' && plain))) handled = focusMsg('last');
    else if (inLog && !e.ctrlKey && !e.metaKey && !e.altKey && (e.key === 'h' || e.key === 'l')) stepChat(e.key === 'h' ? -1 : 1);
    else if (inLog && plain && e.key === 'j') handled = scrollHold(1, e);
    else if (inLog && plain && e.key === 'k') handled = scrollHold(-1, e);
    else if (inLog && plain && e.key === 'ArrowDown') { if (!focusMsg(1)) handled = false; }
    else if (inLog && plain && e.key === 'ArrowUp') focusMsg(-1);
    else if (inLog && plain && e.key === 'g') focusMsg('first');
    else if (inLog && (e.key === 'G' || (e.ctrlKey && e.key === 'End'))) focusMsg('last');
    else if (inLog && ((plain && (e.key === 'i' || e.key === 'Enter')) || (e.ctrlKey && e.key === 'ArrowDown'))) focusInput();
    else if (inLog && e.key === 'Escape') toggle(false);
    else handled = false;
    if (handled) { e.preventDefault(); e.stopPropagation(); }
  }
  panel.addEventListener('keydown', onKey);
  document.addEventListener('keydown', (e) => { if (isOpen && !panel.contains(e.target) && !isField(e.target)) onKey(e); }, true);

  const mark = (c) => {
    if (c.state === 'running') return '… ';
    if (c.state === 'queued') return '⏳ ';
    if (c.state === 'failed') return '! ';
    if (c.kind !== 'refine') return '';
    return c.outcome === 'problems' ? '⚠ ' : c.outcome === 'questions' ? '? ' : '✓ ';
  };
  // The chat picker: a button plus a popup list, built once and patched in place (paint() must not rebuild it, or an open list would close on every agent event).
  // By default it lists running/queued chats, the open one and those opened in this session; "Show all" adds the older ones.
  let showAll = store.get('showAll') === '1';
  let pickOpen = false;
  let hl = null;                 // highlighted chat id while the list is open
  const seen = new Set();        // chats opened in this session
  const visible = () => chats.filter((c) => showAll || active(c) || c.id === chat?.id || seen.has(c.id));
  const trigger = el('button', { type: 'button', class: 'pickbtn', 'aria-haspopup': 'listbox', 'aria-expanded': 'false', 'aria-label': 'Chat', onclick: () => setPick(!pickOpen) });
  const popup = el('div', { class: 'pickpop', role: 'listbox', tabindex: '0', 'aria-label': 'Chats', hidden: true });
  const picker = el('div', { class: 'chatpick' }, trigger, popup);
  const kindOf = (c) => (c.kind === 'refine' ? 'Refine' : c.kind === 'implement' ? 'Implement' : c.kind === 'review' ? 'Review' : c.kind === 'ask' ? 'Ask' : 'Chat');
  const rowTitle = (c) => c.title.replace(/^(Refine|Implement|Review) #\S+?:\s*/, '');
  const stateWord = (c) => (c.state === 'running' ? 'running' : c.state === 'queued' ? 'queued' : c.state === 'failed' ? 'failed' : c.kind === 'refine' && c.outcome === 'problems' ? 'problems' : c.kind === 'refine' && c.outcome === 'questions' ? 'questions' : c.state === 'idle' ? '' : 'done');
  function pickRow(c) {
    const word = stateWord(c);
    return el('div', { class: `pickrow${c.id === hl ? ' hl' : ''}${c.id === chat?.id ? ' cur' : ''}`, role: 'option', 'aria-selected': c.id === chat?.id ? 'true' : 'false', 'data-id': c.id, title: c.title, onmousedown: (e) => e.preventDefault(), onclick: () => choose(c.id) },
      el('span', { class: `pickstate ${c.state}${c.state === 'idle' ? ' ' + (c.outcome || '') : ''}` }, mark(c).trim() || '·'),
      el('span', { class: 'pickkind' }, kindOf(c)),
      c.ticketId ? el('span', { class: 'pickid' }, `#${c.ticketId}`) : null,
      el('span', { class: 'picktitle' }, rowTitle(c)),
      word ? el('span', { class: 'pickword muted' }, word) : null);
  }
  function renderPicker() {
    const list = visible();
    const cur = chats.find((c) => c.id === chat?.id);
    trigger.replaceChildren(cur ? `${mark(cur)}${cur.title}` : 'Chat', el('span', { class: 'caret' }, '▾'));
    if (!list.some((c) => c.id === hl)) hl = chat?.id ?? list[0]?.id ?? null;
    const hidden = chats.length - list.length;
    popup.replaceChildren(...list.map(pickRow),
      !list.length ? el('p', { class: 'muted pickempty' }, 'No open chats') : null,
      chats.length > list.length || showAll
        ? el('div', { class: 'pickrow pickmore', role: 'option', onmousedown: (e) => e.preventDefault(), onclick: toggleAll }, showAll ? 'Show only open chats' : `Show all (${hidden} older)`)
        : null);
    popup.querySelector('.hl')?.scrollIntoView({ block: 'nearest' });
  }
  function toggleAll() { showAll = !showAll; store.set('showAll', showAll ? '1' : '0'); renderPicker(); }
  function setPick(on) {
    if (!on && popup.contains(document.activeElement)) trigger.focus();
    pickOpen = on;
    popup.hidden = !on;
    trigger.setAttribute('aria-expanded', String(on));
    if (on) { hl = chat?.id ?? null; renderPicker(); popup.focus(); }
  }
  function choose(id) { setPick(false); if (id !== chat?.id) openChat(id).catch((err) => toast(err.message)); else focusInput(); }
  function pickKey(e) {
    const list = visible();
    const i = list.findIndex((c) => c.id === hl);
    const move = (to) => { hl = list[Math.max(0, Math.min(list.length - 1, to))]?.id ?? null; renderPicker(); };
    const k = e.key;
    if (e.ctrlKey || e.metaKey || e.altKey) return;
    if (k === 'ArrowDown' || k === 'j') move(i + 1);
    else if (k === 'ArrowUp' || k === 'k') move(i - 1);
    else if (k === 'Home' || k === 'g') move(0);
    else if (k === 'End' || k === 'G') move(list.length - 1);
    else if (k === 'Enter' || k === ' ') { if (hl) choose(hl); }
    else if (k === 'a') toggleAll();
    else if (k === 'Escape' || k === 'Tab') { setPick(false); if (k === 'Tab') return; trigger.focus(); }
    else return;
    e.preventDefault(); e.stopPropagation();
  }
  popup.addEventListener('keydown', pickKey);
  popup.addEventListener('blur', () => setTimeout(() => { if (pickOpen && !picker.contains(document.activeElement)) setPick(false); }, 0));
  trigger.addEventListener('keydown', (e) => { if (e.key === 'ArrowDown' && !e.altKey) { e.preventDefault(); setPick(true); } });
  // The header is built once too, so the picker keeps focus across paint(); only the body below it is rebuilt.
  const delBtn = el('button', { type: 'button', title: 'Delete this chat', onclick: () => remove() }, '🗑');
  const head = el('div', { class: 'chathead' }, picker,
    el('button', { type: 'button', title: 'New read-only question about the board', onclick: () => ask().catch((e) => toast(e.message)) }, '?'),
    el('button', { type: 'button', title: 'New chat', onclick: () => openChat(null).catch((e) => toast(e.message)) }, '+'),
    delBtn,
    el('button', { type: 'button', title: 'Close (Esc)', onclick: () => toggle(false) }, '×'));
  const body = el('div', { class: 'chatbody' });
  panel.append(head, body);
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
    queued = await api('GET', 'agent/queued').catch(() => queued);
    paintButton();
    renderPicker();
    for (const fn of changed) fn();
  }

  async function openChat(id) {
    if (chat) drafts[chat.id] = panel.querySelector('textarea')?.value ?? drafts[chat.id] ?? '';
    chat = id ? await api('GET', `agent/chats/${id}`) : await api('POST', 'agent/chats', { project: project() });
    store.set('current', chat.id);
    seen.add(chat.id);
    await refreshList();
    paint();
  }

  // A new read-only "ask about the board" chat, optionally with the first question already sent.
  async function ask(question) {
    const c = await api('POST', 'agent/ask', { question: question || '' });
    if (chat) drafts[chat.id] = panel.querySelector('textarea')?.value ?? drafts[chat.id] ?? '';
    chat = c;
    seen.add(c.id);
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

  async function review(file) {
    const c = await api('POST', 'agent/review', { file });
    await refreshList();
    toast(`Reviewing: ${c.title}`);
  }

  async function implement(file) {
    const c = await api('POST', 'agent/implement', { file });
    await refreshList();
    toast(c.queued ? `Queued: ${c.title}` : `Implementing: ${c.title}`);
  }

  // Stops the ticket's runs and drops its queued implementation (the server clears the queue before it cancels).
  async function cancelAgent(file) {
    const r = await api('POST', 'agent/cancel-ticket', { file });
    await refreshList();
    toast(r.cancelled || r.queuedDropped ? 'Claude run cancelled' : 'Nothing to cancel');
  }

  async function refineAll() {
    const r = await api('POST', 'agent/refine-all', {});
    await refreshList();
    toast(r.started ? `Refining ${r.started} design ticket${r.started > 1 ? 's' : ''}${r.skipped ? ` (${r.skipped} already running)` : ''}` : r.skipped ? 'All design tickets are already being refined' : 'No design tickets to refine');
  }

  async function toggle(force) {
    isOpen = force ?? !isOpen;
    if (!isOpen) stopHold();
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
    try { chat = await api('POST', `agent/chats/${chat.id}/messages`, { text }); drafts[chat.id] = ''; input.value = ''; await refreshList(); paint(); focusInput(); } catch (e) { toast(`Not sent: ${e.message}`); }
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
    const keep = body.querySelector('textarea');
    const typed = keep ? keep.value : drafts[chat.id] ?? '';
    const hadFocus = keep && document.activeElement === keep;
    const input = el('textarea', {
      rows: 3, placeholder: chat.kind === 'ask' ? 'Ask about the board (read-only; Ctrl+Enter to send)' : 'Message Claude (Ctrl+Enter to send)', 'aria-label': 'Message',
      onkeydown: (e) => {
        if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(input); }
      },
    });
    input.value = typed;
    renderPicker();
    const log = el('div', { class: 'chatlog', tabindex: '-1' },
      chat.messages.length ? chat.messages.map(bubble) : el('p', { class: 'muted' }, chat.kind === 'ask' ? 'Ask about tickets and what changed. Claude can only read the tickets and the change log here; it cannot edit anything.' : chat.kind === 'refine' ? 'Refine run: Claude may edit only this ticket.' : 'Claude runs on this machine with read access to the project and permission to edit files there.'));
    delBtn.disabled = running;
    show(body,
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
          ? el('button', { type: 'button', class: 'danger', title: 'Stop the AI now; the partial answer is kept and the chat can be used again', onclick: () => api('POST', `agent/chats/${chat.id}/cancel`, {}).catch((e) => toast(e.message)) }, '■ Stop')
          : el('button', { type: 'button', class: 'primary', onclick: () => submit(input) }, 'Send')));
    log.scrollTop = log.scrollHeight;
    if (hadFocus || (!keep && !running && !quiet)) input.focus();
  }

  // Hotkey `a`: open without taking focus; again: close.
  async function hotkey() {
    if (isOpen) { await toggle(false); return; }
    quiet = true;
    try { await toggle(true); } finally { quiet = false; }
  }
  // Hotkey `+`: open if needed, then focus the message input.
  async function focusTyping() {
    if (!isOpen) await toggle(true);
    focusInput();
  }

  button.addEventListener('click', () => toggle());
  return {
    toggle, hotkey, focusTyping, isOpen: () => isOpen, close: () => toggle(false), onEvent, ask, refine, review, implement, cancelAgent, refineAll, onChange: (fn) => changed.push(fn),
    refining: (file) => chats.some((c) => c.ticket === file && c.kind === 'refine' && active(c)),
    implementQueued: (file) => queued.includes(file),
    reviewing: (file) => chats.some((c) => c.ticket === file && c.kind === 'review' && active(c)),
    // The most recent chat linked to a ticket (the list is newest first), or null.
    busy: (file) => queued.includes(file) || chats.some((c) => c.ticket === file && active(c)),
    implementing: (file) => chats.some((c) => c.ticket === file && c.kind === 'implement' && active(c)),
    forTicket: (id, proj = '') => (id && chats.find((c) => c.ticketId === id && (c.project || '') === proj)) || null,
    allForTicket: (id, proj = '') => (id ? chats.filter((c) => c.ticketId === id && (c.project || '') === proj) : []),
    open: async (id) => { await toggle(true); await openChat(id); },
    start: () => refreshList().catch(() => {}),
  };
}
