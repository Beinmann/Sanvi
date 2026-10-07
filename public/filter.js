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
