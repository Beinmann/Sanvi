import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createTicketServer } from '../src/server.js';
import { createTerminals, tmuxSessionName } from '../src/terminal.js';

const hasPython = spawnSync('python3', ['-V']).status === 0;
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Reads the SSE stream of a terminal until `until(text)` holds (or the stream ends).
async function readStream(base, id, until) {
  const ctl = new AbortController();
  const res = await fetch(`${base}/api/agent/terminals/${id}/stream`, { signal: ctl.signal });
  const dec = new TextDecoder();
  let buf = ''; let text = ''; let exit = null;
  try {
    for await (const chunk of res.body) {
      buf += dec.decode(chunk, { stream: true });
      let i;
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2);
        const ev = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (ev === 'exit') exit = Number(data);
        else if (data) text += Buffer.from(data, 'base64').toString();
      }
      if (exit !== null || until(text)) break;
    }
  } finally { ctl.abort(); }
  return { text, exit };
}

test('terminal API needs --terminal (not --agents); with it a shell command runs on a pty, takes input and resize, and ends with stop', { skip: !hasPython }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-term-'));
  const off = createTicketServer({ dir, agents: true, agentRun: () => {}, chatsFile: null });
  const on = createTicketServer({ dir, terminal: true, shellCommand: ['sh', '-c', 'echo cwd=$(pwd); [ -t 0 ] && echo tty; stty size; read x; echo got:$x; sleep 30'] });
  try {
    const offBase = `http://127.0.0.1:${(await off.listen(0)).port}`;
    const base = `http://127.0.0.1:${(await on.listen(0)).port}`;
    assert.equal((await fetch(`${offBase}/api/agent/terminals`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status, 403);
    const cwd = fs.realpathSync(dir);
    const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    const made = await post('/api/agent/terminals', { dir: cwd, cols: 90, rows: 20 });
    assert.equal(made.status, 201);
    const t = await made.json();
    const first = await readStream(base, t.id, (x) => x.includes('20 90'));
    assert.match(first.text, new RegExp(`cwd=${cwd}`));
    assert.match(first.text, /tty/);
    assert.match(first.text, /20 90/);
    assert.equal((await post(`/api/agent/terminals/${t.id}/input`, { data: 'hello\n' })).status, 200);
    const second = await readStream(base, t.id, (x) => x.includes('got:hello')); // replays the output kept so far
    assert.match(second.text, /got:hello/);
    assert.equal((await post(`/api/agent/terminals/${t.id}/resize`, { cols: 0, rows: 5 })).status, 400);
    assert.equal((await post(`/api/agent/terminals/${t.id}/stop`, {})).status, 200);
    assert.equal((await post(`/api/agent/terminals/${t.id}/input`, { data: 'x' })).status, 400);
    assert.equal((await post('/api/agent/terminals', { dir: path.join(cwd, 'missing') })).status, 400);
  } finally { await off.close(); await on.close(); }
});

test('terminals: the prompt is the last argument, a finished command reports its exit, and no process is left behind', { skip: !hasPython }, async () => {
  const term = createTerminals({ command: ['sh', '-c', 'echo "args:$1"; echo $$ > pid.txt; sleep 30', 'sh'] });
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tk-term-')));
  const done = createTerminals({ command: ['sh', '-c', 'exit 3'] });
  try {
    const t = term.start({ cwd, prompt: 'do the thing' });
    for (let i = 0; i < 100 && !fs.existsSync(path.join(cwd, 'pid.txt')); i++) await new Promise((r) => setTimeout(r, 50));
    const pid = Number(fs.readFileSync(path.join(cwd, 'pid.txt'), 'utf8'));
    assert.ok(alive(pid));
    term.stop(t.id); // closing the view
    for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(!alive(pid), 'the command is gone after stop');
    assert.throws(() => term.start({}), /directory/);
    const d = done.start({ cwd });
    for (let i = 0; i < 100 && done.get(d.id).state === 'running'; i++) await new Promise((r) => setTimeout(r, 50));
    assert.deepEqual([done.get(d.id).state, done.get(d.id).exitCode], ['exited', 3]);
  } finally { term.stopAll(); done.stopAll(); }
});

test('a command that exits leaves no background job (even one ignoring SIGHUP) behind', { skip: !hasPython }, async () => {
  const term = createTerminals({ command: ['sh', '-c', 'nohup sleep 60 >/dev/null 2>&1 & echo $! > pid.txt; sleep 1'] });
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tk-term-')));
  try {
    const t = term.start({ cwd });
    for (let i = 0; i < 100 && !fs.existsSync(path.join(cwd, 'pid.txt')); i++) await new Promise((r) => setTimeout(r, 50));
    const pid = Number(fs.readFileSync(path.join(cwd, 'pid.txt'), 'utf8'));
    for (let i = 0; i < 100 && term.get(t.id).state === 'running'; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(term.get(t.id).state, 'exited');
    for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(!alive(pid), 'the background job is gone once the command ended');
  } finally { term.stopAll(); }
});

test('a command that exits ends the session even if a leftover job keeps writing to the terminal (also one in its own session)', { skip: !hasPython }, async () => {
  const script = '(while true; do echo x; sleep 0.05; done) & echo $! > pid.txt; '
    + '(setsid sh -c \'for i in $(seq 200); do echo y; sleep 0.05; done\' >/dev/null 2>&1 &) ; sleep 1';
  const term = createTerminals({ command: ['sh', '-c', script] });
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tk-term-')));
  try {
    const t = term.start({ cwd });
    for (let i = 0; i < 100 && !fs.existsSync(path.join(cwd, 'pid.txt')); i++) await new Promise((r) => setTimeout(r, 50));
    const pid = Number(fs.readFileSync(path.join(cwd, 'pid.txt'), 'utf8'));
    for (let i = 0; i < 100 && term.get(t.id).state === 'running'; i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(term.get(t.id).state, 'exited');
    for (let i = 0; i < 100 && alive(pid); i++) await new Promise((r) => setTimeout(r, 50));
    assert.ok(!alive(pid), 'the chatty background job is gone');
  } finally { term.stopAll(); }
});

test('a terminal nobody watches keeps running by default', { skip: !hasPython }, async () => {
  const term = createTerminals({ command: ['sh', '-c', 'sleep 30'] });
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tk-term-')));
  try {
    const t = term.start({ cwd });
    await new Promise((r) => setTimeout(r, 400));
    assert.deepEqual(term.list().map((x) => x.id), [t.id]);
  } finally { term.stopAll(); }
});

test('with idleMs set, a terminal nobody watches is ended after the idle time', { skip: !hasPython }, async () => {
  const term = createTerminals({ command: ['sh', '-c', 'sleep 30'], idleMs: 200 });
  const cwd = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tk-term-')));
  try {
    const t = term.start({ cwd });
    await new Promise((r) => setTimeout(r, 600));
    assert.deepEqual(term.list(), []);
    assert.throws(() => term.get(t.id), /no such terminal/);
  } finally { term.stopAll(); }
});

test('--terminal alone: shell sessions work, ticket sessions (agents) and the agent API stay off', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-term-'));
  const app = createTicketServer({ dir, terminal: true });
  try {
    const base = `http://127.0.0.1:${(await app.listen(0)).port}`;
    const info = await (await fetch(`${base}/api/agent`)).json();
    assert.deepEqual([info.enabled, info.terminal], [false, true]);
    assert.equal((await fetch(`${base}/api/agent/terminals`)).status, 200);
    const ticket = await fetch(`${base}/api/agent/terminals/ticket`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"file":"x.md"}' });
    assert.equal(ticket.status, 403);
    assert.equal((await fetch(`${base}/api/agent/usage`)).status, 403);
  } finally { await app.close(); }
});

test('the vendored terminal front end is served with a module type', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-term-'));
  const app = createTicketServer({ dir });
  try {
    const base = `http://127.0.0.1:${(await app.listen(0)).port}`;
    for (const [f, type] of [['xterm.mjs', /javascript/], ['addon-fit.mjs', /javascript/], ['xterm.css', /css/], ['terminal.js', /javascript/]]) {
      const r = await fetch(`${base}/${f}`);
      assert.equal(r.status, 200, f);
      assert.match(r.headers.get('content-type'), type);
    }
  } finally { await app.close(); }
});

test('ticket sessions: started in the project dir in auto mode with the ticket as context only (no prompt), reused, switchable, and gone when ended or closed', { skip: !hasPython }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-term-'));
  fs.writeFileSync(path.join(dir, '001-one.md'), '---\nstatus: open\n---\n\n# One\n\n## Problem / motivation\n\nx\n');
  fs.writeFileSync(path.join(dir, '002-two.md'), '---\nstatus: open\n---\n\n# Two\n\n## Problem / motivation\n\ny\n');
  // a fake `claude`: prints its working dir and arguments, then ends when told to
  const fake = ['sh', '-c', 'echo "cwd=$(pwd)"; echo "args:$*"; read x; [ "$x" = bye ] && exit 4; sleep 30', 'claude'];
  const app = createTicketServer({ dir, agents: true, terminal: true, agentRun: () => {}, chatsFile: null, terminalCommand: fake });
  try {
    const base = `http://127.0.0.1:${(await app.listen(0)).port}`;
    const post = (p, b) => fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
    const list = async () => (await fetch(`${base}/api/agent/terminals`)).json();

    const a = await post('/api/agent/terminals/ticket', { file: '001-one.md' });
    assert.equal(a.status, 201);
    const ta = await a.json();
    assert.equal(ta.ticket, '001-one.md');
    const out = await readStream(base, ta.id, (x) => x.includes('args:'));
    assert.match(out.text, /args:--permission-mode auto --append-system-prompt This session was opened from ticket #001 "One" \(.*001-one\.md\)\. Do not start working/);
    assert.ok(!/Do not start working[^\r\n]*\r\n[^\r\n]/.test(out.text.replace(/\r\n$/, '')), 'no further (prompt) argument after the context');
    assert.ok(!out.text.includes('bypassPermissions'));

    const again = await post('/api/agent/terminals/ticket', { file: '001-one.md' }); // the hotkey again: same session
    assert.equal(again.status, 200);
    assert.deepEqual([(await again.json()).id, (await list()).length], [ta.id, 1]);
    assert.equal((await post('/api/agent/terminals/ticket', { file: 'missing.md' })).status, 404);

    const tb = await (await post('/api/agent/terminals/ticket', { file: '002-two.md' })).json(); // a second one runs alongside
    assert.notEqual(tb.id, ta.id);
    assert.deepEqual((await list()).map((t) => t.ticket).sort(), ['001-one.md', '002-two.md']);
    assert.equal((await post(`/api/agent/terminals/${ta.id}/input`, { data: 'x\n' })).status, 200); // each takes input while the other exists
    assert.equal((await post(`/api/agent/terminals/${tb.id}/input`, { data: 'bye\n' })).status, 200);

    const ended = await readStream(base, tb.id, () => false); // the process ends: exit event, no longer listed
    assert.equal(ended.exit, 4);
    assert.deepEqual((await list()).map((t) => t.id), [ta.id]);

    const fresh = await (await post('/api/agent/terminals/ticket', { file: '002-two.md' })).json(); // hotkey after the end: a new one
    assert.notEqual(fresh.id, tb.id);

    assert.equal((await fetch(`${base}/api/agent/terminals/${ta.id}`, { method: 'DELETE', headers: { 'content-type': 'application/json' } })).status, 200); // closing a tab
    assert.deepEqual((await list()).map((t) => t.id), [fresh.id]);
    assert.equal((await fetch(`${base}/api/agent/terminals/${ta.id}/stream`)).status, 400);
  } finally { await app.close(); }
});

test('ticket sessions run in an interactive shell: Ctrl+Z gives a prompt in the same session, fg resumes, a normal end exits', { skip: !hasPython }, async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-term-'));
  const term = createTerminals({ command: ['sh', '-c', 'echo started; read x; echo got:$x; exit 5', 'claude'], shell: ['bash', '--norc', '--noprofile'] });
  const base = { cwd: dir, cols: 80, rows: 24 };
  const t = term.start({ ...base, inShell: true });
  try {
    let text = '';
    term.watch(t.id, { on() {} }, { writeHead() {}, end() {}, write(x) { const m = /^data: (.*)$/m.exec(x); if (m && !x.startsWith('event')) text += Buffer.from(m[1], 'base64').toString(); } });
    const send = (data) => term.input(t.id, data);
    const wait = async (re, ms = 5000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) {
        if (re.test(text)) return text;
        await new Promise((r) => setTimeout(r, 50));
      }
      throw new Error(`timed out waiting for ${re}`);
    };
    await wait(/started/);
    const clear = text.lastIndexOf('\x1b[2J');
    assert.ok(clear >= 0 && text.indexOf('Starting...', clear) > clear, 'the screen is cleared and shows Starting... after the echoed launch line');
    assert.ok(text.indexOf('started') > text.indexOf('Starting...'), 'the command output comes after the indicator');
    send('\x1a'); // Ctrl+Z
    await wait(/Stopped|stopped/);
    send('echo shell-works:$(pwd)\n');
    await wait(new RegExp(`shell-works:${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`));
    send('fg\n');
    await new Promise((r) => setTimeout(r, 300));
    send('hello\n');
    await wait(/got:hello/);
  } finally { term.stopAll(); }
});

test('Tab and Shift+Tab bytes reach the command on the pty unchanged (completion is up to the shell)', { skip: !hasPython }, async () => {
  const term = createTerminals({ command: ['sh', '-c', 'stty raw -echo; echo ready; dd bs=1 count=4 2>/dev/null | od -An -tx1; sleep 30'] });
  const t = term.start({ cwd: os.tmpdir() });
  try {
    let text = '';
    term.watch(t.id, { on() {} }, { writeHead() {}, end() {}, write(x) { const m = /^data: (.*)$/m.exec(x); if (m && !x.startsWith('event')) text += Buffer.from(m[1], 'base64').toString(); } });
    for (let i = 0; i < 100 && !text.includes('ready'); i++) await new Promise((r) => setTimeout(r, 50));
    term.input(t.id, '\t\x1b[Z');
    for (let i = 0; i < 100 && !text.includes('5a'); i++) await new Promise((r) => setTimeout(r, 50));
    assert.match(text, /09 1b 5b 5a/);
  } finally { term.stopAll(); }
});

const hasTmux = spawnSync('tmux', ['-V']).status === 0;

test('tmux mode: terminals are windows of one named session, in the given directory, shown through one attached pty', { skip: !hasPython || !hasTmux }, async () => {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tk-tmux-')));
  const sub = fs.mkdirSync(path.join(dir, 'sub')) ?? path.join(dir, 'sub');
  const socket = `tk-test-${process.pid}`;
  const tmux = { session: 'sanvi-test', socket };
  const q = (...a) => spawnSync('tmux', ['-L', socket, ...a], { encoding: 'utf8' });
  const term = createTerminals({ tmux, shell: ['sh'] });
  try {
    const a = term.start({ cwd: dir, cols: 100, rows: 30, command: ['sh', '-c', 'pwd > a.txt; sleep 30'] });
    assert.equal(a.tmux, 'sanvi-test');
    const b = term.start({ cwd: sub, command: ['sh', '-c', 'pwd > b.txt; sleep 30'] }); // a second terminal: same pty, new window
    assert.equal(b.id, a.id);
    assert.equal(term.list().length, 1);
    for (let i = 0; i < 60 && !fs.existsSync(path.join(sub, 'b.txt')); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.readFileSync(path.join(dir, 'a.txt'), 'utf8').trim(), dir);
    assert.equal(fs.readFileSync(path.join(sub, 'b.txt'), 'utf8').trim(), sub);
    assert.equal(q('list-windows', '-t', 'sanvi-test:').stdout.trim().split('\n').length, 2);
    const c = term.start({ cwd: dir, command: ['sh', '-c', 'echo "args:$*" > c.txt; sleep 30', 'claude'], flags: ['--x'], ticket: '001-one.md', inShell: true, name: '#001 One' }); // a ticket session: a window running the command via the shell
    assert.equal(c.id, a.id);
    assert.equal(term.forTicket('001-one.md')?.id, a.id);
    assert.equal(term.forTicket('002-two.md'), null);
    for (let i = 0; i < 60 && !fs.existsSync(path.join(dir, 'c.txt')); i++) await new Promise((r) => setTimeout(r, 50));
    assert.equal(fs.readFileSync(path.join(dir, 'c.txt'), 'utf8').trim(), 'args:--x');
    assert.deepEqual(q('list-windows', '-t', 'sanvi-test:', '-F', '#{window_name}|#{automatic-rename}').stdout.trim().split('\n').filter((l) => l.startsWith('#001')), ['#001 One|0']);
    await new Promise((r) => setTimeout(r, 1500)); // the name stays while the command runs
    assert.ok(q('list-windows', '-t', 'sanvi-test:', '-F', '#{window_name}').stdout.includes('#001 One\n'));
    assert.equal(q('list-sessions', '-F', '#{session_name}').stdout.trim(), 'sanvi-test');
  } finally { term.stopAll(); q('kill-server'); }
});

test('tmux session names are per tickets dir: stable, distinct for equal base names, and free of characters tmux rejects', () => {
  const a = tmuxSessionName('/x/my.proj:1/tickets');
  assert.equal(a, tmuxSessionName('/x/my.proj:1/tickets/'));
  assert.match(a, /^sanvi-my-proj-1-[0-9a-f]{6}$/);
  assert.notEqual(tmuxSessionName('/x/app/tickets'), tmuxSessionName('/y/app/tickets'));
  assert.match(tmuxSessionName('/'), /^sanvi-[0-9a-f]{6}$/);
});

test('two instances with --tmux use separate tmux sessions', { skip: !hasPython || !hasTmux }, async () => {
  const socket = `tk-test2-${process.pid}`;
  const q = (...a) => spawnSync('tmux', ['-L', socket, ...a], { encoding: 'utf8' });
  const mk = () => fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tk-inst-')));
  const [d1, d2] = [mk(), mk()];
  const names = [tmuxSessionName(path.join(d1, 'tickets')), tmuxSessionName(path.join(d2, 'tickets'))];
  const t1 = createTerminals({ tmux: { session: names[0], socket }, shell: ['sh'] });
  const t2 = createTerminals({ tmux: { session: names[1], socket }, shell: ['sh'] });
  try {
    t1.start({ cwd: d1, command: ['sleep', '30'] });
    t2.start({ cwd: d2, command: ['sleep', '30'] });
    assert.notEqual(names[0], names[1]);
    assert.deepEqual(q('list-sessions', '-F', '#{session_name}').stdout.trim().split('\n').sort(), [...names].sort());
    for (const n of names) assert.equal(q('list-windows', '-t', `${n}:`).stdout.trim().split('\n').length, 1);
  } finally { t1.stopAll(); t2.stopAll(); q('kill-server'); }
});

test('a saved instance name gives the tmux session sanvi-<name>; sanitizing and collisions', async () => {
  const { saveName, storedName, sanitizeName, instanceName } = await import('../src/name.js');
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tk-name-')));
  const dir = path.join(root, 'tickets');
  fs.mkdirSync(dir);
  assert.equal(storedName(dir), undefined);
  assert.match(tmuxSessionName(dir), /^sanvi-.+-[0-9a-f]{6}$/);
  assert.equal(saveName(dir, ' my.proj: 1 '), 'my-proj-1');
  assert.equal(storedName(dir), 'my-proj-1');
  assert.equal(tmuxSessionName(dir), 'sanvi-my-proj-1');
  assert.equal(instanceName(dir), 'my-proj-1');
  assert.equal(sanitizeName('x'.repeat(40)).length, 32);
  assert.throws(() => saveName(dir, '...'), /no usable characters/);
  fs.writeFileSync(path.join(root, '.sanvi', 'name'), '# hand edit\nby hand\n');
  assert.equal(storedName(dir), 'by-hand');
});
