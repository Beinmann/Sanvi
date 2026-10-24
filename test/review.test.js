import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newReportPath, listReviews, readReview, reviewPrompt, reviewRunOpts, reviewStartedMessage } from '../src/review.js';
import { createTicketServer } from '../src/server.js';
import { execFileSync } from 'node:child_process';

const TK = path.resolve(import.meta.dirname, '../bin/tk.js');

const setup = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-review-'));
  const dir = path.join(root, 'tickets');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '001-a.md'), '---\nstatus: testing\n---\n# A\n');
  return dir;
};

test('report paths carry the ticket id and a repeated review gets a new file', () => {
  const dir = setup();
  const now = new Date('2026-01-02T03:04:05Z');
  const a = newReportPath(dir, '001', now);
  fs.writeFileSync(a, '# one');
  const b = newReportPath(dir, '001', now);
  assert.match(path.basename(a), /^001-20260102-030405\.md$/);
  assert.notEqual(a, b);
  fs.writeFileSync(b, '# two');
  fs.writeFileSync(path.join(path.dirname(a), '0010-20260102-030405.md'), 'other ticket');
  assert.deepEqual(listReviews(dir, '001').map((r) => r.name), [path.basename(b), path.basename(a)]);
  assert.equal(readReview(dir, path.basename(a)).text, '# one');
  assert.throws(() => readReview(dir, '../x.md'), /invalid/);
  assert.deepEqual(listReviews(dir, '002'), []);
});

test('review prompt names the report and the run may write only that file', () => {
  const p = reviewPrompt({ ticketsDir: '/t', file: '001-a.md', report: '/r/001-x.md' });
  assert.match(p, /\/r\/001-x\.md/);
  assert.match(p, /acceptance criterion/);
  const o = reviewRunOpts({ ticketsDir: '/t', report: '/r/001-x.md' });
  assert.ok(o.allowedTools.includes('Write(//r/001-x.md)'));
  assert.ok(!o.allowedTools.includes('Edit'));
});

test('review endpoint starts a review chat; reports are listed and served read-only', async () => {
  const dir = setup();
  const calls = [];
  const run = (opts) => { calls.push(opts); return { onEvent() {}, done: new Promise(() => {}), cancel() {} }; };
  const app = createTicketServer({ dir, agents: true, agentRun: run, chatsFile: null });
  const { port } = await app.listen(0);
  const j = (m, p, b) => fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: { 'content-type': 'application/json' }, body: m === 'GET' ? undefined : JSON.stringify(b ?? {}) });
  try {
    assert.deepEqual(await (await j('GET', '/api/reviews?id=001')).json(), []);
    const r = await j('POST', '/api/agent/review', { file: '001-a.md' });
    assert.equal(r.status, 201);
    assert.equal((await r.json()).kind, 'review');
    assert.match(calls[0].prompt, /reviews\/001-\d{8}-\d{6}\.md/);
    assert.equal((await j('POST', '/api/agent/review', { file: '001-a.md' })).status, 400); // still running
    assert.equal((await j('POST', '/api/agent/review', { file: 'nope.md' })).status, 404);
    fs.writeFileSync(path.join(dir, '..', '.sanvi', 'reviews', '001-20260101-000000.md'), '# done');
    const list = await (await j('GET', '/api/reviews?id=001')).json();
    assert.equal(list.length, 1);
    assert.equal((await (await j('GET', `/api/reviews/${list[0].name}`)).json()).text, '# done');
    assert.equal((await j('GET', '/api/reviews/..%2Fx.md')).status, 400);
  } finally { await app.close(); }
  const off = createTicketServer({ dir, chatsFile: null });
  const p2 = (await off.listen(0)).port;
  try {
    const r = await fetch(`http://127.0.0.1:${p2}/api/agent/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"file":"001-a.md"}' });
    assert.equal(r.status, 403);
  } finally { await off.close(); }
});

test('review run: report writable as Write and Edit, git is read-only in fact', () => {
  const o = reviewRunOpts({ ticketsDir: '/t', report: '/r/001-x.md' });
  assert.ok(o.allowedTools.includes('Edit(//r/001-x.md)'));
  assert.ok(!o.allowedTools.some((r) => /^Bash\(git branch:/.test(r)), 'no prefix rule that allows branch -D or creating branches');
  assert.ok(o.allowedTools.includes('Bash(git branch --list:*)'));
  assert.ok(o.disallowedTools.includes('Bash(git * --output*)'));
  assert.ok(!o.allowedTools.some((r) => /^Bash\((?!git (status|diff|log|show|branch))/.test(r)), 'only read-only git commands');
});

test('review started message names the real report, else the pattern', () => {
  const m = reviewStartedMessage({ id: '001', title: 'T', report: '001-20260101-000000.md' }, '/x/tickets', 'http://h');
  assert.match(m, /review of #001 started: T/);
  assert.match(m, /reviews\/001-20260101-000000\.md/);
  assert.match(reviewStartedMessage({ id: '001', title: 'T' }, '/x/tickets', 'http://h'), /reviews\/001-\*\.md/);
});

test('tk review says what is missing: no instance, or agents off', () => {
  const dir = setup();
  const env = { ...process.env, TK_STATE_DIR: path.join(path.dirname(dir), 'state') };
  const tk = (...a) => { try { return execFileSync(process.execPath, [TK, '--dir', dir, ...a], { env, encoding: 'utf8', stdio: 'pipe' }); } catch (e) { return `${e.stdout}${e.stderr}`; } };
  try {
    assert.match(tk('review', '001'), /no running instance.*--agents/);
    tk('start', '--port', '0');
    assert.match(tk('review', '001'), /agent features off.*--agents/);
    assert.match(tk('review'), /usage: tk review/);
  } finally { tk('stop'); }
});

test('review run with a slot may also run the tests, with the other deny rules intact', () => {
  const plain = reviewRunOpts({ ticketsDir: '/t', report: '/r/001-x.md' });
  assert.ok(!plain.allowedTools.some((r) => /npm|node --test/.test(r)));
  const o = reviewRunOpts({ ticketsDir: '/t', report: '/r/001-x.md', slot: true });
  for (const r of ['Bash(npm test:*)', 'Bash(npm run test:*)', 'Bash(node --test:*)']) assert.ok(o.allowedTools.includes(r), r);
  assert.ok(o.disallowedTools.includes('Bash(git * --output*)'));
  assert.ok(!o.allowedTools.some((r) => /^(Write|Edit)\(/.test(r) && !r.includes('001-x.md')), 'writes only the report');
  assert.ok(!o.allowedTools.includes('Bash'));
  const p = reviewPrompt({ ticketsDir: '/t', file: '001-a.md', report: '/r/001-x.md', slot: { branch: 'ticket-001', base: 'main', branchExisted: true } });
  assert.match(p, /ticket-001/);
  assert.match(p, /may run the project's tests/);
  assert.match(p, /Skip them if the ticket only implements something minor/);
  assert.doesNotMatch(reviewPrompt({ ticketsDir: '/t', file: '001-a.md', report: '/r/001-x.md' }), /may run the project's tests/);
});

test('a review takes a worktree slot while it runs, shows it busy, and gives it back afterwards', async () => {
  const dir = setup();
  const repo = path.join(path.dirname(dir), 'repo');
  fs.mkdirSync(repo);
  const git = (...a) => execFileSync('git', ['-C', repo, '-c', 'user.name=t', '-c', 'user.email=t@example.com', ...a], { encoding: 'utf8' }).trim();
  git('init', '-q', '-b', 'main'); git('commit', '-q', '--allow-empty', '-m', 'init');
  fs.mkdirSync(path.join(dir, '_projects'));
  fs.writeFileSync(path.join(dir, '_projects', '_default.md'), `---\nname: ""\ndir: ${repo}\n---\n`);
  const calls = [];
  let finish;
  const run = (opts) => { calls.push(opts); return { onEvent() {}, done: new Promise((r) => { finish = r; }), cancel() {} }; };
  const app = createTicketServer({ dir, agents: true, agentRun: run, chatsFile: null });
  const { port } = await app.listen(0);
  const j = (m, p, b) => fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: { 'content-type': 'application/json' }, body: m === 'GET' ? undefined : JSON.stringify(b ?? {}) });
  const busy = async () => (await (await j('GET', '/api/agent/slots')).json()).repos[0].slots.filter((s) => s.busy);
  try {
    const chat = await (await j('POST', '/api/agent/review', { file: '001-a.md' })).json();
    const slot = `${repo}-worktrees/slot-1`;
    assert.equal(calls[0].cwd, slot);
    assert.ok(calls[0].allowedTools.includes('Bash(npm test:*)'));
    assert.equal(git('-C', slot, 'branch', '--show-current'), 'ticket-001');
    const b = await busy();
    assert.equal(b.length, 1);
    assert.equal(b[0].chat, 'running');
    assert.equal(b[0].chatId, chat.id);
    finish({ ok: true, text: 'done' });
    await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual(await busy(), []);
    assert.equal(git('-C', slot, 'branch', '--show-current'), '', 'slot is detached again');
    assert.equal(git('branch', '--list', 'ticket-001'), '', 'the branch the review had to create is dropped again');
  } finally { await app.close(); }
});
