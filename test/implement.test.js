import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorktree, implementPrompt, mergeWorktree } from '../src/implement.js';

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
  assert.doesNotMatch(r.error, /uncommitted/);
  assert.equal(git(top, 'status', '--porcelain'), '');
  fs.rmSync(root, { recursive: true, force: true });
});

test('mergeWorktree merges cleanly when nothing is in the way', () => {
  const { root, wt } = branchWithChange('a.txt', 'branch\n');
  assert.deepEqual(mergeWorktree(wt), { merged: true });
  fs.rmSync(root, { recursive: true, force: true });
});
