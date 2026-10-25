// Persistent allowed hosts: `<tickets dir>/../.sanvi/allowed-hosts`, one entry per line (commas also work,
// `#` starts a comment). An entry is a host name or a `*.suffix` wildcard (`*.ts.net`: any host below it).
// `SANVI_ALLOW_HOSTS` (comma-separated) adds to it. The file is read on every use, so edits apply without a restart.
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './datadir.js';

export const hostsFile = (ticketsDir) => path.join(dataDir(ticketsDir), 'allowed-hosts');

/** Entries of a comma/newline separated list: trimmed, lower-cased, comments and empties dropped. */
export function parseHosts(text) {
  return String(text || '').split('\n').flatMap((line) => line.replace(/#.*/, '').split(',')).map((h) => h.trim().toLowerCase()).filter(Boolean);
}

/** Does `host` (no port) match an entry? `*.x` matches any host below x, not x itself. */
export const hostMatches = (entry, host) => (entry.startsWith('*.') ? host.endsWith(entry.slice(1)) && host.length > entry.length - 1 : entry === host);

export function persistentHosts(ticketsDir, env = process.env) {
  let fromFile = '';
  try { fromFile = fs.readFileSync(hostsFile(ticketsDir), 'utf8'); } catch { /* none yet */ }
  return [...parseHosts(fromFile), ...parseHosts(env.SANVI_ALLOW_HOSTS)];
}
