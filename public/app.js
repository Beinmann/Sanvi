import { renderMarkdown } from './md.js';
import { parseQuery, formatQuery, matchTicket, sortTickets, SORT_KEYS, moveItem, checkStatusName } from './filter.js';
import { initKeys } from './keys.js';
import { attachVim } from './vim.js';

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
  for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid);
  return n;
}

let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => t.classList.remove('show'), 3500);
}

async function api(method, path, body) {
  const res = await fetch(`/api/${path}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { status: res.status, data });
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

// The card being dragged; while held, the column headers show their number keys.
let held = null;
function endHold() { held = null; document.body.classList.remove('holding'); }

function card(t) {
  return el('a', {
    class: `card${changedOnDisk.has(t.file) ? ' changed' : ''}`, 'data-file': t.file, href: `#/t/${encodeURIComponent(t.file)}`, draggable: true,
    ondragstart: (e) => { e.dataTransfer.setData('text/plain', t.file); e.dataTransfer.effectAllowed = 'move'; e.currentTarget.classList.add('dragging'); held = t.file; document.body.classList.add('holding'); },
    ondragend: (e) => { e.currentTarget.classList.remove('dragging'); endHold(); },
  },
  el('div', {}, el('span', { class: 'id' }, `#${t.id}`), t.title),
  el('div', { class: 'meta' },
    t.area && el('span', { class: 'chip' }, t.area),
    t.priority && el('span', { class: 'chip prio' }, t.priority),
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
const COLUMN_DRAG = 'application/x-status-column';

async function moveTicket(file, status) {
  endHold();
  const t = S.tickets.find((x) => x.file === file);
  if (!t || t.status === status) return;
  try {
    const saved = await api('PUT', `tickets/${encodeURIComponent(file)}`, { version: t.version, fields: { status } });
    ownVersions.add(saved.version);
  } catch (e) {
    toast(e.status === 409 ? `#${t.id} changed on disk; not moved. Board refreshed.` : `Move failed: ${e.message}`);
  }
  await refreshAll();
}

// Board/table state lives in the hash: "#/?q=text -area:x&view=table&sort=priority&dir=desc".
const Q = { text: '', parsed: parseQuery(''), view: 'board', sort: 'id', dir: 'asc' };
function setQuery(text) { Q.text = text; Q.parsed = parseQuery(text); }
function loadHash() {
  const h = location.hash || '#/';
  if (!h.startsWith('#/?') && h !== '#/') return false;
  const p = new URLSearchParams(h.slice(3));
  setQuery(p.get('q') || '');
  Q.view = p.get('view') === 'table' ? 'table' : 'board';
  Q.sort = SORT_KEYS.includes(p.get('sort')) ? p.get('sort') : 'id';
  Q.dir = p.get('dir') === 'desc' ? 'desc' : 'asc';
  return true;
}
function hashForState() {
  const p = new URLSearchParams();
  if (Q.text) p.set('q', Q.text);
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
  });
  const tab = (v, label) => el('button', { type: 'button', class: Q.view === v ? 'active' : '', 'aria-pressed': String(Q.view === v), onclick: () => setView(v) }, label);
  return el('div', { class: 'filterbar' }, input,
    el('button', { type: 'button', title: 'Add a status column', onclick: () => document.dispatchEvent(new Event('add-status')) }, '+ Status'),
    el('span', { class: 'viewswitch' }, tab('board', 'Board'), tab('table', 'Table')),
    Q.text.trim() && el('span', { class: 'active-filter' }, 'Filter: ', el('code', {}, formatQuery(Q.parsed))),
    Q.text.trim() && el('button', { type: 'button', onclick: () => { setFilter(''); $('#search')?.focus(); } }, 'Clear'));
}

let pendingFocus = null; // file whose card gets focus on the next board render

function renderBoard() {
  const hadFocus = document.activeElement?.id === 'search';
  const caret = hadFocus ? document.activeElement.selectionStart : 0;
  const target = pendingFocus || document.activeElement?.closest?.('.card')?.dataset.file;
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
    view.replaceChildren(filterBar(), tableView());
    restore();
    if (hadFocus) { const i = $('#search'); i.focus({ preventScroll: true }); i.setSelectionRange(caret, caret); }
    return;
  }
  let num = 0;
  view.replaceChildren(filterBar(), hiddenStrip(), el('div', { class: 'board' }, columns().map((status) => {
    const n = status ? ++num : 0; // numbers follow the full order, hidden columns keep theirs
    if (hidden.has(status)) return null;
    const items = S.tickets.filter((t) => t.status === status && matchTicket(t, Q.parsed))
      .sort((a, b) => (PRIO[a.priority] ?? 2) - (PRIO[b.priority] ?? 2) || a.file.localeCompare(b.file, 'en', { numeric: true }));
    return el('section', {
      class: 'col', 'data-status': status,
      ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('over'); },
      ondragleave: (e) => e.currentTarget.classList.remove('over'),
      ondrop: (e) => {
        e.preventDefault(); e.currentTarget.classList.remove('over');
        const col = e.dataTransfer.getData(COLUMN_DRAG);
        if (col) moveColumn(col, status); else moveTicket(e.dataTransfer.getData('text/plain'), status);
      },
    }, el('h2', S.cfg.statuses.includes(status) ? {
      draggable: true, title: 'Drag to reorder columns',
      ondragstart: (e) => { e.dataTransfer.setData(COLUMN_DRAG, status); e.dataTransfer.effectAllowed = 'move'; },
    } : {}, n > 0 && n <= 9 && el('kbd', { class: 'num', title: `Press ${n} to move the held or focused ticket here` }, String(n)),
    el('span', {}, status || '(no status)'), el('span', { class: 'count' }, String(items.length)),
      el('button', { type: 'button', class: 'hide', title: `Hide ${status || 'this'} column`, 'aria-label': `Hide ${status || 'no-status'} column`, onclick: () => toggleColumn(status) }, '×')), items.map(card));
  })));
  restore();
  if (hadFocus) { const i = $('#search'); i.focus({ preventScroll: true }); i.setSelectionRange(caret, caret); }
  const focusEl = target && [...view.querySelectorAll('.card')].find((c) => c.dataset.file === target);
  if (focusEl) { focusEl.focus({ preventScroll: true }); focusEl.scrollIntoView({ block: 'nearest', inline: 'nearest' }); } // stays visible, no jump if it already is
}

const COLS = [['id', 'ID'], ['title', 'Title'], ['status', 'Status'], ['area', 'Area'], ['priority', 'Priority'], ['progress', 'Progress']];

// Read-only projection of the same tickets and filter as the board.
function tableView() {
  const rows = sortTickets(S.tickets.filter((t) => matchTicket(t, Q.parsed)), Q.sort, Q.dir, columns());
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

const copyDraft = (t) => ({ status: t.status, area: t.area, priority: t.priority, body: t.body });
const isDirty = () => !!D && !D.gone && ['status', 'area', 'priority', 'body'].some((k) => D.draft[k] !== D.loaded[k]);
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
  for (const k of ['status', 'area', 'priority']) if (sent[k] !== D.loaded[k]) fields[k] = sent[k];
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
function hiddenStrip() {
  const list = columns().filter((c) => hidden.has(c));
  if (!list.length) return null;
  const filtering = !!Q.text.trim();
  return el('div', { class: 'hiddenstrip' }, 'Hidden: ', list.map((status) => {
    const all = S.tickets.filter((t) => t.status === status);
    const hits = filtering ? all.filter((t) => matchTicket(t, Q.parsed)).length : 0;
    return el('button', { type: 'button', class: hits ? 'hit' : '', title: `Show ${status || '(no status)'}`, onclick: () => toggleColumn(status) },
      `${status || '(no status)'} (${all.length}${filtering ? `, ${hits} match filter` : ''})`);
  }));
}

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

function renderTab(focusEditor = false) {
  const box = $('#content');
  if (D.tab === 'edit') {
    const ta = el('textarea', {
      class: 'editor', spellcheck: false,
      oninput: (e) => { D.draft.body = e.target.value; updateState(); },
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
    const doc = el('div', { class: 'doc' });
    doc.innerHTML = renderMarkdown(D.draft.body);
    box.replaceChildren(doc);
  }
  for (const b of document.querySelectorAll('.tabs button')) b.classList.toggle('active', b.dataset.tab === D.tab);
}

function setTab(tab) { D.tab = tab; renderTab(tab === 'edit'); }

function renderDetail({ fresh = false, edit = false } = {}) {
  const ed = document.activeElement?.classList?.contains('editor') ? document.activeElement : null;
  const sel = ed && [ed.selectionStart, ed.selectionEnd];
  const d = D.draft;
  view.replaceChildren(el('div', { class: 'detail' },
    el('a', { href: '#/' }, '← Board'),
    el('h1', { id: 'title', tabindex: '-1' }),
    el('div', { class: 'bar' },
      field('Status', select(S.cfg.statuses, d.status, (v) => { d.status = v; updateState(); }, 'f-status')),
      field('Area', el('input', { value: d.area, oninput: (e) => { d.area = e.target.value; updateState(); } })),
      field('Priority', select(['', 'high', 'medium', 'low'], d.priority, (v) => { d.priority = v; updateState(); })),
      el('span', { class: 'spacer' }),
      el('span', { id: 'state', class: 'state' }),
      el('button', { id: 'save', class: 'primary', type: 'button', onclick: save }, 'Save')),
    el('div', { id: 'banner' }),
    el('div', { class: 'tabs' },
      el('button', { type: 'button', 'data-tab': 'view', onclick: () => setTab('view') }, 'Preview'),
      el('button', { type: 'button', 'data-tab': 'edit', onclick: () => setTab('edit') }, 'Edit')),
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
    view.replaceChildren(el('p', {}, `Could not open ${file}: ${e.message} `, el('a', { href: '#/' }, 'Back to board')));
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
  const f = { title: '', area: '', status: S.cfg.statuses[0] || 'open', priority: '' };
  view.replaceChildren(el('form', {
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
  field('Status', select(S.cfg.statuses, f.status, (v) => { f.status = v; })),
  field('Priority', select(['', 'high', 'medium', 'low'], '', (v) => { f.priority = v; })),
  el('div', {}, el('button', { class: 'primary', type: 'submit' }, 'Create'), ' ', el('a', { href: '#/' }, 'Cancel'))));
  view.querySelector('input').focus();
}

// ------------------------------------------------------------ quick idea

function renderIdea() {
  const ta = el('textarea', { rows: 6, required: true, placeholder: 'Describe the idea in a sentence or a few. No title needed.' });
  const submit = async () => {
    const text = ta.value.trim();
    if (!text) return;
    try {
      const t = await api('POST', 'ideas', { text });
      toast(`Idea captured as #${t.id}`);
      location.hash = '#/';
    } catch (err) { toast(err.message); }
  };
  ta.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') { e.preventDefault(); submit(); }
  });
  view.replaceChildren(el('form', { class: 'newform wide', onsubmit: (e) => { e.preventDefault(); submit(); } },
    el('h2', {}, 'Quick idea'),
    el('p', { class: 'hint' }, 'Saved as a ticket in the design column with an auto-derived title, for refinement later. Ctrl+Enter saves and returns to the board.'),
    ta,
    el('div', {}, el('button', { class: 'primary', type: 'submit' }, 'Save idea'), ' ', el('a', { href: '#/' }, 'Done'))));
  ta.focus();
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
    pendingFocus = S.lastFile ?? null;
    if (h === '#/new') renderNew();
    else if (h === '#/idea') renderIdea();
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
  S, el, columns, toast, moveTicket, setTab, heldFile: () => held, addStatus, toggleColumn, isHidden,
  saveIdea: async (text) => { const t = await api('POST', 'ideas', { text }); toast(`Idea captured as #${t.id}`); return t; },
  detail: () => D,
  setDraftStatus: (v) => { D.draft.status = v; const s = $('#f-status'); if (s) s.value = v; updateState(); toast(`Status set to ${v} (unsaved)`); },
});
$('#new-btn').addEventListener('click', () => { location.hash = '#/new'; });
$('#idea-btn').addEventListener('click', () => { location.hash = '#/idea'; });

async function refreshAll() {
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
  const h = location.hash || '#/';
  if (h.startsWith('#/t/')) await refreshDetail();
  else if (h === '#/' || h === '' || h.startsWith('#/?')) renderBoard();
}

// live updates
let refreshTimer;
const es = new EventSource('/api/events');
es.onopen = () => $('#live').classList.add('on');
es.onerror = () => $('#live').classList.remove('on');
es.onmessage = () => { clearTimeout(refreshTimer); refreshTimer = setTimeout(refreshAll, 100); };

currentHash = location.hash;
(async () => {
  [S.cfg, S.tickets] = await Promise.all([api('GET', 'config'), api('GET', 'tickets?bodies=1')]);
  route();
})();
