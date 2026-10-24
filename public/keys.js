// Keyboard layer: global hotkeys, Ctrl+K command menu and the `?` help overlay.
// Pure helpers are exported for tests; DOM wiring happens in initKeys().

import { planStatusDelete } from './filter.js';

// ------------------------------------------------------------ pure helpers

/** Every whitespace-separated token must occur in the label (case-insensitive). */
export function matches(label, query) {
  const l = label.toLowerCase();
  return query.toLowerCase().split(/\s+/).filter(Boolean).every((tok) => l.includes(tok.replace(/^#/, '')));
}

export const TICKET_CAP = 5;

/** Ticket rows for the palette: a counted heading, at most `cap` tickets, then a "Show N more" row unless expanded. */
export function ticketRows(tickets, expanded, expand, cap = TICKET_CAP) {
  if (!tickets.length) return [];
  const row = (x) => ({ label: `#${x.id} ${x.title}`, id: x.id, title: x.title, hint: x.status, always: true, run: () => { location.hash = `#/t/${encodeURIComponent(x.file)}`; } });
  const head = { heading: `Tickets · ${tickets.length}` };
  if (expanded || tickets.length <= cap) return [head, ...tickets.map(row)];
  const rest = tickets.length - cap;
  return [head, ...tickets.slice(0, cap).map(row), { label: `Show ${rest} more ticket${rest > 1 ? 's' : ''}…`, always: true, cmd: false, stay: expand }];
}

/** "#20", "#020" or "20" -> 20; anything else -> null. */
export function parseTicketRef(text) {
  const m = /^\s*#?(\d{1,4})\s*$/.exec(text || '');
  return m ? Number(m[1]) : null;
}

/** Tickets for a typed id: the one with that id, else those whose id starts with the typed digits (#2 -> 2, 20..29). */
export function ticketsByRef(tickets, n) {
  const exact = tickets.filter((t) => Number(t.id) === n);
  return exact.length ? exact : tickets.filter((t) => String(Number(t.id)).startsWith(String(n)));
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

/** The card to select once `file` leaves its column: the one below it, else the one above, else null. */
export function neighbourAfterLeave(cols, file) {
  const col = cols.find((c) => c.includes(file));
  if (!col) return null;
  const i = col.indexOf(file);
  return col[i + 1] ?? col[i - 1] ?? null;
}

/** "Mark as done" is offered only if the project has a `done` status and the ticket isn't there yet. */
export const canMarkDone = (columns, status) => columns.includes('done') && status !== 'done';

/** Age for the slot overview: "5 min", "3 h", "2 d". */
export const formatAge = (ms) => (ms < 3600e3 ? `${Math.max(1, Math.round(ms / 60e3))} min` : ms < 48 * 3600e3 ? `${Math.round(ms / 3600e3)} h` : `${Math.round(ms / 86400e3)} d`);

/** Vim-like jump: `g` is the top of the page, `G` the bottom; any other key is not a jump (null). */
export const jumpTop = (key, scrollHeight) => (key === 'gg' ? 0 : key === 'G' ? scrollHeight : null);

/** `g1`-`g9`: the status of column n in visual order (hidden `null` slots skipped); null for any other key, undefined if there is no such column. */
export function gColumn(key, columns) {
  return /^[1-9]$/.test(key) ? columns.filter(Boolean)[Number(key) - 1] : null;
}

/** `g<number>`: the ticket with that number (leading zeros ignored), else undefined. */
export const gTicket = (tickets, digits) => tickets.find((x) => Number(x.id) === Number(digits));

/** `gt` / `gT`: the file `step` places after `file` in the ordered list of tickets, or null at either end / if unknown. */
export function neighbourFile(order, file, step) {
  const i = order.findIndex((t) => t.file === file);
  return i < 0 ? null : order[i + step]?.file ?? null;
}

export const isTyping = (t) => !!t && (t.isContentEditable || ['INPUT', 'TEXTAREA', 'SELECT'].includes(t.tagName));

export const HELP = [
  ['Everywhere', [
    ['Ctrl+K', 'Command menu: commands, jump to a ticket by title; type #20 for that ticket\'s actions (status, priority, area, comment, delete); Esc or Backspace on empty input goes one step back'],
    ['?', 'Show / hide this help'],
    ['n', 'New ticket'],
    ['b / gb', 'Go to the board'],
    ['g?', 'Popup with just the g hotkeys of the current page, and a button to this full list'],
    ['gi', 'Open the ticket you edited last, in the editor'],
    ['gs', 'Go to the search box and clear its text (/ keeps it)'],
    ['gn', 'Go to the Notes page (NOTES.md)'],
    ['gaa', 'Claude chat: open full screen / close (same as a; only with --agents, as all ga keys)'],
    ['gac', 'Open the Claude chat of the selected / open ticket'],
    ['gai', 'Implement the selected / open ticket with Claude (queued behind a running refine)'],
    ['gar', 'Refine the selected / open ticket with Claude'],
    ['gav', 'Review the selected / open ticket with Claude'],
    ['gas', 'Worktree slot overview (same as gw)'],
    ['gw', 'Worktree slot overview (only with --agents)'],
    ['P', 'Switch the current project (the project new tickets are filed under)'],
    ['Ctrl+I', 'Quick idea: just text, no title; also while typing (your edit is kept)'],
    ['i', 'Quick idea (same as Ctrl+I, outside fields)'],
    ['Ctrl+Shift+Enter / Ctrl+Alt+Enter', 'In the Quick idea dialog (only with --agents; the refine part is hidden with --auto-refine): save and refine / save, refine and queue the implementation'],
    ['Ctrl+M / m', 'Quick note: free text saved to NOTES.md next to the tickets, not tied to any ticket (Ctrl+M also while typing; m outside fields)'],
    ['a', 'Claude chat (only with --agents): open full screen without focus; again: close'],
    ['h / l', 'With the chat open (outside fields): previous / next chat; the chat\'s j/k/g/G/i keys also work and win over the page keys'],
    ['+', 'Claude chat: open if needed and focus the message input'],
    ['/', 'Go to the search box (from any view; goes to the board first); Enter or Esc there leaves it again (Enter on an id like #12 opens that ticket)'],
    ['Ctrl+/ or Ctrl+E', 'Same, also while typing; an unsaved edit asks before it is left'],
    ['Esc', 'Close overlay, leave a field, go back to the board, then clear the card selection'],
  ]],
  ['Board', [
    ['j / k', 'Select next / previous card in the column (with nothing selected: the last selected card, else the first)'],
    ['h / l', 'Previous / next column'],
    ['g1 - g9', 'Select the first card of column n (numbered as the column badges; a hidden column selects its strip entry); acts after a pause of about 0.7 s'],
    ['g<number>', 'Two or more digits, then a pause of about 0.7 s: select the card of that ticket (g201, g0201); in a hidden column its peek list opens with the ticket focused; more digits restart the pause, any other key cancels'],
    ['gh', 'Select the "Hidden: ..." strip'],
    ['Enter', 'Open the selected ticket'],
    ['Space / Ctrl+Space', 'Pick up the selected (or hovered, if none) card; h / l choose among shown columns, j / k switch to the hidden ones and back, Space or Enter drops, Esc cancels'],
    ['c', 'Add a timestamped comment to the selected (or hovered, if none) ticket; ☰ on a card opens its menu'],
    ['1-9', 'Only in move mode (after Space / Ctrl+Space): drop the ticket in that column; the numbers show on the headers then'],
    ['k at the top card', 'Move up onto the "Hidden: ..." strip; h / l pick a hidden status, Enter lists its tickets (j / k move, Space picks one up to move it, Enter opens it, h / l switch status, Esc or k at the top closes), j goes back to the cards'],
    ['d', 'Delete the selected (or hovered, if none) ticket after a confirmation; it goes to the trash for 30 days'],
    ['s', 'Set status of the selected ticket (menu)'],
    ['Drag a column header', 'Reorder the status columns (saved in _config.yml)'],
  ]],
  ['Ticket', [
    ['j / k', 'Scroll down / up (outside fields)'],
    ['gg / G', 'Scroll to the top / bottom (outside fields)'],
    ['gj / gk', 'Scroll down / up a few lines (about 5)'],
    ['g<n>j / g<n>k', 'Scroll down / up n/30 of the window height: g10j about a third of a page, g30j a full page'],
    ['gt / gT', 'Next / previous ticket in board order'],
    ['gc', 'Jump to the Notes at the bottom of the ticket (the page bottom if there are none)'],
    ['gr', 'Open the newest review report of the ticket'],
    ['c / Ctrl+Shift+Enter', 'Add a timestamped comment to this ticket (c outside fields, Ctrl+Shift+Enter also while typing; unsaved edits are kept)'],
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
  const focusedCardFile = () => document.activeElement?.closest?.('.card')?.dataset.file ?? null;
  const cardTarget = () => selectedFile() ?? focusedCardFile() ?? hoverFile;
  function moveFocus(dir) {
    const cols = boardCols().map((c) => [...c].map((x) => x.dataset.file));
    const hiddenList = ctx.hiddenColumns?.() ?? [];
    const strip = ctx.stripSelected?.() ?? null;
    if (strip !== null) { // on the "Hidden: ..." strip: h/l along it, j back to the cards
      if (dir === 'left' || dir === 'right') ctx.selectStrip(hiddenList[Math.max(0, Math.min(hiddenList.length - 1, hiddenList.indexOf(strip) + (dir === 'right' ? 1 : -1)))]);
      else if (dir === 'next') { const f = navigate(cols, null, ctx.lastSelected?.(), 'next'); if (f) { ctx.select(f); scrollToCard(f); } }
      return;
    }
    const cur = selectedFile();
    const file = navigate(cols, cur, ctx.lastSelected?.(), dir);
    if (!file && !cols.some((c) => c.length) && hiddenList.length) { // no cards at all: any move key falls back to the hidden strip
      ctx.selectStrip(hiddenList.find((s) => ctx.hiddenCount(s) > 0) ?? hiddenList[0]);
      return;
    }
    if (dir === 'prev' && cur && file === cur && hiddenList.length) { ctx.selectStrip(hiddenList[0]); return; } // top of the column: up to the strip
    if (!file) return;
    ctx.select(file);
    scrollToCard(file);
  }
  // The sticky header would cover a card scrolled to the viewport edge (style.css gives .card a scroll-margin-top);
  // the first card of a column goes to the very top so the column heading and the page above it show too.
  const scrollToCard = (file) => {
    const card = [...document.querySelectorAll('.card')].find((c) => c.dataset.file === file);
    if (!card) return;
    if (card.closest('.col')?.querySelector('.card') === card) window.scrollTo({ top: 0, left: window.scrollX });
    card.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  };
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

  // About (081): build and server info, from GET /api/about.
  async function openAbout() {
    let a;
    try { a = await ctx.about(); } catch (e) { ctx.toast(`About failed: ${e.message}`); return; }
    const row = (k, v) => [el('dt', {}, k), el('dd', {}, v)];
    const box = el('div', { class: 'dialog form about', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'About Sanvi' },
      el('h2', {}, 'About Sanvi'),
      el('dl', {},
        row('Version', a.version || 'unknown'),
        row('Commit', a.commit ? `${a.commit} (${a.date})` : 'not a git checkout'),
        row('Node', a.node),
        row('Tickets directory', `${a.dir} (${a.tickets} tickets)`),
        row('Server started', new Date(a.started).toLocaleString())),
      a.behind > 0 && el('p', { class: 'hint', role: 'status' }, `Server is running older code than the checkout: restart to pick up ${a.behind} newer commit${a.behind > 1 ? 's' : ''}.`),
      el('div', { class: 'buttons' }, el('button', { class: 'primary', type: 'button', onclick: closeOverlay }, 'Close')));
    openOverlay(box);
  }

  function openHelp() {
    const box = el('div', { class: 'dialog help', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Keyboard shortcuts', tabindex: '-1' },
      el('h2', {}, 'Keyboard shortcuts'),
      HELP.map(([group, rows]) => el('section', {}, el('h3', {}, group),
        el('dl', {}, rows.map(([k, d]) => [el('dt', {}, el('kbd', {}, k)), el('dd', {}, d)])))));
    openOverlay(box);
  }

  // `g?`: only the `g` rows of HELP that apply on this page (Everywhere plus the page's own group), with a way to the full list.
  function openGHelp() {
    const route = hashRoute();
    const own = route === 'board' ? 'Board' : route === 'detail' ? 'Ticket' : null;
    const groups = HELP.filter(([group]) => group === 'Everywhere' || group === own)
      .map(([group, rows]) => [group, rows.filter(([k]) => k.split(' / ').some((x) => x.startsWith('g')))]).filter(([, rows]) => rows.length);
    const box = el('div', { class: 'dialog help ghelp', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'g hotkeys', tabindex: '-1' },
      el('h2', {}, 'g hotkeys'),
      groups.map(([group, rows]) => el('section', {}, el('h3', {}, group),
        el('dl', {}, rows.flatMap(([k, d], i) => {
          const sub = /^ga\w$/.test(k); // gaa..gas hang under a `ga` prefix row, only in this popup
          const row = [el('dt', { class: sub ? 'sub' : '' }, el('kbd', {}, k)), el('dd', { class: sub ? 'sub' : '' }, d)];
          return sub && !/^ga\w$/.test(rows[i - 1]?.[0] ?? '') ? [el('dt', {}, el('kbd', {}, 'ga')), el('dd', {}, 'Claude chat and agent keys (only with --agents)'), ...row] : row;
        })))),
      el('div', { class: 'buttons' }, el('button', { type: 'button', class: 'allkeys', onclick: () => { closeOverlay(); openHelp(); } }, '⌨️ All shortcuts')));
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
    // Which project the idea goes to (079): defaults like a new ticket; changing it does not switch the view.
    const { names, fresh } = ctx.projects();
    const sel = names.length ? el('select', { 'aria-label': 'Project', id: 'idea-project' },
      el('option', { value: '' }, 'No project'), ...(fresh && !names.includes(fresh) ? [fresh, ...names] : names).map((n) => el('option', { value: n }, n))) : null;
    if (sel) sel.value = fresh;
    // `then`: what to do with the saved ticket (refine / queue the implementation); only with --agents.
    const save = async (then) => {
      const text = ta.value.trim();
      if (!text) return;
      let t;
      try { t = await ctx.saveIdea(text, pics.images, done, sel ? sel.value : fresh); pics.release(); closeOverlay(); } catch (e) { err.textContent = e.message; ctx.toast(e.message); return; }
      if (then) await then(t);
    };
    const agents = !!ctx.agents?.();
    const refineToo = agents && !ctx.autoRefine?.(); // with --auto-refine the server refines every new idea itself
    const saveRefine = () => save((t) => ctx.refine(t.file));
    const saveImplement = () => save(async (t) => { if (refineToo) await ctx.refine(t.file); await ctx.implement(t.file); }); // implement queues behind the running refine
    for (const f of [ta, sel]) f?.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' || !(e.ctrlKey || e.metaKey)) return;
      if (!e.shiftKey && !e.altKey) { e.preventDefault(); save(); }
      else if (agents && e.shiftKey && !e.altKey) { e.preventDefault(); if (refineToo) saveRefine(); } // Ctrl+Shift+Enter
      else if (agents && e.altKey && !e.shiftKey) { e.preventDefault(); saveImplement(); } // Ctrl+Alt+Enter
    });
    const box = el('div', { class: 'dialog form', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Quick idea' },
      el('h2', {}, 'Quick idea'),
      el('p', { class: 'hint' }, `Saved as a ticket in the design column with an auto-derived title, for refinement later. Paste or drop images to attach them. Ctrl+Enter saves, Esc cancels.${agents ? ` Ctrl+Shift+Enter ${refineToo ? 'saves and refines' : '(not needed with --auto-refine)'}, Ctrl+Alt+Enter saves${refineToo ? ', refines' : ''} and implements.` : ''}`),
      ta, sel && el('label', { class: 'projpick' }, 'Project ', sel), pics.node, err,
      el('div', { class: 'buttons' }, el('button', { class: 'primary', type: 'button', onclick: () => save() }, 'Save idea'), ' ', el('button', { type: 'button', onclick: closeOverlay }, 'Cancel'),
        agents && el('div', { class: 'stack' },
          refineToo && el('button', { class: 'small', type: 'button', title: 'Save the idea and let Claude refine it (Ctrl+Shift+Enter)', onclick: saveRefine }, 'Save and refine'),
          el('button', { class: 'small', type: 'button', title: `Save the idea${refineToo ? ', let Claude refine it' : ''} and queue the implementation (Ctrl+Alt+Enter)`, onclick: saveImplement }, 'Save, refine and implement'))));
    openOverlay(box, { focus: ta });
  }

  // Quick note: a line in NOTES.md, independent of any ticket. Without a version the server just appends.
  function openScratch() {
    const ta = el('textarea', { rows: 5, placeholder: 'A reminder, a link, a thought. Ctrl+Enter saves, Esc cancels.', 'aria-label': 'Quick note' });
    const err = el('p', { class: 'hint', role: 'alert' });
    const save = async () => {
      if (!ta.value.trim()) return;
      try { await ctx.addScratch(ta.value); closeOverlay(); } catch (e) { err.textContent = e.message; }
    };
    ta.addEventListener('keydown', (e) => {
      if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); save(); }
    });
    const box = el('div', { class: 'dialog form', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Quick note dialog' },
      el('h2', {}, 'Quick note'),
      el('p', { class: 'hint' }, 'Saved with a timestamp to NOTES.md in the tickets folder. Not a ticket; find it again under Notes.'),
      ta, err,
      el('div', { class: 'buttons' }, el('button', { class: 'primary', type: 'button', onclick: save }, 'Save note'), ' ', el('button', { type: 'button', onclick: closeOverlay }, 'Cancel')));
    openOverlay(box, { focus: ta });
  }
  document.addEventListener('open-scratch', () => { if (!overlay) openScratch(); });

  // Quick comment: appended as a timestamped line to the ticket's Notes (server side).
  function openNote(file) {
    const t = S.tickets.find((x) => x.file === file);
    if (!t) return;
    const ta = el('textarea', { rows: 4, placeholder: 'Comment. Ctrl+Enter saves, Esc cancels.', 'aria-label': 'Comment' });
    const err = el('p', { class: 'hint', role: 'alert' });
    const pics = imageBox(ta);
    const done = {}; // images already stored by a failed attempt
    const inEditor = document.activeElement?.classList?.contains('editor'); // opened while typing in the description
    const save = async () => {
      if (!ta.value.trim() && !pics.images.length) return;
      try { await ctx.addNote(file, ta.value, pics.images, done); pics.release(); closeOverlay(); if (inEditor) document.querySelector('.editor')?.focus({ preventScroll: true }); } catch (e) { err.textContent = e.message; }
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
    const refinable = ctx.agents?.();
    const refining = refinable && ctx.isRefining(file);
    menu = el('div', { class: 'cardmenu', role: 'menu', 'data-file': file },
      entry('Add comment', 'c', () => openNote(file)),
      ...(refinable ? [entry(refining ? 'Claude is refining this ticket…' : 'Refine with Claude', 'agent', () => { if (!refining) ctx.refine(file); })] : []),
      ...(ctx.agents?.() ? [entry('Review with Claude', 'agent', () => ctx.review(file))] : []),
      ...(ctx.agents?.() ? [entry(refining ? 'Queue implementation with Claude' : 'Implement with Claude', 'agent', () => ctx.implement(file))] : []),
      entry('Delete…', 'd', () => openConfirmDelete(file)));
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

  // ---- command palette: a stack of levels. Each level has a placeholder and rows(query) giving
  // [{ heading } | { label, hint, run } | { label, hint, push: () => level }]; `always` rows skip the text filter.
  const filterRows = (rows, q) => {
    const out = [];
    let head = null;
    for (const r of rows) {
      if (r.heading) { head = r; continue; }
      if (r.always || matches(r.label, q)) { if (head) { out.push(head); head = null; } out.push(r); }
    }
    return out;
  };
  const fieldOf = (t, field) => (ctx.detail()?.file === t.file ? ctx.detail().draft[field] : t[field]) ?? '';

  function valueLevel(t, field) {
    const cur = fieldOf(t, field);
    if (field === 'area' || field === 'project') {
      const areas = field === 'project' ? ctx.projects().names : [...new Set(S.tickets.map((x) => x.area).filter(Boolean))].sort();
      return {
        placeholder: `${field === 'area' ? 'Area' : 'Project'} for #${t.id}: type a name or pick one…`,
        rows: (q) => [...areas.map((a) => ({ label: a, hint: a === cur ? 'current' : '', run: () => ctx.setField(t.file, field, a) })),
          { label: '(none)', hint: cur === '' ? 'current' : '', run: () => ctx.setField(t.file, field, '') },
          ...(q.trim() && !areas.includes(q.trim()) ? [{ label: `Set ${field} to “${q.trim()}”`, always: true, run: () => ctx.setField(t.file, field, q.trim()) }] : [])],
      };
    }
    const values = field === 'status' ? ctx.columns().filter(Boolean) : ['high', 'medium', 'low', ''];
    return {
      placeholder: `${field[0].toUpperCase()}${field.slice(1)} for #${t.id}…`,
      rows: () => values.map((v) => ({ label: v || '(none)', hint: v === cur ? 'current' : '',
        run: () => (field === 'status' ? (ctx.detail()?.file === t.file ? ctx.setDraftStatus(v) : ctx.moveTicket(t.file, v)) : ctx.setField(t.file, field, v)) })),
    };
  }

  // The selected card leaves its column, so the selection moves on to its neighbour (below, else above) once the board is redrawn.
  async function markDone(t) {
    if (ctx.detail()?.file === t.file) return ctx.setDraftStatus('done');
    const next = selectedFile() === t.file ? neighbourAfterLeave(boardCols().map((c) => [...c].map((x) => x.dataset.file)), t.file) : null;
    await ctx.moveTicket(t.file, 'done');
    if (next && [t.file, null].includes(selectedFile()) && S.tickets.some((x) => x.file === next)) { ctx.select(next); scrollToCard(next); }
  }
  const doneRows = (t) => (canMarkDone(ctx.columns(), fieldOf(t, 'status'))
    ? [{ label: 'Mark as done', hint: 'status', cmd: true, run: () => markDone(t) }] : []);

  function ticketLevel(t) {
    const hint = (f) => fieldOf(t, f) || '(none)';
    return {
      placeholder: `Actions for #${t.id} ${t.title}`,
      rows: () => [
        { label: 'Open', hint: 'Enter', run: () => { location.hash = `#/t/${encodeURIComponent(t.file)}`; } },
        ...(ctx.agents?.() ? [{ label: ctx.isRefining(t.file) ? 'Claude is refining this ticket…' : 'Refine with Claude', hint: 'agent', run: () => ctx.refine(t.file) }] : []),
        ...(ctx.agents?.() ? [{ label: 'Review with Claude', hint: 'agent', run: () => ctx.review(t.file) }] : []),
        ...(ctx.agents?.() ? [{ label: ctx.isRefining(t.file) ? 'Queue implementation with Claude' : 'Implement with Claude', hint: 'agent', run: () => ctx.implement(t.file) }] : []),
        { label: 'Change status…', hint: hint('status'), push: () => valueLevel(t, 'status') },
        ...doneRows(t),
        { label: 'Change priority…', hint: hint('priority'), push: () => valueLevel(t, 'priority') },
        { label: 'Change project…', hint: hint('project'), push: () => valueLevel(t, 'project') },
        { label: 'Change area…', hint: hint('area'), push: () => valueLevel(t, 'area') },
        { label: 'Add comment', hint: 'c', run: () => openNote(t.file) },
        { label: 'Delete…', hint: 'd', run: () => openConfirmDelete(t.file) },
      ],
    };
  }

  // Pick one of several chats about a ticket; `nav` makes plain h/j/k/l move, open and go back (the list is short, no text filter).
  function chatsLevel(t, chats) {
    return {
      placeholder: `Chat for #${t.id}: j/k move, l or Enter opens, h goes back`, nav: true,
      rows: () => chats.map((c) => ({ label: c.title || `(${c.kind})`, hint: c.kind, always: true, run: () => ctx.openChat(c.id) })),
    };
  }

  // Delete a status (063): pick it, then (if tickets use it) pick where they go, then confirm.
  function confirmLevel(question, label, run) {
    return { placeholder: question, rows: () => [{ label, hint: 'Enter confirms, Esc cancels', run }] };
  }
  function deleteTargetLevel(status, plan) {
    const n = plan.users.length;
    return {
      placeholder: `${n} ticket${n > 1 ? 's use' : ' uses'} "${status}": move them to…`,
      rows: () => plan.targets.map((c) => ({ label: `Move them to ${c}`, hint: plan.inConfig ? 'then delete the status' : '', push: () => confirmLevel(
        `Move ${n} ticket${n > 1 ? 's' : ''} to ${c}${plan.inConfig ? ` and delete status ${status}` : ''}?`,
        `${plan.inConfig ? 'Delete' : 'Move'}: ${n} ticket${n > 1 ? 's' : ''} → ${c}`, () => ctx.deleteStatus(status, c)) })),
    };
  }
  function deleteStatusLevel() {
    return {
      placeholder: 'Delete which status?',
      rows: () => ctx.columns().filter(Boolean).map((c) => {
        const plan = planStatusDelete(S.cfg.statuses, S.tickets, c);
        const n = plan.users.length;
        const hint = !plan.inConfig ? `${n} tickets, not in config` : n ? `${n} ticket${n > 1 ? 's' : ''} use it` : 'unused';
        const label = plan.inConfig ? c : `${c} (only on tickets)`;
        if (plan.error) return { label, hint: 'cannot delete', run: () => ctx.toast(plan.error) };
        return { label, hint,
          push: () => (n ? deleteTargetLevel(c, plan) : confirmLevel(`Delete status ${c}?`, `Delete status ${c}`, () => ctx.deleteStatus(c, null))) };
      }),
    };
  }

  // One row per choice: All projects, each project, No project. `prefix` turns them into palette commands (083).
  function projectRows(prefix = '') {
    const { names, current, recent, none } = ctx.projects();
    const row = (label, value, hint) => ({ label: `${prefix}${label}`, hint: value === current ? 'current' : hint, ...(prefix ? { cmd: true } : {}), run: () => ctx.setProject(value) });
    return [row('All projects', '', ''), ...names.map((n) => row(n, n, recent.includes(n) ? 'recent' : '')), row('No project', none, '')];
  }
  // Worktree slots of the implement runs: overview, and the pool size (stored in the project's .sanvi dir).
  async function openSlots() {
    let data;
    try { data = await ctx.slots(); } catch (e) { ctx.toast(`Slots: ${e.message}`); return; }
    const chatText = { running: 'chat running', failed: 'chat failed', finished: 'finished, not merged', gone: 'chat gone' };
    // Free: green; busy with a live chat: accent; failed / gone / finished-but-held: stale (warn or danger).
    const slotState = (o) => !o.busy ? ['free', 'free'] : o.chat === 'running' ? ['busy', 'busy'] : o.chat === 'failed' ? ['failed', 'failed'] : ['stale', 'stale'];
    const slotRow = (o) => {
      const [cls, label] = slotState(o);
      return el('li', { class: `slot ${cls}` },
        el('span', { class: 'dot', 'aria-hidden': 'true' }),
        el('strong', { class: 'slot-name' }, o.name),
        el('span', { class: `chip slot-state ${cls}` }, label),
        o.busy ? el('div', { class: 'slot-detail' },
          el('span', { class: 'slot-branch' }, o.branch),
          el('small', { title: new Date(o.taken).toLocaleString() }, `${formatAge(o.ageMs)} ago`),
          el('small', {}, chatText[o.chat] || o.chat)) : null);
    };
    const box = el('div', { class: 'dialog slots', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Worktree slots', tabindex: '-1' },
      el('h2', {}, `Worktree slots (${data.poolSize} per repository)`),
      data.repos.length ? data.repos.map((r) => el('section', {}, el('h3', {}, r.name),
        el('ul', { class: 'slot-list' }, r.slots.map(slotRow)))) : el('p', { class: 'hint' }, 'No project has a repository directory yet.'),
      el('p', { class: 'hint' }, 'A slot held for over 24 h by a run that is not active is freed automatically when the next slot is taken.'),
      el('div', { class: 'buttons' },
        el('button', { type: 'button', onclick: () => { closeOverlay(); openPalette('slots'); } }, 'Change slot count…'),
        el('button', { type: 'button', class: 'primary', onclick: closeOverlay }, 'Close')));
    openOverlay(box);
  }

  function slotCountLevel() {
    ctx.slots().catch(() => {}); // learn the current count for the hint
    return {
      placeholder: 'Worktree slot count (only while all slots are free)…',
      rows: () => Array.from({ length: ctx.slotMax?.() || 10 }, (_, i) => i + 1).map((n) => ({ label: `${n} slot${n > 1 ? 's' : ''}`, hint: n === ctx.slotCount?.() ? 'current' : '', always: true, run: () => ctx.setSlots(n).then(() => ctx.toast(`Worktree slots: ${n}`)).catch((e) => ctx.toast(`Slot count not changed: ${e.message}`)) })),
    };
  }

  // Shown when starting an implement run found every slot busy: says so and offers to raise the count.
  function warnSlotsBusy(message) {
    const box = el('div', { class: 'dialog form', role: 'alertdialog', 'aria-modal': 'true', 'aria-label': 'All worktree slots are busy' },
      el('h2', {}, 'All worktree slots are busy'),
      el('p', {}, message),
      el('div', { class: 'buttons' },
        el('button', { type: 'button', onclick: closeOverlay }, 'Close'),
        el('button', { type: 'button', onclick: () => { closeOverlay(); openSlots(); } }, 'Show slots'),
        el('button', { type: 'button', class: 'primary', onclick: () => { closeOverlay(); openPalette('slots'); } }, 'Increase slot count…')));
    openOverlay(box);
  }

  function projectLevel() {
    return { placeholder: 'Switch project…', rows: () => projectRows() };
  }
  function columnsLevel() {
    return { placeholder: 'Show or hide a column…', rows: () => ctx.columns().map((c) => ({ label: `${ctx.isHidden(c) ? 'Show' : 'Hide'} ${c || '(no status)'}`, hint: ctx.isHidden(c) ? 'hidden' : 'shown', run: () => ctx.toggleColumn(c) })) };
  }

  let expanded = false; // the ticket list was expanded with "Show N more"; stays so while typing
  function rootLevel() {
    return {
      placeholder: 'Jump to ticket, #20 for its actions, or run a command…',
      rows: (q) => {
        const ref = parseTicketRef(q);
        if (ref !== null) { // #20 / 020: that ticket's actions
          const hits = ticketsByRef(S.tickets, ref);
          return hits.length ? [{ heading: `Tickets · ${hits.length}` }, ...hits.map((x) => ({ label: `#${x.id} ${x.title}`, id: x.id, title: x.title, hint: x.status, always: true, push: () => ticketLevel(x) }))] : [];
        }
        const file = contextFile();
        const t = file && S.tickets.find((x) => x.file === file);
        const rows = [];
        if (q.trim().endsWith('?') && ctx.agents?.()) rows.push({ heading: 'Ask' }, { label: `Ask Claude: “${q.trim()}”`, hint: 'read-only', always: true, run: () => ctx.ask(q.trim()) });
        if (t) {
          rows.push({ heading: 'This ticket' }, { label: `Ticket #${t.id} …`, hint: 'actions', cmd: true, push: () => ticketLevel(t) }, ...doneRows(t));
          if (ctx.agents?.()) {
            { const refining = ctx.isRefining(t.file); rows.push({ label: refining ? 'Claude is refining this ticket…' : 'Refine with Claude', hint: 'agent', cmd: true, run: () => { if (!refining) ctx.refine(t.file); } }); }
            rows.push({ label: ctx.isRefining(t.file) ? 'Queue implementation with Claude' : 'Implement with Claude', hint: 'agent', cmd: true, run: () => ctx.implement(t.file) });
            rows.push({ label: 'Review with Claude', hint: 'agent', cmd: true, run: () => ctx.review(t.file) });
            const chats = ctx.chatsFor(t);
            if (chats.length === 1) rows.push({ label: 'Go to chat', hint: chats[0].kind, cmd: true, run: () => ctx.openChat(chats[0].id) });
            else if (chats.length > 1) rows.push({ label: 'Go to chat…', hint: `${chats.length} chats`, cmd: true, push: () => chatsLevel(t, chats) });
          }
        }
        rows.push({ heading: 'Commands' },
          { cmd: true, label: 'New ticket', hint: 'n', run: () => { location.hash = '#/new'; } },
          { cmd: true, label: 'Quick idea', hint: 'i / Ctrl+I', run: openIdea },
          { cmd: true, label: 'Quick note…', hint: 'm / Ctrl+M', run: openScratch },
          { cmd: true, label: 'Projects (directory, instructions)', hint: 'agent context', run: () => { location.hash = '#/projects'; } },
          { cmd: true, label: 'Notes', run: () => { location.hash = '#/notes'; } },
          { cmd: true, label: 'Search tickets', hint: '/ or Ctrl+/ or Ctrl+E', run: focusSearch },
          ...(ctx.projects().mode === 'dropdown' ? [{ cmd: true, label: 'Switch project…', hint: 'P', push: projectLevel }] : []),
          { cmd: true, label: 'Board', hint: 'b', run: () => { location.hash = '#/'; } },
          { cmd: true, label: 'Trash (restore deleted tickets)', hint: 'trash', run: () => { location.hash = '#/trash'; } },
          { cmd: true, label: 'Add status…', hint: 'column', run: openAddStatus },
          { cmd: true, label: 'Delete status…', hint: 'column', push: deleteStatusLevel },
          { cmd: true, label: 'Columns…', hint: 'show / hide', push: columnsLevel },
          ...(ctx.agents?.() ? [
            { cmd: true, label: 'Chat with Claude', hint: 'a', run: () => $('#chat-btn').click() },
            { cmd: true, label: 'Refresh Claude limits (5-hour, weekly)', hint: 'agent', run: () => ctx.refreshLimits() },
            { cmd: true, label: 'Worktree slots (overview)', hint: 'agent', run: openSlots },
            { cmd: true, label: 'Set worktree slot count…', hint: 'agent', push: slotCountLevel },
            { cmd: true, label: 'Refine all design tickets', hint: 'agent', run: () => ctx.refineAll() },
            { cmd: true, label: 'Ask Claude about the board…', hint: 'agent', run: () => ctx.ask('') },
          ] : []),
          { cmd: true, label: 'About Sanvi', hint: 'version', run: openAbout },
          { cmd: true, label: 'Show keyboard shortcuts', hint: '?', run: openHelp });
        if (q.trim() && ctx.projects().mode === 'dropdown') rows.push(...projectRows('Switch to project: ')); // only while typing, so the default list stays short
        if (q.trim()) rows.push(...ticketRows(S.tickets.filter((x) => matches(`#${x.id} ${x.title}`, q)), expanded, () => { expanded = true; }));
        return rows;
      },
    };
  }

  function openPalette(mode = 'all') {
    const file = contextFile();
    const t = file && S.tickets.find((x) => x.file === file);
    if (mode === 'status' && !t) { ctx.toast('No ticket selected'); return; }
    expanded = false;
    const stack = [mode === 'status' ? valueLevel(t, 'status') : mode === 'slots' ? slotCountLevel() : mode === 'project' ? projectLevel() : rootLevel()];
    let shown = [], sel = 0;
    const input = el('input', {
      type: 'text', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'cmd-list', 'aria-autocomplete': 'list',
      placeholder: stack[0].placeholder, autocomplete: 'off', spellcheck: false,
    });
    const list = el('ul', { id: 'cmd-list', role: 'listbox' });
    const box = el('div', { class: 'dialog palette', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command menu' }, input, list);
    const top = () => stack[stack.length - 1];
    const paint = () => {
      const rows = filterRows(top().rows(input.value), input.value).slice(0, 50);
      shown = rows.filter((r) => !r.heading);
      sel = Math.min(sel, Math.max(shown.length - 1, 0));
      list.replaceChildren(...(shown.length ? rows.map((r) => {
        if (r.heading) return el('li', { class: 'heading', role: 'presentation' }, r.heading);
        const n = shown.indexOf(r);
        const props = {
          id: `cmd-${n}`, role: 'option', 'aria-selected': String(n === sel), class: `${n === sel ? 'sel ' : ''}${r.id ? 'tk' : r.cmd ? 'cmd' : ''}`.trim(),
          onmousedown: (e) => { e.preventDefault(); run(r); },
        };
        if (r.id) return el('li', props, el('span', { class: 'pid' }, `#${r.id}`), el('span', { class: 'ptitle', title: r.title }, r.title), r.hint && el('small', { class: 'chip' }, r.hint));
        return el('li', props, r.cmd && el('span', { class: 'mark', 'aria-hidden': 'true' }, '›'), el('span', { class: 'plabel' }, r.label), el('small', {}, r.hint ?? ''));
      }) : [el('li', { class: 'none' }, 'No matches')]));
      input.setAttribute('aria-activedescendant', shown.length ? `cmd-${sel}` : '');
      input.placeholder = top().placeholder;
      list.querySelector('.sel')?.scrollIntoView({ block: 'nearest' });
    };
    const run = (r) => {
      if (r.stay) { r.stay(); paint(); return; }
      if (r.push) { stack.push(r.push()); input.value = ''; sel = 0; paint(); return; }
      closeOverlay(); r.run();
    };
    const back = () => { stack.pop(); input.value = ''; sel = 0; paint(); };
    input.addEventListener('input', () => { sel = 0; paint(); });
    input.addEventListener('keydown', (e) => {
      const ctrl = e.ctrlKey && !e.altKey;
      if (top().nav && !e.ctrlKey && !e.metaKey && !e.altKey && ['h', 'j', 'k', 'l'].includes(e.key)) {
        if (e.key === 'j') { sel = Math.min(sel + 1, shown.length - 1); paint(); }
        else if (e.key === 'k') { sel = Math.max(sel - 1, 0); paint(); }
        else if (e.key === 'h') back();
        else if (shown[sel]) run(shown[sel]);
      } else if (e.key === 'ArrowDown' || (ctrl && e.key === 'n')) { sel = Math.min(sel + 1, shown.length - 1); paint(); }
      else if (e.key === 'ArrowUp' || (ctrl && e.key === 'p')) { sel = Math.max(sel - 1, 0); paint(); }
      else if (e.key === 'Enter') { if (shown[sel]) run(shown[sel]); }
      else if (stack.length > 1 && (e.key === 'Escape' || (e.key === 'Backspace' && !input.value))) back(); // one step back
      else return;
      e.preventDefault();
    });
    paint();
    openOverlay(box, { focus: input });
  }

  // Focus the board's search box from any view. Off the board this navigates first (keeping the current
  // query), through the normal hash route, so the guard against discarding an unsaved edit applies; if
  // the user declines, we never reach the board and nothing is focused.
  async function focusSearch(clear = false) {
    if (hashRoute() !== 'board') location.hash = ctx.boardHash();
    for (let i = 0; i < 30; i++) {
      const input = hashRoute() === 'board' && $('#search');
      if (input) {
        if (clear && input.value) { input.value = ''; input.dispatchEvent(new Event('input', { bubbles: true })); }
        input.focus(); input.select(); return;
      }
      await new Promise((r) => setTimeout(r, 50));
    }
  }

  // j/k on the ticket page: a tap nudges, holding scrolls at a steady speed per frame (key repeat alone is
  // jagged: a pause, then big steps). Stops on key release, focus loss or when the key's context goes away.
  let hold = null; // { key, dir, raf, t }
  function scrollHold(dir, e) {
    if (e.repeat || hold) return;
    hold = { key: e.key, dir, raf: 0, t: performance.now() };
    scrollBy({ top: dir * 24, behavior: 'instant' });
    const step = (now) => {
      if (!hold) return;
      scrollBy({ top: dir * 0.8 * Math.min(now - hold.t, 50), behavior: 'instant' }); // ~800 px/s
      hold.t = now;
      hold.raf = requestAnimationFrame(step);
    };
    hold.raf = requestAnimationFrame(step);
  }
  const stopHold = () => { if (hold) { cancelAnimationFrame(hold.raf); hold = null; } };
  document.addEventListener('keyup', (e) => { if (hold && e.key === hold.key) stopHold(); });
  window.addEventListener('blur', stopHold);

  // ---- global keys
  let pendingGA = false; // `ga` was just pressed (agents only): the next key picks the agent action
  let gCount = ''; // digits typed after `g` on the ticket page (`g10j`)
  let gTimer = null; // board: `g<digits>` runs after a short pause (column n for one digit, ticket number for more)
  const G_PAUSE = 700;
  let pendingG = false; // a first `g` was just pressed (`gg` scrolls to the top, `g` + letter is a "go to" key)
  // Second key after `ga`; true when it was one of ours. Anything else cancels the prefix and is handled as a normal key.
  function agentKey(key) {
    const withFile = (fn) => { const f = contextFile(); if (f) fn(f); else ctx.toast('Select or open a ticket first'); return true; };
    switch (key) {
      case 'a': ctx.chatHotkey(); return true;
      case 'c': return withFile((f) => ctx.openTicketChat(f));
      case 'i': return withFile((f) => ctx.implement(f));
      case 'r': return withFile((f) => { if (!ctx.isRefining(f)) ctx.refine(f); });
      case 'v': return withFile((f) => ctx.review(f));
      case 's': openSlots(); return true;
      default: return false;
    }
  }
  // Digits typed after `g` on the board: one digit is column n, more are a ticket number (leading zeros ignored).
  function gDigits(digits) {
    if (digits.length === 1) { gKey(digits); return; }
    const t = gTicket(S.tickets, digits);
    if (!t) { ctx.toast(`No ticket ${digits}`); return; }
    if (ctx.isHidden(t.status)) { ctx.selectStrip(t.status); ctx.peekOpen(t.status, t.file); return; }
    ctx.select(t.file); scrollToCard(t.file);
  }
  // Second key after `g`; true when it was one of ours. Anything else cancels the prefix and is handled as a normal key.
  function gKey(key) {
    const route = hashRoute();
    const board = route === 'board';
    const detail = route === 'detail' && ctx.detail();
    const agents = !!ctx.agents?.();
    const needDetail = (fn) => { if (!detail) return false; fn(); return true; };
    if (/^[1-9]$/.test(key)) { // column n of the board, numbered as the column badges are (visual order)
      if (!board) return false;
      const status = gColumn(key, ctx.columns());
      if (status === undefined) { ctx.toast(`No column ${key}`); return true; }
      if (ctx.isHidden(status)) { ctx.selectStrip(status); return true; }
      const first = boardCols()[ctx.columns().indexOf(status)]?.[0];
      if (first) { ctx.select(first.dataset.file); scrollToCard(first.dataset.file); } else ctx.toast('That column is empty');
      return true;
    }
    switch (key) {
      case 'g': return needDetail(() => window.scrollTo({ top: jumpTop('gg', document.documentElement.scrollHeight) }));
      case 'i': { const f = ctx.lastEdited?.(); if (f) ctx.openEdit(f); else ctx.toast('No ticket edited yet'); return true; }
      case 'b': location.hash = ctx.boardHash(); return true;
      case 't': case 'T': return needDetail(() => { const f = ctx.neighbour(detail.file, key === 't' ? 1 : -1); if (f) location.hash = `#/t/${encodeURIComponent(f)}`; else ctx.toast(key === 't' ? 'Last ticket' : 'First ticket'); });
      case 'c': return needDetail(() => { // the Notes section at the bottom, else the very bottom
        ctx.setTab('view');
        const h = [...document.querySelectorAll('#content h2')].reverse().find((x) => /^notes\b/i.test(x.textContent.trim()));
        if (h) h.scrollIntoView({ block: 'start' }); else window.scrollTo({ top: document.documentElement.scrollHeight });
      });
      case 'r': return needDetail(() => { const b = $('#review-report-btn'); if (b && !b.hidden) b.click(); else ctx.toast('No review report for this ticket'); });
      case 'h': {
        if (!board) return false;
        const hid = ctx.hiddenColumns?.() ?? [];
        if (!hid.length) ctx.toast('No hidden columns'); else ctx.selectStrip(hid.find((x) => ctx.hiddenCount(x) > 0) ?? hid[0]);
        return true;
      }
      case 'a': if (!agents) return false; pendingGA = true; return true; // prefix of the agent keys (gaa gac gai gar gav gas)
      case 'w': if (!agents) return false; openSlots(); return true;
      case 's': focusSearch(true); return true;
      case 'n': location.hash = '#/notes'; return true;
      case '?': openGHelp(); return true;
      default: return false;
    }
  }
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
    if (mod && !e.altKey && !e.shiftKey && e.key.toLowerCase() === 'm') { // works while typing, too
      e.preventDefault();
      if (overlay?.node.querySelector('textarea[aria-label="Quick note"]')) return;
      if (overlay) closeOverlay();
      openScratch();
      return;
    }
    if (e.key === 'Escape') {
      if (!overlay && ctx.pick?.() && !isTyping(e.target)) { e.preventDefault(); ctx.setPick(null); return; }
      if (overlay) { e.preventDefault(); closeOverlay(); return; }
      if (!isTyping(e.target) && ctx.peekClose?.()) { e.preventDefault(); return; } // an open hidden-status list closes first
      if (isTyping(e.target)) {
        e.preventDefault();
        if (hashRoute() === 'new') location.hash = '#/'; else e.target.blur();
      } else if (ctx.chatClose?.()) { e.preventDefault(); } // an open chat panel closes before navigating back
      else if (hashRoute() !== 'board') { e.preventDefault(); location.hash = '#/'; }
      else if (selectedFile() || ctx.stripSelected?.() != null) { e.preventDefault(); ctx.select(null); ctx.selectStrip?.(null); } // clear the selection (and the card focus)
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
    if (mod && e.shiftKey && !e.altKey && e.key === 'Enter' && hashRoute() === 'detail' && ctx.detail()) { // comment, also while typing in the editor
      e.preventDefault();
      if (!overlay) openNote(ctx.detail().file);
      return;
    }
    if (mod || e.altKey || isTyping(e.target)) return;
    if (e.key === 'Shift') return; // a bare modifier does not break a pending `gg`
    const gPending = pendingG, gaPending = pendingGA, gN = gCount; pendingG = false; pendingGA = false; gCount = '';
    clearTimeout(gTimer);

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
    if (gaPending && ctx.agents?.() && agentKey(e.key)) { e.preventDefault(); return; }
    if (gPending && board && /^\d$/.test(e.key) && (gN || e.key !== '0')) { // board: g<digits> + pause
      pendingG = true; gCount = gN + e.key; e.preventDefault();
      gTimer = setTimeout(() => { const n = gCount; pendingG = false; gCount = ''; gDigits(n); }, G_PAUSE);
      return;
    }
    if (gPending && hashRoute() === 'detail') { // ticket page: g<n>j / g<n>k scroll n/30 of the viewport, gj / gk a few lines
      if (/^\d$/.test(e.key) && (gN || e.key !== '0')) { pendingG = true; gCount = gN + e.key; e.preventDefault(); return; }
      if (e.key === 'j' || e.key === 'k') {
        scrollBy({ top: (e.key === 'j' ? 1 : -1) * (gN ? Number(gN) * innerHeight / 30 : 120), behavior: 'instant' });
        e.preventDefault(); return;
      }
    }
    if (gPending && gKey(e.key)) { e.preventDefault(); return; }
    switch (e.key) {
      case '?': openHelp(); break;
      case '/': focusSearch(); break;
      case 'n': location.hash = '#/new'; break;
      case 'b': location.hash = '#/'; break;
      case 'i': openIdea(); break;
      case 'm': openScratch(); break;
      case 'g': case 'G':
        if (e.key === 'g') { pendingG = true; break; } // first `g`: wait for the second key (a second `g` was taken by gKey)
        if (hashRoute() !== 'detail') return;
        window.scrollTo({ top: jumpTop('G', document.documentElement.scrollHeight) });
        break;
      case 'a': if (ctx.agents?.()) ctx.chatHotkey(); else return; break;
      case '+': if (ctx.agents?.()) ctx.chatType(); else return; break;
      case 'P': if (ctx.projects().mode === 'dropdown') openPalette('project'); else return; break;
      case 's': openPalette('status'); break;
      case 'j': if (board) moveFocus('next'); else if (hashRoute() === 'detail') scrollHold(1, e); else return; break;
      case 'k': if (board) moveFocus('prev'); else if (hashRoute() === 'detail') scrollHold(-1, e); else return; break;
      case 'h': if (board) moveFocus('left'); else return; break;
      case 'l': if (board) moveFocus('right'); else return; break;
      case ' ': { // pick the selected card up (not when a button or link has the focus: Space is theirs)
        if (!board || (e.target !== document.body && !e.target.classList?.contains('card'))) return;
        const t = S.tickets.find((x) => x.file === cardTarget());
        if (!t) return;
        ctx.setPick({ file: t.file, status: t.status });
        break;
      }
      case 'Enter': { // on the strip: list the hidden status; else open the selected card
        const strip = board ? ctx.stripSelected?.() ?? null : null;
        if (strip !== null) { ctx.peekOpen(strip); break; }
        // open the selected card, also when focus is lost (a focused card opens natively)
        if (!board || e.target !== document.body) return;
        const f = cardTarget();
        if (!f) return;
        location.hash = `#/t/${encodeURIComponent(f)}`;
        break;
      }
      case 'd': { // delete (after confirmation): the focused or hovered card, or the open ticket
        const f = hashRoute() === 'detail' ? ctx.detail()?.file : board && cardTarget();
        if (!f) return;
        openConfirmDelete(f);
        break;
      }
      case 'c': { const f = board ? cardTarget() : hashRoute() === 'detail' && ctx.detail()?.file; if (!f) return; openNote(f); break; }
      case 'e': if (hashRoute() === 'detail' && ctx.detail()) ctx.setTab('edit'); else return; break;
      case 'p': if (hashRoute() === 'detail' && ctx.detail()) ctx.setTab('view'); else return; break;
      default: return;
    }
    e.preventDefault();
  });

  $('#help-btn')?.addEventListener('click', openHelp);
  $('#cmd-btn')?.addEventListener('click', () => openPalette());
  return { warnSlotsBusy };
}
