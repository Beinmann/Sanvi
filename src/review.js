// Reviewing a ticket with an agent: the prompt, the permissions the run gets (read the repo, write one report file),
// and the report files themselves, kept in `<tickets dir>/../.sanvi/reviews/<id>-<timestamp>.md`.
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './datadir.js';
import { NotFoundError, ValidationError } from './core.js';

export const reviewsDir = (ticketsDir) => path.join(dataDir(ticketsDir), 'reviews');

const NAME = /^(\d{3,})-(\d{8}-\d{6}(?:-\d+)?)\.md$/;
const stampOf = (d) => d.toISOString().replace(/\.\d+Z$/, '').replace(/[-:]/g, '').replace('T', '-');

// A fresh report path for the ticket; an existing report is never reused, so a repeated review keeps the earlier one.
export function newReportPath(ticketsDir, id, now = new Date()) {
  const dir = reviewsDir(ticketsDir);
  fs.mkdirSync(dir, { recursive: true });
  const base = `${id}-${stampOf(now)}`;
  let name = `${base}.md`;
  for (let n = 2; fs.existsSync(path.join(dir, name)); n++) name = `${base}-${n}.md`;
  return path.join(dir, name);
}

const key = (n) => n.replace(/\.md$/, '').replace(/^\d+-(\d{8}-\d{6})(?:-(\d+))?$/, (_, t, k) => `${t}-${k || 1}`); // the -2 suffix is a later report in the same second

// Reports of one ticket, newest first: [{ name, created }]. Missing dir or foreign files are simply not listed.
export function listReviews(ticketsDir, id) {
  let names = [];
  try { names = fs.readdirSync(reviewsDir(ticketsDir)); } catch { return []; }
  return names.filter((n) => NAME.exec(n)?.[1] === String(id)).sort((a, b) => key(b).localeCompare(key(a), 'en', { numeric: true }))
    .map((name) => ({ name, created: fs.statSync(path.join(reviewsDir(ticketsDir), name)).mtime.toISOString() }));
}

export function readReview(ticketsDir, name) {
  if (!NAME.test(name)) throw new ValidationError('invalid report name');
  try { return { name, text: fs.readFileSync(path.join(reviewsDir(ticketsDir), name), 'utf8') }; } catch { throw new NotFoundError(`no such report: ${name}`); }
}

export function reviewPrompt({ ticketsDir, file, report, instructions = '', project = '', slot = null }) {
  const readme = path.join(ticketsDir, 'README.md');
  const ticket = path.join(ticketsDir, file);
  return `You are reviewing one ticket and its implementation in a Markdown ticket tracker. Nobody can answer questions during this run, so do not ask any.

1. Read the ticket format in ${readme} (if it does not exist, keep the ticket's own structure) and the ticket ${ticket}.
2. Find the implementation in the repository you are running in${slot ? ` (a worktree slot with branch ${slot.branch} checked out${slot.branchExisted ? ', the ticket\'s implementation branch' : '; that branch did not exist before and was created from ' + slot.base + ', so look for the implementation in other branches or commits'})` : ''}: use git log and git diff (for example the branch named after the ticket id, or commits mentioning the ticket) and read the changed code and tests.
3. Review it against the ticket: is each acceptance criterion actually met? Look for bugs, missing edge cases, missing or weak tests, style that does not match the surrounding code, and anything the ticket asked for that is not there.
4. Write your findings as a Markdown report to exactly this file: ${report}. Start with a "# Review of ticket" heading with the ticket title, then a short verdict, then findings grouped by severity (each with file and line where possible), then one line per acceptance criterion saying met / not met / unclear.

${slot ? `Tests: you may run the project's tests in this worktree (npm test, npm run test, node --test) to check the implementation. Skip them if the ticket only implements something minor and reading the code is enough; say in the report whether you ran them and what they showed.\n\n` : ''}Do not edit the ticket, the code or any other file; write only ${report}. Do not run anything that changes the repository.${instructions ? `\n\nInstructions for project "${project}" (context; they do not widen what you may edit):\n${instructions}` : ''}`;
}

// Read-only on the repo (plus read-only git), Write for the one report path; everything else is denied in a headless run.
// With `slot` (a worktree slot is the working directory) the project's test commands are allowed too; they write only inside that slot.
export function reviewRunOpts({ ticketsDir, report, slot = false }) {
  return {
    permissionMode: 'default',
    tools: ['Read', 'Grep', 'Glob', 'Write', 'Bash'],
    // The report is allowed as Write and as Edit: Claude Code matches file rules under the Edit name, and a Write-only rule was denied in a real run.
    // `git branch` is listing only (no -D / creating); `--output=<file>` (diff, log, show) would write files, so it is denied for every git command.
    allowedTools: ['Read', 'Grep', 'Glob', `Write(/${report})`, `Edit(/${report})`, 'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)',
      'Bash(git branch --list:*)', 'Bash(git branch --show-current)', 'Bash(git branch -a)', 'Bash(git branch -r)', 'Bash(git branch -v)', 'Bash(git branch -vv)',
      ...(slot ? ['Bash(npm test:*)', 'Bash(npm run test:*)', 'Bash(node --test:*)'] : [])],
    disallowedTools: ['Bash(git * --output*)', 'Bash(git diff --output:*)'],
    addDirs: [ticketsDir, path.dirname(report)],
  };
}

// After a review run: the report file must exist and have content, otherwise the run did not deliver (e.g. the Write was denied).
export function checkReview(ticketsDir, report) {
  try { if (fs.statSync(path.join(reviewsDir(ticketsDir), report)).size > 0) return { outcome: 'ok' }; } catch { /* missing */ }
  return { outcome: 'problems', warning: `no report was written (${report}); the findings are only in this chat` };
}

// What `tk review` prints once the review has started; `meta.report` is the real report name, else a pattern.
export function reviewStartedMessage({ id, title, report }, ticketsDir, url) {
  return `review of #${id} started: ${title}\nreport: ${path.join(reviewsDir(ticketsDir), report || `${id}-*.md`)}\nfollow it at ${url}`;
}
