import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { findTicketsDir, offerTicketsDir } from '../src/ticketsdir.js';

const TK = fileURLToPath(new URL('../bin/tk.js', import.meta.url));
const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tk-td-'));

test('confirmed: creates <cwd>/tickets and names it in the question', async () => {
  const cwd = tmp();
  let question = '';
  const made = await offerTicketsDir(cwd, { isTTY: true, ask: async (q) => { question = q; return 'y'; } });
  assert.equal(made, path.join(cwd, 'tickets'));
  assert.ok(fs.statSync(made).isDirectory());
  assert.ok(question.includes(made));
  assert.equal(findTicketsDir(cwd), made);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('declined (no or just Enter) or no terminal: nothing is created', async () => {
  const cwd = tmp();
  for (const a of ['n', '', 'no']) assert.equal(await offerTicketsDir(cwd, { isTTY: true, ask: async () => a }), null);
  assert.equal(await offerTicketsDir(cwd, { isTTY: false, ask: async () => { throw new Error('must not ask'); } }), null);
  assert.deepEqual(fs.readdirSync(cwd), []);
  fs.rmSync(cwd, { recursive: true, force: true });
});

test('CLI without a terminal keeps the error and creates nothing, also for start', () => {
  const cwd = tmp();
  const env = { ...process.env, TK_DIR: '', TK_STATE_DIR: path.join(cwd, 'state') };
  for (const cmd of ['list', 'start', 'serve']) {
    const r = spawnSync(process.execPath, [TK, cmd], { cwd, env, encoding: 'utf8', input: '', timeout: 15000 });
    assert.equal(r.status, 1, cmd);
    assert.match(r.stderr, /no tickets dir found/);
    assert.doesNotMatch(r.stderr, /at .*tk\.js/); // no stack trace
  }
  assert.ok(!fs.existsSync(path.join(cwd, 'tickets')));
  fs.rmSync(cwd, { recursive: true, force: true });
});
