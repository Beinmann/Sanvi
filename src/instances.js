// Per-user registry of running web UI instances: one small JSON file per
// tickets dir in a state dir outside any repo (chats and the server log are per project, see below). Entries are only trusted after
// checking the process is alive (and, where possible, really is `tk`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { dataDir } from './datadir.js';

export function stateDir() {
  if (process.env.TK_STATE_DIR) return process.env.TK_STATE_DIR;
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'sanvi');
}

const instDir = () => path.join(stateDir(), 'instances');
const keyOf = (dir) => crypto.createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 12);
const entryPath = (dir) => path.join(instDir(), `${keyOf(dir)}.json`);
// Chats and the server log live in the project's `.sanvi` dir. Files from the per-user state dir
// (`chats/<hash>.json`, `logs/<hash>.log`) are moved over on first use, never overwriting.
function projectFile(dir, name, oldRel) {
  const target = path.join(dataDir(dir), name);
  const old = path.join(stateDir(), oldRel(keyOf(dir)));
  try {
    if (!fs.existsSync(target) && fs.existsSync(old)) {
      fs.mkdirSync(path.dirname(target), { recursive: true });
      try { fs.renameSync(old, target); } catch { fs.copyFileSync(old, target); fs.unlinkSync(old); }
    }
  } catch { /* leave the old file; the new one starts empty */ }
  return target;
}
export const chatsPath = (dir) => projectFile(dir, 'chats.json', (k) => path.join('chats', `${k}.json`));
export const logPath = (dir) => projectFile(dir, 'server.log', (k) => path.join('logs', `${k}.log`));

// One server per tickets dir: `.sanvi/server.lock` holds `{ pid, port }`. A lock whose process is gone is
// stale (crash) and replaced; a live one makes `acquireLock` throw an Error with `.lock` set unless `force`.
export const lockPath = (dir) => path.join(dataDir(dir), 'server.lock');

export function acquireLock(dir, { force = false } = {}) {
  const file = lockPath(dir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (let tries = 0; tries < 3; tries++) {
    try {
      fs.writeFileSync(file, JSON.stringify({ pid: process.pid }), { flag: 'wx' });
      return file;
    } catch (e) {
      if (e.code !== 'EEXIST') throw e;
    }
    let cur = null;
    try { cur = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* unreadable: stale */ }
    if (!force && cur && Number.isInteger(cur.pid) && cur.pid !== process.pid && isTkProcess(cur.pid)) {
      const err = new Error(`another Sanvi instance is already serving this dir (pid ${cur.pid}${cur.port ? `, port ${cur.port}` : ''}). Stop it with \`tk stop\`, or if that is wrong (e.g. the pid was reused), delete ${file} or start with --force.`);
      err.lock = cur;
      throw err;
    }
    try { fs.unlinkSync(file); } catch { /* raced with another cleanup */ }
  }
  throw new Error(`could not take the lock ${file}; delete it or start with --force`);
}

export function updateLock(dir, info) {
  try { fs.writeFileSync(lockPath(dir), JSON.stringify({ pid: process.pid, ...info })); } catch { /* best effort */ }
}

export function releaseLock(dir) {
  const file = lockPath(dir);
  try {
    if (JSON.parse(fs.readFileSync(file, 'utf8')).pid === process.pid) fs.unlinkSync(file);
  } catch { /* gone or not ours */ }
}

export function isTkProcess(pid) {
  try { process.kill(pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
  try {
    return fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').includes('tk.js');
  } catch { return true; } // no /proc: trust the liveness check
}

export function register(entry) {
  fs.mkdirSync(instDir(), { recursive: true });
  const file = entryPath(entry.dir);
  fs.writeFileSync(`${file}.tmp${process.pid}`, JSON.stringify(entry, null, 2));
  fs.renameSync(`${file}.tmp${process.pid}`, file);
}

export function unregister(dir, pid) {
  const file = entryPath(dir);
  try {
    const cur = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (pid == null || cur.pid === pid) fs.unlinkSync(file);
  } catch { /* already gone */ }
}

/** Live instances; stale entries (dead process or unreadable file) are removed. */
export function listInstances() {
  let names = [];
  try { names = fs.readdirSync(instDir()); } catch { return []; }
  const out = [];
  for (const n of names.filter((x) => x.endsWith('.json'))) {
    const file = path.join(instDir(), n);
    try {
      const e = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Number.isInteger(e.pid) && isTkProcess(e.pid)) out.push(e);
      else fs.unlinkSync(file);
    } catch { try { fs.unlinkSync(file); } catch { /* ignore */ } }
  }
  return out.sort((a, b) => a.dir.localeCompare(b.dir));
}

export const findInstance = (dir) => listInstances().find((e) => e.dir === path.resolve(dir));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** SIGTERM, wait for exit, SIGKILL as a last resort. Returns true once gone. */
export async function stopInstance(e) {
  try { process.kill(e.pid, 'SIGTERM'); } catch { /* already gone */ }
  for (let i = 0; i < 40 && isTkProcess(e.pid); i++) await sleep(100);
  if (isTkProcess(e.pid)) {
    try { process.kill(e.pid, 'SIGKILL'); } catch { /* ignore */ }
    await sleep(200);
  }
  unregister(e.dir, e.pid);
  return !isTkProcess(e.pid);
}

export async function waitForInstance(dir, pid, ms = 8000) {
  for (let t = 0; t < ms; t += 100) {
    const e = findInstance(dir);
    if (e && e.pid === pid) return e;
    if (!isTkProcess(pid)) return null;
    await sleep(100);
  }
  return null;
}
