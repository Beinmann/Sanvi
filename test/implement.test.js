import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorktree, releaseWorktree, implementPrompt, mergeWorktree, mergeConflictPrompt, mergeRunOpts, completeMerge, readMarker, slotOverview, resizePool, STALE_MS } from '../src/implement.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

function tempRepo() {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'sanvi-impl-')));
  const top = path.join(root, 'repo');
  fs.mkdirSync(top);
  git(top, 'init', '-q', '-b', 'main');
  git(top, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'init');
  return { root, top };
}

test('createWorktree makes a new branch and worktree for a fresh ticket', () => {
  const { root, top } = tempRepo();
  const wt = createWorktree({ dir: top, id: '001' });
  assert.equal(wt.branch, 'ticket-001');
  assert.ok(fs.existsSync(wt.worktree));
  assert.equal(git(wt.worktree, 'branch', '--show-current'), 'ticket-001');
  fs.rmSync(root, { recursive: true, force: true });
});

test('createWorktree reuses a leftover worktree and keeps its commits', () => {
  const { root, top } = tempRepo();
  const first = createWorktree({ dir: top, id: '002' });
  git(first.worktree, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'earlier work');
  const again = createWorktree({ dir: top, id: '002' });
  assert.equal(again.worktree, first.worktree);
  assert.equal(git(again.worktree, 'log', '-1', '--format=%s'), 'earlier work');
  fs.rmSync(root, { recursive: true, force: true });
});

test('createWorktree creates a worktree for an existing branch whose worktree is gone', () => {
  const { root, top } = tempRepo();
  const first = createWorktree({ dir: top, id: '003' });
  git(first.worktree, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '--allow-empty', '-m', 'earlier work');
  fs.rmSync(first.worktree, { recursive: true, force: true });
  fs.rmSync(`${first.worktree}.busy`);
  const again = createWorktree({ dir: top, id: '003' });
  assert.ok(fs.existsSync(again.worktree));
  assert.equal(git(again.worktree, 'log', '-1', '--format=%s'), 'earlier work');
  fs.rmSync(root, { recursive: true, force: true });
});

test('createWorktree creates a worktree for an existing branch that was never checked out', () => {
  const { root, top } = tempRepo();
  git(top, 'branch', 'ticket-004');
  const wt = createWorktree({ dir: top, id: '004' });
  assert.equal(git(wt.worktree, 'branch', '--show-current'), 'ticket-004');
  fs.rmSync(root, { recursive: true, force: true });
});

test('implementPrompt tells the agent to block on unclear tickets before implementing', () => {
  const p = implementPrompt({ ticketsDir: '/t', file: '001-x.md' });
  const clear = p.indexOf('clear enough');
  assert.ok(clear > 0 && clear < p.indexOf('3. Implement'));
  assert.match(p, /do NOT change any code/);
  assert.match(p, /dated Note[^\n]*Blocked:/);
});

function branchWithChange(file, text) {
  const { root, top } = tempRepo();
  git(top, 'config', 'user.name', 't');
  git(top, 'config', 'user.email', 't@example.com');
  fs.writeFileSync(path.join(top, file), 'one\n');
  git(top, 'add', '-A');
  git(top, 'commit', '-q', '-m', 'add file');
  const wt = createWorktree({ dir: top, id: '002' });
  fs.writeFileSync(path.join(wt.worktree, file), text);
  return { root, top, wt };
}

test('mergeWorktree reports uncommitted changes in the main checkout, not a conflict', () => {
  const { root, top, wt } = branchWithChange('a.txt', 'branch\n');
  fs.writeFileSync(path.join(top, 'a.txt'), 'local edit\n');
  const r = mergeWorktree(wt);
  assert.equal(r.merged, false);
  assert.match(r.error, /uncommitted changes to a\.txt/);
  assert.match(r.error, /complete and kept/);
  assert.match(r.error, /commit or stash/i);
  assert.doesNotMatch(r.error, /merge conflict/);
  assert.equal(fs.readFileSync(path.join(top, 'a.txt'), 'utf8'), 'local edit\n');
  assert.ok(fs.existsSync(wt.worktree));
  fs.rmSync(root, { recursive: true, force: true });
});

test('mergeWorktree reports a real conflict as a conflict', () => {
  const { root, top, wt } = branchWithChange('a.txt', 'branch\n');
  fs.writeFileSync(path.join(top, 'a.txt'), 'main\n');
  git(top, 'commit', '-q', '-am', 'main change');
  const r = mergeWorktree(wt);
  assert.equal(r.merged, false);
  assert.match(r.error, /merge conflict in a\.txt/);
  assert.equal(r.conflict, true);
  assert.deepEqual(r.conflicts, ['a.txt']);
  assert.doesNotMatch(r.error, /uncommitted/);
  assert.equal(git(top, 'status', '--porcelain'), '');
  fs.rmSync(root, { recursive: true, force: true });
});

test('mergeWorktree merges cleanly when nothing is in the way', () => {
  const { root, wt } = branchWithChange('a.txt', 'branch\n');
  assert.deepEqual(mergeWorktree(wt), { merged: true });
  fs.rmSync(root, { recursive: true, force: true });
});

test('non-conflict refusals are not flagged as conflicts', () => {
  const { root, top, wt } = branchWithChange('a.txt', 'branch\n');
  fs.writeFileSync(path.join(top, 'a.txt'), 'local edit\n');
  assert.equal(mergeWorktree(wt).conflict, undefined);
  fs.rmSync(root, { recursive: true, force: true });
});

function conflicted() {
  const c = branchWithChange('a.txt', 'branch\n');
  fs.writeFileSync(path.join(c.top, 'a.txt'), 'main\n');
  git(c.top, 'commit', '-q', '-am', 'main change');
  return c;
}

test('conflict path: a resolving agent (stubbed) completes the merge and the worktree goes away', () => {
  const { root, top, wt } = conflicted();
  assert.equal(mergeWorktree(wt).conflict, true);
  // stand-in for the agent: merge, resolve, commit
  try { git(top, 'merge', '--no-edit', wt.branch); } catch { /* conflict expected */ }
  fs.writeFileSync(path.join(top, 'a.txt'), 'main+branch\n');
  git(top, 'add', 'a.txt');
  git(top, 'commit', '-q', '--no-edit');
  assert.deepEqual(completeMerge(wt), { merged: true });
  assert.ok(!fs.existsSync(wt.worktree + '.busy'));
  assert.equal(fs.readFileSync(path.join(top, 'a.txt'), 'utf8'), 'main+branch\n');
  fs.rmSync(root, { recursive: true, force: true });
});

test('conflict path: an agent that gives up leaves the merge aborted and the worktree kept', () => {
  const { root, top, wt } = conflicted();
  mergeWorktree(wt);
  try { git(top, 'merge', '--no-edit', wt.branch); } catch { /* conflict expected */ }
  const r = completeMerge(wt); // the agent neither resolved nor aborted
  assert.equal(r.merged, false);
  assert.match(r.error, /not resolved/);
  assert.equal(git(top, 'status', '--porcelain'), '');
  assert.ok(fs.existsSync(wt.worktree));
  fs.rmSync(root, { recursive: true, force: true });
});

test('the merge prompt offers resolving or blocking; its permissions cover the main checkout', () => {
  const wt = { top: '/repo', base: 'main', branch: 'ticket-002', worktree: '/repo-worktrees/ticket-002' };
  const p = mergeConflictPrompt({ ticketsDir: '/n/tickets', file: '002-x.md', wt, conflicts: ['a.txt'] });
  assert.match(p, /git merge --no-edit ticket-002/);
  assert.match(p, /not straightforward[^]*git merge --abort[^]*Blocked:[^]*status: blocked/);
  const o = mergeRunOpts({ ticketsDir: '/n/tickets', projectDir: '/repo' });
  assert.ok(o.allowedTools.includes('Edit(//repo/**)') && o.allowedTools.includes('Bash(git merge:*)'));
});

test('pool: tickets get distinct slots, and an exhausted pool is reported', () => {
  const { root, top } = tempRepo();
  const a = createWorktree({ dir: top, id: '010', poolSize: 2 });
  const b = createWorktree({ dir: top, id: '011', poolSize: 2 });
  assert.notEqual(a.worktree, b.worktree);
  assert.match(a.worktree, /slot-\d+$/);
  assert.throws(() => createWorktree({ dir: top, id: '012', poolSize: 2 }), /all 2 worktrees are busy/);
  fs.rmSync(root, { recursive: true, force: true });
});

test('pool: a released slot is clean, free again and reused; ignored files stay', () => {
  const { root, top } = tempRepo();
  fs.writeFileSync(path.join(top, '.gitignore'), 'node_modules\n');
  git(top, 'add', '-A'); git(top, '-c', 'user.name=t', '-c', 'user.email=t@example.com', 'commit', '-q', '-m', 'ignore');
  const a = createWorktree({ dir: top, id: '020', poolSize: 1 });
  fs.mkdirSync(path.join(a.worktree, 'node_modules'));
  fs.writeFileSync(path.join(a.worktree, 'node_modules', 'x'), 'dep');
  fs.writeFileSync(path.join(a.worktree, 'scratch.txt'), 'junk');
  fs.writeFileSync(path.join(a.worktree, '.gitignore'), 'changed');
  assert.throws(() => createWorktree({ dir: top, id: '021', poolSize: 1 }), /busy/);
  assert.equal(releaseWorktree(a), true);
  assert.equal(git(a.worktree, 'status', '--porcelain'), '');
  assert.equal(git(a.worktree, 'branch', '--show-current'), '');
  const b = createWorktree({ dir: top, id: '021', poolSize: 1 });
  assert.equal(b.worktree, a.worktree);
  assert.equal(git(b.worktree, 'branch', '--show-current'), 'ticket-021');
  assert.ok(fs.existsSync(path.join(b.worktree, 'node_modules', 'x')));
  assert.ok(!fs.existsSync(path.join(b.worktree, 'scratch.txt')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('pool: a merged run frees its slot with the worktree clean', () => {
  const { root, top, wt } = branchWithChange('a.txt', 'branch\n');
  assert.deepEqual(mergeWorktree(wt), { merged: true });
  assert.ok(fs.existsSync(wt.worktree));
  assert.ok(!fs.existsSync(`${wt.worktree}.busy`));
  assert.equal(git(wt.worktree, 'status', '--porcelain'), '');
  assert.equal(createWorktree({ dir: top, id: '030', poolSize: 1 }).worktree, wt.worktree);
  fs.rmSync(root, { recursive: true, force: true });
});

test('slots: the marker records when the slot was taken; an old one-line marker counts from its mtime', () => {
  const { root, top } = tempRepo();
  const a = createWorktree({ dir: top, id: '040', poolSize: 2, now: Date.parse('2026-01-01T00:00:00Z') });
  const lines = fs.readFileSync(`${a.worktree}.busy`, 'utf8').split('\n');
  assert.deepEqual(lines.slice(0, 2), ['ticket-040', '2026-01-01T00:00:00.000Z']);
  fs.writeFileSync(`${a.worktree}.busy`, 'ticket-040\n');
  assert.equal(readMarker(a.worktree).branch, 'ticket-040');
  assert.ok(Math.abs(readMarker(a.worktree).taken - Date.now()) < 5000);
  fs.rmSync(root, { recursive: true, force: true });
});

test('slots: a slot older than 24 h is freed before refusing, unless its run is active; the branch is kept', () => {
  const { root, top } = tempRepo();
  const t0 = Date.parse('2026-01-01T00:00:00Z');
  const a = createWorktree({ dir: top, id: '050', poolSize: 1, now: t0 });
  fs.writeFileSync(path.join(a.worktree, 'junk.txt'), 'x');
  const later = t0 + STALE_MS + 1000;
  assert.throws(() => createWorktree({ dir: top, id: '051', poolSize: 1, now: t0 + STALE_MS - 1000 }), /all 1 worktrees are busy \(slot-1: ticket-050 \(\d+ (min|h)\)\)/);
  assert.throws(() => createWorktree({ dir: top, id: '051', poolSize: 1, now: later, isActive: (b) => b === 'ticket-050' }), /busy/);
  const b = createWorktree({ dir: top, id: '051', poolSize: 1, now: later });
  assert.equal(b.worktree, a.worktree);
  assert.equal(git(top, 'branch', '--list', 'ticket-050'), 'ticket-050');
  assert.ok(!fs.existsSync(path.join(b.worktree, 'junk.txt')));
  fs.rmSync(root, { recursive: true, force: true });
});

test('slots: releasing with a branch does nothing if the slot now belongs to another ticket', () => {
  const { root, top } = tempRepo();
  const a = createWorktree({ dir: top, id: '060', poolSize: 1 });
  assert.equal(releaseWorktree(a), true);
  const b = createWorktree({ dir: top, id: '061', poolSize: 1 });
  assert.equal(releaseWorktree(a), false); // stale handle of the first run
  assert.equal(git(b.worktree, 'branch', '--show-current'), 'ticket-061');
  assert.ok(fs.existsSync(`${b.worktree}.busy`));
  fs.rmSync(root, { recursive: true, force: true });
});

test('slots: resizePool grows and shrinks only while all slots are free, touching just the removed slots', () => {
  const { root, top } = tempRepo();
  resizePool({ top, from: 1, to: 3 });
  assert.ok(fs.existsSync(`${top}-worktrees/slot-3`));
  const keep = `${top}-worktrees/unrelated`;
  fs.mkdirSync(keep, { recursive: true });
  createWorktree({ dir: top, id: '070', poolSize: 3 });
  assert.throws(() => resizePool({ top, from: 3, to: 1 }), /busy/);
  releaseWorktree({ base: 'main', worktree: `${top}-worktrees/slot-1` });
  resizePool({ top, from: 3, to: 1 });
  assert.ok(fs.existsSync(`${top}-worktrees/slot-1`));
  assert.ok(!fs.existsSync(`${top}-worktrees/slot-2`) && !fs.existsSync(`${top}-worktrees/slot-3`));
  assert.ok(fs.existsSync(keep));
  assert.equal(git(top, 'worktree', 'list').split('\n').length, 2);
  assert.deepEqual(slotOverview(top, 2).map((o) => o.busy), [false, false]);
  fs.rmSync(root, { recursive: true, force: true });
});
