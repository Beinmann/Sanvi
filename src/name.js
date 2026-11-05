// Instance name: `<tickets dir>/../.sanvi/name` holds just the name (`#` comments allowed), set with `tk rename`.
// It is shown in the UI header and names the tmux session (`sanvi-<name>`). Without the file the name is derived from the
// directory (see `instanceName`). Read on every use, so a hand edit applies to the next start.
import fs from 'node:fs';
import path from 'node:path';
import { dataDir } from './datadir.js';

export const MAX_NAME = 32;
export const nameFile = (ticketsDir) => path.join(dataDir(ticketsDir), 'name');

/** Characters outside `[A-Za-z0-9_-]` become `-` (runs collapse, ends trimmed), at most 32 characters. May return ''. */
export const sanitizeName = (s) => String(s).replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, MAX_NAME).replace(/-+$/, '');

/** The name saved by `tk rename` (sanitized), or undefined when there is none or the file is unreadable/empty. */
export function storedName(ticketsDir) {
  try { return sanitizeName(fs.readFileSync(nameFile(ticketsDir), 'utf8').replace(/#.*/g, '').trim()) || undefined; } catch { return undefined; }
}

/** Save the name; returns the sanitized form. Throws an Error when nothing usable is left. */
export function saveName(ticketsDir, raw) {
  const name = sanitizeName(raw);
  if (!name) throw new Error(`"${raw}" has no usable characters; use letters, digits, "_" or "-"`);
  const file = nameFile(ticketsDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${name}\n`);
  return name;
}

/** Display name of an instance: the saved name, else its project directory (the parent of a dir called `tickets`), else the dir's own name. */
export const instanceName = (dir) => storedName(dir) || (path.basename(dir) === 'tickets' ? path.basename(path.dirname(dir)) : path.basename(dir));
