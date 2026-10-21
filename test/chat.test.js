import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createChats } from '../src/chat.js';
import { startRun } from '../src/agent.js';
import { createTicketServer } from '../src/server.js';

// A runner whose runs finish when the test says so.
function fakeRunner() {
  const calls = [];
  const run = (opts) => {
    let listener = () => {}; let finish;
    const done = new Promise((r) => { finish = r; });
    const handle = {
      opts, onEvent: (fn) => { listener = fn; }, done,
      cancel: () => finish({ ok: false, cancelled: true, error: 'cancelled', sessionId: 's1' }),
      say: (text) => listener({ type: 'assistant', message: { content: [{ type: 'text', text }, { type: 'tool_use', name: 'Read' }] } }),
      end: (extra = {}) => finish({ ok: true, sessionId: 's1', text: '', costUsd: 0.01, ...extra }),
    };
    calls.push(handle);
    return handle;
  };
  return { run, calls };
}
const tick = () => new Promise((r) => setImmediate(r));

test('a message starts a run, resumes the session on the next one, and records the reply', async () => {
  const f = fakeRunner();
  const chats = createChats({ cwd: '/work', run: f.run });
  const c = chats.create();
  chats.send(c.id, 'hello there');
  assert.equal(chats.get(c.id).state, 'running');
  assert.equal(f.calls[0].opts.cwd, '/work');
  assert.equal(f.calls[0].opts.resume, null);
  f.calls[0].say('hi');
  f.calls[0].end(); await tick();
  const after = chats.get(c.id);
  assert.equal(after.state, 'idle');
  assert.equal(after.title, 'hello there');
  assert.deepEqual(after.messages.map((m) => m.text), ['hello there', 'hi']);
  assert.deepEqual(after.messages[1].tools, ['Read']);
  chats.send(c.id, 'again');
  assert.equal(f.calls[1].opts.resume, 's1');
  assert.equal(chats.get(c.id).costUsd, 0.01);
});

test('a normal chat runs in auto mode with Write; ask chats keep their own options', () => {
  const f = fakeRunner();
  const chats = createChats({ cwd: '/work', run: f.run });
  const c = chats.create();
  chats.send(c.id, 'hi');
  assert.equal(f.calls[0].opts.permissionMode, 'auto');
  assert.deepEqual(f.calls[0].opts.tools, ['Read', 'Grep', 'Glob', 'Edit', 'Write']);
  const a = chats.create({ kind: 'ask', runOpts: { permissionMode: 'default', tools: ['Read'] } });
  chats.send(a.id, 'q');
  assert.equal(f.calls[1].opts.permissionMode, 'default');
  assert.deepEqual(f.calls[1].opts.tools, ['Read']);
});

test('usage sums the cost of all chats under the claude provider', async () => {
  const f = fakeRunner();
  const chats = createChats({ cwd: '/work', run: f.run });
  assert.equal(chats.usage().claude.costUsd, 0);
  const a = chats.create(); const b = chats.create();
  chats.send(a.id, 'one'); f.calls[0].end(); await tick();
  chats.send(b.id, 'two'); f.calls[1].end(); await tick();
  assert.equal(chats.usage().claude.costUsd, 0.02);
  assert.equal(chats.usage().claude.chats, 2);
});

test('by default any number of chats run at once, none is queued or rejected', () => {
  const f = fakeRunner();
  const chats = createChats({ cwd: '/w', run: f.run });
  for (let i = 0; i < 8; i++) assert.equal(chats.send(chats.create().id, 'x').state, 'running');
  assert.equal(f.calls.length, 8);
});

test('one run per chat, an optional global limit, cancel, and failures are shown', async () => {
  const f = fakeRunner();
  const chats = createChats({ cwd: '/w', run: f.run, maxRuns: 2 });
  const [a, b, c] = [chats.create(), chats.create(), chats.create()];
  chats.send(a.id, 'x');
  assert.throws(() => chats.send(a.id, 'y'), /still answering/);
  chats.send(b.id, 'x');
  assert.throws(() => chats.send(c.id, 'x'), /too many/);
  assert.throws(() => chats.send(c.id, '  '), /empty/);
  chats.cancel(a.id); await tick();
  assert.equal(chats.get(a.id).state, 'idle');
  assert.match(chats.get(a.id).messages.at(-1).text, /\(stopped\)/);
  f.calls[1].end({ ok: false, error: 'boom' }); await tick();
  assert.equal(chats.get(b.id).state, 'failed');
  assert.equal(chats.get(b.id).error, 'boom');
  chats.send(c.id, 'now it fits');
});

test('missing claude binary gives a clear message instead of crashing', async () => {
  const r = startRun({ prompt: 'x', cwd: os.tmpdir(), bin: 'definitely-not-installed-claude' });
  const d = await r.done;
  assert.equal(d.ok, false);
  assert.match(d.error, /not found/);
});

test('a follow-up whose cwd no longer exists names the directory, not the claude binary', async () => {
  const gone = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tk-gone-')), 'removed-worktree');
  const d = await startRun({ prompt: 'x', cwd: gone, resume: 'old-session' }).done;
  assert.equal(d.ok, false);
  assert.match(d.error, /no longer exists/);
  assert.ok(d.error.includes(gone));
  assert.doesNotMatch(d.error, /not found/);
});

test('startRun parses stream-json from the CLI and passes resume', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-fake-'));
  const bin = path.join(dir, 'fake-claude');
  fs.writeFileSync(bin, `#!/usr/bin/env node
const a = process.argv.slice(2);
console.log(JSON.stringify({ type: 'assistant', session_id: 'abc', message: { content: [{ type: 'text', text: 'args:' + a.join(' ') }] } }));
console.log(JSON.stringify({ type: 'result', is_error: false, result: 'fin', total_cost_usd: 0.5, session_id: 'abc' }));
`, { mode: 0o755 });
  const r = startRun({ prompt: 'p', cwd: dir, resume: 'prev', bin });
  const seen = [];
  r.onEvent((e) => seen.push(e));
  const d = await r.done;
  assert.equal(d.ok, true);
  assert.equal(d.sessionId, 'abc');
  assert.equal(d.costUsd, 0.5);
  assert.match(seen[0].message.content[0].text, /--resume prev/);
  assert.match(seen[0].message.content[0].text, /--tools Read,Grep,Glob,Edit/);
});

test('agent routes are refused unless the server was started with agents', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-agent-'));
  const off = createTicketServer({ dir });
  const on = createTicketServer({ dir, agents: true, agentRun: fakeRunner().run, chatsFile: null, limitsProbe: async () => { throw new Error('offline'); } });
  try {
    for (const [app, expect] of [[off, 403], [on, 201]]) {
      const { port } = await app.listen(0);
      const base = `http://127.0.0.1:${port}`;
      assert.equal((await (await fetch(`${base}/api/agent`)).json()).enabled, expect === 201);
      const r = await fetch(`${base}/api/agent/chats`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(r.status, expect);
      const usage = await fetch(`${base}/api/agent/usage`);
      assert.equal(usage.status, expect === 201 ? 200 : 403);
      if (expect === 201) assert.equal((await usage.json()).claude.costUsd, 0);
      assert.equal((await fetch(`${base}/api/agent/limits`)).status, expect === 201 ? 200 : 403);
      const cross = await fetch(`${base}/api/agent/chats`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}' });
      assert.equal(cross.status, 403);
    }
  } finally { await off.close(); await on.close(); }
});

test('chats survive a restart; a run that was in flight is marked interrupted; delete works', async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tk-chats-')), 'sub', 'chats.json');
  const f = fakeRunner();
  const one = createChats({ cwd: '/w', file, run: f.run });
  const a = one.create();
  one.send(a.id, 'first question');
  f.calls[0].end(); await tick();
  const b = one.create();
  one.send(b.id, 'still running');

  const two = createChats({ cwd: '/w', file, run: f.run });
  assert.equal(two.list().length, 2);
  assert.equal(two.get(a.id).messages[0].text, 'first question');
  assert.equal(two.get(b.id).state, 'failed');
  assert.match(two.get(b.id).error, /restart/);
  two.send(a.id, 'continues');
  assert.equal(f.calls.at(-1).opts.resume, 's1');
  assert.throws(() => two.remove(a.id), /cancel/);
  two.remove(b.id);
  assert.equal(createChats({ cwd: '/w', file, run: f.run }).list().length, 1);
});

test('chat directory: default, from the project, explicit, validated, locked after the first message', async () => {
  const mk = (n) => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), `tk-${n}-`)));
  const [base, other] = [mk('base'), mk('other')];
  const f = fakeRunner();
  const infos = { web: { dir: other, instructions: 'Use tabs.' }, gone: { dir: path.join(base, 'missing'), instructions: '' } };
  const chats = createChats({ cwd: base, run: f.run, projectInfo: (n) => infos[n] || {} });

  assert.equal(chats.create().cwd, base);
  assert.equal(chats.create({ project: 'nope' }).cwd, base);
  assert.equal(chats.create({ project: 'web' }).cwd, other);
  assert.equal(chats.create({ project: 'web', dir: base }).cwd, base); // explicit wins
  const bad = chats.create({ project: 'gone' });
  assert.equal(bad.cwd, base); // a stored directory that does not exist here falls back, with a warning
  assert.match(bad.warning, /not found/);

  assert.throws(() => chats.create({ dir: 'relative/path' }), /absolute/);
  assert.throws(() => chats.create({ dir: path.join(base, 'missing') }), /not a directory/);
  const link = path.join(mk('lnk'), 'l');
  fs.symlinkSync(other, link);
  assert.equal(chats.create({ dir: link }).cwd, other); // resolved through symlinks

  const c = chats.create();
  chats.setCwd(c.id, other);
  chats.send(c.id, 'hi');
  assert.equal(f.calls.at(-1).opts.cwd, other);
  assert.throws(() => chats.setCwd(c.id, base), /cannot change/);

  const w = chats.create({ project: 'web' }); // the project's instructions travel with the first message only
  chats.send(w.id, 'first');
  assert.match(f.calls.at(-1).opts.prompt, /Instructions for project "web":\nUse tabs\.[\s\S]*first$/);
  f.calls.at(-1).end(); await tick();
  chats.send(w.id, 'second');
  assert.equal(f.calls.at(-1).opts.prompt, 'second');
});

async function refineSetup(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-out-'));
  for (const [n, status] of files) fs.writeFileSync(path.join(dir, n), `---\nstatus: ${status}\n---\n# T ${n}\n`);
  const f = fakeRunner();
  const app = createTicketServer({ dir, agents: true, agentRun: f.run, chatsFile: null });
  const { port } = await app.listen(0);
  const j = (m, p, b) => fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: { 'content-type': 'application/json' }, body: JSON.stringify(b ?? {}) });
  const list = async () => (await j('GET', '/api/agent/chats')).json().catch(() => []);
  return { dir, f, app, j, port, list: async () => (await fetch(`http://127.0.0.1:${port}/api/agent/chats`)).json() };
}

test('refine outcome: unchanged ticket is a problem, still-design means questions, opened is ok; denials warn', async () => {
  const s = await refineSetup([['001-a.md', 'design'], ['002-b.md', 'design'], ['003-c.md', 'design']]);
  try {
    for (const f of ['001-a.md', '002-b.md', 'x']) if (f !== 'x') assert.equal((await s.j('POST', '/api/agent/refine', { file: f })).status, 201);
    assert.equal((await s.j('POST', '/api/agent/refine', { file: '001-a.md' })).status, 400); // already being refined
    assert.equal((await s.j('POST', '/api/agent/refine', { file: 'nope.md' })).status, 404);
    fs.writeFileSync(path.join(s.dir, '002-b.md'), '---\nstatus: open\n---\n# T refined\n');
    s.f.calls[0].end(); s.f.calls[1].end({ denials: 2 }); await tick(); await tick();
    const by = Object.fromEntries((await s.list()).map((c) => [c.ticket, c.outcome]));
    assert.equal(by['001-a.md'], 'problems');
    assert.equal(by['002-b.md'], 'problems'); // changed and open, but 2 calls were refused
    const detail = await (await fetch(`http://127.0.0.1:${s.port}/api/agent/chats/${(await s.list()).find((c) => c.ticket === '002-b.md').id}`)).json();
    assert.match(detail.warning, /2 tool calls were refused/);
    fs.writeFileSync(path.join(s.dir, '003-c.md'), '---\nstatus: design\n---\n# T asks\n');
    assert.equal((await s.j('POST', '/api/agent/refine', { file: '003-c.md' })).status, 201);
    fs.writeFileSync(path.join(s.dir, '003-c.md'), '---\nstatus: design\n---\n# T asks more\n');
    s.f.calls[2].end(); await tick();
    assert.equal((await s.list()).find((c) => c.ticket === '003-c.md').outcome, 'questions');
    assert.equal((await s.j('POST', '/api/agent/refine', { file: '002-b.md' })).status, 201); // finished, so it may run again
  } finally { await s.app.close(); }
});

test('a chat started for a ticket is linked to it by id and project, and the link survives a restart', async () => {
  const s = await refineSetup([['001-a.md', 'design'], ['002-b.md', 'open']]);
  try {
    await s.j('POST', '/api/agent/refine', { file: '001-a.md' });
    const list = await s.list();
    assert.equal(list.length, 1);
    assert.equal(list[0].ticketId, '001');
    assert.equal(list[0].project, '');
  } finally { await s.app.close(); }

  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'tk-link-')), 'chats.json');
  const chats = createChats({ cwd: '/w', file, run: fakeRunner().run });
  const plain = chats.create();
  const linked = chats.create({ ticketId: 7, project: 'web' });
  const again = createChats({ cwd: '/w', file, run: fakeRunner().run }).list();
  assert.equal(again.find((c) => c.id === linked.id).ticketId, '7');
  assert.equal(again.find((c) => c.id === linked.id).project, 'web');
  assert.equal(again.find((c) => c.id === plain.id).ticketId, null);
});

test('refine-all starts every design ticket not already running', async () => {
  const s = await refineSetup([['001-a.md', 'design'], ['002-b.md', 'open'], ['003-c.md', 'design']]);
  try {
    await s.j('POST', '/api/agent/refine', { file: '001-a.md' });
    const r = await (await s.j('POST', '/api/agent/refine-all')).json();
    assert.deepEqual(r, { started: 1, skipped: 1 });
    assert.deepEqual((await s.list()).map((c) => c.ticket).sort(), ['001-a.md', '003-c.md']);
  } finally { await s.app.close(); }
});

test('ask: read-only tools, runs in the tickets dir, preamble only on the first message', async () => {
  const s = await refineSetup([['001-a.md', 'open']]);
  try {
    const chat = await (await s.j('POST', '/api/agent/ask', { question: 'what is open?' })).json();
    assert.equal(chat.kind, 'ask');
    assert.equal(chat.title, 'Ask: what is open?');
    const o = s.f.calls[0].opts;
    assert.equal(o.cwd, fs.realpathSync(s.dir));
    assert.deepEqual(o.tools, ['Read', 'Grep', 'Glob']);
    assert.ok(!o.allowedTools.some((t) => /Edit|Write|Bash/.test(t)));
    assert.ok(o.allowedTools.every((t) => /^(Read|Grep|Glob)\(\/\/.*\/\*\*\)$/.test(t))); // reads only inside the tickets dir (and the log dir)
    assert.match(o.prompt, /read-only[\s\S]*what is open\?$/);
    s.f.calls[0].end(); await tick();
    await s.j('POST', `/api/agent/chats/${chat.id}/messages`, { text: 'and blocked?' });
    assert.equal(s.f.calls[1].opts.prompt, 'and blocked?');
    const empty = await (await s.j('POST', '/api/agent/ask', {})).json(); // no question: an empty ask chat to type into
    assert.equal(empty.messages.length, 0);
  } finally { await s.app.close(); }
});

test('implement: runs in a worktree, merges into the base branch on success, keeps the worktree on failure', async () => {
  const { execFileSync } = await import('node:child_process');
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-impl-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 't@example.com'); g(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'init');
  const dir = path.join(repo, 'tickets');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '001-a.md'), '---\nstatus: open\n---\n# A\n');
  fs.mkdirSync(path.join(dir, '_projects'));
  fs.writeFileSync(path.join(dir, '_projects', '_default.md'), `---\nname: ""\ndir: ${repo}\n---\n`);
  fs.writeFileSync(path.join(dir, '002-b.md'), '---\nstatus: open\n---\n# B\n');
  const f = fakeRunner();
  const app = createTicketServer({ dir, agents: true, agentRun: f.run, chatsFile: null });
  const { port } = await app.listen(0);
  const post = (file) => fetch(`http://127.0.0.1:${port}/api/agent/implement`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ file }) });
  const chat = async (id) => (await fetch(`http://127.0.0.1:${port}/api/agent/chats/${id}`)).json();
  try {
    const c1 = await (await post('001-a.md')).json();
    const wt1 = f.calls[0].opts.cwd;
    assert.match(wt1, /ticket-001$/);
    assert.match(fs.readFileSync(path.join(dir, '001-a.md'), 'utf8'), /status: in-progress/, 'ticket goes in-progress on play');
    assert.match(f.calls[0].opts.prompt, /status: testing/);
    assert.ok(f.calls[0].opts.addDirs.includes(repo), 'notes repo readable');
    assert.ok(f.calls[0].opts.allowedTools.some((r) => r.startsWith('Write(') && r.includes(repo)), 'notes repo writable');
    assert.ok(dir.startsWith(repo), 'the ticket is under the writable notes repo');
    assert.deepEqual(f.calls[0].opts.disallowedTools, [], 'tickets inside the project checkout: no lock-out of the ticket');
    fs.writeFileSync(path.join(wt1, 'new.txt'), 'x\n'); // left uncommitted: the server commits it
    f.calls[0].end(); await tick();
    assert.equal((await chat(c1.id)).state, 'idle');
    assert.ok(fs.existsSync(path.join(repo, 'new.txt')), 'merged into main');
    assert.ok(!fs.existsSync(wt1), 'worktree removed');

    const c2 = await (await post('002-b.md')).json();
    const wt2 = f.calls[1].opts.cwd;
    fs.writeFileSync(path.join(wt2, 'other.txt'), 'y\n');
    f.calls[1].end({ ok: false, error: 'boom' }); await tick();
    const after = await chat(c2.id);
    assert.equal(after.state, 'failed');
    assert.ok(!fs.existsSync(path.join(repo, 'other.txt')), 'nothing merged');
    assert.ok(fs.existsSync(wt2), 'worktree kept');

    // conflict: the same file changed on main and in the worktree
    fs.writeFileSync(path.join(dir, '003-c.md'), '---\nstatus: open\n---\n# C\n');
    const c3 = await (await post('003-c.md')).json();
    const wt3 = f.calls[2].opts.cwd;
    fs.writeFileSync(path.join(wt3, 'a.txt'), 'from agent\n');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'from main\n'); g(repo, 'commit', '-qam', 'main change');
    f.calls[2].end(); await tick(); await tick();
    assert.equal((await chat(c3.id)).state, 'running', 'the agent is called again for the conflict');
    assert.equal(f.calls[3].opts.cwd, repo);
    assert.match(f.calls[3].opts.prompt, /git merge --no-edit ticket-/);
    f.calls[3].end(); await tick(); await tick(); // it resolved nothing and aborted nothing
    const conflict = await chat(c3.id);
    assert.equal(conflict.state, 'failed');
    assert.match(conflict.error, /Nothing was merged/);
    assert.equal(g(repo, 'status', '--porcelain', '--untracked-files=no'), ''); // no half-merge left behind
    assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'from main\n');

    // conflict the agent resolves: merge, fix, commit
    fs.writeFileSync(path.join(dir, '004-d.md'), '---\nstatus: open\n---\n# D\n');
    const c4 = await (await post('004-d.md')).json();
    const wt4 = f.calls[4].opts.cwd;
    fs.writeFileSync(path.join(wt4, 'a.txt'), 'from agent 2\n');
    fs.writeFileSync(path.join(repo, 'a.txt'), 'from main 2\n'); g(repo, 'commit', '-qam', 'main change 2');
    f.calls[4].end(); await tick(); await tick();
    try { g(repo, 'merge', '--no-edit', 'ticket-004'); } catch { /* conflict expected */ }
    fs.writeFileSync(path.join(repo, 'a.txt'), 'both\n'); g(repo, 'add', 'a.txt'); g(repo, 'commit', '-q', '--no-edit');
    f.calls[5].end(); await tick(); await tick();
    const resolved = await chat(c4.id);
    assert.equal(resolved.state, 'idle');
    assert.ok(!fs.existsSync(wt4), 'worktree removed');
    assert.equal(fs.readFileSync(path.join(repo, 'a.txt'), 'utf8'), 'both\n');
  } finally { await app.close(); }
});

test('implement while refining is queued and starts after a clean refine; dropped otherwise', async () => {
  const { execFileSync } = await import('node:child_process');
  const g = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8' }).trim();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-implq-'));
  const repo = path.join(root, 'repo');
  fs.mkdirSync(repo);
  g(repo, 'init', '-q', '-b', 'main');
  g(repo, 'config', 'user.email', 't@example.com'); g(repo, 'config', 'user.name', 't');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'a\n');
  g(repo, 'add', '-A'); g(repo, 'commit', '-qm', 'init');
  const dir = path.join(repo, 'tickets');
  fs.mkdirSync(path.join(dir, '_projects'), { recursive: true });
  fs.writeFileSync(path.join(dir, '_projects', '_default.md'), `---\nname: ""\ndir: ${repo}\n---\n`);
  fs.writeFileSync(path.join(dir, '001-a.md'), '---\nstatus: design\n---\n# A\n');
  fs.writeFileSync(path.join(dir, '002-b.md'), '---\nstatus: design\n---\n# B\n');
  const f = fakeRunner();
  const app = createTicketServer({ dir, agents: true, agentRun: f.run, chatsFile: null });
  const { port } = await app.listen(0);
  const post = (url, body) => fetch(`http://127.0.0.1:${port}/api/agent/${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  try {
    await post('refine', { file: '001-a.md' });
    const q = await (await post('implement', { file: '001-a.md' })).json();
    assert.equal(q.queued, true);
    assert.equal(f.calls.length, 1, 'no implement run yet');
    fs.writeFileSync(path.join(dir, '001-a.md'), '---\nstatus: open\n---\n# A\nrefined\n');
    f.calls[0].end(); await tick();
    assert.equal(f.calls.length, 2, 'implement started after the refine');
    assert.match(f.calls[1].opts.cwd, /ticket-001$/);

    // a refine that fails drops the queued implementation
    await post('refine', { file: '002-b.md' });
    assert.equal((await (await post('implement', { file: '002-b.md' })).json()).queued, true);
    f.calls[2].say('partial'); f.calls[2].end({ ok: false, error: 'boom' }); await tick(); // output so far: no fresh-session retry
    assert.equal(f.calls.length, 3, 'no implement run after a failed refine');
  } finally { await app.close(); }
});

test('implement needs a project directory', async () => {
  const s = await refineSetup([['001-a.md', 'open']]);
  try {
    const r = await s.j('POST', '/api/agent/implement', { file: '001-a.md' });
    assert.equal(r.status, 400);
    assert.match((await r.json()).error, /has no directory/);
  } finally { await s.app.close(); }
});

test('implement permissions: main checkout off limits unless the tickets live inside it', async () => {
  const { implementRunOpts } = await import('../src/implement.js');
  const { execFileSync } = await import('node:child_process');
  const notes = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tk-notes-')));
  execFileSync('git', ['init', '-q'], { cwd: notes });
  fs.mkdirSync(path.join(notes, 'tickets')); fs.mkdirSync(path.join(notes, 'code'));
  const o = implementRunOpts({ ticketsDir: path.join(notes, 'tickets'), projectDir: path.join(notes, 'code') });
  assert.ok(o.allowedTools.includes(`Edit(/${notes}/**)`));
  assert.deepEqual(o.disallowedTools, [`Edit(/${notes}/code/**)`, `Write(/${notes}/code/**)`]);
  assert.deepEqual(o.addDirs, [notes]);
  assert.equal(o.permissionMode, 'auto');
});

// Session reuse for refine/implement runs
const usage = (n) => ({ type: 'assistant', message: { content: [], usage: { input_tokens: n, cache_read_input_tokens: 0, output_tokens: 0 } } });
async function runOne(chats, f, kind, { sid, tokens = 1000, fail = false, cwd = '/work' } = {}) {
  const c = chats.create({ kind, dir: undefined });
  chats.get(c.id); // exists
  chats.send(c.id, 'go');
  const h = f.calls.at(-1);
  if (tokens) h.emitUsage(tokens);
  if (fail) h.end({ ok: false, error: 'No conversation found', sessionId: null }); else h.end({ sessionId: sid });
  await tick();
  return h;
}
function usageRunner() {
  const f = fakeRunner();
  const run = (opts) => { const h = f.run(opts); let l; const on = h.onEvent; h.onEvent = (fn) => { l = fn; on(fn); }; h.emitUsage = (n) => l(usage(n)); return h; };
  return { ...f, run };
}

test('refine runs resume the previous session until it reaches the token threshold', async () => {
  const f = usageRunner();
  const chats = createChats({ cwd: '/work', run: f.run, sessionReuse: { enabled: true, maxTokens: 70000 } });
  await runOne(chats, f, 'refine', { sid: 'a', tokens: 50000 });
  assert.equal(f.calls[0].opts.resume, null);
  await runOne(chats, f, 'refine', { sid: 'a', tokens: 80000 });
  assert.equal(f.calls[1].opts.resume, 'a');
  await runOne(chats, f, 'refine', { sid: 'b' });
  assert.equal(f.calls[2].opts.resume, null); // 80k >= 70k: new session
  await runOne(chats, f, 'refine', { sid: 'b' });
  assert.equal(f.calls[3].opts.resume, 'b');
  await runOne(chats, f, 'implement', { sid: 'c' });
  assert.equal(f.calls[4].opts.resume, null); // other kind: separate session
});

test('session reuse can be switched off, and plain chats never share a session', async () => {
  const f = usageRunner();
  const off = createChats({ cwd: '/work', run: f.run, sessionReuse: { enabled: false, maxTokens: 70000 } });
  await runOne(off, f, 'refine', { sid: 'a' });
  await runOne(off, f, 'refine', { sid: 'a' });
  assert.equal(f.calls[1].opts.resume, null);
  const on = createChats({ cwd: '/work', run: f.run, sessionReuse: { enabled: true, maxTokens: 70000 } });
  await runOne(on, f, 'chat', { sid: 'x' });
  await runOne(on, f, 'chat', { sid: 'x' });
  assert.equal(f.calls[3].opts.resume, null);
});

test('a missing session falls back to a fresh one without failing the run', async () => {
  const f = usageRunner();
  const chats = createChats({ cwd: '/work', run: f.run, sessionReuse: { enabled: true, maxTokens: 70000 } });
  await runOne(chats, f, 'refine', { sid: 'gone' });
  const c = chats.create({ kind: 'refine' });
  chats.send(c.id, 'go');
  assert.equal(f.calls[1].opts.resume, 'gone');
  f.calls[1].end({ ok: false, error: 'No conversation found', sessionId: 'gone' }); await tick();
  assert.equal(f.calls.length, 3);
  assert.equal(f.calls[2].opts.resume, null);
  assert.equal(chats.get(c.id).state, 'running');
  f.calls[2].end({ sessionId: 'new' }); await tick();
  assert.equal(chats.get(c.id).state, 'idle');
  await runOne(chats, f, 'refine', { sid: 'new' });
  assert.equal(f.calls[3].opts.resume, 'new');
});
