// Interactive terminals: the real `claude` CLI on a pseudo-terminal, bridged to the browser (SSE for output, POST for
// input). Node has no pty, so src/ptyhost.py (python3, standard library only) owns it. Exists only with --agents.
// A terminal ends when it is stopped, when the server closes, or when no browser has been watching it for a while.
import { spawn } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ValidationError } from './core.js';

const HOST = fileURLToPath(new URL('./ptyhost.py', import.meta.url));
const KEEP = 256 * 1024;   // output kept for a browser that attaches late or reconnects
const MAX = 8;             // terminals at once
const IDLE_MS = 20000;     // nobody watching for this long: the process is ended

const size = (v, dflt, max) => (Number.isInteger(v) && v >= 1 && v <= max ? v : dflt);

export function createTerminals({ command = ['claude'], idleMs = IDLE_MS, python = 'python3' } = {}) {
  const terms = new Map();

  const view = (t) => ({ id: t.id, cwd: t.cwd, cols: t.cols, rows: t.rows, state: t.state, exitCode: t.exitCode, created: t.created });
  const get = (id) => {
    const t = terms.get(id);
    if (!t) throw new ValidationError('no such terminal');
    return t;
  };
  const emit = (t, event, data) => { for (const res of t.watchers) res.write(`${event ? `event: ${event}\n` : ''}data: ${data}\n\n`); };

  function arm(t) { // end the process when nobody has been watching for a while
    clearTimeout(t.idle);
    if (t.state === 'running' && !t.watchers.size) t.idle = setTimeout(() => stop(t.id), idleMs);
  }

  /** Starts `command` (plus the optional initial `prompt`) in `cwd`. This is also the entry for other runs to use. */
  function start({ cwd, prompt, cols, rows } = {}) {
    if (!cwd) throw new ValidationError('a directory is needed');
    if ([...terms.values()].filter((t) => t.state === 'running').length >= MAX) throw new ValidationError(`at most ${MAX} terminals at once`);
    cols = size(cols, 100, 500); rows = size(rows, 30, 200);
    const args = [...command];
    const text = String(prompt || '').trim();
    if (text) args.push(text.startsWith('-') ? `Task: ${text}` : text);
    const t = { id: crypto.randomUUID(), cwd, cols, rows, state: 'running', exitCode: null, created: new Date().toISOString(), chunks: [], bytes: 0, watchers: new Set(), idle: null, proc: null };
    const proc = spawn(python, ['-I', HOST, cwd, String(cols), String(rows), ...args], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'], cwd, env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor' },
    });
    t.proc = proc;
    const out = (buf) => {
      t.chunks.push(buf); t.bytes += buf.length;
      while (t.bytes > KEEP && t.chunks.length > 1) t.bytes -= t.chunks.shift().length;
      emit(t, '', buf.toString('base64'));
    };
    proc.stdout.on('data', out);
    proc.stderr.on('data', out);
    for (const s of [proc.stdin, proc.stdio[3]]) s.on('error', () => { /* the process is gone */ });
    const done = (code, why) => {
      if (t.state !== 'running') return;
      t.state = 'exited'; t.exitCode = code;
      clearTimeout(t.idle);
      if (why) out(Buffer.from(`\r\n[${why}]\r\n`));
      emit(t, 'exit', String(code));
      for (const res of t.watchers) res.end();
      t.watchers.clear();
    };
    proc.on('error', (e) => done(127, e.code === 'ENOENT' ? `the terminal needs ${python} (not found)` : `cannot start: ${e.message}`));
    proc.on('close', (code) => done(code ?? 1, `exited with code ${code ?? 1}`));
    terms.set(t.id, t);
    arm(t);
    return view(t);
  }

  /** Attaches an SSE response: replays the kept output, then streams. Ends with the terminal. */
  function watch(id, req, res) {
    const t = get(id);
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
    res.write('retry: 1000\n\n');
    for (const c of t.chunks) res.write(`data: ${c.toString('base64')}\n\n`);
    if (t.state !== 'running') { res.write(`event: exit\ndata: ${t.exitCode}\n\n`); return res.end(); }
    t.watchers.add(res);
    arm(t);
    req.on('close', () => { t.watchers.delete(res); arm(t); });
  }

  function input(id, data) {
    const t = get(id);
    if (t.state !== 'running') throw new ValidationError('the terminal has ended');
    if (typeof data !== 'string') throw new ValidationError('data must be a string');
    t.proc.stdin.write(data);
  }

  function resize(id, cols, rows) {
    const t = get(id);
    cols = size(cols, 0, 500); rows = size(rows, 0, 200);
    if (!cols || !rows) throw new ValidationError('cols and rows must be positive integers');
    t.cols = cols; t.rows = rows;
    if (t.state === 'running') t.proc.stdio[3].write(`${cols} ${rows}\n`);
    return view(t);
  }

  function stop(id) {
    const t = terms.get(id);
    if (!t) return;
    if (t.state === 'running') t.proc.kill('SIGTERM'); // the host hangs up the command, then exits
    terms.delete(id);
    for (const res of t.watchers) res.end();
    t.watchers.clear();
    clearTimeout(t.idle);
  }

  function stopAll() { for (const id of [...terms.keys()]) stop(id); }

  return { start, watch, input, resize, stop, stopAll, list: () => [...terms.values()].map(view), get: (id) => view(get(id)) };
}
