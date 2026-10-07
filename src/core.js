// Ticket files are the single source of truth. Everything here works on
// `<dir>/<id>-<slug>.md` files with a flat YAML frontmatter block, and is
// tolerant of hand-edited files: unknown frontmatter lines, comments and the
// body are preserved byte for byte unless they are explicitly changed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const DEFAULT_STATUSES = ['open', 'in-progress', 'testing', 'blocked', 'deferred', 'done'];
const FILE_RE = /^(\d+)-(.+)\.md$/;
const KEY_RE = /^[A-Za-z_][\w-]*$/;

export class ConflictError extends Error {
  constructor(current) {
    super('ticket changed on disk since it was loaded');
    this.name = 'ConflictError';
    this.current = current;
  }
}
export class NotFoundError extends Error {
  constructor(msg) { super(msg); this.name = 'NotFoundError'; }
}
export class ValidationError extends Error {
  constructor(msg) { super(msg); this.name = 'ValidationError'; }
}

export const hash = (raw) => crypto.createHash('sha1').update(raw).digest('hex').slice(0, 16);

// --- document parsing -------------------------------------------------

export function splitDoc(raw) {
  const m = /^---\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(raw);
  if (!m) return { front: null, body: raw };
  return { front: m[1], body: raw.slice(m[0].length) };
}

function unquote(v) {
  const q = /^(["'])(.*)\1$/.exec(v);
  return q ? q[2] : v;
}

function parseValue(rest) {
  const v = rest.trim();
  if (/^["']/.test(v)) {
    const q = /^(["'])((?:\\.|(?!\1).)*)\1/.exec(v);
    if (q) return q[2];
  }
  return unquote(v.replace(/\s+#.*$/, '').trim());
}

export function parseFront(front) {
  const out = {};
  if (!front) return out;
  for (const line of front.split(/\r?\n/)) {
    const m = /^([A-Za-z_][\w-]*):(.*)$/.exec(line);
    if (m) out[m[1]] = parseValue(m[2]);
  }
  return out;
}

function formatValue(v) {
  if (/^[\w./@-][^:#]*$/.test(v) && !/\s#/.test(v) && !/^(true|false|null|yes|no|~)$/i.test(v) && v === v.trim()) return v;
  return JSON.stringify(v);
}

// Replace/insert/remove one key, leaving every other line untouched.
function setFrontField(front, key, value) {
  const lines = front === null || front === '' ? [] : front.split('\n');
  const idx = lines.findIndex((l) => new RegExp(`^${key}:`).test(l));
  const empty = value === null || value === undefined || value === '';
  if (idx >= 0) {
    if (parseValue(lines[idx].slice(key.length + 1)) === (empty ? '' : value)) return lines.join('\n');
    if (empty) lines.splice(idx, 1);
    else lines[idx] = `${key}: ${formatValue(value)}`;
  } else if (!empty) {
    lines.push(`${key}: ${formatValue(value)}`);
  }
  return lines.join('\n');
}

function buildRaw(front, body) {
  return `---\n${front}\n---\n${body}`;
}

function titleOf(body) {
  let fence = false;
  for (const line of body.split(/\r?\n/)) {
    if (/^```/.test(line)) fence = !fence;
    const m = !fence && /^#\s+(.+?)\s*#*\s*$/.exec(line);
    if (m) return m[1];
  }
  return '';
}

function progressOf(body) {
  const all = body.match(/^\s*[-*]\s+\[[ xX]\]/gm) || [];
  const done = body.match(/^\s*[-*]\s+\[[xX]\]/gm) || [];
  return { done: done.length, total: all.length };
}

export function toTicket(file, raw, mtimeMs = 0) {
  const m = FILE_RE.exec(file);
  const { front, body } = splitDoc(raw);
  const fields = parseFront(front);
  return {
    file,
    id: m ? m[1] : '',
    slug: m ? m[2] : file.replace(/\.md$/, ''),
    title: titleOf(body) || (m ? m[2] : file),
    hasTitle: !!titleOf(body),
    hasFrontmatter: front !== null,
    status: fields.status || '',
    area: fields.area || '',
    priority: fields.priority || '',
    fields,
    body,
    progress: progressOf(body),
    version: hash(raw),
    mtime: mtimeMs,
  };
}

// --- directory level --------------------------------------------------

export function isTicketFile(name) {
  return FILE_RE.test(name);
}

function resolveFile(dir, file) {
  if (typeof file !== 'string' || file !== path.basename(file) || !isTicketFile(file)) {
    throw new NotFoundError(`not a ticket file: ${file}`);
  }
  const p = path.join(dir, file);
  if (!fs.existsSync(p)) throw new NotFoundError(`no such ticket: ${file}`);
  return p;
}

export function readTicket(dir, file) {
  const p = resolveFile(dir, file);
  const raw = fs.readFileSync(p, 'utf8');
  return toTicket(file, raw, fs.statSync(p).mtimeMs);
}

export function listTickets(dir) {
  const out = [];
  for (const name of fs.readdirSync(dir)) {
    if (!isTicketFile(name)) continue;
    try { out.push(readTicket(dir, name)); } catch { /* vanished mid-read */ }
  }
  return out.sort((a, b) => a.file.localeCompare(b.file, 'en', { numeric: true }));
}

export function findTicket(dir, ref) {
  const all = listTickets(dir);
  const r = String(ref).replace(/\.md$/, '');
  const num = /^\d+$/.test(r) ? Number(r) : null;
  const hit = all.find((t) => t.file === `${r}.md`)
    || (num !== null && all.find((t) => Number(t.id) === num))
    || all.find((t) => t.slug === r);
  if (!hit) throw new NotFoundError(`no ticket matching "${ref}"`);
  return hit;
}

// Minimal reader for `_config.yml`: only `statuses`, as a flow or block list.
export function readConfig(dir) {
  const cfg = { statuses: [...DEFAULT_STATUSES], configured: false };
  let text;
  try { text = fs.readFileSync(path.join(dir, '_config.yml'), 'utf8'); } catch { return cfg; }
  const flow = /^statuses:\s*\[(.*)\]\s*$/m.exec(text);
  let list = null;
  if (flow) list = flow[1].split(',').map((s) => unquote(s.trim())).filter(Boolean);
  else {
    const block = /^statuses:\s*\r?\n((?:[ \t]*-[ \t]+.+\r?\n?)+)/m.exec(text);
    if (block) list = block[1].split(/\r?\n/).map((l) => unquote(l.replace(/^\s*-\s+/, '').replace(/\s+#.*$/, '').trim())).filter(Boolean);
  }
  if (list && list.length) { cfg.statuses = list; cfg.configured = true; }
  return cfg;
}

// --- writing ----------------------------------------------------------

/** Persist the status order in `_config.yml`, replacing an existing `statuses` entry (flow or block) in place and keeping other lines. */
export function writeStatuses(dir, statuses) {
  if (!Array.isArray(statuses) || !statuses.length || statuses.some((s) => typeof s !== 'string' || !s.trim() || /[\r\n,\[\]"']/.test(s))
    || new Set(statuses).size !== statuses.length) throw new ValidationError('statuses must be a list of distinct, non-empty names without commas, brackets or quotes');
  const file = path.join(dir, '_config.yml');
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { /* new file */ }
  const line = `statuses: [${statuses.join(', ')}]\n`;
  const re = /^statuses:[ \t]*(?:\[.*\][ \t]*\r?\n?|\r?\n(?:[ \t]*-[ \t]+.+\r?\n?)+)/m;
  if (re.test(text)) text = text.replace(re, () => line);
  else text = `${line}${text}`;
  atomicWrite(file, text);
}

function atomicWrite(p, content) {
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, p);
}

function checkFields(fields) {
  for (const [k, v] of Object.entries(fields)) {
    if (!KEY_RE.test(k)) throw new ValidationError(`invalid field name: ${k}`);
    if (v !== null && typeof v !== 'string') throw new ValidationError(`field ${k} must be a string`);
    if (typeof v === 'string' && /[\r\n]/.test(v)) throw new ValidationError(`field ${k} must be a single line`);
  }
}

// Optimistic concurrency: `version` is the hash of the file as the caller saw
// it. If the file differs now, nothing is written.
export function saveTicket(dir, file, { fields = {}, body } = {}, version) {
  const p = resolveFile(dir, file);
  checkFields(fields);
  if (body !== undefined && typeof body !== 'string') throw new ValidationError('body must be a string');
  const raw = fs.readFileSync(p, 'utf8');
  if (version !== hash(raw)) throw new ConflictError(toTicket(file, raw, fs.statSync(p).mtimeMs));
  const doc = splitDoc(raw);
  let front = doc.front;
  for (const [k, v] of Object.entries(fields)) front = setFrontField(front, k, v);
  const next = buildRaw(front ?? '', body === undefined ? doc.body : body);
  if (next === raw || (front === doc.front && (body === undefined || body === doc.body))) {
    return toTicket(file, raw, fs.statSync(p).mtimeMs);
  }
  atomicWrite(p, next);
  return readTicket(dir, file);
}

export function slugify(title) {
  const s = title.toLowerCase().normalize('NFKD').replace(/[^\x00-\x7f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return s || 'ticket';
}

const pad = (n) => String(n).padStart(3, '0');

export function createTicket(dir, { title, area = '', status, priority = '', body: customBody } = {}) {
  title = (title || '').trim();
  if (!title) throw new ValidationError('title is required');
  checkFields({ area, priority, ...(status ? { status } : {}), title });
  status = status || readConfig(dir).statuses[0] || 'open';
  const slug = slugify(title);
  let front = '';
  front = setFrontField(front, 'status', status);
  front = setFrontField(front, 'area', area || null);
  front = setFrontField(front, 'priority', priority || null);
  const body = customBody ?? `\n# ${title}\n\n## Problem / motivation\n\n\n\n## Acceptance criteria\n\n- [ ] \n`;
  for (let attempt = 0; attempt < 5; attempt++) {
    const max = listTickets(dir).reduce((m, t) => Math.max(m, Number(t.id)), 0);
    const file = `${pad(max + 1 + attempt)}-${slug}.md`;
    try {
      fs.writeFileSync(path.join(dir, file), buildRaw(front, body), { flag: 'wx' });
      return readTicket(dir, file);
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
  }
  throw new Error('could not allocate a ticket id');
}

// Quick capture: one or a few sentences, no title. The title is a placeholder
// derived from the first line; the text goes in verbatim for a later
// refinement pass (human or AI) that rewrites the ticket properly.
export const IDEA_STATUS = 'design';

export function ideaTitle(text) {
  const first = text.trim().split(/\r?\n/)[0].replace(/\s+/g, ' ');
  const sentence = /^.*?[.!?](?=\s|$)/.exec(first)?.[0] ?? first;
  if (sentence.length <= 60) return sentence.replace(/[.!?]+$/, '');
  return `${sentence.slice(0, 60).replace(/\s+\S*$/, '')}…`;
}

export function createIdea(dir, { text, status = IDEA_STATUS } = {}) {
  if (text != null && typeof text !== 'string') throw new ValidationError('idea text must be a string');
  text = (text || '').trim();
  if (!text) throw new ValidationError('idea text is required');
  const title = ideaTitle(text);
  const date = new Date().toISOString().slice(0, 10);
  const body = `\n# ${title}\n\n## Problem / motivation\n\n${text}\n\n## Acceptance criteria\n\n- [ ] \n\n## Notes\n\n- ${date}: Captured as a quick idea; the title is auto-derived and the text above is unrefined. Needs refinement.\n`;
  return createTicket(dir, { title, status, body });
}

// --- validation -------------------------------------------------------

export function validate(dir) {
  const problems = [];
  const add = (file, level, message) => problems.push({ file, level, message });
  const cfg = readConfig(dir);
  const tickets = listTickets(dir);
  const seen = new Map();
  for (const t of tickets) {
    const n = Number(t.id);
    if (seen.has(n)) add(t.file, 'error', `duplicate id ${t.id} (also ${seen.get(n)})`);
    else seen.set(n, t.file);
    if (t.id.length < 3) add(t.file, 'warn', 'id is not zero-padded to 3 digits');
    if (!t.hasFrontmatter) add(t.file, 'error', 'missing frontmatter');
    else if (!t.status) add(t.file, 'error', 'missing status');
    else if (!cfg.statuses.includes(t.status)) add(t.file, 'warn', `status "${t.status}" is not in ${cfg.statuses.join(' | ')}`);
    if (!t.hasTitle) add(t.file, 'warn', 'no "# title" heading');
    if (!/^##\s+Problem/im.test(t.body)) add(t.file, 'warn', 'no "Problem / motivation" section');
    if (!/^##\s+Acceptance criteria/im.test(t.body)) add(t.file, 'warn', 'no "Acceptance criteria" section');
  }
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.md') && !isTicketFile(name) && !/^(_|README)/.test(name)) {
      add(name, 'warn', 'markdown file does not look like <id>-<slug>.md; ignored');
    }
  }
  return problems;
}
