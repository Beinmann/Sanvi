// Run configs: a project's command is started in its own process group, one per project. Starting it again
// stops the process this server started earlier (the whole group) and spawns it anew. The command comes only
// from the project object on disk, never from the request.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ValidationError } from './core.js';
import { listProjectObjects } from './projects.js';

const KILL_GRACE_MS = 3000;

const expand = (p) => (p === '~' || p.startsWith('~/') ? path.join(os.homedir(), p.slice(1)) : p);

export function createRunner({ dir, grace = KILL_GRACE_MS }) {
  const running = new Map(); // project name -> { child, exited: Promise }

  function stop(name) {
    const r = running.get(name);
    if (!r) return Promise.resolve(false);
    running.delete(name);
    const signal = (s) => { try { process.kill(-r.child.pid, s); } catch { /* already gone */ } };
    signal('SIGTERM');
    const timer = setTimeout(() => signal('SIGKILL'), grace);
    return r.exited.then(() => { clearTimeout(timer); signal('SIGKILL'); return true; }); // sweep stragglers of the group
  }

  async function start(name) {
    if (typeof name !== 'string') throw new ValidationError('choose a project to run');
    const o = listProjectObjects(dir).find((x) => x.name === name);
    if (!o?.run) throw new ValidationError(`project "${name || 'default project'}" has no run command`);
    const cwd = expand(o.runDir || o.dir || '');
    if (!cwd) throw new ValidationError(`project "${name}" has a run command but no working directory (set one, or the project directory)`);
    if (!path.isAbsolute(cwd)) throw new ValidationError('the working directory must be absolute (or start with ~/)');
    try { if (!fs.statSync(cwd).isDirectory()) throw new Error(); } catch { throw new ValidationError(`working directory not found on this machine: ${cwd}`); }
    const restarted = await stop(name);
    const child = spawn('sh', ['-c', o.run], { cwd, detached: true, stdio: 'ignore' });
    const exited = new Promise((resolve) => child.once('exit', resolve).once('error', resolve));
    const entry = { child, exited };
    running.set(name, entry);
    exited.then(() => { if (running.get(name) === entry) running.delete(name); });
    await new Promise((resolve) => child.once('spawn', resolve).once('error', resolve));
    return { running: !!child.pid && running.get(name) === entry, restarted, pid: child.pid };
  }

  return {
    start, stop,
    isRunning: (name) => running.has(name),
    stopAll: () => Promise.all([...running.keys()].map(stop)),
  };
}
