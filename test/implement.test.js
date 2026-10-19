import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { createWorktree } from '../src/implement.js';

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
