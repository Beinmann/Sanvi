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
/**
 * Which card a j/k/h/l press selects. `cols` = arrays of file names in board order; `selected`/`last` = file
 * names or null. With a selection it steps from it; without one it re-selects the last selected card if it is
 * still on the board, else the first card of the first non-empty column. Returns a file name or null.
 */
export function navigate(cols, selected, last, dir) {
  const find = (f) => {
    if (!f) return null;
    for (let col = 0; col < cols.length; col++) { const row = cols[col].indexOf(f); if (row >= 0) return { col, row }; }
    return null;
  };
  const cur = find(selected);
  if (cur) { const n = step(cols, cur, dir); return n ? cols[n.col][n.row] : null; }
  if (find(last)) return last;
  const n = step(cols, null, dir);
  return n ? cols[n.col][n.row] : null;
}

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
    ['Ctrl+I', 'Quick idea: just text, no title; also while typing (your edit is kept)'],
    ['i', 'Quick idea (same as Ctrl+I, outside fields)'],
    ['/', 'Go to the search box (from any view; goes to the board first)'],
    ['Ctrl+/ or Ctrl+E', 'Same, also while typing; an unsaved edit asks before it is left'],
    ['Esc', 'Close overlay, leave a field, go back to the board, then clear the card selection'],
  ]],
  ['Board', [
    ['j / k', 'Select next / previous card in the column (with nothing selected: the last selected card, else the first)'],
    ['h / l', 'Previous / next column'],
    ['Enter', 'Open the selected ticket'],
    ['Space / Ctrl+Space', 'Pick up the selected (or hovered, if none) card; h / l choose among shown columns, j / k switch to the hidden ones and back, Space or Enter drops, Esc cancels'],
    ['c', 'Add a timestamped comment to the selected (or hovered, if none) ticket; ☰ on a card opens its menu'],
    ['1-9', 'Only in move mode (after Space / Ctrl+Space): drop the ticket in that column; the numbers show on the headers then'],
    ['v', 'Peek into hidden columns: list their tickets; h / l switch status, j / k move, Enter opens, Esc closes'],
    ['d', 'Delete the selected (or hovered, if none) ticket after a confirmation; it goes to the trash for 30 days'],
    ['s', 'Set status of the selected ticket (menu)'],
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
  // The card keys act on: the selection; hover only counts while nothing is selected.
  const selectedFile = () => ctx.selected?.() ?? null;
  const cardTarget = () => selectedFile() ?? hoverFile;
  function moveFocus(dir) {
    const cols = boardCols().map((c) => [...c].map((x) => x.dataset.file));
    const file = navigate(cols, selectedFile(), ctx.lastSelected?.(), dir);
    if (!file) return;
    ctx.select(file);
    [...document.querySelectorAll('.card')].find((c) => c.dataset.file === file)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function contextFile() {
    const r = hashRoute();
    if (r === 'detail') return ctx.detail()?.file ?? null;
    if (r === 'board') return cardTarget();
    return null;
  }

  // ---- overlays
  function openOverlay(node, { onClose, focus } = {}) {
    closeOverlay();
    const prev = document.activeElement;
    const backdrop = el('div', { class: 'overlay', onmousedown: (e) => { if (e.target === backdrop) closeOverlay(); } }, node);
    document.body.append(backdrop);
    const target = focus ?? node;
    const typable = ['INPUT', 'TEXTAREA'].includes(target.tagName);
    // The browser window can be active without the page owning the keyboard focus (seen in Firefox right after an
    // OS screenshot tool): focus() then sets activeElement but no caret, and no focus event tells us when it
    // changes. So: keep checking while the overlay is open; when the page really has focus, re-apply it (blur then
    // focus, which forces the caret); while it has not, say so instead of failing silently.
    const hint = el('div', { class: 'focushint', role: 'status', hidden: true }, 'The page does not have keyboard focus yet: click in the dialog, then type.');
    backdrop.append(hint);
    let hadFocus = false;
    const check = () => {
      if (overlay?.node !== backdrop) return;
      const has = document.hasFocus();
      hint.hidden = has;
      if (has && (!hadFocus || !backdrop.contains(document.activeElement))) { if (typable) target.blur(); target.focus(); }
      hadFocus = has;
    };
    const timer = setInterval(check, 150);
    const refocus = () => { hadFocus = false; check(); };
    const redirect = (e) => { // focus is elsewhere but a key arrived: move it into the box (the key then types there)
      if (overlay?.node !== backdrop || backdrop.contains(document.activeElement)) return;
      if (typable && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) target.focus(); else refocus();
    };
    node.addEventListener('mousedown', (e) => { if (!e.target.closest('button, input, textarea, select, a')) { e.preventDefault(); target.focus(); } });
    window.addEventListener('focus', refocus);
    document.addEventListener('visibilitychange', refocus);
    document.addEventListener('keydown', redirect, true);
    overlay = {
      node: backdrop,
      close() {
        clearInterval(timer);
        window.removeEventListener('focus', refocus);
        document.removeEventListener('visibilitychange', refocus);
        document.removeEventListener('keydown', redirect, true);
        backdrop.remove(); overlay = null; onClose?.(); if (prev?.isConnected) prev.focus();
      },
    };
    target.focus();
    check();
  }

  function closeOverlay() { overlay?.close(); }

  function openHelp() {
    const box = el('div', { class: 'dialog help', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Keyboard shortcuts', tabindex: '-1' },
      el('h2', {}, 'Keyboard shortcuts'),
      HELP.map(([group, rows]) => el('section', {}, el('h3', {}, group),
        el('dl', {}, rows.map(([k, d]) => [el('dt', {}, el('kbd', {}, k)), el('dd', {}, d)])))));
    openOverlay(box);
  }

  // Images pasted or dropped into an overlay's textarea: kept in memory with removable thumbnails and only
  // uploaded on save, so cancelling leaves no files behind. Returns { images, node }.
  function imageBox(ta) {
    const images = [];
    const node = el('div', { class: 'thumbs' });
    const paint = () => node.replaceChildren(...images.map((im, i) => el('span', { class: 'thumb' },
      el('img', { src: im.url, alt: im.name || 'pasted image' }),
      el('button', { type: 'button', title: 'Remove image', 'aria-label': 'Remove image', onclick: () => { URL.revokeObjectURL(im.url); images.splice(i, 1); paint(); ta.focus(); } }, '×'))));
    const add = (files) => {
      const imgs = [...(files ?? [])].filter((f) => f.type.startsWith('image/'));
      for (const f of imgs) images.push({ blob: f, name: f.name, url: URL.createObjectURL(f) });
      if (imgs.length) paint();
      return imgs.length > 0;
    };
    ta.addEventListener('paste', (e) => { if (add(e.clipboardData?.files)) e.preventDefault(); });
    ta.addEventListener('dragover', (e) => { if ([...(e.dataTransfer?.types ?? [])].includes('Files')) e.preventDefault(); });
    ta.addEventListener('drop', (e) => { if (add(e.dataTransfer?.files)) e.preventDefault(); });
    return { images, node, release: () => images.forEach((im) => URL.revokeObjectURL(im.url)) };
  }

  // Idea capture as an overlay, so it works mid-edit: no route change, so no
  // draft is discarded; closing restores focus to the field the user was in.
  function openIdea() {
    const ta = el('textarea', { rows: 6, placeholder: 'Describe the idea in a sentence or a few. No title needed.', 'aria-label': 'Quick idea' });
    const pics = imageBox(ta);
    const done = {}; // survives a failed save, so a retry does not create the idea twice
    const err = el('p', { class: 'hint', role: 'alert' });
    const save = async () => {
      const text = ta.value.trim();
      if (!text) return;
      try { await ctx.saveIdea(text, pics.images, done); pics.release(); closeOverlay(); } catch (e) { err.textContent = e.message; ctx.toast(e.message); }
    };
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); }
    });
    const box = el('div', { class: 'dialog form', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Quick idea' },
      el('h2', {}, 'Quick idea'),
      el('p', { class: 'hint' }, 'Saved as a ticket in the design column with an auto-derived title, for refinement later. Paste or drop images to attach them. Ctrl+Enter saves, Esc cancels.'),
      ta, pics.node, err,
      el('div', { class: 'buttons' }, el('button', { class: 'primary', type: 'button', onclick: save }, 'Save idea'), ' ', el('button', { type: 'button', onclick: closeOverlay }, 'Cancel')));
    openOverlay(box, { focus: ta });
  }

  // Quick comment: appended as a timestamped line to the ticket's Notes (server side).
  function openNote(file) {
    const t = S.tickets.find((x) => x.file === file);
    if (!t) return;
    const ta = el('textarea', { rows: 4, placeholder: 'Comment. Ctrl+Enter saves, Esc cancels.', 'aria-label': 'Comment' });
    const err = el('p', { class: 'hint', role: 'alert' });
    const pics = imageBox(ta);
    const done = {}; // images already stored by a failed attempt
    const save = async () => {
      if (!ta.value.trim() && !pics.images.length) return;
      try { await ctx.addNote(file, ta.value, pics.images, done); pics.release(); closeOverlay(); } catch (e) { err.textContent = e.message; }
    };
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); }
    });
    const box = el('div', { class: 'dialog form', role: 'dialog', 'aria-modal': 'true', 'aria-label': `Comment on #${t.id}` },
      el('h2', {}, `Comment on #${t.id}`),
      el('p', { class: 'hint' }, 'Added with a timestamp at the end of the ticket\'s Notes. Paste or drop images to attach them.'),
      ta, pics.node, err,
      el('div', { class: 'buttons' }, el('button', { class: 'primary', type: 'button', onclick: save }, 'Add comment'), ' ', el('button', { type: 'button', onclick: closeOverlay }, 'Cancel')));
    openOverlay(box, { focus: ta });
  }
  document.addEventListener('add-note', (e) => { if (!overlay) openNote(e.detail); });

  // Delete asks first; Enter or y confirms, Esc or n cancels. The ticket goes to the trash (restorable).
  function openConfirmDelete(file) {
    const t = S.tickets.find((x) => x.file === file);
    if (!t) return;
    const yes = () => { closeOverlay(); ctx.deleteTicket(file); };
    // Cancel has the focus, so d then Enter does nothing; y deletes at once, or move to Delete first.
    const cancel = el('button', { type: 'button', onclick: closeOverlay }, 'Cancel (Esc / n)');
    const del = el('button', { class: 'primary', type: 'button', onclick: yes }, 'Delete (y)');
    const box = el('div', { class: 'dialog form', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': `Delete #${t.id}` },
      el('h2', {}, `Delete #${t.id} ${t.title}?`),
      el('p', { class: 'hint' }, 'It moves to the trash and can be restored for 30 days. Enter confirms the focused button; y deletes, ← → switch buttons.'),
      el('div', { class: 'buttons' }, cancel, del));
    box.addEventListener('keydown', (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const k = e.key.toLowerCase();
      if (k === 'y') { e.preventDefault(); e.stopPropagation(); yes(); }
      else if (k === 'n') { e.preventDefault(); e.stopPropagation(); closeOverlay(); }
      else if (['arrowleft', 'arrowright', 'h', 'l', 'tab'].includes(k)) {
        e.preventDefault(); e.stopPropagation();
        (document.activeElement === cancel ? del : cancel).focus();
      } else if (k === 'enter') e.stopPropagation(); // the focused button handles it
    });
    openOverlay(box, { focus: cancel });
  }

  // Per-card menu (the hamburger at the bottom right of a card); entries are the per-ticket actions.
  let menu = null;
  function closeMenu() { menu?.remove(); menu = null; }
  document.addEventListener('card-menu', (e) => {
    const { file, anchor } = e.detail;
    const was = menu?.dataset.file;
    closeMenu();
    if (was === file || overlay) return;
    const entry = (label, hint, run) => el('button', { type: 'button', role: 'menuitem', onclick: () => { closeMenu(); run(); } }, label, el('kbd', {}, hint));
    menu = el('div', { class: 'cardmenu', role: 'menu', 'data-file': file }, entry('Add comment', 'c', () => openNote(file)), entry('Delete…', 'd', () => openConfirmDelete(file)));
    document.body.append(menu);
    const r = anchor.getBoundingClientRect();
    menu.style.left = `${Math.max(4, Math.min(r.right - menu.offsetWidth, innerWidth - menu.offsetWidth - 4))}px`;
    menu.style.top = `${r.bottom + menu.offsetHeight + 4 > innerHeight ? r.top - menu.offsetHeight - 4 : r.bottom + 4}px`;
    menu.querySelector('button').focus();
  });
  document.addEventListener('mousedown', (e) => { if (menu && !menu.contains(e.target) && !e.target.closest?.('.menu-btn')) closeMenu(); });
  document.addEventListener('keydown', (e) => { if (menu && e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); } }, true);

  // The card under the mouse counts as the target of card hotkeys when no card has keyboard focus.
  let hoverFile = null;
  document.addEventListener('mouseover', (e) => { hoverFile = e.target.closest?.('.card')?.dataset.file ?? null; });
  document.addEventListener('mouseleave', () => { hoverFile = null; });

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
  document.addEventListener('open-idea', () => { if (!overlay) openIdea(); });

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
    if (t) items.push({ label: `Delete #${t.id}…`, hint: 'd', run: () => openConfirmDelete(t.file) });
    items.push({ label: 'Peek into hidden columns', hint: 'v', run: () => ctx.peekToggle() });
    items.push({ label: 'Trash (restore deleted tickets)', hint: 'trash', run: () => { location.hash = '#/trash'; } });
    items.push(
      { label: 'Add status…', hint: 'column', run: openAddStatus },
      { label: 'New ticket', hint: 'n', run: () => { location.hash = '#/new'; } },
      { label: 'Quick idea', hint: 'i / Ctrl+I', run: openIdea },
      { label: 'Search tickets', hint: '/ or Ctrl+/ or Ctrl+E', run: focusSearch },
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

  // Focus the board's search box from any view. Off the board this navigates first (keeping the current
  // query), through the normal hash route, so the guard against discarding an unsaved edit applies; if
  // the user declines, we never reach the board and nothing is focused.
  async function focusSearch() {
    if (hashRoute() !== 'board') location.hash = ctx.boardHash();
    for (let i = 0; i < 30; i++) {
      const input = hashRoute() === 'board' && $('#search');
      if (input) { input.focus(); input.select(); return; }
      await new Promise((r) => setTimeout(r, 50));
    }
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
    if (mod && !e.altKey && (e.key === '/' || (e.key.toLowerCase() === 'e' && !e.shiftKey))) { // search; works while typing, too
      e.preventDefault();
      if (overlay) closeOverlay();
      focusSearch();
      return;
    }
    if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'i') { // works while typing, too
      e.preventDefault();
      if (overlay?.node.querySelector('textarea[aria-label="Quick idea"]')) return;
      openIdea();
      return;
    }
    if (e.key === 'Escape') {
      if (!overlay && ctx.pick?.() && !isTyping(e.target)) { e.preventDefault(); ctx.setPick(null); return; }
      if (overlay) { e.preventDefault(); closeOverlay(); return; }
      if (isTyping(e.target)) {
        e.preventDefault();
        if (hashRoute() === 'new') location.hash = '#/'; else e.target.blur();
      } else if (hashRoute() !== 'board') { e.preventDefault(); location.hash = '#/'; }
      else if (selectedFile()) { e.preventDefault(); ctx.select(null); } // clear the selection (and the card focus)
      return;
    }
    if (overlay) { // keep focus inside; the overlays handle their own keys
      if (e.key === 'Tab') { e.preventDefault(); (overlay.node.querySelector('input') ?? overlay.node.firstChild).focus(); }
      else if (e.key === '?' && overlay.node.querySelector('.help')) { e.preventDefault(); closeOverlay(); }
      return;
    }
    if (e.ctrlKey && !e.metaKey && !e.altKey && (e.key === ' ' || e.code === 'Space') && hashRoute() === 'board' && !isTyping(e.target)) {
      // Ctrl+Space: pick up / drop without depending on where the focus is (plain Space can scroll the page)
      const pk = ctx.pick?.();
      const f = cardTarget();
      e.preventDefault();
      if (pk) { const t = S.tickets.find((x) => x.file === pk.file); ctx.setPick(null); if (t && t.status !== pk.status) ctx.moveTicket(pk.file, pk.status); }
      else { const t = f && S.tickets.find((x) => x.file === f); if (t) ctx.setPick({ file: t.file, status: t.status }); }
      return;
    }
    if (mod || e.altKey || isTyping(e.target)) return;

    const board = hashRoute() === 'board';
    // Keyboard pick-up (034): while a card is picked up only these keys act, so the board is never half-held.
    const pk = board && ctx.pick?.();
    if (pk && e.key !== '?' && e.key !== '/') {
      // h/l walk the shown columns or the hidden ones, never a mix; j/k switch between the two groups
      const all = ctx.columns();
      const hiddenNow = ctx.isHidden(pk.status);
      const group = all.filter((c) => ctx.isHidden(c) === hiddenNow);
      if (e.key === 'h' || e.key === 'l') ctx.setPick({ ...pk, status: group[Math.max(0, Math.min(group.length - 1, group.indexOf(pk.status) + (e.key === 'l' ? 1 : -1)))] });
      else if (e.key === 'j' || e.key === 'k') {
        const other = all.filter((c) => ctx.isHidden(c) !== hiddenNow);
        if (other.length) ctx.setPick({ ...pk, status: other[0] });
        else ctx.toast('No hidden columns');
      }
      else if (e.key === ' ' || e.key === 'Enter') { const t = S.tickets.find((x) => x.file === pk.file); ctx.setPick(null); if (t && t.status !== pk.status) ctx.moveTicket(pk.file, pk.status); }
      else if (/^[1-9]$/.test(e.key)) { const target = all.filter(Boolean)[Number(e.key) - 1]; if (target == null) return; ctx.moveTicket(pk.file, target); }
      e.preventDefault(); // j/k/n/i/s...: swallowed until the card is dropped or Esc
      return;
    }
    switch (e.key) {
      case '?': openHelp(); break;
      case '/': focusSearch(); break;
      case 'n': location.hash = '#/new'; break;
      case 'b': location.hash = '#/'; break;
      case 'i': openIdea(); break;
      case 's': openPalette('status'); break;
      case 'j': if (board) moveFocus('next'); else return; break;
      case 'k': if (board) moveFocus('prev'); else return; break;
      case 'h': if (board) moveFocus('left'); else return; break;
      case 'l': if (board) moveFocus('right'); else return; break;
      case ' ': { // pick the selected card up (not when a button or link has the focus: Space is theirs)
        if (!board || (e.target !== document.body && !e.target.classList?.contains('card'))) return;
        const t = S.tickets.find((x) => x.file === cardTarget());
        if (!t) return;
        ctx.setPick({ file: t.file, status: t.status });
        break;
      }
      case 'Enter': { // open the selected card, also when focus is lost (a focused card opens natively)
        if (!board || e.target !== document.body) return;
        const f = cardTarget();
        if (!f) return;
        location.hash = `#/t/${encodeURIComponent(f)}`;
        break;
      }
      case 'v': ctx.peekToggle(); break; // peek into the hidden columns
      case 'd': { // delete (after confirmation): the focused or hovered card, or the open ticket
        const f = hashRoute() === 'detail' ? ctx.detail()?.file : board && cardTarget();
        if (!f) return;
        openConfirmDelete(f);
        break;
      }
      case 'c': { const f = board && cardTarget(); if (!f) return; openNote(f); break; }
      case 'e': if (hashRoute() === 'detail' && ctx.detail()) ctx.setTab('edit'); else return; break;
      case 'p': if (hashRoute() === 'detail' && ctx.detail()) ctx.setTab('view'); else return; break;
      default: return;
    }
    e.preventDefault();
  });

  $('#help-btn')?.addEventListener('click', openHelp);
  $('#cmd-btn')?.addEventListener('click', () => openPalette());
}
