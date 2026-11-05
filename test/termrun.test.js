import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createTerminalRun, interactiveFlags } from '../src/termrun.js';

function setup() {
  const state = { status: 'in-progress', alive: true, started: null, ended: false };
  const terminals = {
    start: (o) => { state.started = o; return { id: 't1' }; },
    alive: () => state.alive,
    end: () => { state.ended = true; state.alive = false; },
  };
  const run = createTerminalRun({ terminals, ticketStatus: () => state.status, pollMs: 10 });
  const go = () => run({ prompt: '-do it', cwd: '/w', interactive: { file: '001-a.md', name: 'Implement #1' }, allowedTools: ['Bash(git status:*)'], addDirs: ['/n'], tools: ['Read'] });
  const marker = () => state.started.flags[state.started.flags.indexOf('--settings') + 1].match(/touch '([^']+)'/)[1];
  return { state, go, marker };
}

test('interactiveFlags maps run options to CLI flags and registers the Stop hook', () => {
  const f = interactiveFlags({ allowedTools: ['A', 'B'], disallowedTools: ['C'], addDirs: ['/x', '/y'], tools: ['Read', 'Edit'] }, '/tmp/m');
  assert.deepEqual(f.slice(0, 8), ['--permission-mode', 'auto', '--tools', 'Read,Edit', '--allowedTools', 'A,B', '--disallowedTools', 'C']);
  assert.ok(f.includes('--add-dir=/x') && f.includes('--add-dir=/y'));
  assert.match(f.at(-1), /"Stop".*touch '\/tmp\/m'/);
});

test('the run starts a terminal with the prompt after -- and finishes at a Stop after the status changed', async () => {
  const { state, go, marker } = setup();
  const r = go();
  assert.equal(state.started.cwd, '/w');
  assert.deepEqual(state.started.flags.slice(-2), ['--', '-do it']);
  fs.writeFileSync(marker(), ''); // a turn ended, status unchanged (e.g. a question): keep going
  await new Promise((x) => setTimeout(x, 50));
  assert.equal(state.ended, false);
  assert.equal(fs.existsSync(marker()), false);
  state.status = 'testing';
  fs.writeFileSync(marker(), '');
  const d = await r.done;
  assert.equal(d.ok, true);
  assert.equal(state.ended, true);
});

test('a session that ends is ok only if the status changed; cancel ends it', async () => {
  let s = setup();
  let r = s.go(); s.state.alive = false;
  assert.match((await r.done).error, /before the ticket left status "in-progress"/);
  s = setup(); r = s.go(); s.state.status = 'testing'; s.state.alive = false;
  assert.equal((await r.done).ok, true);
  s = setup(); r = s.go(); r.cancel();
  const d = await r.done;
  assert.equal(d.cancelled, true); assert.equal(s.state.ended, true);
});

test('a refine run (watch: version) finishes when the ticket changed even if the status did not', async () => {
  const state = { v: 'a', alive: true, ended: false, started: null };
  const terminals = { start: (o) => { state.started = o; return {}; }, alive: () => state.alive, end: () => { state.ended = true; state.alive = false; } };
  const run = createTerminalRun({ terminals, ticketStatus: () => 'idea', ticketVersion: () => state.v, pollMs: 10 });
  const r = run({ prompt: 'x', cwd: '/w', interactive: { file: 'f.md', name: 'Refine #1', watch: 'version' } });
  const marker = state.started.flags[state.started.flags.indexOf('--settings') + 1].match(/touch '([^']+)'/)[1];
  fs.writeFileSync(marker, '');
  await new Promise((x) => setTimeout(x, 50));
  assert.equal(state.ended, false);
  state.v = 'b';
  fs.writeFileSync(marker, '');
  assert.equal((await r.done).ok, true);
});
