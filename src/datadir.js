// The dir Sanvi writes its own files to: `<tickets dir>/../.sanvi/`. Installs from before the rename have
// `.tk`; it is moved over on first use. Never overwrites: if both exist, `.tk` is left alone with a warning.
import fs from 'node:fs';
import path from 'node:path';

const warned = new Set();

export function dataDir(ticketsDir, warn = (m) => console.warn(m)) {
  const parent = path.dirname(path.resolve(ticketsDir));
  const dir = path.join(parent, '.sanvi');
  const old = path.join(parent, '.tk');
  try {
    if (fs.existsSync(old)) {
      if (!fs.existsSync(dir)) fs.renameSync(old, dir);
      else if (!warned.has(old)) {
        warned.add(old);
        warn(`Both ${old} and ${dir} exist; using ${dir} and leaving ${old} untouched (merge or remove it by hand).`);
      }
    }
  } catch (err) {
    warn(`Could not migrate ${old} to ${dir}: ${err.message}`);
  }
  return dir;
}
