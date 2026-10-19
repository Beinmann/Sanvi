// Implementing a ticket with an agent: the prompt, the permissions, and the git worktree + merge around the run.
// The code change happens in a worktree of the project's repository on its own branch; the ticket file itself
// (which may live in another repo) is edited in place. Merging into the base branch happens only after a clean run.
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { ValidationError } from './core.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitError = (e) => String(e.stderr || e.stdout || e.message).trim().split('\n').slice(-3).join(' ');

export function implementPrompt({ ticketsDir, file, instructions = '', project = '' }) {
  const readme = path.join(ticketsDir, 'README.md');
  const ticket = path.join(ticketsDir, file);
  return `You are implementing one ticket in a Markdown ticket tracker. Nobody can answer questions during this run, so do not ask any.

1. Read the ticket format in ${readme} (if it does not exist, keep the ticket's own structure) and the ticket ${ticket}.
2. Implement the ticket in the repository you are running in (a git worktree on its own branch). Follow the surrounding code's style, add or update tests where the repo has them, and run them.
3. Tick the ticket's acceptance criteria that are met, add a dated Note saying what you did, write or update its "## Summary" ("To test: ..."), and set "status: testing" (not "done") in the frontmatter. The ticket is ${ticket}, outside your repository; edit it there. You may also read and edit notes elsewhere in the notes repository (${path.dirname(ticketsDir)} and below), but never the project's main checkout.
4. Commit your changes in the repository with git. Do not switch branches, merge or push: the branch is merged for you if you finish successfully.${instructions ? `\n\nInstructions for project "${project}":\n${instructions}` : ''}`;
}

// The notes repo (the one holding the tickets) is readable and writable, so the agent can use notes, research and the
// ticket. The project's main checkout may lie inside it but is off limits: code changes belong in the worktree.
export function implementRunOpts({ ticketsDir, projectDir }) {
  let notes = ticketsDir;
  try { notes = git(ticketsDir, 'rev-parse', '--show-toplevel'); } catch { /* tickets are not in a git repo */ }
  const rule = (tool, p) => `${tool}(/${p}/**)`;
  const within = (p, root) => p === root || p.startsWith(`${root}/`);
  // never lock the agent out of its own ticket, even if the tickets live inside the project's checkout
  const inside = projectDir && within(projectDir, notes) && !within(ticketsDir, projectDir);
  return {
    permissionMode: 'auto',
    tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
    allowedTools: [rule('Edit', notes), rule('Write', notes), 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git log:*)', 'Bash(npm test:*)', 'Bash(npm run test:*)', 'Bash(node --test:*)'],
    disallowedTools: inside ? [rule('Edit', projectDir), rule('Write', projectDir)] : [],
    addDirs: [notes],
    maxBudgetUsd: 5,
  };
}

// A worktree on a new branch `ticket-<id>` next to the repo that contains `dir`; returns where it is and what to merge into.
export function createWorktree({ dir, id }) {
  let top;
  try { top = git(dir, 'rev-parse', '--show-toplevel'); } catch { throw new ValidationError(`not inside a git repository: ${dir}`); }
  const base = git(top, 'branch', '--show-current');
  if (!base) throw new ValidationError('the repository is on a detached HEAD; check out a branch first');
  const branch = `ticket-${id}`;
  const worktree = `${top}-worktrees/${branch}`;
  try {
    // a leftover from an earlier attempt: keep its branch (and worktree, if still there) and continue on it
    git(top, 'worktree', 'prune');
    const registered = git(top, 'worktree', 'list', '--porcelain').split('\n').some((l) => l === `worktree ${worktree}`);
    if (!registered) {
      let exists = true;
      try { git(top, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`); } catch { exists = false; }
      git(top, 'worktree', 'add', ...(exists ? [worktree, branch] : [worktree, '-b', branch]));
    }
  } catch (e) { throw new ValidationError(`could not create the worktree: ${gitError(e)}`); }
  return { top, base, branch, worktree };
}

// After a successful run: commit what the agent left, merge into the base branch, remove the worktree.
// On any problem nothing stays half-merged and the worktree is kept. Returns { merged } or { merged: false, error }.
export function mergeWorktree({ top, base, branch, worktree }) {
  try {
    if (git(worktree, 'status', '--porcelain')) { git(worktree, 'add', '-A'); git(worktree, 'commit', '-m', `Implement ${branch}`); }
    if (!git(top, 'rev-list', `${base}..${branch}`)) return { merged: false, error: 'the agent made no commits' };
    if (git(top, 'branch', '--show-current') !== base) return { merged: false, error: `the main checkout is no longer on ${base}; merge ${branch} by hand` };
    try { git(top, 'merge', '--no-edit', branch); } catch (e) {
      try { git(top, 'merge', '--abort'); } catch { /* nothing to abort */ }
      return { merged: false, error: `merge conflict or blocked merge: ${gitError(e)}` };
    }
  } catch (e) { return { merged: false, error: gitError(e) }; }
  try { git(top, 'worktree', 'remove', worktree); git(top, 'branch', '-d', branch); } catch { /* merged anyway; leftovers are harmless */ }
  return { merged: true };
}
