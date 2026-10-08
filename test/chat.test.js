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
