import { renderMarkdown, splitSummary } from './md.js';
import { insertNote } from './notes.js';
import { compact } from './util.js';
import { serialQueue, coalesce, isTransient, describeFailure } from './queue.js';
import { planStatusDelete, parseQuery, formatQuery, matchTicket, scoreTicket, matchedOnlyInBody, sortTickets, SORT_KEYS, moveItem, checkStatusName, idQuery } from './filter.js';
import { initKeys } from './keys.js';
import { attachVim } from './vim.js';
import { initChat } from './chat.js';
import { initProjects } from './projects.js';

const $ = (sel) => document.querySelector(sel);
const view = $('#view');

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (v === true) n.setAttribute(k, '');
    else if (v !== false && v != null) n.setAttribute(k, v);
  }
  for (const kid of kids.flat(Infinity)) if (kid != null && kid !== false) n.append(kid);
  return n;
}

// replaceChildren that ignores null/false children (optional pieces), instead of printing "null".
const show = (target, ...nodes) => target.replaceChildren(...compact(nodes));

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

async function api(method, path, body) {
  let res;
  try {
    res = await fetch(`/api/${path}`, {
      method,
      headers: body ? { 'content-type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch (e) { throw Object.assign(new Error(describeFailure(0)), { cause: e }); } // no status: network error
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(describeFailure(res.status, res.statusText, data)), { status: res.status, data });
  return data;
}

const S = { cfg: { statuses: [], name: '' }, tickets: [] };
let D = null; // open detail state

// ---------------------------------------------------------------- board

const PRIO = { high: 0, medium: 1, '': 2, low: 3 };

function columns() {
  const cols = [...S.cfg.statuses];
  for (const t of S.tickets) if (t.status && !cols.includes(t.status)) cols.push(t.status);
  if (S.tickets.some((t) => !t.status)) cols.push('');
  return cols;
}

// Files changed by someone else (terminal, agent) in the last few seconds get a flag on their card.
const changedOnDisk = new Set();
const ownVersions = new Set(); // versions this browser wrote; a refresh seeing one is not an outside change

// Keyboard pick-up (034): { file, status } = the card and the column it would land in. Nothing is
// written until the drop; the state lives here so re-renders and live refreshes keep it.
let pick = null;
function endHold() { pick = null; document.body.classList.remove('moving'); }
function setPick(p) {
  pick = p;
  document.body.classList.toggle('moving', !!p); // number badges show only in move mode
  renderBoard();
}

// Selecting by focus too: Tab, click or any other way of focusing a card makes it the selection.
document.addEventListener('focusin', (e) => {
  const c = e.target.closest?.('.card');
  if (c && c.dataset.file !== selected) setSelected(c.dataset.file, { focus: false });
});

// The selected card (045): explicit state, independent of DOM focus, so keys keep working after focus is lost.
// `lastSelected` survives Esc so j/k can come back to it.
let selected = null;
let lastSelected = null;
// The selection can also sit on an entry of the "Hidden: ..." strip (reached with k from a column's top card,
// or h/l along the strip); Enter there opens that status's list.
let stripSel = null;
function paintStripSel() {
  if (document.activeElement?.closest?.('.stripentry')) document.activeElement.blur(); // the selection, not a stale focus ring, marks the entry
  for (const b of document.querySelectorAll('.stripentry[data-status]')) b.classList.toggle('selected', stripSel !== null && b.dataset.status === stripSel);
  document.body.classList.toggle('has-selection', !!selected || stripSel !== null);
}
function setStripSel(status) {
  stripSel = status ?? null;
  if (stripSel !== null) setSelected(null);
  paintStripSel();
}

function setSelected(file, { focus = true } = {}) {
  selected = file || null;
  if (selected) { lastSelected = selected; stripSel = null; }
  document.body.classList.toggle('has-selection', !!selected || stripSel !== null);
  paintStripSel();
  let el0 = null;
  for (const c of document.querySelectorAll('.card')) {
    const on = c.dataset.file === selected;
    c.classList.toggle('selected', on);
    if (on) el0 = c;
  }
  const a = document.activeElement;
  if (!selected) { if (a?.closest?.('.card')) a.blur(); return; }
  if (focus && el0 && a !== el0 && (!a || a === document.body || a.closest?.('.card'))) el0.focus({ preventScroll: true });
}

function card(t, inText = false) {
  return el('a', {
    class: `card${changedOnDisk.has(t.file) ? ' changed' : ''}${pick?.file === t.file ? ' picked' : ''}${selected === t.file ? ' selected' : ''}`, 'data-file': t.file, href: `#/t/${encodeURIComponent(t.file)}`, draggable: true,
    ondragstart: (e) => { e.dataTransfer.setData('text/plain', t.file); e.dataTransfer.effectAllowed = 'move'; e.currentTarget.classList.add('dragging'); },
    ondragend: (e) => { e.currentTarget.classList.remove('dragging'); endHold(); },
  },
  el('div', {}, el('span', { class: 'id' }, `#${t.id}`), t.title),
  el('button', {
    type: 'button', class: 'menu-btn', title: 'Ticket menu', 'aria-label': `Menu for #${t.id}`, 'aria-haspopup': 'menu',
    onclick: (e) => { e.preventDefault(); e.stopPropagation(); document.dispatchEvent(new CustomEvent('card-menu', { detail: { file: t.file, anchor: e.currentTarget } })); },
  }, '☰'),
  el('div', { class: 'meta' },
    inText && el('span', { class: 'chip', title: 'Matched in the description, not the title' }, 'in text'),
    !project && t.project && el('span', { class: 'chip project', title: 'Project' }, t.project),
    t.area && el('span', { class: 'chip' }, t.area),
    t.priority && el('span', { class: 'chip prio' }, t.priority),
    agentOn && chatPage.refining(t.file) && el('span', { class: 'chip refining', title: 'Claude is refining this ticket' }, 'refining…'),
    t.progress.total > 0 && el('span', {}, `${t.progress.done}/${t.progress.total}`)));
}

// Reorder status columns by dragging a header; the order is saved in the config file so it is shared.
async function moveColumn(from, to) {
  const list = S.cfg.statuses; // only configured statuses move; hidden ones keep their place
  if (!list.includes(from) || !list.includes(to) || from === to) return;
  const next = moveItem(list, list.indexOf(from), list.indexOf(to));
  try { await api('PUT', 'config', { statuses: next }); } catch (e) { toast(`Reorder failed: ${e.message}`); }
  await refreshAll();
}
// Append a status to `statuses:` in the config file (same writer as column reordering).
async function addStatus(input) {
  const { name, error } = checkStatusName(input, columns());
  if (error) throw new Error(error);
  await api('PUT', 'config', { statuses: [...S.cfg.statuses, name] });
  await refreshAll();
  toast(`Status "${name}" added`);
  return name;
}
// Delete a status (063): tickets still using it are moved first (normal version-checked saves, one by one); only when
// all moves succeeded is it removed from `statuses:`. Ticket files are never deleted.
async function deleteStatus(status, target) {
  const plan = planStatusDelete(S.cfg.statuses, S.tickets, status);
  if (plan.error) { toast(plan.error); return; }
  if (plan.users.length && !plan.targets.includes(target)) { toast('Choose a status to move the tickets to'); return; }
  const moved = [];
  for (const t of plan.users) {
    try {
      const saved = await api('PUT', `tickets/${encodeURIComponent(t.file)}`, { version: t.version, fields: { status: target } });
      ownVersions.add(saved.version);
      moved.push(`#${t.id}`);
    } catch (e) {
      toast(`#${t.id} not moved (${e.status === 409 ? 'changed on disk' : e.message}); status "${status}" kept. Moved so far: ${moved.join(', ') || 'none'}`);
      await refreshAll();
      return;
    }
  }
  try {
    if (plan.inConfig) await api('PUT', 'config', { statuses: S.cfg.statuses.filter((c) => c !== status) });
  } catch (e) { toast(`Status not removed: ${e.message}. Moved: ${moved.join(', ') || 'none'}`); await refreshAll(); return; }
  if (hidden.delete(status)) { try { localStorage.setItem('tk.hidden', JSON.stringify([...hidden])); } catch { /* ignore */ } }
  await refreshAll();
  toast(`Status "${status}" deleted${moved.length ? `; moved ${moved.length} ticket${moved.length > 1 ? 's' : ''} to ${target}` : ''}`);
}
// Drag preview for a column: a faded copy of the whole column (header and cards), not just the header text.
function columnDragStart(e, status) {
  e.dataTransfer.setData(COLUMN_DRAG, status);
  e.dataTransfer.effectAllowed = 'move';
  const col = e.currentTarget.closest('.col');
  if (!col) return;
  const ghost = col.cloneNode(true);
  ghost.classList.add('drag-ghost');
  ghost.style.width = `${col.offsetWidth}px`;
  document.body.append(ghost);
  e.dataTransfer.setDragImage?.(ghost, 24, 16);
  setTimeout(() => { ghost.remove(); col.classList.add('dragging-col'); }, 0); // after the browser took its snapshot
}
const COLUMN_DRAG = 'application/x-status-column';

// Moves run one at a time (each followed by its refresh), so quick repeats cannot pile up requests.
const moveQueue = serialQueue();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function moveTicket(file, status) {
  endHold();
  return moveQueue(() => doMove(file, status));
}
async function doMove(file, status) {
  const t = S.tickets.find((x) => x.file === file);
  if (!t || t.status === status) return;
  const put = () => api('PUT', `tickets/${encodeURIComponent(file)}`, { version: t.version, fields: { status } });
  let transient = false;
  try {
    let saved;
    try { saved = await put(); } catch (e) {
      if (!isTransient(e)) throw e;
      await sleep(300); // gateway hiccup or dropped connection: once more; the version check keeps it from applying twice
      try { saved = await put(); } catch (e2) {
        if (e2.status === 409 && e2.data?.current?.status === status) saved = e2.data.current; // the first try did get through
        else { transient = isTransient(e2); throw e2; }
      }
    }
    ownVersions.add(saved.version);
    if (hidden.has(status)) toast(`#${t.id} moved to ${status || '(no status)'} (hidden)`);
  } catch (e) {
    toast(e.status === 409 ? `#${t.id} changed on disk; not moved. Board refreshed.` : `Move failed: ${e.message}${transient ? ' - the move was not saved, board reloaded' : ''}`);
  }
  await refreshAll();
}

// Board/table state lives in the hash: "#/?q=text -area:x&view=table&sort=priority&dir=desc".
// The table view is switched off for now (056): the code stays, but no tab leads to it and #/?view=table shows the board.
const TABLE_VIEW = false;
const Q = { text: '', parsed: parseQuery(''), view: 'board', sort: 'id', dir: 'asc' };
// Current project (067, 071, 072): a pinned `project:` term added to every query. Kept in localStorage and
// mirrored as `project:<name>` in the URL's q parameter; URLs without it fall back to the stored value.
// NO_PROJECT pins the empty term `project:` (tickets without a project). The choices are the distinct
// `project:` values on tickets; a project exists as long as some ticket has it.
const PROJECT_KEY = 'sanvi.project';
const NO_PROJECT = '__none__';
let project = '';
const storedProject = () => { try { return localStorage.getItem(PROJECT_KEY) || ''; } catch { return ''; } };
project = storedProject();
const projectNames = () => [...new Set(S.tickets.map((t) => t.project).filter(Boolean))].sort((a, b) => a.localeCompare(b));
// A stored project that no ticket has any more (renamed, removed) would show an empty board: fall back to all.
// A project typed in the URL is honoured, so shared links keep working.
let projectFromUrl = false;
function dropStaleProject() {
  if (!project || project === NO_PROJECT || projectFromUrl || projectNames().includes(project)) return false;
  project = '';
  persistProject();
  setQuery(Q.text);
  return true;
}
// One project and no explicit choice, and every ticket has it: the switcher is just a label and new tickets go there.
const soleProject = () => { const n = projectNames(); return n.length === 1 && (project === '' || project === n[0]) && S.tickets.every((t) => t.project) ? n[0] : ''; };
// The one place that decides what the header shows (and whether P works): 'none' | 'label' | 'dropdown'.
const switcherMode = () => (soleProject() ? 'label' : projectNames().length > 0 || project ? 'dropdown' : 'none');
// Recently used projects (069): remembered in the browser, newest first, at most 9 (Alt+1..9).
const RECENT_KEY = 'sanvi.recentProjects';
let recent = [];
try { recent = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]').filter((x) => typeof x === 'string'); } catch { /* ignore */ }
const noteRecent = (n) => { recent = [n, ...recent.filter((x) => x !== n)].slice(0, 9); try { localStorage.setItem(RECENT_KEY, JSON.stringify(recent)); } catch { /* ignore */ } };
const recentProjects = () => recent.filter((n) => projectNames().includes(n));
const orderedProjects = () => { const r = recentProjects(); return [...r, ...projectNames().filter((n) => !r.includes(n))]; };
const newProjectValue = () => soleProject() || (project === NO_PROJECT ? '' : project);
const projectTerm = () => (project === NO_PROJECT ? 'project:' : project ? `project:${project}` : '');
function setQuery(text) {
  Q.text = text;
  const m = /(?:^|\s)project:([^\s,]*)(?=\s|$)/i.exec(text);
  projectFromUrl = !!m;
  if (m) { project = m[1] || NO_PROJECT; Q.text = text.replace(m[0], ' ').trim(); persistProject(); }
  Q.parsed = parseQuery([Q.text, projectTerm()].filter(Boolean).join(' '));
}
function persistProject() { try { if (project) localStorage.setItem(PROJECT_KEY, project); else localStorage.removeItem(PROJECT_KEY); } catch { /* ignore */ } }
function setProject(name) {
  projectFromUrl = false;
  project = name === NO_PROJECT ? NO_PROJECT : String(name ?? '').trim().replace(/[\s,]+/g, '-');
  persistProject();
  if (project && project !== NO_PROJECT) noteRecent(project);
  setQuery(Q.text);
  paintProject();
  syncHash();
  toast(project === NO_PROJECT ? 'Project: none' : project ? `Project: ${project}` : 'Project: all');
}
function paintProject() {
  const sel = $('#proj-sel'), label = $('#proj-label');
  if (!sel) return;
  const names = orderedProjects();
  const mode = switcherMode();
  sel.hidden = mode !== 'dropdown';
  label.hidden = mode !== 'label';
  label.textContent = soleProject();
  if (project && project !== NO_PROJECT && !names.includes(project)) names.push(project);
  sel.replaceChildren(el('option', { value: '' }, 'All projects'), ...names.map((n) => el('option', { value: n }, n)),
    el('option', { value: NO_PROJECT }, 'No project'));
  sel.value = project;
  sel.classList.toggle('set', !!project);
}
function loadHash() {
  const h = location.hash || '#/';
  if (!h.startsWith('#/?') && h !== '#/') return false;
  const p = new URLSearchParams(h.slice(3));
  const hq = p.get('q') || '';
  if (!/(?:^|\s)project:/i.test(hq)) project = storedProject();
  setQuery(hq);
  if (dropStaleProject()) syncHash();
  Q.view = TABLE_VIEW && p.get('view') === 'table' ? 'table' : 'board';
  if (!TABLE_VIEW && p.get('view') === 'table') { // old bookmark: show the board and drop the parameter from the URL
    const h2 = hashForState();
    history.replaceState(null, '', h2); currentHash = h2;
  }
  Q.sort = SORT_KEYS.includes(p.get('sort')) ? p.get('sort') : 'id';
  Q.dir = p.get('dir') === 'desc' ? 'desc' : 'asc';
  return true;
}
function hashForState() {
  const p = new URLSearchParams();
  const q = [Q.text, projectTerm()].filter(Boolean).join(' ');
  if (q) p.set('q', q);
  if (Q.view === 'table') {
    p.set('view', 'table');
    if (Q.sort !== 'id' || Q.dir !== 'asc') { p.set('sort', Q.sort); p.set('dir', Q.dir); }
  }
  const qs = p.toString();
  return qs ? `#/?${qs}` : '#/';
}
function syncHash() {
  const h = hashForState();
  if (location.hash !== h) { currentHash = h; history.replaceState(null, '', h); }
  renderBoard();
}
function setFilter(text) { setQuery(text); syncHash(); }
function setView(view) { Q.view = view; syncHash(); }
function sortBy(key) {
  if (Q.sort === key) Q.dir = Q.dir === 'asc' ? 'desc' : 'asc'; else { Q.sort = key; Q.dir = 'asc'; }
  syncHash();
}

function filterBar() {
  const input = el('input', {
    id: 'search', type: 'search', value: Q.text, placeholder: 'Search… e.g. migrate -area:research status:open,blocked',
    oninput: (e) => setFilter(e.target.value),
    onkeydown: (e) => { // Enter on an id query (#33, 033, 33) opens that ticket, hidden column or not
      if (e.key !== 'Enter' || e.isComposing) return;
      const n = idQuery(Q.parsed);
      const hits = n === null ? [] : S.tickets.filter((t) => Number(t.id) === n);
      if (hits.length === 1) { e.preventDefault(); location.hash = `#/t/${encodeURIComponent(hits[0].file)}`; }
    },
  });
  const tab = (v, label) => el('button', { type: 'button', class: Q.view === v ? 'active' : '', 'aria-pressed': String(Q.view === v), onclick: () => setView(v) }, label);
  return el('div', { class: 'filterbar' }, input,
    TABLE_VIEW && el('span', { class: 'viewswitch' }, tab('board', 'Board'), tab('table', 'Table')),
    Q.view === 'board' && el('span', { class: 'selhint' }, 'No card selected · press j'),
    Q.text.trim() && el('span', { class: 'active-filter' }, 'Filter: ', el('code', {}, formatQuery(Q.parsed))),
    Q.text.trim() && el('button', { type: 'button', onclick: () => { setFilter(''); $('#search')?.focus(); } }, 'Clear'));
}

let pendingFocus = null; // file whose card gets focus on the next board render

function pickBar() {
  const t = pick && S.tickets.find((x) => x.file === pick.file);
  if (!t) return null;
  return el('div', { class: 'pickbar', role: 'status' }, el('strong', {}, `Moving #${t.id}`), ` → ${pick.status || '(no status)'}  ·  `,
    el('kbd', {}, 'h'), ' ', el('kbd', {}, 'l'), ' choose column · ', el('kbd', {}, 'j'), ' ', el('kbd', {}, 'k'), ' shown/hidden · ', el('kbd', {}, '1'), '-', el('kbd', {}, '9'), ' drop there · ',
    el('kbd', {}, 'Space'), '/', el('kbd', {}, 'Enter'), ' drop · ', el('kbd', {}, 'Esc'), ' cancel');
}

const byBoardOrder = (a, b) => scoreTicket(b, Q.parsed) - scoreTicket(a, Q.parsed) || (PRIO[a.priority] ?? 2) - (PRIO[b.priority] ?? 2) || a.file.localeCompare(b.file, 'en', { numeric: true });

function renderBoard() {
  const peekFile = document.activeElement?.closest?.('.peekpop a')?.dataset.file; // keep the list's focus across a re-render
  if (peek && !hidden.has(peek)) peek = null; // the column was shown after all
  if (pick && !S.tickets.some((t) => t.file === pick.file)) { pick = null; document.body.classList.remove('moving'); } // the ticket is gone
  const hadFocus = document.activeElement?.id === 'search';
  const caret = hadFocus ? document.activeElement.selectionStart : 0;
  const a0 = document.activeElement;
  const focusFree = !a0 || a0 === document.body || !!a0.closest?.('.card'); // not typing in a field, overlay or list
  if (pendingFocus) selected = pendingFocus;
  if (selected && !S.tickets.some((t) => t.file === selected)) selected = null; // it was deleted or renamed
  if (stripSel !== null && !hidden.has(stripSel)) stripSel = null; // that column is shown again
  if (selected) lastSelected = selected;
  document.body.classList.toggle('has-selection', !!selected || stripSel !== null);
  const target = selected;
  pendingFocus = null;
  $('#dirname').textContent = S.cfg.name ? `· ${S.cfg.name}` : '';
  // keep scroll (page, board, table wrapper, each column) across the re-render
  const scroll = {
    y: window.scrollY, x: document.querySelector('.board')?.scrollLeft ?? 0, tx: document.querySelector('.tablewrap')?.scrollLeft ?? 0,
    cols: Object.fromEntries([...document.querySelectorAll('.col')].map((c) => [c.dataset.status, c.scrollTop])),
  };
  const restore = () => {
    const b = document.querySelector('.board'), t = document.querySelector('.tablewrap');
    if (b) b.scrollLeft = scroll.x;
    if (t) t.scrollLeft = scroll.tx;
    for (const c of document.querySelectorAll('.col')) c.scrollTop = scroll.cols[c.dataset.status] ?? 0;
    window.scrollTo(0, scroll.y);
  };
  if (Q.view === 'table') {
    show(view, filterBar(), tableView());
    restore();
    if (hadFocus) { const i = $('#search'); i.focus({ preventScroll: true }); i.setSelectionRange(caret, caret); }
    return;
  }
  let num = 0;
  show(view, filterBar(), hiddenStrip(), hiddenIdNotice(), pickBar(), el('div', { class: 'board' }, [...columns().map((status) => {
    const n = status ? ++num : 0; // numbers follow the full order, hidden columns keep theirs
    if (hidden.has(status)) return null;
    const items = S.tickets.filter((t) => t.status === status && matchTicket(t, Q.parsed))
      .sort(byBoardOrder);
    return el('section', {
      class: `col${pick?.status === status ? ' target' : ''}`, 'data-status': status,
      ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('over'); },
      ondragleave: (e) => e.currentTarget.classList.remove('over'),
      ondrop: (e) => {
        e.preventDefault(); e.currentTarget.classList.remove('over');
        const col = e.dataTransfer.getData(COLUMN_DRAG);
        if (col) moveColumn(col, status); else moveTicket(e.dataTransfer.getData('text/plain'), status);
      },
    }, el('h2', S.cfg.statuses.includes(status) ? {
      draggable: 'true', title: 'Drag to reorder columns',
      ondragstart: (e) => columnDragStart(e, status),
      ondragend: (e) => e.currentTarget.closest('.col')?.classList.remove('dragging-col'),
    } : {}, n > 0 && n <= 9 && el('kbd', { class: 'num', title: `Press ${n} to move the held or focused ticket here` }, String(n)),
    el('span', {}, status || '(no status)'), el('span', { class: 'count' }, String(items.length)),
      el('button', { type: 'button', class: 'hide', title: `Hide ${status || 'this'} column`, 'aria-label': `Hide ${status || 'no-status'} column`, onclick: () => toggleColumn(status) }, '×')), items.map((t) => card(t, matchedOnlyInBody(t, Q.parsed))));
  }), el('div', { class: 'addcol' }, el('button', { type: 'button', title: 'Add a status column', onclick: () => document.dispatchEvent(new Event('add-status')) }, '+ Status'))]));
  restore();
  if (peekFile) view.querySelector(`.peekpop a[data-file="${CSS.escape(peekFile)}"]`)?.focus({ preventScroll: true });
  if (hadFocus) { const i = $('#search'); i.focus({ preventScroll: true }); i.setSelectionRange(caret, caret); }
  const focusEl = target && [...view.querySelectorAll('.card')].find((c) => c.dataset.file === target);
  if (focusEl && focusFree && !peekFile) { focusEl.focus({ preventScroll: true }); } // never scroll here: a move or live refresh keeps the view; j/k/h/l scroll themselves
}

const COLS = [['id', 'ID'], ['title', 'Title'], ['status', 'Status'], ['area', 'Area'], ['priority', 'Priority'], ['progress', 'Progress']];

// Read-only projection of the same tickets and filter as the board.
function tableView() {
  let rows = sortTickets(S.tickets.filter((t) => matchTicket(t, Q.parsed)), Q.sort, Q.dir, columns());
  if (Q.sort === 'id' && Q.dir === 'asc' && Q.parsed.words.length) { // default order + a text query: best matches first
    rows = rows.map((t) => [scoreTicket(t, Q.parsed), t]).sort((a, b) => b[0] - a[0]).map((x) => x[1]); // stable
  }
  const head = COLS.map(([key, label]) => el('th', { 'aria-sort': Q.sort === key ? (Q.dir === 'asc' ? 'ascending' : 'descending') : 'none' },
    el('button', { type: 'button', onclick: () => sortBy(key) }, label, Q.sort === key ? (Q.dir === 'asc' ? ' ▲' : ' ▼') : '')));
  const open = (t) => { location.hash = `#/t/${encodeURIComponent(t.file)}`; };
  return el('div', { class: 'tablewrap' }, el('table', { class: 'tickets' },
    el('thead', {}, el('tr', {}, head)),
    el('tbody', {}, rows.length ? rows.map((t) => el('tr', { class: changedOnDisk.has(t.file) ? 'changed' : '', onclick: () => open(t) },
      el('td', { class: 'id' }, `#${t.id}`),
      el('td', {}, el('a', { href: `#/t/${encodeURIComponent(t.file)}`, 'data-file': t.file }, t.title)),
      el('td', {}, t.status),
      el('td', {}, t.area),
      el('td', {}, t.priority),
      el('td', {}, t.progress.total > 0 ? `${t.progress.done}/${t.progress.total}` : ''))) : el('tr', {}, el('td', { colspan: String(COLS.length), class: 'none' }, 'No matching tickets')))));
}

// --------------------------------------------------------------- detail

const copyDraft = (t) => ({ status: t.status, area: t.area, project: t.project, priority: t.priority, body: t.body });
const isDirty = () => !!D && !D.gone && ['status', 'area', 'project', 'priority', 'body'].some((k) => D.draft[k] !== D.loaded[k]);
const titleOfDraft = () => /^#\s+(.+?)\s*#*\s*$/m.exec(D.draft.body)?.[1] || D.loaded.title;

function updateState() {
  if (!D) return;
  const s = $('#state');
  const dirty = isDirty();
  s.textContent = dirty ? 'Unsaved changes — Ctrl+S to save' : 'Saved';
  s.className = `state${dirty ? ' dirty' : ''}`;
  $('#save').disabled = !dirty;
  $('#title').textContent = `#${D.loaded.id} ${titleOfDraft()}`;
}

function updateBanner() {
  const b = $('#banner');
  if (!b) return;
  b.replaceChildren();
  if (D.gone) {
    b.append(el('div', { class: 'banner err' }, 'This ticket no longer exists on disk. Your draft is still here.'));
  } else if (D.stale) {
    b.append(el('div', { class: 'banner', role: 'alert' },
      el('span', {}, D.conflict ? 'Not saved: this ticket changed on disk after you opened it.' : 'This ticket changed on disk while you were editing.'),
      el('button', { type: 'button', onclick: () => { D.loaded = D.stale; D.draft = copyDraft(D.stale); D.stale = null; D.conflict = false; renderDetail(); } }, 'Load disk version (discard my edits)'),
      el('button', { type: 'button', onclick: () => { D.loaded = D.stale; D.stale = null; D.conflict = false; updateBanner(); updateState(); toast('Kept your draft; the next save overwrites the disk version.'); } }, 'Keep my draft')));
  }
}

async function save() {
  if (!D || !isDirty()) return true;
  const sent = { ...D.draft };
  const fields = {};
  for (const k of ['status', 'area', 'project', 'priority']) if (sent[k] !== D.loaded[k]) fields[k] = sent[k];
  try {
    const t = await api('PUT', `tickets/${encodeURIComponent(D.file)}`, {
      version: D.loaded.version, fields, ...(sent.body !== D.loaded.body ? { body: sent.body } : {}),
    });
    ownVersions.add(t.version);
    D.loaded = t;
    D.stale = null; D.conflict = false;
    for (const k of Object.keys(sent)) if (D.draft[k] === sent[k]) D.draft[k] = t[k];
    updateBanner(); updateState();
    toast('Saved');
    return true;
  } catch (e) {
    if (e.status === 409) { D.stale = e.data.current; D.conflict = true; updateBanner(); $('#banner button')?.focus(); }
    else toast(`Save failed: ${e.message}`);
    return false;
  }
}

// Hidden board columns: a per-browser view preference (not written to the config file).
const hidden = new Set((() => { try { return JSON.parse(localStorage.getItem('tk.hidden') || '[]'); } catch { return []; } })());
function toggleColumn(status) {
  if (hidden.has(status)) hidden.delete(status); else hidden.add(status);
  try { localStorage.setItem('tk.hidden', JSON.stringify([...hidden])); } catch { /* ignore */ }
  if (document.querySelector('.board')) renderBoard();
}
const isHidden = (status) => hidden.has(status);

// Never hide silently: a strip lists hidden columns with counts and restores one on click.
// An id search (#33) that only finds its ticket in a hidden column would look like "not found": say where it is.
function hiddenIdNotice() {
  const n = idQuery(Q.parsed);
  if (n === null || !Q.text.includes('#')) return null;
  const hits = S.tickets.filter((t) => Number(t.id) === n && hidden.has(t.status) && matchTicket(t, Q.parsed));
  if (!hits.length) return null;
  return el('div', { class: 'hiddennotice', role: 'status' }, hits.map((t) => el('span', {},
    `#${t.id} ${t.title} is in hidden status ${t.status || '(no status)'} `,
    el('button', { type: 'button', onclick: () => { location.hash = `#/t/${encodeURIComponent(t.file)}`; } }, 'Open'), ' ',
    el('button', { type: 'button', onclick: () => toggleColumn(t.status) }, 'Show column'))));
}

// Tickets of one status within the current project (not the search text): what the hidden strip, its peek list
// and the keyboard fallback count, so they agree with the board.
const scopedTickets = (status) => {
  const p = parseQuery(projectTerm());
  return S.tickets.filter((t) => t.status === status && matchTicket(t, p));
};

function hiddenStrip() {
  const list = columns().filter((c) => hidden.has(c));
  if (!list.length) return null;
  const filtering = !!Q.text.trim();
  const numbered = columns().filter(Boolean);
  return el('div', { class: 'hiddenstrip' }, 'Hidden: ', list.map((status) => {
    const all = scopedTickets(status);
    const hits = filtering ? all.filter((t) => matchTicket(t, Q.parsed)).length : 0;
    const n = numbered.indexOf(status) + 1; // same numbering as the column badges
    const main = el('button', {
      type: 'button', 'data-status': status, title: `Show ${status || '(no status)'} (drop a ticket here to move it without showing)`,
      onclick: () => toggleColumn(status),
    }, n > 0 && n <= 9 && el('kbd', { class: 'num', title: `Press ${n} to move the held or focused ticket here` }, String(n)),
    `${status || '(no status)'} (${all.length}${filtering ? `, ${hits} match filter` : ''})`);
    const open = peek === status;
    // The state classes (hit, target, selected, over) live on the wrapper so name and arrow are one shape; both halves take drops.
    const drop = (e) => !e.target.closest?.('.peekpop') && !e.dataTransfer.types.includes(COLUMN_DRAG);
    return el('span', {
      class: `stripentry${hits ? ' hit' : ''}${pick?.status === status ? ' target' : ''}${stripSel === status ? ' selected' : ''}`, 'data-status': status,
      ondragover: (e) => { if (drop(e)) { e.preventDefault(); e.currentTarget.classList.add('over'); } },
      ondragleave: (e) => { if (!e.currentTarget.contains(e.relatedTarget)) e.currentTarget.classList.remove('over'); },
      ondrop: (e) => {
        if (!drop(e)) return;
        e.preventDefault(); e.currentTarget.classList.remove('over');
        const file = e.dataTransfer.getData('text/plain');
        if (file) moveTicket(file, status);
      },
    }, main,
      el('button', { type: 'button', class: 'peekbtn', 'data-status': status, title: `Peek at the tickets in ${status || '(no status)'} without showing the column`, 'aria-label': `Peek at ${status || 'no-status'} tickets`, 'aria-expanded': String(open), 'aria-haspopup': 'menu', onclick: () => togglePeek(status) }, '▾'),
      open && peekPopover(status));
  }));
}

// Peek (040): a read-only list of a hidden status's tickets in a popover under its strip entry. Nothing is
// un-hidden or stored. Items open the ticket or can be dragged onto a visible column.
let peek = null;
function togglePeek(status) {
  peek = peek === status ? null : status;
  renderBoard();
  if (peek) view.querySelector('.peekpop a')?.focus({ preventScroll: true });
}
// Enter on a selected strip entry: open (or re-enter) its list. h/l inside the list switch status.
function peekOpen(status) {
  if (peek !== status) togglePeek(status); else view.querySelector('.peekpop a')?.focus({ preventScroll: true });
}
function peekStep(dir) {
  const list = columns().filter((c) => hidden.has(c));
  const to = list[Math.max(0, Math.min(list.length - 1, list.indexOf(peek) + dir))];
  if (to === undefined || to === peek) return;
  peek = to;
  stripSel = to;
  renderBoard();
  view.querySelector('.peekpop a')?.focus({ preventScroll: true });
}
function closePeek({ refocus = false } = {}) {
  const was = peek;
  peek = null;
  renderBoard();
  if (refocus && stripSel !== was) [...view.querySelectorAll('.stripentry')].find((x) => x.querySelector('button[data-status]')?.dataset.status === was)?.querySelector('.peekbtn')?.focus({ preventScroll: true });
}
function peekPopover(status) {
  const items = scopedTickets(status).filter((t) => matchTicket(t, Q.parsed)).sort(byBoardOrder);
  const total = scopedTickets(status).length;
  return el('div', {
    class: 'peekpop', role: 'menu', 'aria-label': `Tickets in ${status || '(no status)'}`,
    onkeydown: (e) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const links = [...e.currentTarget.querySelectorAll('a')];
      const at = links.indexOf(document.activeElement);
      if (e.key === 'Escape') closePeek({ refocus: true });
      else if (e.key === 'h' || e.key === 'l' || e.key === 'ArrowLeft' || e.key === 'ArrowRight') peekStep(e.key === 'l' || e.key === 'ArrowRight' ? 1 : -1);
      else if (e.key === ' ') { // pick the ticket up like a card on the board: h/l choose the column, Space/Enter drops
        const t = S.tickets.find((x) => x.file === document.activeElement?.dataset?.file);
        if (t) { peek = null; setPick({ file: t.file, status: t.status }); }
      } else if (e.key === 'j' || e.key === 'ArrowDown') links[Math.min(links.length - 1, at + 1)]?.focus();
      else if ((e.key === 'k' || e.key === 'ArrowUp') && at <= 0) closePeek({ refocus: true }); // up past the first ticket: back to the strip
      else if (e.key === 'k' || e.key === 'ArrowUp') links[at - 1]?.focus();
      else if (e.key !== 'Enter' && e.key !== 'Tab') return; // Enter follows the link natively
      if (e.key !== 'Enter' && e.key !== 'Tab') e.preventDefault();
      e.stopPropagation(); // the board's own keys must not act while the list has the focus
    },
  }, items.length ? items.map((t) => el('a', {
    href: `#/t/${encodeURIComponent(t.file)}`, role: 'menuitem', draggable: 'true', 'data-file': t.file,
    ondragstart: (e) => { e.dataTransfer.setData('text/plain', t.file); e.dataTransfer.effectAllowed = 'move'; },
  }, el('span', { class: 'id' }, `#${t.id}`), el('span', { class: 'ttl' }, t.title),
  el('span', { class: 'meta' }, t.priority && el('span', { class: 'chip prio' }, t.priority), t.area && el('span', { class: 'chip' }, t.area))))
    : el('p', { class: 'hint' }, total ? `No tickets in ${status || '(no status)'} match the filter.` : `No tickets in ${status || '(no status)'}.`));
}
// Clicking empty space clears the selection, like Esc (058). A drag or text selection is not a click.
document.addEventListener('click', (e) => {
  if (!(selected || stripSel !== null) || !document.querySelector('.board')) return;
  if (e.target.closest?.('.card, button, a, input, textarea, select, .peekpop, .overlay, .cardmenu, .stripentry')) return;
  if (!document.body.contains(e.target) || String(getSelection()).length) return;
  setSelected(null);
  setStripSel(null);
});
document.addEventListener('mousedown', (e) => { if (peek && !e.target.closest?.('.stripentry')) { peek = null; if (document.querySelector('.board')) renderBoard(); } });

// Vim mode is an opt-in per-browser preference; storage can throw (private windows etc.).
const vimPref = {
  get() { try { return localStorage.getItem('tk.vim') === '1'; } catch { return false; } },
  set(on) { try { localStorage.setItem('tk.vim', on ? '1' : '0'); } catch { /* ignore */ } },
};

// Leave the editor for the preview. Unsaved edits stay in the draft unless `discard`.
function leaveEditor(discard = false) {
  if (!D) return;
  if (discard) { D.draft.body = D.loaded.body; updateState(); }
  setTab('view');
  document.querySelector('.tabs button.active')?.focus();
}

function field(label, node) { return el('label', {}, label, node); }

function select(values, current, onchange, id) {
  const opts = [...new Set([...values, current])];
  return el('select', { id, onchange: (e) => onchange(e.target.value) },
    opts.map((v) => el('option', { value: v, selected: v === current }, v || '(none)')));
}

// Upload an image for the open ticket and insert `![screenshot](assets/<id>-<n>.<ext>)` at the cursor.
// On any error the text is left as it was.
async function uploadImage(file, blob) {
  const res = await fetch(`/api/tickets/${encodeURIComponent(file)}/assets`, { method: 'POST', headers: { 'content-type': blob.type }, body: blob });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || res.statusText);
  return data.path;
}
const imageMd = (paths) => paths.map((p) => `![screenshot](${p})`);
// Upload the overlay's pending images to `file` (skipping ones a previous attempt already stored, tracked in `done`).
async function uploadAll(file, images, done, what) {
  done.paths ??= [];
  for (let i = done.paths.length; i < images.length; i++) {
    try { done.paths.push(await uploadImage(file, images[i].blob)); } catch (e) {
      throw new Error(`${what} but image ${i + 1} (${images[i].name || 'pasted'}) failed: ${e.message}. Press save again to retry; your text is kept.`);
    }
  }
}
async function attachImage(ta, blob) {
  try {
    const path = await uploadImage(D.file, blob);
    const md = `![screenshot](${path})`;
    const at = ta.selectionEnd;
    ta.setRangeText(md, at, at, 'end');
    ta.dispatchEvent(new Event('input', { bubbles: true }));
    toast(`Image saved as ${path}`);
  } catch (e) { toast(`Image not added: ${e.message}`); }
}
// A missing or unreadable attachment says so instead of showing just its alt text (error events do not bubble).
document.addEventListener('error', (e) => {
  const img = e.target;
  if (!(img instanceof HTMLImageElement) || !img.closest('.doc')) return;
  img.replaceWith(el('span', { class: 'missing-image', title: img.getAttribute('src') }, `Image not found: ${img.getAttribute('src')}`));
}, true);
// A comment was saved on the open ticket: take over its new version and put the same line into the draft, so a
// later save of unsaved edits is not refused as stale. Tab, scroll and (in the editor) the selection stay.
function applyNoteToDetail(saved) {
  const { note, ...t } = saved;
  const wasDirty = isDirty();
  const ed = $('.editor');
  const keep = { y: window.scrollY, top: ed?.scrollTop ?? 0, sel: ed ? [ed.selectionStart, ed.selectionEnd] : null };
  D.loaded = t;
  if (wasDirty) D.draft.body = insertNote(D.draft.body, note);
  else D.draft = copyDraft(t);
  renderTab();
  updateBanner(); updateState();
  const ta = $('.editor');
  if (ta) { ta.scrollTop = keep.top; ta.setSelectionRange(Math.min(keep.sel[0], ta.value.length), Math.min(keep.sel[1], ta.value.length)); }
  window.scrollTo(0, keep.y);
}
const imageOf = (dt) => [...(dt?.files ?? [])].find((f) => f.type.startsWith('image/'));

function renderTab(focusEditor = false) {
  const box = $('#content');
  if (D.tab === 'edit') {
    const ta = el('textarea', {
      class: 'editor', spellcheck: false,
      oninput: (e) => { D.draft.body = e.target.value; updateState(); },
      onpaste: (e) => { const f = imageOf(e.clipboardData); if (f) { e.preventDefault(); attachImage(e.currentTarget, f); } },
      ondragover: (e) => { if ([...(e.dataTransfer?.types ?? [])].includes('Files')) e.preventDefault(); },
      ondrop: (e) => { const f = imageOf(e.dataTransfer); if (f) { e.preventDefault(); attachImage(e.currentTarget, f); } },
    });
    ta.value = D.draft.body;
    const vimOn = vimPref.get();
    const mode = el('span', { id: 'vimmode', class: 'vimmode', 'aria-live': 'polite' });
    const toggle = el('input', { type: 'checkbox', checked: vimOn, onchange: (e) => { vimPref.set(e.target.checked); renderTab(); } });
    box.replaceChildren(ta, el('div', { class: 'editorbar' },
      el('label', {}, toggle, ' Vim mode'), mode,
      el('span', { class: 'hint' }, vimOn ? ':w save · :q leave · :q! discard · :wq' : 'Ctrl+S save · Esc leave')));
    if (vimOn) {
      attachVim(ta, {
        onChange: (t) => { D.draft.body = t; updateState(); },
        onSave: () => save(),
        onQuit: (force) => {
          if (!force && isDirty()) { mode.textContent = 'E37: No write since last change (add ! to override)'; return; }
          leaveEditor(force);
        },
        onStatus: (text, m) => { mode.textContent = text; mode.dataset.mode = m; },
      });
    }
    if (focusEditor) ta.focus();
  } else {
    const { summary, rest } = splitSummary(D.draft.body);
    const doc = el('div', { class: 'doc' });
    doc.innerHTML = renderMarkdown(rest);
    if (summary) {
      const sum = el('aside', { class: 'summary', 'aria-label': 'Summary' }, el('h2', {}, 'Summary'), el('div', { class: 'doc' }));
      sum.lastChild.innerHTML = renderMarkdown(summary);
      box.replaceChildren(sum, doc);
    } else box.replaceChildren(doc);
  }
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === D.tab);
}

function setTab(tab) { D.tab = tab; renderTab(tab === 'edit'); }

function renderDetail({ fresh = false, edit = false } = {}) {
  const ed = document.activeElement?.classList?.contains('editor') ? document.activeElement : null;
  const sel = ed && [ed.selectionStart, ed.selectionEnd];
  const d = D.draft;
  show(view, el('div', { class: 'detail' },
    el('a', { href: '#/' }, '← Board'),
    el('h1', { id: 'title', tabindex: '-1' }),
    el('div', { class: 'bar' },
      field('Status', select(S.cfg.statuses, d.status, (v) => { d.status = v; updateState(); }, 'f-status')),
      field('Area', el('input', { value: d.area, oninput: (e) => { d.area = e.target.value; updateState(); } })),
      field('Project', el('input', { value: d.project, oninput: (e) => { d.project = e.target.value; updateState(); } })),
      field('Priority', select(['', 'high', 'medium', 'low'], d.priority, (v) => { d.priority = v; updateState(); })),
      el('span', { class: 'spacer' }),
      agentOn && d.status === 'design' && el('button', {
        type: 'button', id: 'refine-btn', title: 'Let Claude rewrite this ticket (problem, criteria, approach) and move it to open',
        disabled: chatPage.refining(D.file),
        onclick: () => refineTicket(D.file),
      }, chatPage.refining(D.file) ? 'Refining…' : 'Refine with Claude'),
      el('span', { id: 'state', class: 'state' }),
      el('button', { id: 'save', class: 'primary', type: 'button', onclick: save }, 'Save')),
    el('div', { id: 'banner' }),
    el('div', { class: 'tabs' },
      el('button', { type: 'button', 'data-tab': 'view', onclick: () => setTab('view') }, 'Preview'),
      el('button', { type: 'button', 'data-tab': 'edit', onclick: () => setTab('edit') }, 'Edit'),
      el('button', { type: 'button', class: 'comment-btn', title: 'Add a timestamped comment (c)', onclick: () => document.dispatchEvent(new CustomEvent('add-note', { detail: D.file })) }, 'Comment')),
    el('div', { id: 'content' })));
  renderTab(edit); updateBanner(); updateState();
  if (ed && D.tab === 'edit') { const t = $('.editor'); t.focus(); t.setSelectionRange(...sel); }
  else if (fresh && !edit) $('#title').focus();
}

async function openTicket(file, tab = 'view') {
  try {
    const t = await api('GET', `tickets/${encodeURIComponent(file)}`);
    D = { file, loaded: t, draft: copyDraft(t), stale: null, conflict: false, gone: false, tab };
    S.lastFile = file;
    renderDetail({ fresh: true, edit: tab === 'edit' });
  } catch (e) {
    D = null;
    show(view, el('p', {}, `Could not open ${file}: ${e.message} `, el('a', { href: '#/' }, 'Back to board')));
  }
}

async function refreshDetail() {
  if (!D) return;
  try {
    const t = await api('GET', `tickets/${encodeURIComponent(D.file)}`);
    D.gone = false;
    if (t.version === D.loaded.version) { updateBanner(); return; }
    if (!isDirty()) {
      D.loaded = t; D.draft = copyDraft(t); D.stale = null;
      renderDetail(); toast('Reloaded: changed on disk');
    } else { D.stale = t; updateBanner(); }
  } catch (e) {
    if (e.status === 404) { D.gone = true; updateBanner(); updateState(); }
  }
}

// ------------------------------------------------------------ new ticket

function renderNew() {
  const f = { title: '', area: '', project: newProjectValue(), status: S.cfg.statuses[0] || 'open', priority: '' };
  show(view, el('form', {
    class: 'newform',
    onsubmit: async (e) => {
      e.preventDefault();
      try {
        const t = await api('POST', 'tickets', f);
        pendingTab = 'edit';
        location.hash = `#/t/${encodeURIComponent(t.file)}`;
      } catch (err) { toast(err.message); }
    },
  },
  el('h2', {}, 'New ticket'),
  field('Title', el('input', { required: true, oninput: (e) => { f.title = e.target.value; } })),
  field('Area', el('input', { oninput: (e) => { f.area = e.target.value; } })),
  field('Project', el('input', { value: f.project, oninput: (e) => { f.project = e.target.value; } })),
  field('Status', select(S.cfg.statuses, f.status, (v) => { f.status = v; })),
  field('Priority', select(['', 'high', 'medium', 'low'], '', (v) => { f.priority = v; })),
  el('div', {}, el('button', { class: 'primary', type: 'submit' }, 'Create'), ' ', el('a', { href: '#/' }, 'Cancel'))));
  view.querySelector('input').focus();
}

// ------------------------------------------------------------------ trash

// Move a ticket to the trash (files are kept for 30 days, see the Trash view). Focus goes to a neighbouring card.
async function deleteTicket(file) {
  const t = S.tickets.find((x) => x.file === file);
  if (!t) return;
  const cardEl = [...document.querySelectorAll('.card')].find((c) => c.dataset.file === file);
  const near = (cardEl?.nextElementSibling ?? cardEl?.previousElementSibling);
  const neighbour = near?.classList.contains('card') ? near.dataset.file : null;
  try {
    await api('DELETE', `tickets/${encodeURIComponent(file)}`, { version: t.version });
    toast(`#${t.id} moved to the trash (restore it from Trash within 30 days)`);
    if (location.hash.startsWith('#/t/')) { D = null; location.hash = '#/'; }
    pendingFocus = neighbour;
  } catch (e) {
    toast(e.status === 409 ? `#${t.id} changed on disk; not deleted. Board refreshed.` : `Delete failed: ${e.message}`);
  }
  await refreshAll();
}

async function renderTrash() {
  let items;
  try { items = await api('GET', 'trash'); } catch (e) { toast(`Trash failed: ${e.message}`); return; }
  const act = async (fn, msg) => { try { await fn(); toast(msg); } catch (e) { toast(e.message); } await renderTrash(); };
  show(view, el('div', { class: 'detail' }, el('a', { href: '#/' }, '← Board'), el('h1', {}, 'Trash'),
    el('p', { class: 'hint' }, 'Deleted tickets are kept for 30 days, then removed for good. Restoring never overwrites a ticket; if the id was reused the ticket gets the next free id.'),
    items.length ? el('table', { class: 'trash' }, el('thead', {}, el('tr', {}, ['ID', 'Title', 'Days left', ''].map((h) => el('th', {}, h)))),
      el('tbody', {}, items.map((x) => el('tr', {}, el('td', {}, `#${x.id}`), el('td', {}, x.title), el('td', {}, `${x.daysLeft}`),
        el('td', {},
          el('button', { type: 'button', class: 'primary', onclick: () => act(() => api('POST', `trash/${x.key}/restore`, {}), `#${x.id} restored`) }, 'Restore'), ' ',
          el('button', { type: 'button', onclick: () => { if (confirm(`Delete #${x.id} "${x.title}" for good? This cannot be undone.`)) act(() => api('DELETE', `trash/${x.key}`, {}), `#${x.id} deleted for good`); } }, 'Delete for good')))))
    ) : el('p', {}, 'The trash is empty.')));
}

// ------------------------------------------------------------ scratch notes

// NOTES.md: notes that belong to no ticket. `scratch` is the last listing; its version guards delete/promote.
let scratch = { version: '', notes: [] };
let notesQuery = '';

async function renderNotes() {
  try { scratch = await api('GET', 'scratch'); } catch (e) { toast(`Notes failed: ${e.message}`); return; }
  paintNotes();
}

function paintNotes() {
  const act = async (fn, msg) => {
    try { scratch = await fn(); toast(msg); } catch (e) {
      toast(e.status === 409 ? 'Notes changed on disk; reloaded, try again.' : `Failed: ${e.message}`);
      if (e.status === 409) scratch = e.data.current;
    }
    await refreshAll();
    if (location.hash === '#/notes') paintNotes();
  };
  const q = notesQuery.trim().toLowerCase();
  const shown = [...scratch.notes].reverse().filter((n) => !q || `${n.stamp} ${n.text}`.toLowerCase().includes(q));
  const search = el('input', { type: 'search', placeholder: 'Search notes', 'aria-label': 'Search notes', value: notesQuery,
    oninput: (e) => { notesQuery = e.target.value; paintNotes(); } });
  const cards = compact(shown.length ? shown.map((n) => {
    const body = el('div', { class: 'md' });
    body.innerHTML = renderMarkdown(n.text);
    return el('article', { class: `note${n.promoted ? ' promoted' : ''}`, 'data-index': n.index },
      el('div', { class: 'stamp' }, n.stamp || 'undated'),
      body,
      el('div', { class: 'buttons' },
        n.promoted
          ? (() => { const t = S.tickets.find((x) => Number(x.id) === Number(n.promoted)); return el('a', { href: t ? `#/t/${encodeURIComponent(t.file)}` : '#/' }, `→ #${n.promoted}`); })()
          : el('button', { type: 'button', onclick: () => act(async () => { const r = await api('POST', `scratch/${n.index}/promote`, { version: scratch.version, project: newProjectValue() }); return r; }, 'Made an idea ticket from the note') }, 'Make ticket'),
        ' ',
        el('button', { type: 'button', onclick: () => { if (confirm('Delete this note? This cannot be undone.')) act(() => api('DELETE', `scratch/${n.index}`, { version: scratch.version }), 'Note deleted'); } }, 'Delete')));
  }) : el('p', {}, scratch.notes.length ? 'No note matches.' : 'No notes yet. Press m (or Ctrl+M) to jot one down.'));
  const list = el('div', { class: 'notes' }, cards);
  const hadFocus = document.activeElement?.getAttribute?.('aria-label') === 'Search notes';
  show(view, el('div', { class: 'detail' }, el('a', { href: '#/' }, '← Board'), el('h1', {}, 'Notes'),
    el('p', { class: 'hint' }, 'Quick notes saved in NOTES.md next to the tickets, newest first. Edit the file by hand if you like. m / Ctrl+M adds one.'),
    search, list));
  if (hadFocus) { search.focus(); search.setSelectionRange(search.value.length, search.value.length); }
}

// --------------------------------------------------------------- routing

let pendingTab = null;
let currentHash = '';
let ignoreHash = false;

async function route() {
  const h = location.hash || '#/';
  if (h.startsWith('#/t/')) {
    const tab = pendingTab || 'view';
    pendingTab = null;
    await openTicket(decodeURIComponent(h.slice(4)), tab);
  } else {
    D = null;
    peek = null;
    if (pick && h !== '#/' && !h.startsWith('#/?')) setPick(null);
    pendingFocus = S.lastFile ?? null;
    if (h === '#/new') renderNew();
    else if (h === '#/trash') renderTrash();
    else if (h === '#/notes') renderNotes();
    else if (h === '#/projects') projectsPage.render();
    else if (h === '#/idea') location.replace('#/'); // old bookmark: the idea box is an overlay now (i / Ctrl+I)
    else { loadHash(); await refreshAll(); }
  }
}

window.addEventListener('hashchange', () => {
  if (ignoreHash) { ignoreHash = false; return; }
  if (isDirty() && !confirm('Discard unsaved changes?')) {
    ignoreHash = true; location.hash = currentHash; return;
  }
  currentHash = location.hash;
  route();
});
window.addEventListener('beforeunload', (e) => { if (isDirty()) e.preventDefault(); });
document.addEventListener('keydown', (e) => {
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') { e.preventDefault(); save(); }
});
initKeys({
  S, el, columns, toast, moveTicket, setTab, pick: () => pick, setPick, boardHash: hashForState, deleteTicket, peekClose: () => { if (peek === null) return false; closePeek({ refocus: true }); return true; }, peekOpen, stripSelected: () => stripSel, selectStrip: setStripSel, hiddenColumns: () => columns().filter((c) => hidden.has(c)), hiddenCount: (status) => scopedTickets(status).length, selected: () => selected, lastSelected: () => lastSelected, select: setSelected, addStatus, deleteStatus, toggleColumn, isHidden,
  // `done` is kept by the overlay across retries: the ticket is created once, images are stored once.
  saveIdea: async (text, images = [], done = {}, ideaProject = newProjectValue()) => {
    done.ticket ??= await api('POST', 'ideas', { text, project: ideaProject });
    const t = done.ticket;
    await uploadAll(t.file, images, done, `Idea #${t.id} was saved,`);
    if (done.paths?.length && !done.linked) {
      const cur = await api('GET', `tickets/${encodeURIComponent(t.file)}`);
      const links = `${imageMd(done.paths).join('\n\n')}\n`;
      const at = cur.body.indexOf('\n## Acceptance criteria');
      const body = at < 0 ? `${cur.body.replace(/\n*$/, '\n')}\n${links}` : `${cur.body.slice(0, at).replace(/\n*$/, '\n')}\n${links}${cur.body.slice(at)}`;
      try { ownVersions.add((await api('PUT', `tickets/${encodeURIComponent(t.file)}`, { version: cur.version, body })).version); } catch (e) {
        throw new Error(`Idea #${t.id} was saved with its images, but linking them failed: ${e.message}. Press save again to retry; your text is kept.`);
      }
    }
    done.linked = true;
    toast(`Idea captured as #${t.id}`);
    return t;
  },
  addScratch: async (text) => {
    scratch = await api('POST', 'scratch', { text });
    toast(`Note saved (${scratch.notes.length} in NOTES.md)`);
    if (location.hash === '#/notes') paintNotes();
  },
  about: () => api('GET', 'about'),
  agents: () => agentOn,
  refine: refineTicket,
  refineAll: () => chatPage.refineAll().catch((e) => toast(`Refine failed: ${e.message}`)),
  ask: (q) => chatPage.ask(q).catch((e) => toast(`Ask failed: ${e.message}`)),
  isRefining: (file) => chatPage.refining(file),
  detail: () => D, projects: () => ({ names: orderedProjects(), recent: recentProjects(), current: project, none: NO_PROJECT, mode: switcherMode(), fresh: newProjectValue() }), setProject,
  addNote: async (file, text, images = [], done = {}) => {
    const t = S.tickets.find((x) => x.file === file);
    if (!t) throw new Error('ticket not found');
    const open = D && D.file === file ? D : null; // the ticket is open in the detail view: it may hold an unsaved draft
    if (open && (open.stale || open.gone)) throw new Error('This ticket changed on disk while you were editing: resolve the banner above first (your comment text is kept).');
    await uploadAll(file, images, done, 'Comment not added:');
    const full = [text.trim(), ...imageMd(done.paths ?? [])].filter(Boolean).join('\n');
    let saved;
    try {
      saved = await api('POST', `tickets/${encodeURIComponent(file)}/notes`, { version: open ? open.loaded.version : t.version, text: full });
      ownVersions.add(saved.version);
    } catch (e) {
      if (e.status === 409) { await refreshAll(); throw new Error(`#${t.id} changed on disk; comment not saved (your text is kept). Try again.`); }
      throw e;
    }
    if (open && D === open) applyNoteToDetail(saved);
    await refreshAll();
    toast(`Comment added to #${t.id}`);
  },
  setField: async (file, field, value) => {
    if (D && D.file === file) { D.draft[field] = value; renderDetail(); toast(`${field[0].toUpperCase()}${field.slice(1)} set to ${value || '(none)'} (unsaved)`); return; }
    const t = S.tickets.find((x) => x.file === file);
    if (!t || (t[field] ?? '') === value) return;
    try {
      const saved = await api('PUT', `tickets/${encodeURIComponent(file)}`, { version: t.version, fields: { [field]: value } });
      ownVersions.add(saved.version);
      toast(`#${t.id} ${field}: ${value || '(none)'}`);
    } catch (e) { toast(e.status === 409 ? `#${t.id} changed on disk; not changed. Board refreshed.` : `Change failed: ${e.message}`); }
    await refreshAll();
  },
  setDraftStatus: (v) => { D.draft.status = v; const s = $('#f-status'); if (s) s.value = v; updateState(); toast(`Status set to ${v} (unsaved)`); },
});
$('#new-btn').addEventListener('click', () => { location.hash = '#/new'; });
$('#proj-sel').addEventListener('change', (e) => {
  setProject(e.target.value);
});
$('#trash-btn').addEventListener('click', () => { location.hash = '#/trash'; });
$('#notes-btn').addEventListener('click', () => { location.hash = '#/notes'; });
$('#projects-btn').addEventListener('click', () => { location.hash = '#/projects'; });
const projectsPage = initProjects({ el, show, api, toast, view, canBrowse: () => agentOn });
async function paintProjectsBadge() { // the button carries the number of project warnings
  try { await projectsPage.load(); } catch { return; }
  const n = projectsPage.warningCount();
  $('#projects-btn').textContent = n ? `Projects ⚠ ${n}` : 'Projects';
  $('#projects-btn').title = n ? `${n} project warning${n > 1 ? 's' : ''}: open to see them` : 'Projects: directory and instructions for the agent';
}
document.addEventListener('projects-changed', paintProjectsBadge);
let agentOn = false; // server started with --agents
async function refineTicket(file) {
  try { await chatPage.refine(file); } catch (e) { toast(`Refine failed: ${e.message}`); }
}
const chatPage = initChat({ el, show, api, toast, button: $('#chat-btn'), project: () => (project === NO_PROJECT ? '' : project) });
api('GET', 'agent').then((a) => {
  agentOn = a.enabled;
  $('#chat-btn').hidden = !a.enabled;
  if (!a.enabled) return;
  chatPage.start();
  let lastKey = '';
  chatPage.onChange(() => { // repaint the board / detail when the set of tickets being refined changes
    const key = S.tickets.filter((t) => chatPage.refining(t.file)).map((t) => t.file).join();
    if (key === lastKey) return;
    lastKey = key;
    if (document.querySelector('.board, .tablewrap')) renderBoard();
    else if (D && !isDirty()) renderDetail();
  });
}).catch(() => {});
$('#idea-btn').addEventListener('click', () => document.dispatchEvent(new Event('open-idea')));

const refreshAll = coalesce(doRefresh); // bursts of refreshes (moves, live events) share one request pair
async function doRefresh() {
  const before = new Map(S.tickets.map((t) => [t.file, t.version]));
  try {
    [S.cfg, S.tickets] = await Promise.all([api('GET', 'config'), api('GET', 'tickets?bodies=1')]);
  } catch (e) { toast(`Load failed: ${e.message}`); return; }
  for (const t of S.tickets) {
    if (!before.has(t.file) || before.get(t.file) === t.version) continue;
    if (ownVersions.has(t.version)) continue;
    changedOnDisk.add(t.file);
    setTimeout(() => { changedOnDisk.delete(t.file); if (document.querySelector('.board, .tablewrap')) renderBoard(); }, 6000);
  }
  if (dropStaleProject()) syncHash();
  paintProject();
  paintProjectsBadge();
  const h = location.hash || '#/';
  if (h.startsWith('#/t/')) await refreshDetail();
  else if (h === '#/trash') renderTrash();
  else if (h === '#/notes') renderNotes();
  else if (h === '#/' || h === '' || h.startsWith('#/?')) renderBoard();
}

// live updates
let refreshTimer;
const es = new EventSource('/api/events');
es.onopen = () => $('#live').classList.add('on');
es.onerror = () => $('#live').classList.remove('on');
es.onmessage = (e) => {
  let msg = {};
  try { msg = JSON.parse(e.data); } catch { /* treat as a file change */ }
  if (msg.type === 'chat') return chatPage.onEvent(msg);
  clearTimeout(refreshTimer); refreshTimer = setTimeout(refreshAll, 100);
};

currentHash = location.hash;
(async () => {
  [S.cfg, S.tickets] = await Promise.all([api('GET', 'config'), api('GET', 'tickets?bodies=1')]);
  route();
})();
