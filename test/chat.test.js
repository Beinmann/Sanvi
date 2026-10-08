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

test('one run per chat, a global limit, cancel, and failures are shown', async () => {
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
  const on = createTicketServer({ dir, agents: true, agentRun: fakeRunner().run, chatsFile: null });
  try {
    for (const [app, expect] of [[off, 403], [on, 201]]) {
      const { port } = await app.listen(0);
      const base = `http://127.0.0.1:${port}`;
      assert.equal((await (await fetch(`${base}/api/agent`)).json()).enabled, expect === 201);
      const r = await fetch(`${base}/api/agent/chats`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      assert.equal(r.status, expect);
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
