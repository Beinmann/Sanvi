// Build information for the About dialog and `tk --version`: package version plus the git commit of the
// checkout this code runs from. Every git call is optional; without git (or outside a checkout) only the version shows.
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');

function git(...args) {
  try { return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim(); } catch { return ''; }
}

export function buildInfo() {
  let version = '';
  try { version = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8')).version; } catch { /* keep empty */ }
  const full = git('rev-parse', 'HEAD');
  // Only count as a checkout when this dir is the repo's top level, not a parent repo around an unpacked copy.
  const isCheckout = !!full && path.resolve(git('rev-parse', '--show-toplevel')) === path.resolve(ROOT);
  return {
    version,
    commit: isCheckout ? full.slice(0, 7) : '',
    full: isCheckout ? full : '',
    date: isCheckout ? git('log', '-1', '--format=%cs') : '',
  };
}

/** How many commits the checkout's HEAD is ahead of `startFull` (0 when equal or unknown). */
export function commitsBehind(startFull) {
  if (!startFull) return 0;
  const head = git('rev-parse', 'HEAD');
  if (!head || head === startFull) return 0;
  const n = Number(git('rev-list', '--count', `${startFull}..HEAD`));
  return Number.isFinite(n) ? n : 0;
}

export const versionLine = (b = buildInfo()) => `sanvi ${b.version}${b.commit ? ` (${b.commit}, ${b.date})` : ''}`;
