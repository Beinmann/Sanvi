// Persistent port: `<tickets dir>/../.sanvi/port` holds just the port number (`#` comments allowed). It is the default
// for `tk serve` / `tk start`; an explicit `--port` overrides it. Read on every start, so edits apply to the next one.
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './datadir.js';

export const DEFAULT_PORT = 4321;
export const portFile = (ticketsDir) => path.join(dataDir(ticketsDir), 'port');

/** Parse a port number: an integer from `min` to 65535 (a bare number, no sign, no decimals), else null. */
export function parsePort(text, min = 1) {
  const s = String(text).trim();
  if (!/^\d{1,5}$/.test(s)) return null;
  const n = Number(s);
  return n >= min && n <= 65535 ? n : null;
}

/** The stored port: `{ port }` (undefined when there is no file), or `{ error }` for unreadable/invalid content. */
export function storedPort(ticketsDir) {
  const file = portFile(ticketsDir);
  let text;
  try { text = fs.readFileSync(file, 'utf8'); } catch (e) {
    return e.code === 'ENOENT' ? {} : { error: `cannot read ${file}: ${e.message}` };
  }
  const value = text.replace(/#.*/g, '').trim();
  if (!value) return {};
  const port = parsePort(value);
  return port === null ? { error: `${file} must contain a port number from 1 to 65535, found "${value.slice(0, 40)}"` } : { port };
}

/** The port to use: the `--port` flag value, else the stored one, else 4321. Throws an Error with a message for invalid input. */
export function resolvePort(flagValue, ticketsDir) {
  if (flagValue !== undefined) {
    const port = parsePort(flagValue, 0);
    if (port === null) throw new Error(`invalid --port "${flagValue}": use an integer from 1 to 65535`);
    return { port, source: '--port' };
  }
  const stored = storedPort(ticketsDir);
  if (stored.error) throw new Error(stored.error);
  return stored.port === undefined ? { port: DEFAULT_PORT, source: 'default' } : { port: stored.port, source: portFile(ticketsDir) };
}
