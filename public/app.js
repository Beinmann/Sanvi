import { renderMarkdown } from './md.js';
import { parseQuery, formatQuery, matchTicket } from './filter.js';
import { initKeys } from './keys.js';

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

function card(t) {
  return el('a', {
    class: 'card', 'data-file': t.file, href: `#/t/${encodeURIComponent(t.file)}`, draggable: true,
    ondragstart: (e) => { e.dataTransfer.setData('text/plain', t.file); e.dataTransfer.effectAllowed = 'move'; e.currentTarget.classList.add('dragging'); },
    ondragend: (e) => e.currentTarget.classList.remove('dragging'),
  },
  el('div', {}, el('span', { class: 'id' }, `#${t.id}`), t.title),
  el('div', { class: 'meta' },
    t.area && el('span', { class: 'chip' }, t.area),
    t.priority && el('span', { class: 'chip prio' }, t.priority),
    t.progress.total > 0 && el('span', {}, `${t.progress.done}/${t.progress.total}`)));
}

async function moveTicket(file, status) {
  const t = S.tickets.find((x) => x.file === file);
  if (!t || t.status === status) return;
  try {
    await api('PUT', `tickets/${encodeURIComponent(file)}`, { version: t.version, fields: { status } });
  } catch (e) {
    toast(e.status === 409 ? `#${t.id} changed on disk; not moved. Board refreshed.` : `Move failed: ${e.message}`);
  }
  await refreshAll();
}

// Filter query lives in the hash: "#/?q=text -area:x". Board-only state.
const Q = { text: '', parsed: parseQuery('') };
function setQuery(text) { Q.text = text; Q.parsed = parseQuery(text); }
function queryFromHash() {
  const h = location.hash || '#/';
  if (!h.startsWith('#/?') && h !== '#/') return null;
  return new URLSearchParams(h.slice(3)).get('q') || '';
}
function hashForQuery(text) { return text ? `#/?q=${encodeURIComponent(text)}` : '#/'; }
function setFilter(text) {
  setQuery(text);
  const h = hashForQuery(text);
  if (location.hash !== h) { currentHash = h; history.replaceState(null, '', h); }
  renderBoard();
}

function filterBar() {
  const input = el('input', {
    id: 'search', type: 'search', value: Q.text, placeholder: 'Search… e.g. migrate -area:research status:open,blocked',
    oninput: (e) => setFilter(e.target.value),
  });
  return el('div', { class: 'filterbar' }, input,
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
  view.replaceChildren(filterBar(), el('div', { class: 'board' }, columns().map((status) => {
    const items = S.tickets.filter((t) => t.status === status && matchTicket(t, Q.parsed))
      .sort((a, b) => (PRIO[a.priority] ?? 2) - (PRIO[b.priority] ?? 2) || a.file.localeCompare(b.file, 'en', { numeric: true }));
    return el('section', {
      class: 'col', 'data-status': status,
      ondragover: (e) => { e.preventDefault(); e.currentTarget.classList.add('over'); },
      ondragleave: (e) => e.currentTarget.classList.remove('over'),
      ondrop: (e) => { e.preventDefault(); e.currentTarget.classList.remove('over'); moveTicket(e.dataTransfer.getData('text/plain'), status); },
    }, el('h2', {}, el('span', {}, status || '(no status)'), el('span', {}, String(items.length))), items.map(card));
  })));
  if (hadFocus) { const i = $('#search'); i.focus(); i.setSelectionRange(caret, caret); }
  if (target) [...view.querySelectorAll('.card')].find((c) => c.dataset.file === target)?.focus();
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
  if (!D || !isDirty()) return;
  const sent = { ...D.draft };
  const fields = {};
  for (const k of ['status', 'area', 'priority']) if (sent[k] !== D.loaded[k]) fields[k] = sent[k];
  try {
    const t = await api('PUT', `tickets/${encodeURIComponent(D.file)}`, {
      version: D.loaded.version, fields, ...(sent.body !== D.loaded.body ? { body: sent.body } : {}),
    });
    D.loaded = t;
    D.stale = null; D.conflict = false;
    for (const k of Object.keys(sent)) if (D.draft[k] === sent[k]) D.draft[k] = t[k];
    updateBanner(); updateState();
    toast('Saved');
  } catch (e) {
    if (e.status === 409) { D.stale = e.data.current; D.conflict = true; updateBanner(); $('#banner button')?.focus(); }
    else toast(`Save failed: ${e.message}`);
  }
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
    box.replaceChildren(el('textarea', {
      class: 'editor', spellcheck: false,
      oninput: (e) => { D.draft.body = e.target.value; updateState(); },
    }));
    box.firstChild.value = D.draft.body;
    if (focusEditor) box.firstChild.focus();
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
    else { setQuery(queryFromHash() ?? ''); await refreshAll(); }
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
  S, el, columns, toast, moveTicket, setTab,
  detail: () => D,
  setDraftStatus: (v) => { D.draft.status = v; const s = $('#f-status'); if (s) s.value = v; updateState(); toast(`Status set to ${v} (unsaved)`); },
});
$('#new-btn').addEventListener('click', () => { location.hash = '#/new'; });

async function refreshAll() {
  try {
    [S.cfg, S.tickets] = await Promise.all([api('GET', 'config'), api('GET', 'tickets?bodies=1')]);
  } catch (e) { toast(`Load failed: ${e.message}`); return; }
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
