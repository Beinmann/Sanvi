// Per-user registry of running web UI instances: one small JSON file per
// tickets dir in a state dir outside any repo. Entries are only trusted after
// checking the process is alive (and, where possible, really is `tk`).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

export function stateDir() {
  if (process.env.TK_STATE_DIR) return process.env.TK_STATE_DIR;
  const base = process.env.XDG_STATE_HOME || path.join(os.homedir(), '.local', 'state');
  return path.join(base, 'sanvi');
}

const instDir = () => path.join(stateDir(), 'instances');
const keyOf = (dir) => crypto.createHash('sha1').update(path.resolve(dir)).digest('hex').slice(0, 12);
const entryPath = (dir) => path.join(instDir(), `${keyOf(dir)}.json`);
export const logPath = (dir) => path.join(stateDir(), 'logs', `${keyOf(dir)}.log`);

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
