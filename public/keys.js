// Keyboard layer: global hotkeys, Ctrl+K command menu and the `?` help overlay.
// Pure helpers are exported for tests; DOM wiring happens in initKeys().

// ------------------------------------------------------------ pure helpers

/** Every whitespace-separated token must occur in the label (case-insensitive). */
export function matches(label, query) {
  const l = label.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((tok) => l.includes(tok.replace(/^#/, '')));
}

/**
 * Move within board columns. `cols` is an array of arrays of items; `pos` is
 * {col, row} or null. Returns the new {col, row}, or null if nothing to focus.
 * dir: 'next' | 'prev' (within column), 'left' | 'right' (across non-empty columns).
 */
export function step(cols, pos, dir) {
  const filled = cols.map((c, i) => (c.length ? i : -1)).filter((i) => i >= 0);
  if (!filled.length) return null;
  if (!pos || !cols[pos.col]?.length) return { col: filled[0], row: 0 };
  const { col, row } = pos;
  if (dir === 'next') return { col, row: Math.min(row + 1, cols[col].length - 1) };
  if (dir === 'prev') return { col, row: Math.max(row - 1, 0) };
  const target = dir === 'right' ? filled.find((i) => i > col) : [...filled].reverse().find((i) => i < col);
  if (target == null) return pos;
  return { col: target, row: Math.min(row, cols[target].length - 1) };
}

export const isTyping = (t) => !!t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

export const HELP = [
  ['Everywhere', [
    ['Ctrl+K', 'Command menu: jump to a ticket, change status, new ticket'],
    ['?', 'Show / hide this help'],
    ['n', 'New ticket'],
    ['b', 'Go to the board'],
    ['Ctrl+I', 'Quick idea overlay, also while typing (your edit is kept)'],
    ['i', 'Quick idea page (just text, no title)'],
    ['/', 'Board: focus the search box'],
    ['Esc', 'Close overlay, leave a field, go back to the board'],
  ]],
  ['Board', [
    ['j / k', 'Next / previous card in the column'],
    ['h / l', 'Previous / next column'],
    ['Enter', 'Open the focused ticket'],
    ['1-9', 'Move the focused (or dragged) ticket to that column; numbers show on the column headers'],
    ['s', 'Set status of the focused ticket (menu)'],
    ['Drag a column header', 'Reorder the status columns (saved in _config.yml)'],
  ]],
  ['Ticket', [
    ['e / p', 'Edit / preview'],
    ['s', 'Set status (unsaved until you save)'],
    ['Ctrl+S', 'Save'],
    ['Esc', 'Leave the editor; Esc again returns to the board'],
  ]],
];

// -------------------------------------------------------------- DOM wiring

/**
 * ctx: { S, el, columns(), detail(): D|null, moveTicket(file, status), setDraftStatus(status),
 *        setTab(tab), toast(msg) }
 */
export function initKeys(ctx) {
  const { S, el } = ctx;
  const $ = (s) => document.querySelector(s);
  let overlay = null; // { node, close }

  const hashRoute = () => {
    const h = location.hash || '#/';
    return h.startsWith('#/t/') ? 'detail' : h === '#/new' || h === '#/idea' ? 'new' : h === '#/' || h.startsWith('#/?') ? 'board' : 'other';
  };

  // ---- board focus
  const boardCols = () => ctx.columns().map((s) =>
    [...document.querySelectorAll('.col')].find((c) => c.dataset.status === s)?.querySelectorAll('.card') ?? []);
  const focusedCard = () => document.activeElement?.closest?.('.card') ?? null;
  function moveFocus(dir) {
    const cols = boardCols().map((c) => [...c]);
    const cur = focusedCard();
    let pos = null;
    if (cur) cols.forEach((c, ci) => { const ri = c.indexOf(cur); if (ri >= 0) pos = { col: ci, row: ri }; });
    const next = step(cols, pos, dir);
    if (next) { const c = cols[next.col][next.row]; c.focus(); c.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  }
  function contextFile() {
    const r = hashRoute();
    if (r === 'detail') return ctx.detail()?.file ?? null;
    if (r === 'board') return focusedCard()?.dataset.file ?? null;
    return null;
  }

  // ---- overlays
  function openOverlay(node, { onClose, focus } = {}) {
    closeOverlay();
    const prev = document.activeElement;
    const backdrop = el('div', { class: 'overlay', onmousedown: (e) => { if (e.target === backdrop) closeOverlay(); } }, node);
    document.body.append(backdrop);
    overlay = {
      node: backdrop,
      close() { backdrop.remove(); overlay = null; onClose?.(); if (prev?.isConnected) prev.focus(); },
    };
    (focus ?? node).focus();
  }
  function closeOverlay() { overlay?.close(); }

  function openHelp() {
    const box = el('div', { class: 'dialog help', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Keyboard shortcuts', tabindex: '-1' },
      el('h2', {}, 'Keyboard shortcuts'),
      HELP.map(([group, rows]) => el('section', {}, el('h3', {}, group),
        el('dl', {}, rows.map(([k, d]) => [el('dt', {}, el('kbd', {}, k)), el('dd', {}, d)])))));
    openOverlay(box);
  }

  // Idea capture as an overlay, so it works mid-edit: no route change, so no
  // draft is discarded; closing restores focus to the field the user was in.
  function openIdea() {
    const ta = el('textarea', { rows: 6, placeholder: 'Describe the idea. Ctrl+Enter saves, Esc cancels.', 'aria-label': 'Quick idea' });
    const save = async () => {
      const text = ta.value.trim();
      if (!text) return;
      try { await ctx.saveIdea(text); closeOverlay(); } catch (err) { ctx.toast(err.message); }
    };
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); }
    });
    const box = el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Quick idea' },
      el('h2', {}, 'Quick idea'), ta,
      el('div', {}, el('button', { class: 'primary', type: 'button', onclick: save }, 'Save idea')));
    openOverlay(box, { focus: ta });
  }

  function openAddStatus() {
    const input = el('input', { type: 'text', placeholder: 'New status name, e.g. reopened', autocomplete: 'off', spellcheck: false, 'aria-label': 'New status name' });
    const err = el('p', { class: 'hint', role: 'alert' });
    const submit = async () => {
      try { await ctx.addStatus(input.value); closeOverlay(); } catch (e) { err.textContent = e.message; }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    const box = el('div', { class: 'dialog form', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Add status' },
      el('h2', {}, 'Add status'), input, err,
      el('div', {}, el('button', { class: 'primary', type: 'button', onclick: submit }, 'Add')));
    openOverlay(box, { focus: input });
  }
  document.addEventListener('add-status', openAddStatus);

  function commandItems(mode) {
    const file = contextFile();
    const t = file && S.tickets.find((x) => x.file === file);
    const items = [];
    const statuses = ctx.columns().filter(Boolean);
    if (t) {
      for (const s of statuses) {
        if (s !== (ctx.detail()?.draft.status ?? t.status)) {
          items.push({ label: `Set #${t.id} status: ${s}`, hint: 'status', run: () => (ctx.detail() ? ctx.setDraftStatus(s) : ctx.moveTicket(t.file, s)) });
        }
      }
    }
    if (mode === 'status') return items;
    items.push(
      { label: 'Add status…', hint: 'column', run: openAddStatus },
      { label: 'New ticket', hint: 'n', run: () => { location.hash = '#/new'; } },
      { label: 'Quick idea', hint: 'i / Ctrl+I', run: () => { location.hash = '#/idea'; } },
      { label: 'Board', hint: 'b', run: () => { location.hash = '#/'; } },
      { label: 'Show keyboard shortcuts', hint: '?', run: openHelp },
    );
    for (const c of ctx.columns()) {
      items.push({ label: `${ctx.isHidden(c) ? 'Show' : 'Hide'} column: ${c || '(no status)'}`, hint: 'column', run: () => ctx.toggleColumn(c) });
    }
    for (const x of S.tickets) {
      items.push({ label: `#${x.id} ${x.title}`, hint: x.status, run: () => { location.hash = `#/t/${encodeURIComponent(x.file)}`; } });
    }
    return items;
  }

  function openPalette(mode = 'all') {
    const all = commandItems(mode);
    if (mode === 'status' && !all.length) { ctx.toast('No ticket selected'); return; }
    let shown = [], sel = 0;
    const input = el('input', {
      type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'cmd-list', 'aria-autocomplete': 'list',
      placeholder: mode === 'status' ? 'Set status…' : 'Jump to ticket or run a command…', autocomplete: 'off', spellcheck: false,
    });
    const list = el('ul', { id: 'cmd-list', role: 'listbox' });
    const box = el('div', { class: 'dialog palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command menu' }, input, list);
    const paint = () => {
      shown = all.filter((i) => matches(i.label, input.value)).slice(0, 50);
      sel = Math.min(sel, Math.max(shown.length - 1, 0));
      list.replaceChildren(...(shown.length ? shown.map((i, n) => el('li', {
        id: `cmd-${n}`, role: 'option', 'aria-selected': String(n === sel), class: n === sel ? 'sel' : '',
        onmousedown: (e) => { e.preventDefault(); run(i); },
      }, el('span', {}, i.label), el('small', {}, i.hint ?? ''))) : [el('li', { class: 'none' }, 'No matches')]));
      input.setAttribute('aria-activedescendant', shown.length ? `cmd-${sel}` : '');
      list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    };
    const run = (i) => { closeOverlay(); i.run(); };
    input.addEventListener('input', () => { sel = 0; paint(); });
    input.addEventListener('keydown', (e) => {
      const ctrl = e.ctrlKey && !e.altKey;
      if (e.key === 'ArrowDown' || (ctrl && e.key === 'n')) { sel = Math.min(sel + 1, shown.length - 1); paint(); }
      else if (e.key === 'ArrowUp' || (ctrl && e.key === 'p')) { sel = Math.max(sel - 1, 0); paint(); }
      else if (e.key === 'Enter') { if (shown[sel]) run(shown[sel]); }
      else return;
      e.preventDefault();
    });
    paint();
    openOverlay(box, { focus: input });
  }

  // ---- global keys
  document.addEventListener('keydown', (e) => {
    if (e.isComposing || e.defaultPrevented) return;
    const mod = e.ctrlKey || e.metaKey;

    if (mod && !e.altKey && e.key.toLowerCase() === 'k') { // works while typing, too
      e.preventDefault();
      if (overlay?.node.querySelector('.palette')) closeOverlay(); else openPalette();
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'i') { // works while typing, too
      e.preventDefault();
      if (overlay?.node.querySelector('textarea[aria-label="Quick idea"]')) return;
      openIdea();
      return;
    }
    if (e.key === 'Escape') {
      if (overlay) { e.preventDefault(); closeOverlay(); return; }
      if (isTyping(e.target)) {
        e.preventDefault();
        if (hashRoute() === 'new') location.hash = '#/'; else e.target.blur();
      } else if (hashRoute() !== 'board') { e.preventDefault(); location.hash = '#/'; }
      return;
    }
    if (overlay) { // keep focus inside; the overlays handle their own keys
      if (e.key === 'Tab') { e.preventDefault(); (overlay.node.querySelector('input') ?? overlay.node.firstChild).focus(); }
      else if (e.key === '?' && overlay.node.querySelector('.help')) { e.preventDefault(); closeOverlay(); }
      return;
    }
    if (mod || e.altKey || isTyping(e.target)) return;

    const board = hashRoute() === 'board';
    switch (e.key) {
      case '?': openHelp(); break;
      case '/': if (board) $('#search')?.focus(); else return; break;
      case 'n': location.hash = '#/new'; break;
      case 'b': location.hash = '#/'; break;
      case 'i': location.hash = '#/idea'; break;
      case 's': openPalette('status'); break;
      case 'j': if (board) moveFocus('next'); else return; break;
      case 'k': if (board) moveFocus('prev'); else return; break;
      case 'h': if (board) moveFocus('left'); else return; break;
      case 'l': if (board) moveFocus('right'); else return; break;
      case '1': case '2': case '3': case '4': case '5': case '6': case '7': case '8': case '9': {
        const file = ctx.heldFile?.() ?? (board && focusedCard()?.dataset.file);
        const target = ctx.columns().filter(Boolean)[Number(e.key) - 1];
        if (!file || target == null) return;
        ctx.moveTicket(file, target);
        break;
      }
      case 'e': if (hashRoute() === 'detail' && ctx.detail()) ctx.setTab('edit'); else return; break;
      case 'p': if (hashRoute() === 'detail' && ctx.detail()) ctx.setTab('view'); else return; break;
      default: return;
    }
    e.preventDefault();
  });

  $('#help-btn')?.addEventListener('click', openHelp);
  $('#cmd-btn')?.addEventListener('click', () => openPalette());
}
