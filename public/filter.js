// Pure ticket filter, shared by the board and (later) the table view.
// Syntax: free-text words plus `key:v1,v2` / `-key:v1,v2` for key in FIELDS.
// Unknown keys and malformed tokens are treated as text, never as errors.
// Filters on different keys, and every text word, combine with AND; values
// within one filter are OR (include) or NOR (exclude). Matching is
// case-insensitive; `area:` and `priority:` accept the empty value (`area:`)
// to mean "not set".

export const FIELDS = ['status', 'area', 'priority'];

export function parseQuery(query) {
  const words = [];
  const filters = [];
  for (const tok of String(query ?? '').split(/\s+/).filter(Boolean)) {
    const m = /^(-?)([a-z]+):(.*)$/i.exec(tok);
    const key = m?.[2].toLowerCase();
    if (m && FIELDS.includes(key)) {
      filters.push({ key, exclude: m[1] === '-', values: m[3].split(',').map((v) => v.toLowerCase()) });
    } else words.push(tok.toLowerCase());
  }
  return { words, filters };
}

export function formatQuery({ words, filters }) {
  return [...words, ...filters.map((f) => `${f.exclude ? '-' : ''}${f.key}:${f.values.join(',')}`)].join(' ');
}

export function matchTicket(ticket, parsed) {
  const q = typeof parsed === 'string' ? parseQuery(parsed) : parsed;
  for (const f of q.filters) {
    const hit = f.values.includes(String(ticket[f.key] ?? '').toLowerCase());
    if (hit === f.exclude) return false;
  }
  if (q.words.length) {
    const hay = `${ticket.title ?? ''}\n${ticket.body ?? ''}`.toLowerCase();
    if (!q.words.every((w) => hay.includes(w))) return false;
  }
  return true;
}

export const SORT_KEYS = ['id', 'title', 'status', 'area', 'priority', 'progress'];
const PRIO_RANK = { high: 0, medium: 1, '': 2, low: 3 };

/**
 * Sort a copy of `tickets` by one of SORT_KEYS. `statusOrder` is the column
 * order (status sorts by it). Empty values and ties fall back to the id.
 * Unknown keys keep the id order.
 */
export function sortTickets(tickets, key, dir = 'asc', statusOrder = []) {
  const byId = (a, b) => String(a.file).localeCompare(String(b.file), 'en', { numeric: true });
  const val = {
    id: (t) => Number(t.id) || 0,
    title: (t) => String(t.title ?? '').toLowerCase(),
    status: (t) => { const i = statusOrder.indexOf(t.status); return i < 0 ? statusOrder.length : i; },
    area: (t) => String(t.area ?? '').toLowerCase(),
    priority: (t) => PRIO_RANK[t.priority ?? ''] ?? 2,
    progress: (t) => (t.progress?.total ? t.progress.done / t.progress.total : -1),
  }[key];
  if (!val) return [...tickets].sort(byId);
  const sign = dir === 'desc' ? -1 : 1;
  return [...tickets].sort((a, b) => {
    const x = val(a), y = val(b);
    return (x < y ? -1 : x > y ? 1 : 0) * sign || byId(a, b);
  });
}

/** Copy of `list` with the item at `from` placed where the item at `to` is now (before it when moving left, after it when moving right). */
export function moveItem(list, from, to) {
  if (from === to || from < 0 || to < 0 || from >= list.length || to >= list.length) return [...list];
  const out = [...list];
  out.splice(to, 0, out.splice(from, 1)[0]);
  return out;
}

/** Normalise user input for a new status (trim, lowercase, spaces to hyphens) and validate it. Returns { name, error }. */
export function checkStatusName(input, existing = []) {
  const name = String(input ?? '').trim().toLowerCase().replace(/\s+/g, '-');
  if (!name) return { name, error: 'Enter a name' };
  if (!/^[a-z0-9][a-z0-9-]*$/.test(name)) return { name, error: 'Use letters, digits and hyphens only' };
  if (existing.includes(name)) return { name, error: `"${name}" already exists` };
  return { name, error: null };
}
