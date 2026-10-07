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
