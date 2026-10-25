import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { expandFlags } from '../src/cliflags.js';

const TK = path.resolve(import.meta.dirname, '../bin/tk.js');

test('expandFlags: --agents-full enables agents and auto-refine, other flags are left alone', () => {
  assert.deepEqual(expandFlags({ 'agents-full': true }), { 'agents-full': true, agents: true, 'auto-refine': true });
  assert.deepEqual(expandFlags({ agents: true }), { agents: true });
  assert.deepEqual(expandFlags({ 'auto-refine': true }), { 'auto-refine': true });
  assert.deepEqual(expandFlags({}), {});
});

test('tk: --agents-full counts as --agents (the network check applies) and --auto-refine alone is still refused', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-flags-'));
  const run = (...args) => spawnSync(process.execPath, [TK, '--dir', dir, 'serve', ...args], { encoding: 'utf8' });
  const full = run('--agents-full', '--host', '0.0.0.0');
  assert.notEqual(full.status, 0);
  assert.match(full.stderr, /--agents with a non-loopback/);
  const refine = run('--auto-refine');
  assert.match(refine.stderr, /--auto-refine needs --agents/);
});
