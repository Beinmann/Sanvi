// Implementing a ticket with an agent: the prompt, the permissions, and the git worktree + merge around the run.
// The code change happens in a worktree of the project's repository on its own branch; the ticket file itself
// (which may live in another repo) is edited in place. Merging into the base branch happens only after a clean run.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ValidationError } from './core.js';
import { reviewsDir } from './review.js';

const git = (cwd, ...args) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const gitError = (e) => String(e.stderr || e.stdout || e.message).trim().split('\n').slice(-3).join(' ');

export function implementPrompt({ ticketsDir, file, instructions = '', project = '' }) {
  const readme = path.join(ticketsDir, 'README.md');
  const ticket = path.join(ticketsDir, file);
  return `You are implementing one ticket in a Markdown ticket tracker. Nobody can answer questions during this run, so do not ask any.

1. Read the ticket format in ${readme} (if it does not exist, keep the ticket's own structure) and the ticket ${ticket}.
2. Judge whether the ticket is clear enough to implement without guessing: an understandable problem and concrete, verifiable acceptance criteria. If it is not, do NOT change any code and do not set its status to "in-progress" or "testing". Instead add a dated Note to the ticket (${ticket}) that starts with "Blocked:" and lists your specific open questions, optionally set "status: blocked" in the frontmatter, and stop here (skip steps 3-5).
3. Implement the ticket in the repository you are running in (a git worktree on its own branch). Follow the surrounding code's style, add or update tests where the repo has them, and run them.
4. Tick the ticket's acceptance criteria that are met, add a dated Note saying what you did, write or update its "## Summary" ("To test: ..."), and set "status: testing" (not "done") in the frontmatter. The ticket is ${ticket}, outside your repository; edit it there. You may also read and edit notes elsewhere in the notes repository (${path.dirname(ticketsDir)} and below), but never the project's main checkout.
5. Commit your changes in the repository with git. Do not switch branches, merge or push: the branch is merged for you if you finish successfully.${instructions ? `\n\nInstructions for project "${project}":\n${instructions}` : ''}`;
}

// The notes repo (the one holding the tickets) is readable and writable, so the agent can use notes, research and the
// ticket. The project's main checkout may lie inside it but is off limits: code changes belong in the worktree.
export function implementRunOpts({ ticketsDir, projectDir }) {
  let notes = ticketsDir;
  try { notes = git(ticketsDir, 'rev-parse', '--show-toplevel'); } catch { /* tickets are not in a git repo */ }
  const reviews = reviewsDir(ticketsDir);
  const rule = (tool, p) => `${tool}(/${p}/**)`;
  const within = (p, root) => p === root || p.startsWith(`${root}/`);
  // never lock the agent out of its own ticket, even if the tickets live inside the project's checkout
  const inside = projectDir && within(projectDir, notes) && !within(ticketsDir, projectDir);
  return {
    permissionMode: 'auto',
    tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write', 'Bash'],
    allowedTools: [rule('Edit', notes), rule('Write', notes), 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git add:*)', 'Bash(git commit:*)', 'Bash(git log:*)', 'Bash(npm test:*)', 'Bash(npm run test:*)', 'Bash(node --test:*)'],
    // review reports (of any ticket) are readable, also when they lie outside the notes repo, but never writable
    disallowedTools: [...(inside ? [rule('Edit', projectDir), rule('Write', projectDir)] : []), rule('Edit', reviews), rule('Write', reviews)],
    addDirs: [notes, reviews],
    maxBudgetUsd: 5,
  };
}

export const DEFAULT_POOL_SIZE = 4;

// Worktrees come from a fixed pool of slots `<repo>-worktrees/slot-<n>`, created lazily and reused between tickets so
// ignored files (node_modules, build output) survive. A slot is busy while `slot-<n>.busy` exists next to it; the marker
// lives outside the worktree (so `git clean` never touches it) and on disk (so a restart does not lose it).
const slotDir = (top, n) => `${top}-worktrees/slot-${n}`;
const markerOf = (worktree) => `${worktree}.busy`;
export const MAX_POOL_SIZE = 10;
export const STALE_MS = 24 * 60 * 60 * 1000; // typical runs take minutes, the longest seen ~15; a day is stuck

// A marker is the branch on line 1 and, on line 2, when the slot was taken (ISO). Older markers have no second
// line; they count as taken at the file's mtime.
export function readMarker(worktree) {
  const file = markerOf(worktree);
  try {
    const [branch, stamp] = fs.readFileSync(file, 'utf8').split('\n');
    const t = Date.parse(stamp);
    return { branch: branch.trim(), taken: Number.isFinite(t) ? t : fs.statSync(file).mtimeMs };
  } catch { return null; }
}

export function repoTop(dir) {
  try { return git(dir, 'rev-parse', '--show-toplevel'); } catch { return null; }
}

/** Every slot of the repo's pool: `{ n, name, worktree, busy, branch, taken }` (branch/taken only when busy). */
export function slotOverview(top, size) {
  return Array.from({ length: size }, (_, i) => {
    const n = i + 1;
    const worktree = slotDir(top, n);
    const m = readMarker(worktree);
    return { n, name: `slot-${n}`, worktree, busy: !!m, branch: m?.branch || null, taken: m ? new Date(m.taken).toISOString() : null };
  });
}

const ago = (ms) => (ms < 3600e3 ? `${Math.max(1, Math.round(ms / 60e3))} min` : ms < 48 * 3600e3 ? `${Math.round(ms / 3600e3)} h` : `${Math.round(ms / 86400e3)} d`);

function branchExists(top, branch) {
  try { git(top, 'rev-parse', '--verify', '--quiet', `refs/heads/${branch}`); return true; } catch { return false; }
}

// Takes a free slot and checks out branch `ticket-<id>` in it (created from the current branch, or continued if a
// leftover exists). A slot already busy with this ticket is reused. Returns where it is and what to merge into.
// Slots held longer than `staleMs` are freed first, except those `isActive(branch)` says still have a run in this server.
export function createWorktree({ dir, id, poolSize = DEFAULT_POOL_SIZE, isActive = () => false, staleMs = STALE_MS, now = Date.now() }) {
  let top;
  try { top = git(dir, 'rev-parse', '--show-toplevel'); } catch { throw new ValidationError(`not inside a git repository: ${dir}`); }
  const base = git(top, 'branch', '--show-current');
  if (!base) throw new ValidationError('the repository is on a detached HEAD; check out a branch first');
  const branch = `ticket-${id}`;
  const size = Math.max(1, Math.floor(Number(poolSize)) || DEFAULT_POOL_SIZE);
  try {
    git(top, 'worktree', 'prune');
    for (let n = 1; n <= size; n++) { // stale sweep: before looking for a free slot, hence also before refusing
      const m = readMarker(slotDir(top, n));
      if (m && now - m.taken > staleMs && !isActive(m.branch)) releaseWorktree({ base, worktree: slotDir(top, n), branch: m.branch });
    }
    const marked = (n) => fs.existsSync(markerOf(slotDir(top, n)));
    let slot = 0;
    for (let n = 1; n <= size && !slot; n++) { // this ticket's own slot from an earlier attempt
      if (readMarker(slotDir(top, n))?.branch === branch) slot = n;
    }
    const reused = !!slot;
    for (let n = 1; n <= size && !slot; n++) if (!marked(n)) slot = n;
    if (!slot) {
      const held = slotOverview(top, size).map((o) => `${o.name}: ${o.branch} (${ago(now - Date.parse(o.taken))})`).join(', ');
      throw new ValidationError(`all ${size} worktrees are busy (${held}); wait for a run to finish, free one by deleting its chat, or increase the slot count`);
    }
    const worktree = slotDir(top, slot);
    const registered = git(top, 'worktree', 'list', '--porcelain').split('\n').includes(`worktree ${worktree}`);
    const exists = branchExists(top, branch);
    if (!registered) git(top, 'worktree', 'add', '--detach', worktree, base);
    if (git(worktree, 'branch', '--show-current') !== branch) {
      git(worktree, 'reset', '--hard'); git(worktree, 'clean', '-fd');
      git(worktree, 'checkout', ...(exists ? [branch] : ['-b', branch, base]));
    }
    fs.writeFileSync(markerOf(worktree), `${branch}\n${new Date(now).toISOString()}\n`);
    return { top, base, branch, worktree, reused, branchExisted: exists };
  } catch (e) {
    if (e instanceof ValidationError) throw e;
    throw new ValidationError(`could not create the worktree: ${gitError(e)}`);
  }
}

// Gives the slot back: discards leftover changes, detaches from the ticket branch (which is kept) onto the base branch's
// commit, and removes the busy marker. Ignored files stay. Returns true if the slot is free now. With `branch`, nothing
// happens if the marker names another branch (the slot was taken by someone else meanwhile); then it returns false.
export function releaseWorktree({ base, worktree, branch }) {
  try {
    const m = readMarker(worktree);
    if (branch && m && m.branch !== branch) return false;
    if (fs.existsSync(worktree)) {
      git(worktree, 'reset', '--hard'); git(worktree, 'clean', '-fd');
      git(worktree, 'checkout', '--detach', base);
    }
    fs.rmSync(markerOf(worktree), { force: true });
    return true;
  } catch { return false; }
}

// Resizes the pool of one repo between `from` and `to` slots, only while every slot of it is free. Growing adds
// detached worktrees; shrinking removes just the removed slots, by exact `slot-<n>` name, and only if git lists the
// path as a worktree of this repo under `<repo>-worktrees/`.
export function resizePool({ top, from, to }) {
  const base = git(top, 'branch', '--show-current') || 'HEAD';
  if (slotOverview(top, Math.max(from, to, MAX_POOL_SIZE)).some((o) => o.busy)) throw new ValidationError('a worktree slot is busy; the slot count can only change while all slots are free');
  git(top, 'worktree', 'prune');
  const listed = () => git(top, 'worktree', 'list', '--porcelain').split('\n');
  for (let n = from + 1; n <= to; n++) {
    const worktree = slotDir(top, n);
    if (!fs.existsSync(worktree) && !listed().includes(`worktree ${worktree}`)) git(top, 'worktree', 'add', '--detach', worktree, base);
  }
  for (let n = to + 1; n <= Math.max(from, MAX_POOL_SIZE); n++) {
    const worktree = slotDir(top, n);
    if (path.dirname(worktree) !== `${top}-worktrees` || path.basename(worktree) !== `slot-${n}`) continue;
    if (listed().includes(`worktree ${worktree}`)) git(top, 'worktree', 'remove', '--force', worktree);
    fs.rmSync(markerOf(worktree), { force: true });
  }
}

// After a successful run: commit what the agent left, merge into the base branch, free the worktree slot.
// On any problem nothing stays half-merged and the worktree is kept. Returns { merged } or { merged: false, error }.
export function mergeWorktree({ top, base, branch, worktree }) {
  try {
    if (git(worktree, 'status', '--porcelain')) { git(worktree, 'add', '-A'); git(worktree, 'commit', '-m', `Implement ${branch}`); }
    if (!git(top, 'rev-list', `${base}..${branch}`)) return { merged: false, error: 'the agent made no commits' };
    if (git(top, 'branch', '--show-current') !== base) return { merged: false, error: `the main checkout is no longer on ${base}; merge ${branch} by hand` };
    const kept = `The branch ${branch} is complete and kept; the worktree is at ${worktree}.`;
    // uncommitted changes in the main checkout to files the branch also changes make git refuse the merge; that is not a conflict
    const changed = new Set(git(top, 'diff', '--name-only', `${base}...${branch}`).split('\n').filter(Boolean));
    const dirty = git(top, 'status', '--porcelain', '--untracked-files=no').split('\n').filter(Boolean)
      .map((l) => l.replace(/^\s*\S+\s+/, '').replace(/^.* -> /, '')).filter((f) => changed.has(f));
    if (dirty.length) return { merged: false, error: `not merged: the main checkout has uncommitted changes to ${dirty.join(', ')}, which ${branch} also changes. Nothing was merged. ${kept} Commit or stash those changes, then merge ${branch} by hand.` };
    try { git(top, 'merge', '--no-edit', branch); } catch (e) {
      let conflicts = [];
      try { conflicts = git(top, 'diff', '--name-only', '--diff-filter=U').split('\n').filter(Boolean); } catch { /* none to list */ }
      try { git(top, 'merge', '--abort'); } catch { /* nothing to abort */ }
      if (conflicts.length) return { merged: false, conflict: true, conflicts, error: `merge conflict in ${conflicts.join(', ')}: ${base} and ${branch} changed the same lines. Nothing was merged. ${kept} Resolve it by merging ${branch} by hand.` };
      return { merged: false, error: `the merge was refused: ${gitError(e)} Nothing was merged. ${kept}` };
    }
  } catch (e) { return { merged: false, error: gitError(e) }; }
  releaseWorktree({ base, worktree, branch });
  try { git(top, 'branch', '-d', branch); } catch { /* merged anyway; leftovers are harmless */ }
  return { merged: true };
}

// The prompt for the follow-up run that resolves a merge conflict in the main checkout (`top`).
export function mergeConflictPrompt({ ticketsDir, file, wt, conflicts = [] }) {
  const ticket = path.join(ticketsDir, file);
  return `Merging the branch ${wt.branch} into ${wt.base} in ${wt.top} stopped with a conflict (${conflicts.join(', ')}). The merge was aborted, so the checkout is clean. Nobody can answer questions during this run, so do not ask any.

1. In ${wt.top} run "git merge --no-edit ${wt.branch}" and look at the conflicts (git status, git diff). The ticket ${ticket} says what ${wt.branch} intended.
2. If the conflict is straightforward (both sides can simply be kept, or one side clearly supersedes the other; this is the case in 90+% of conflicts), resolve it by editing the conflicting files, run the tests if the repo has them, then git add the files and git commit to complete the merge.
3. If the conflict is not straightforward (you would have to guess what is intended), do not guess: run "git merge --abort", add a dated Note to the ticket ${ticket} that starts with "Blocked:" and explains the conflict, and set "status: blocked" in its frontmatter.
Do not push, do not switch branches, do not touch other files.`;
}

// Like implementRunOpts, but for the merge step: the main checkout is writable and git may merge there.
export function mergeRunOpts({ ticketsDir, projectDir }) {
  const o = implementRunOpts({ ticketsDir, projectDir: null });
  const rule = (tool) => `${tool}(/${projectDir}/**)`;
  return {
    ...o,
    allowedTools: [...o.allowedTools, rule('Edit'), rule('Write'), 'Bash(git merge:*)', 'Bash(git rm:*)', 'Bash(git show:*)', 'Bash(git checkout:*)'],
    addDirs: [...o.addDirs, projectDir],
  };
}

// After the conflict-resolving run: is the branch merged now? If so free the worktree; otherwise leave nothing half-merged.
export function completeMerge({ top, base, branch, worktree }) {
  let merged = false;
  try { git(top, 'merge-base', '--is-ancestor', branch, base); merged = true; } catch { /* not merged */ }
  if (!merged) { try { git(top, 'merge', '--abort'); } catch { /* no merge in progress */ } return { merged: false, error: `the conflict was not resolved by the agent; ${base} is unchanged, the branch ${branch} is kept` }; }
  releaseWorktree({ base, worktree, branch });
  try { git(top, 'branch', '-d', branch); } catch { /* merged anyway; leftovers are harmless */ }
  return { merged: true };
}
