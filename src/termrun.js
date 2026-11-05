// An agent run on a terminal (with --terminal): the same shape as startRun in agent.js ({ onEvent, cancel, done }), but the
// agent is the interactive `claude` on a pty, so the user can watch it in the terminal panel and answer its questions.
// There is no JSON stream, so the end of the run is detected instead: a Stop hook (end of an agent turn) touches a marker
// file, and the run is finished when such a turn ended after the ticket left the status it had at the start (the agent
// ends its work by setting it, e.g. `testing`). If the session ends first (closed, exited) the run ends with it: ok only
// if the ticket status had changed.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const POLL_MS = 1000;
const quote = (a) => `'${String(a).replace(/'/g, `'\\''`)}'`;

/** Flags for the interactive CLI from run options of the headless one (`--max-budget-usd` and the output format only exist for `-p`). */
export function interactiveFlags({ permissionMode = 'auto', tools, allowedTools, disallowedTools, addDirs = [] }, marker) {
  const flags = ['--permission-mode', permissionMode];
  if (tools?.length) flags.push('--tools', tools.join(','));
  if (allowedTools?.length) flags.push('--allowedTools', allowedTools.join(','));
  if (disallowedTools?.length) flags.push('--disallowedTools', disallowedTools.join(','));
  for (const d of addDirs) flags.push(`--add-dir=${d}`);
  flags.push('--settings', JSON.stringify({ hooks: { Stop: [{ hooks: [{ type: 'command', command: `touch ${quote(marker)}` }] }] } }));
  return flags;
}

/** `terminals` is createTerminals(); `ticketStatus(file)` gives the ticket's current status. Returns a `run(opts)` for runs with `opts.interactive = { file, name }`. */
export function createTerminalRun({ terminals, ticketStatus, pollMs = POLL_MS }) {
  return function run({ prompt, cwd, interactive, ...opts }) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sanvi-run-'));
    const marker = path.join(dir, 'stop');
    const before = ticketStatus(interactive.file);
    const changed = () => { try { return ticketStatus(interactive.file) !== before; } catch { return false; } };
    let timer = null;
    let cancelled = false;
    let finish;
    const done = new Promise((resolve) => { finish = resolve; });
    const end = (extra) => {
      clearInterval(timer);
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* temp dir */ }
      finish({ ok: false, sessionId: null, text: '', costUsd: null, denials: 0, error: null, cancelled, ...extra });
    };
    let term;
    try {
      term = terminals.start({ cwd, flags: [...interactiveFlags(opts, marker), '--', prompt], name: interactive.name });
    } catch (e) {
      end({ error: e.message });
      return { onEvent() {}, cancel() {}, done };
    }
    timer = setInterval(() => {
      if (fs.existsSync(marker)) {
        if (changed()) { terminals.end(term); return end({ ok: true, text: 'The implementation ran in a terminal session; see the ticket and the branch for the result.' }); }
        try { fs.rmSync(marker); } catch { /* raced */ } // a turn ended (a question, a pause) but the work is not done
      }
      if (!terminals.alive(term)) end(changed() ? { ok: true, text: 'The terminal session ended after the ticket changed status.' } : { error: `the terminal session ended before the ticket left status "${before}"` });
    }, pollMs);
    return {
      onEvent() { /* no event stream on a terminal */ },
      cancel() { if (cancelled) return; cancelled = true; terminals.end(term); end({ error: 'cancelled' }); },
      done,
    };
  };
}
