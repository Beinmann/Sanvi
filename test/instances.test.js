import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const TK = fileURLToPath(new URL('../bin/tk.js', import.meta.url));

function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-inst-'));
  const mk = (n) => {
    const d = path.join(root, n, 'tickets');
    fs.mkdirSync(d, { recursive: true });
    fs.writeFileSync(path.join(d, '001-a.md'), '---\nstatus: open\n---\n\n# A\n');
    return d;
  };
  const env = { ...process.env, TK_STATE_DIR: path.join(root, 'state') };
  const tk = (...a) => execFileSync(process.execPath, [TK, ...a], { env, encoding: 'utf8' });
  return { root, mk, tk };
}

test('start/ps/stop with several instances', () => {
  const { root, mk, tk } = setup();
  const a = mk('a'); const b = mk('b');
  try {
    const s1 = tk('--dir', a, 'start', '--port', '0');
    assert.match(s1, /started .*http:\/\/localhost:\d+/);
    assert.match(tk('--dir', a, 'start'), /already running/);
    tk('--dir', b, 'start');
    const list = JSON.parse(tk('ps', '--json'));
    assert.equal(list.length, 2);
    assert.notEqual(list[0].port, list[1].port);
    assert.match(tk('--dir', a, 'stop'), /stopped/);
    const after = JSON.parse(tk('ps', '--json'));
    assert.deepEqual(after.map((e) => e.dir), [b]);
    assert.match(tk('--dir', a, 'stop'), /nothing to stop/);
  } finally {
    tk('stop', '--all');
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('stale entries are cleaned up', () => {
  const { root, tk } = setup();
  try {
    const inst = path.join(root, 'state', 'instances');
    fs.mkdirSync(inst, { recursive: true });
    fs.writeFileSync(path.join(inst, 'dead.json'), JSON.stringify({ dir: '/x', pid: 2147483646, port: 1, url: 'u' }));
    assert.match(tk('ps'), /no running instances/);
    assert.deepEqual(fs.readdirSync(inst), []);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('chatsPath and logPath live in the project .sanvi dir; old per-user files are moved once', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'sanvi-paths-'));
  const stateBefore = process.env.TK_STATE_DIR;
  process.env.TK_STATE_DIR = path.join(root, 'state');
  try {
    const { chatsPath, logPath } = await import('../src/instances.js');
    const tickets = path.join(root, 'proj', 'tickets');
    fs.mkdirSync(tickets, { recursive: true });
    const c0 = chatsPath(tickets);
    assert.equal(c0, path.join(root, 'proj', '.sanvi', 'chats.json'));
    assert.equal(logPath(tickets), path.join(root, 'proj', '.sanvi', 'server.log'));
    // plant an old-style file by deriving its name from a second project
    const t2 = path.join(root, 'p2', 'tickets');
    fs.mkdirSync(t2, { recursive: true });
    const crypto = await import('node:crypto');
    const k = crypto.createHash('sha1').update(path.resolve(t2)).digest('hex').slice(0, 12);
    fs.mkdirSync(path.join(root, 'state', 'chats'), { recursive: true });
    fs.writeFileSync(path.join(root, 'state', 'chats', `${k}.json`), 'OLD');
    assert.equal(fs.readFileSync(chatsPath(t2), 'utf8'), 'OLD');
    assert.ok(!fs.existsSync(path.join(root, 'state', 'chats', `${k}.json`)));
    // never overwrites
    fs.writeFileSync(path.join(root, 'state', 'chats', `${k}.json`), 'OLD2');
    assert.equal(fs.readFileSync(chatsPath(t2), 'utf8'), 'OLD');
  } finally {
    if (stateBefore === undefined) delete process.env.TK_STATE_DIR; else process.env.TK_STATE_DIR = stateBefore;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('server lock: live holder refuses, stale lock is replaced, --force overrides, release removes', async () => {
  const { spawn, spawnSync } = await import('node:child_process');
  const { root, mk, tk } = setup();
  const d = mk('lock');
  const lock = path.join(root, 'lock', '.sanvi', 'server.lock');
  const { acquireLock, releaseLock } = await import('../src/instances.js');
  // a live process whose command line contains tk.js stands in for another instance
  const holder = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 20000)', 'tk.js'], { stdio: 'ignore' });
  try {
    fs.mkdirSync(path.dirname(lock), { recursive: true });
    fs.writeFileSync(lock, JSON.stringify({ pid: holder.pid, port: 4999 }));
    assert.throws(() => acquireLock(d), (e) => /pid \d+, port 4999/.test(e.message) && e.message.includes('server.lock') && e.message.includes('--force'));
    const r = spawnSync(process.execPath, [TK, '--dir', d, 'serve', '--port', '0'], { encoding: 'utf8', env: { ...process.env, TK_STATE_DIR: path.join(root, 'state') } });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr + r.stdout, /already serving/);
    // dead holder: stale, replaced
    fs.writeFileSync(lock, JSON.stringify({ pid: 2147483646, port: 1 }));
    acquireLock(d);
    assert.equal(JSON.parse(fs.readFileSync(lock, 'utf8')).pid, process.pid);
    releaseLock(d);
    assert.ok(!fs.existsSync(lock));
    // force over a live holder
    fs.writeFileSync(lock, JSON.stringify({ pid: holder.pid }));
    acquireLock(d, { force: true });
    releaseLock(d);
  } finally {
    holder.kill();
    tk('stop', '--all');
    fs.rmSync(root, { recursive: true, force: true });
  }
});
