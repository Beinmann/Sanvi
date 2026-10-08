// Projects as objects: one small Markdown file per project in `<tickets>/_projects/`.
//   ---
//   name: web
//   dir: /path/to/the/repo        (a path on the machine that runs Sanvi)
//   ---
//   Free-text instructions for the agent (conventions, what to avoid, ...).
// The empty project name ("default project") lives in `_default.md`. Files may be hand-edited or missing; a file
// without a `name:` is named after its file name. Tickets stay the only place a ticket's project is written.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { splitDoc, parseFront, slugify, atomicWrite, listTickets, ValidationError } from './core.js';

export const PROJECTS_DIR = '_projects';
export const DEFAULT_LABEL = 'default project';
const DEFAULT_FILE = '_default.md';

const fileFor = (name) => (name ? `${slugify(name)}.md` : DEFAULT_FILE);

export function listProjectObjects(dir) {
  const root = path.join(dir, PROJECTS_DIR);
  let names = [];
  try { names = fs.readdirSync(root).filter((n) => n.endsWith('.md')).sort(); } catch { return []; }
  const out = [];
  for (const file of names) {
    let raw;
    try { raw = fs.readFileSync(path.join(root, file), 'utf8'); } catch { continue; }
    const { front, body } = splitDoc(raw);
    const f = parseFront(front);
    const base = file.replace(/\.md$/, '');
    const name = f.name !== undefined ? f.name.trim() : (file === DEFAULT_FILE ? '' : base);
    out.push({ name, dir: (f.dir || '').trim(), instructions: body.trim(), file });
  }
  return out;
}

const plain = (v) => (/^[\w./@~-][^:#]*$/.test(v) && v === v.trim() ? v : JSON.stringify(v));

export function saveProject(dir, { name = '', dir: pdir = '', instructions = '' } = {}) {
  for (const [k, v] of Object.entries({ name, dir: pdir, instructions })) if (typeof v !== 'string') throw new ValidationError(`${k} must be a string`);
  name = name.trim(); pdir = pdir.trim();
  if (/[\r\n]/.test(name) || /[\r\n]/.test(pdir)) throw new ValidationError('name and directory must be a single line');
  const file = fileFor(name);
  const clash = listProjectObjects(dir).find((o) => o.file === file && o.name !== name);
  if (clash) throw new ValidationError(`"${name}" would use the same file as project "${clash.name}"`);
  const root = path.join(dir, PROJECTS_DIR);
  fs.mkdirSync(root, { recursive: true });
  const front = [`name: ${name ? plain(name) : '""'}`, ...(pdir ? [`dir: ${plain(pdir)}`] : [])].join('\n');
  atomicWrite(path.join(root, file), `---\n${front}\n---\n${instructions.trim() ? `${instructions.trim()}\n` : ''}`);
}

/** Read-only projection: every project that exists as an object or is used by a ticket, with its warnings. */
export function projectView(dir) {
  const objects = new Map(listProjectObjects(dir).map((o) => [o.name, o]));
  const counts = new Map();
  for (const t of listTickets(dir)) counts.set(t.project || '', (counts.get(t.project || '') || 0) + 1);
  const names = new Set(['', ...objects.keys(), ...counts.keys()]);
  const list = [...names].map((name) => {
    const o = objects.get(name);
    const tickets = counts.get(name) || 0;
    const warnings = [];
    if (!o && name) warnings.push(`${tickets} ticket${tickets === 1 ? '' : 's'} use this project, but it has no project object yet`);
    if (o && !o.dir && !o.instructions) warnings.push('no information set (no directory, no instructions)');
    let dirOk = null;
    if (o?.dir) {
      try { dirOk = fs.statSync(o.dir).isDirectory(); } catch { dirOk = false; }
      if (!dirOk) warnings.push(`directory not found on this machine: ${o.dir}`);
    }
    return { name, label: name || DEFAULT_LABEL, exists: !!o, dir: o?.dir || '', instructions: o?.instructions || '', tickets, dirOk, warnings, file: o?.file || null };
  });
  return list.sort((a, b) => (a.name === '' ? -1 : b.name === '' ? 1 : a.name.localeCompare(b.name)));
}

/** What the agent should know about a project, read fresh each time so hand edits count. */
export function projectInfo(dir, name) {
  const o = listProjectObjects(dir).find((x) => x.name === (name || ''));
  return o ? { dir: o.dir, instructions: o.instructions } : {};
}

/** `tk validate` style problems: a ticket whose project has no object, and project objects with nothing set. */
export function projectProblems(dir) {
  const known = new Set(listProjectObjects(dir).map((o) => o.name));
  const out = [];
  for (const t of listTickets(dir)) {
    if (t.project && !known.has(t.project)) out.push({ file: t.file, level: 'warn', message: `project "${t.project}" has no project object (${PROJECTS_DIR}/${fileFor(t.project)})` });
  }
  for (const o of listProjectObjects(dir)) {
    if (!o.dir && !o.instructions) out.push({ file: `${PROJECTS_DIR}/${o.file}`, level: 'warn', message: `project "${o.name || DEFAULT_LABEL}" has no information set (no directory, no instructions)` });
  }
  return out;
}

/** Sub-directories of `input` (absolute, or ~/...), for the directory picker. Names only, sorted; dot-directories only on request. */
export function listDirs(input, { hidden = false } = {}) {
  let p = String(input ?? '').trim() || '~';
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  if (!path.isAbsolute(p)) throw new ValidationError('path must be absolute (or start with ~/)');
  let real;
  try {
    real = fs.realpathSync(p);
    if (!fs.statSync(real).isDirectory()) throw new Error('not a directory');
  } catch { throw new ValidationError(`not a directory: ${p}`); }
  let entries;
  try { entries = fs.readdirSync(real, { withFileTypes: true }); } catch { throw new ValidationError(`cannot read ${real}`); }
  const isDir = (e) => {
    if (e.isDirectory()) return true;
    if (!e.isSymbolicLink()) return false;
    try { return fs.statSync(path.join(real, e.name)).isDirectory(); } catch { return false; }
  };
  const dirs = entries.filter((e) => isDir(e) && (hidden || !e.name.startsWith('.'))).map((e) => e.name)
    .sort((a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' }));
  const parent = path.dirname(real);
  return { path: real, parent: parent === real ? null : parent, dirs };
}
