// Ticket files are the single source of truth. Everything here works on
// `<dir>/<id>-<slug>.md` files with a flat YAML frontmatter block, and is
// tolerant of hand-edited files: unknown frontmatter lines, comments and the
// body are preserved byte for byte unless they are explicitly changed.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { noteStamp, formatNote, insertNote } from '../public/notes.js';

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

export { noteStamp };

// Append `- YYYY-MM-DD HH:MM: text` at the end of the `## Notes` section (created if missing).
// Only that spot changes; goes through saveTicket for the version check.
export function addNote(dir, file, text, version, now = new Date()) {
  if (typeof text !== 'string' || !text.trim()) throw new ValidationError('note text is required');
  const t = readTicket(dir, file);
  return saveTicket(dir, file, { body: insertNote(t.body, formatNote(text, now)) }, version);
}

export function slugify(title) {
  const s = title.toLowerCase().normalize('NFKD').replace(/[^\x00-\x7f]/g, '')
    .replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60).replace(/-+$/, '');
  return s || 'ticket';
}

const pad = (n) => String(n).padStart(3, '0');

// Highest id in use, trashed tickets included, so a deleted ticket's id is not handed out again.
function maxId(dir) {
  return Math.max(0, ...listTickets(dir).map((t) => Number(t.id)), ...listTrash(dir).map((t) => Number(t.id)));
}

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
    const file = `${pad(maxId(dir) + 1 + attempt)}-${slug}.md`;
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

export function createIdea(dir, { text, status = IDEA_STATUS, area = '' } = {}) {
  if (text != null && typeof text !== 'string') throw new ValidationError('idea text must be a string');
  text = (text || '').trim();
  if (!text) throw new ValidationError('idea text is required');
  const title = ideaTitle(text);
  const date = new Date().toISOString().slice(0, 10);
  const body = `\n# ${title}\n\n## Problem / motivation\n\n${text}\n\n## Acceptance criteria\n\n- [ ] \n\n## Notes\n\n- ${date}: Captured as a quick idea; the title is auto-derived and the text above is unrefined. Needs refinement.\n`;
  return createTicket(dir, { title, status, area, body });
}

// --- scratch notes -------------------------------------------------------
// `<dir>/NOTES.md`: notes that belong to no ticket. Top-level `- ` items (continuation lines indented), newest
// last in the file. Anything else in the file (headings, prose) is left alone, so hand edits are fine.
export const SCRATCH_FILE = 'NOTES.md';
const PROMOTED_RE = /\s*→\s*#(\d+)\s*$/;

export function parseScratch(raw) {
  const lines = raw.split(/\r?\n/);
  const notes = [];
  for (let i = 0; i < lines.length; i++) {
    if (!/^[-*] /.test(lines[i])) continue;
    let end = i + 1;
    for (let j = i + 1; j < lines.length; j++) {
      if (/^\s+\S/.test(lines[j])) end = j + 1;
      else if (lines[j].trim() === '') continue; // blank: part of the item only if indented text follows
      else break;
    }
    const first = lines[i].slice(2);
    const promoted = PROMOTED_RE.exec(first);
    const m = /^(\d{4}-\d{2}-\d{2})(?: (\d{2}:\d{2}))?:\s*/.exec(first);
    const head = (promoted ? first.slice(0, promoted.index) : first).slice(m ? m[0].length : 0);
    const text = [head, ...lines.slice(i + 1, end).map((l) => l.replace(/^ {1,2}/, ''))].join('\n').trim();
    notes.push({ index: notes.length, stamp: m ? `${m[1]}${m[2] ? ` ${m[2]}` : ''}` : '', text, promoted: promoted ? promoted[1] : '', start: i, end });
    i = end - 1;
  }
  return notes;
}

function readScratchRaw(dir) {
  try { return fs.readFileSync(path.join(dir, SCRATCH_FILE), 'utf8'); } catch (e) { if (e.code === 'ENOENT') return ''; throw e; }
}

const publicNote = ({ start, end, ...n }) => n;

export function listScratch(dir) {
  const raw = readScratchRaw(dir);
  return { version: hash(raw), notes: parseScratch(raw).map(publicNote) };
}

// `version` (the hash from listScratch) is checked when given; appends without one just go to the end.
function writeScratch(dir, version, edit) {
  const raw = readScratchRaw(dir);
  if (version && version !== hash(raw)) throw new ConflictError(listScratch(dir));
  const next = edit(raw);
  if (next !== raw) atomicWrite(path.join(dir, SCRATCH_FILE), next);
  return listScratch(dir);
}

export function addScratch(dir, text, version, now = new Date()) {
  if (typeof text !== 'string' || !text.trim()) throw new ValidationError('note text is required');
  const item = formatNote(text, now);
  return writeScratch(dir, version, (raw) => {
    const eol = raw.includes('\r\n') ? '\r\n' : '\n';
    const body = raw.replace(/\s+$/, '');
    const last = body.split(/\r?\n/).pop();
    const sep = !body ? '' : /^([-*] |\s)/.test(last) ? eol : eol + eol;
    return `${body || '# Notes' + eol}${body ? '' : eol}${sep}${item.replace(/\n/g, eol)}${eol}`;
  });
}

function noteAt(raw, index) {
  const n = parseScratch(raw)[index];
  if (!n) throw new NotFoundError(`no such note: ${index}`);
  return n;
}

export function deleteScratch(dir, index, version) {
  return writeScratch(dir, version || 'required', (raw) => {
    const n = noteAt(raw, index);
    const lines = raw.split(/(?<=\n)/);
    lines.splice(n.start, n.end - n.start);
    return lines.join('');
  });
}

// Turns a note into an idea ticket and marks the note `→ #NNN`. Returns { notes, ticket }.
export function promoteScratch(dir, index, version, { area = '' } = {}) {
  let ticket = null;
  const list = writeScratch(dir, version || 'required', (raw) => {
    const n = noteAt(raw, index);
    if (n.promoted) throw new ValidationError(`note already promoted to #${n.promoted}`);
    ticket = createIdea(dir, { text: n.text, area });
    const lines = raw.split(/(?<=\n)/);
    lines[n.start] = lines[n.start].replace(/(\r?\n)?$/, ` → #${ticket.id}$1`);
    return lines.join('');
  });
  return { ...list, ticket };
}

// --- trash --------------------------------------------------------------
// Deleting moves the ticket (and its images) to `<dir>/.trash/<deletion ms>/`; nothing is destroyed until
// the retention period passes or the user deletes it for good. `listTickets` only reads `<dir>` itself.

export const TRASH_DIR = '.trash';
export const TRASH_DAYS = 30; // retention; change here
const DAY_MS = 86_400_000;
const trashRoot = (dir) => path.join(dir, TRASH_DIR);
const assetsOf = (dir, id) => {
  const adir = path.join(dir, ASSET_DIR);
  if (!fs.existsSync(adir)) return [];
  return fs.readdirSync(adir).filter((n) => n.startsWith(`${id}-`) && /^\d+\.\w+$/.test(n.slice(id.length + 1)));
};

export function deleteTicket(dir, file, version, now = Date.now()) {
  const p = resolveFile(dir, file);
  const raw = fs.readFileSync(p, 'utf8');
  if (version !== hash(raw)) throw new ConflictError(toTicket(file, raw, fs.statSync(p).mtimeMs));
  const t = toTicket(file, raw);
  let key = String(now);
  while (fs.existsSync(path.join(trashRoot(dir), key))) key = String(Number(key) + 1);
  const dest = path.join(trashRoot(dir), key);
  fs.mkdirSync(path.join(dest, ASSET_DIR), { recursive: true });
  for (const name of assetsOf(dir, t.id)) fs.renameSync(path.join(dir, ASSET_DIR, name), path.join(dest, ASSET_DIR, name));
  fs.renameSync(p, path.join(dest, file));
  return { key, file, id: t.id, title: t.title };
}

export function listTrash(dir, now = Date.now()) {
  const root = trashRoot(dir);
  if (!fs.existsSync(root)) return [];
  const out = [];
  for (const key of fs.readdirSync(root)) {
    if (!/^\d+$/.test(key)) continue;
    const file = fs.readdirSync(path.join(root, key)).find(isTicketFile);
    if (!file) continue;
    const t = toTicket(file, fs.readFileSync(path.join(root, key, file), 'utf8'));
    const deletedAt = Number(key);
    out.push({ key, file, id: t.id, title: t.title, status: t.status, deletedAt, daysLeft: Math.max(0, Math.ceil((deletedAt + TRASH_DAYS * DAY_MS - now) / DAY_MS)) });
  }
  return out.sort((a, b) => b.deletedAt - a.deletedAt);
}

// Restore under the same file name; if that id is taken again, use the next free id (and say so in Notes).
export function restoreTicket(dir, key) {
  const item = listTrash(dir).find((x) => x.key === String(key));
  if (!item) throw new NotFoundError(`not in the trash: ${key}`);
  const src = path.join(trashRoot(dir), item.key);
  let file = item.file;
  let id = item.id;
  const taken = listTickets(dir).some((t) => Number(t.id) === Number(item.id)) || fs.existsSync(path.join(dir, file));
  let raw = fs.readFileSync(path.join(src, item.file), 'utf8');
  if (taken) {
    id = pad(maxId(dir) + 1);
    file = item.file.replace(/^\d+/, id);
    raw = raw.split(`${ASSET_DIR}/${item.id}-`).join(`${ASSET_DIR}/${id}-`);
  }
  fs.mkdirSync(path.join(dir, ASSET_DIR), { recursive: true });
  const adir = path.join(src, ASSET_DIR);
  for (const name of fs.existsSync(adir) ? fs.readdirSync(adir) : []) {
    const target = path.join(dir, ASSET_DIR, taken ? name.replace(/^\d+/, id) : name);
    if (!fs.existsSync(target)) fs.renameSync(path.join(adir, name), target); // never overwrite an existing image
  }
  fs.writeFileSync(path.join(dir, file), raw, { flag: 'wx' });
  fs.rmSync(src, { recursive: true, force: true });
  let t = readTicket(dir, file);
  if (taken) t = addNote(dir, file, `Restored from the trash; the old id #${item.id} was in use again, so this is now #${id}.`, t.version);
  return t;
}

export function purgeTrashItem(dir, key) {
  if (!/^\d+$/.test(String(key)) || !fs.existsSync(path.join(trashRoot(dir), String(key)))) throw new NotFoundError(`not in the trash: ${key}`);
  fs.rmSync(path.join(trashRoot(dir), String(key)), { recursive: true, force: true });
}

// Remove everything deleted more than `days` ago; returns how many items went.
export function purgeTrash(dir, days = TRASH_DAYS, now = Date.now()) {
  const old = listTrash(dir, now).filter((x) => now - x.deletedAt > days * DAY_MS);
  for (const x of old) purgeTrashItem(dir, x.key);
  return old.length;
}

// --- images attached to tickets ----------------------------------------

export const ASSET_DIR = 'assets';
export const MAX_ASSET_BYTES = 5 * 1024 * 1024;
export const ASSET_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/gif': 'gif', 'image/webp': 'webp' };
export const ASSET_MIME = { png: 'image/png', jpg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp' };

// The bytes must really be the image type claimed (no HTML or script smuggled in under image/png).
function sniffImage(buf) {
  if (buf.length > 8 && buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'png';
  if (buf.length > 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length > 6 && /^GIF8[79]a$/.test(buf.subarray(0, 6).toString('latin1'))) return 'gif';
  if (buf.length > 12 && buf.subarray(0, 4).toString('latin1') === 'RIFF' && buf.subarray(8, 12).toString('latin1') === 'WEBP') return 'webp';
  return null;
}

// Store an image next to the tickets as assets/<ticket id>-<n>.<ext> and return its relative path.
export function saveAsset(dir, file, buf, mime) {
  const t = readTicket(dir, file);
  const ext = ASSET_TYPES[String(mime).split(';')[0].trim().toLowerCase()];
  if (!ext) throw new ValidationError('only PNG, JPEG, GIF and WebP images are accepted');
  if (!buf.length) throw new ValidationError('empty image');
  if (buf.length > MAX_ASSET_BYTES) throw new ValidationError(`image too large (max ${MAX_ASSET_BYTES / 1024 / 1024} MB)`);
  if (sniffImage(buf) !== ext) throw new ValidationError(`content is not a valid ${ext.toUpperCase()} image`);
  const adir = path.join(dir, ASSET_DIR);
  fs.mkdirSync(adir, { recursive: true });
  const prefix = `${t.id}-`;
  let n = 0;
  for (const name of fs.readdirSync(adir)) {
    const m = name.startsWith(prefix) && /^(\d+)\.\w+$/.exec(name.slice(prefix.length));
    if (m) n = Math.max(n, Number(m[1]));
  }
  for (;;) { // wx: never overwrite, retry if another writer took the number
    const name = `${prefix}${++n}.${ext}`;
    try { fs.writeFileSync(path.join(adir, name), buf, { flag: 'wx' }); return `${ASSET_DIR}/${name}`; } catch (e) { if (e.code !== 'EEXIST') throw e; }
  }
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
    for (const m of t.body.matchAll(/!\[[^\]]*\]\(([^)\s]+)\)/g)) {
      const u = m[1];
      if (/^([a-z][a-z0-9+.-]*:|\/\/|\/|#)/i.test(u)) continue;
      const target = path.resolve(dir, decodeURIComponent(u.split(/[?#]/)[0]));
      if (!target.startsWith(dir + path.sep) || !fs.existsSync(target)) add(t.file, 'warn', `image not found: ${u}`);
    }
  }
  for (const name of fs.readdirSync(dir)) {
    if (name.endsWith('.md') && !isTicketFile(name) && !/^(_|README|NOTES\.md$)/.test(name)) {
      add(name, 'warn', 'markdown file does not look like <id>-<slug>.md; ignored');
    }
  }
  return problems;
}
