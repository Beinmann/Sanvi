// The only module that knows how an agent is run. Today: the Claude Code CLI, headless (`claude -p`).
// To use another backend, provide a function with the same shape as startRun.
import { spawn } from 'node:child_process';

export const DEFAULT_TOOLS = ['Read', 'Grep', 'Glob', 'Edit'];

// startRun({ prompt, cwd, resume?, tools?, maxBudgetUsd? }) -> { cancel(), onEvent(fn), done }
//   onEvent(fn): fn(event) for each JSON line the CLI prints (stream-json).
//   done: resolves (never rejects) to { ok, sessionId, text, costUsd, error, cancelled }.
export function startRun({ prompt, cwd, resume, tools = DEFAULT_TOOLS, maxBudgetUsd = 2, bin = 'claude' }) {
  const args = [
    '-p', prompt,
    '--output-format', 'stream-json', '--verbose',
    '--permission-mode', 'acceptEdits',
    '--tools', tools.join(','),
    '--max-budget-usd', String(maxBudgetUsd),
  ];
  if (resume) args.push('--resume', resume);

  const listeners = [];
  let cancelled = false;
  let result = null;
  let sessionId = resume || null;
  let stderr = '';
  let buf = '';
  let child;

  const handleLine = (line) => {
    if (!line.trim()) return;
    let ev;
    try { ev = JSON.parse(line); } catch { return; }
    if (ev.session_id) sessionId = ev.session_id;
    if (ev.type === 'result') result = ev;
    for (const fn of listeners) fn(ev);
  };

  const done = new Promise((resolve) => {
    const finish = (extra) => resolve({ ok: false, sessionId, text: '', costUsd: null, error: null, cancelled, ...extra });
    try {
      child = spawn(bin, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (e) {
      return finish({ error: e.message });
    }
    child.on('error', (e) => finish({
      error: e.code === 'ENOENT' ? `"${bin}" not found: install the Claude Code CLI and make sure it is on PATH` : e.message,
    }));
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (d) => {
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) { handleLine(buf.slice(0, i)); buf = buf.slice(i + 1); }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (d) => { stderr = (stderr + d).slice(-4000); });
    child.on('close', (code) => {
      handleLine(buf);
      if (cancelled) return finish({ error: 'cancelled' });
      if (result && !result.is_error) return finish({ ok: true, text: result.result || '', costUsd: result.total_cost_usd ?? null });
      const why = (result && (result.result || result.subtype)) || stderr.trim() || `claude exited with code ${code}`;
      finish({ error: String(why), costUsd: result?.total_cost_usd ?? null });
    });
  });

  return {
    onEvent: (fn) => { listeners.push(fn); },
    cancel() {
      cancelled = true;
      if (!child || child.exitCode !== null) return;
      child.kill('SIGTERM');
      setTimeout(() => { if (child.exitCode === null) child.kill('SIGKILL'); }, 3000).unref();
    },
    done,
  };
}
