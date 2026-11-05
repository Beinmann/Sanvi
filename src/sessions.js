// Overview of open terminal sessions across all running instances (`tk sessions`). Asks each instance's API;
// in tmux mode it also lists the windows of the tmux session, since the API only knows the one attached pty.
import { execFileSync } from 'node:child_process';

const get = async (url, p) => {
  const r = await fetch(`${url}/api/${p}`, { signal: AbortSignal.timeout(3000) });
  if (!r.ok) throw new Error(`${r.status}`);
  return r.json();
};

function tmuxWindows(session) {
  try {
    const raw = execFileSync('tmux', ['list-windows', '-t', `${session}:`, '-F', '#{window_index}\t#{window_name}\t#{pane_current_path}\t#{window_activity}'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
    return raw.trim().split('\n').filter(Boolean).map((l) => {
      const [index, name, cwd, activity] = l.split('\t');
      return { kind: 'tmux window', name: `${index}: ${name}`, cwd, since: activity ? new Date(Number(activity) * 1000).toISOString() : null };
    });
  } catch { return []; }
}

/** [{ instance: {url, dir, pid}, sessions: [{kind, name, cwd, since}] | null, note? }] for each instance. */
export async function collectSessions(instances) {
  return Promise.all(instances.map(async (instance) => {
    try {
      const info = await get(instance.url, 'agent');
      if (!info.terminal) return { instance, sessions: [], note: 'terminal off' };
      const list = await get(instance.url, 'agent/terminals');
      const sessions = info.tmux
        ? tmuxWindows(info.tmux)
        : list.map((t) => ({ kind: t.ticket ? 'ticket' : 'shell', name: t.ticket || '', cwd: t.cwd, since: t.created }));
      return { instance, sessions };
    } catch (e) {
      return { instance, sessions: null, note: `not reachable (${e.message})` };
    }
  }));
}

export function formatSessions(results) {
  if (!results.length) return 'no running instances';
  return results.map(({ instance, sessions, note }) => {
    const head = `${instance.url}  ${instance.dir}`;
    if (!sessions) return `${head}\n  ${note}`;
    if (!sessions.length) return `${head}\n  ${note || 'no open sessions'}`;
    return `${head}\n${sessions.map((s) => `  ${s.kind.padEnd(11)} ${(s.name || '-').padEnd(30)} ${s.since ? s.since.slice(0, 16).replace('T', ' ') : '-'}  ${s.cwd}`).join('\n')}`;
  }).join('\n\n');
}
