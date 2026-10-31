// Interactive terminals: the real `claude` CLI on a pseudo-terminal, bridged to the browser (SSE for output, POST for
// input). Node has no pty, so src/ptyhost.py (python3, standard library only) owns it. Exists only with --agents.
// A terminal ends when it is stopped, when its process exits, or when the server closes. It keeps running while no browser watches it
// (a reloaded or reopened page re-attaches); an idle timeout exists only when `idleMs` is set.
import { spawn, execFileSync } from 'node:child_process';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { ValidationError } from './core.js';

const HOST = fileURLToPath(new URL('./ptyhost.py', import.meta.url));
const KEEP = 256 * 1024;   // output kept for a browser that attaches late or reconnects
const MAX = 8;             // terminals at once
const IDLE_MS = 0;         // no timeout by default; with idleMs > 0, a terminal nobody watched for this long is ended
const REAP_MS = 10000;     // an ended terminal is forgotten after this long (late watchers still see its output and exit)

const size = (v, dflt, max) => (Number.isInteger(v) && v >= 1 && v <= max ? v : dflt);

const quote = (a) => `'${String(a).replace(/'/g, `'\\''`)}'`;
// Typed into the interactive shell: clears the screen (so the echoed line is not what stays visible, and shows "Starting..." until the command prints),
// then runs $SANVI_RUN as a foreground job, so Ctrl+Z (exit status 128+SIGTSTP) returns to the prompt for `fg`; any other end leaves the shell too.
const RUN_LINE = ` printf '\\033[H\\033[2J\\033[3JStarting...\\r\\n'; eval "$SANVI_RUN"; s=$?; [ "$s" -eq 148 ] || exit "$s"\n`;

export const TMUX_SESSION = 'sanvi'; // the fixed name of the tmux session used with --tmux

export function createTerminals({ command = ['claude'], shell = null, tmux = null, idleMs = IDLE_MS, reapMs = REAP_MS, python = 'python3' } = {}) {
  const terms = new Map();
  // tmux mode: `tmux` is { session, socket? }. One pty is attached to that session; every further terminal is a window in it.
  const windows = new Map(); // ticket file -> tmux window id
  const tm = (args) => execFileSync('tmux', [...(tmux.socket ? ['-L', tmux.socket] : []), ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  const hasWindow = (id) => { try { return tm(['list-windows', '-t', `${tmux.session}:`, '-F', '#{window_id}']).split('\n').includes(id); } catch { return false; } };

  const view = (t) => ({ id: t.id, cwd: t.cwd, cols: t.cols, rows: t.rows, state: t.state, exitCode: t.exitCode, created: t.created, ticket: t.ticket, ...(t.tmux && { tmux: tmux.session }) });
  const get = (id) => {
    const t = terms.get(id);
    if (!t) throw new ValidationError('no such terminal');
    return t;
  };
  const emit = (t, event, data) => { for (const res of t.watchers) res.write(`${event ? `event: ${event}\n` : ''}data: ${data}\n\n`); };

  function arm(t) { // opt-in (idleMs > 0): end the process when nobody has been watching for a while
    clearTimeout(t.idle);
    if (idleMs > 0 && t.state === 'running' && !t.watchers.size) t.idle = setTimeout(() => stop(t.id), idleMs);
  }

  /** Starts `command` (or the given `command`, plus `flags` and the optional initial `prompt`) in `cwd`. `ticket` (a file name) marks a ticket session.
   *  With `inShell` (and a `shell`) the command runs as a job of an interactive shell instead of being the pty's direct child, so Ctrl+Z gives a shell. */
  function start({ cwd, prompt, cols, rows, flags = [], ticket = null, inShell = false, command: cmd = command } = {}) {
    if (!cwd) throw new ValidationError('a directory is needed');
    if ([...terms.values()].filter((t) => t.state === 'running').length >= MAX) throw new ValidationError(`at most ${MAX} terminals at once`);
    cols = size(cols, 100, 500); rows = size(rows, 30, 200);
    const args = [...cmd, ...flags];
    const text = String(prompt || '').trim();
    if (text) args.push(text.startsWith('-') ? `Task: ${text}` : text);
    if (tmux) return startWindow({ cwd, cols, rows, args, ticket, inShell });
    return launch({ cwd, cols, rows, argv: inShell && shell ? shell : args, env: inShell && shell ? { SANVI_RUN: args.map(quote).join(' ') } : {}, ticket, typed: inShell && shell ? RUN_LINE : '' });
  }

  /** tmux mode: a new window in the named session (created with its first window), shown through the one attached pty. */
  function startWindow({ cwd, cols, rows, args, ticket, inShell }) {
    const env = inShell ? ['-e', `SANVI_RUN=${args.map(quote).join(' ')}`] : [];
    const run = inShell ? [] : [args.map(quote).join(' ')];
    let id;
    try {
      let has = true;
      try { tm(['has-session', '-t', `=${tmux.session}`]); } catch { has = false; }
      id = has
        ? tm(['new-window', '-t', `${tmux.session}:`, '-c', cwd, '-P', '-F', '#{window_id}', ...env, ...run])
        : tm(['new-session', '-d', '-s', tmux.session, '-c', cwd, '-x', String(cols), '-y', String(rows), '-P', '-F', '#{window_id}', ...env, ...run]);
      if (inShell) { tm(['send-keys', '-t', id, '-l', RUN_LINE.trimEnd()]); tm(['send-keys', '-t', id, 'Enter']); }
    } catch (e) { throw new ValidationError(`tmux failed: ${String(e.stderr || e.message).trim()}`); }
    if (ticket) windows.set(ticket, id);
    const attached = [...terms.values()].find((t) => t.tmux && t.state === 'running');
    if (attached) return view(attached);
    return launch({ cwd, cols, rows, argv: ['tmux', ...(tmux.socket ? ['-L', tmux.socket] : []), 'attach-session', '-t', tmux.session], env: {}, ticket: null, typed: '', isTmux: true });
  }

  function launch({ cwd, cols, rows, argv, env, ticket, typed, isTmux = false }) {
    const t = { tmux: isTmux, id: crypto.randomUUID(), cwd, ticket, cols, rows, state: 'running', exitCode: null, created: new Date().toISOString(), chunks: [], bytes: 0, watchers: new Set(), idle: null, proc: null };
    const proc = spawn(python, ['-I', HOST, cwd, String(cols), String(rows), ...argv], {
      stdio: ['pipe', 'pipe', 'pipe', 'pipe'], cwd, env: { ...process.env, TERM: 'xterm-256color', COLORTERM: 'truecolor', ...env },
    });
    t.proc = proc;
    if (typed) proc.stdin.write(typed); // queued on the pty until the shell reads it
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
      setTimeout(() => { if (terms.get(t.id) === t) terms.delete(t.id); }, reapMs).unref();
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

  /** The running session of a ticket, if any (ended ones do not count). */
  const forTicket = (file) => {
    if (!tmux) return [...terms.values()].find((t) => t.state === 'running' && t.ticket === file);
    const id = windows.get(file);
    if (!id || !hasWindow(id)) { windows.delete(file); return undefined; }
    try { tm(['select-window', '-t', id]); } catch { return undefined; }
    return [...terms.values()].find((t) => t.state === 'running' && t.tmux);
  };

  return { start, forTicket: (file) => { const t = forTicket(file); return t ? view(t) : null; }, watch, input, resize, stop, stopAll, list: () => [...terms.values()].filter((t) => t.state === 'running').map(view), get: (id) => view(get(id)) };
}
