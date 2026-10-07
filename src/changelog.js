// Bounded change log for writes made through the web UI: JSON Lines in
// `<tickets dir>/../.tk/changes.log`. Entries hold summaries and short content
// hashes, never ticket bodies. Logging failures never propagate to callers.
import fs from 'node:fs';
import path from 'node:path';

const env = (k, d) => (Number(process.env[k]) > 0 ? Number(process.env[k]) : d);

export const LOG_DEFAULTS = () => ({
  maxBytes: env('TK_LOG_MAX_BYTES', 1_000_000), // rotate when the log would exceed this
  keep: env('TK_LOG_KEEP', 5),                  // files kept in total: changes.log + .1 ... .(keep-1)
  coalesceMs: env('TK_LOG_COALESCE_MS', 30_000), // successive edits of one ticket within this merge
});

const lines = (s) => (s || '').split('\n').filter((l) => l.trim() !== ''); // blank lines are noise

/** Summarise a body change without storing content. */
export function summarizeBody(from = '', to = '') {
  const count = new Map();
  for (const l of lines(from)) count.set(l, (count.get(l) || 0) + 1);
  const added = [];
  for (const l of lines(to)) {
    if (count.get(l) > 0) count.set(l, count.get(l) - 1);
    else added.push(l);
  }
  let removed = 0;
  for (const n of count.values()) removed += n;
  const sections = new Set();
  let section = '(top)';
  const addedSet = new Set(added);
  for (const l of lines(to)) {
    if (/^#{1,6}\s/.test(l)) section = l.replace(/^#+\s*/, '').trim();
    if (addedSet.has(l)) sections.add(section);
  }
  const ticks = (s) => ({ on: (s.match(/^\s*[-*] \[[xX]\]/gm) || []).length, off: (s.match(/^\s*[-*] \[ \]/gm) || []).length });
  const a = ticks(from); const b = ticks(to);
  const out = { linesAdded: added.length, linesRemoved: removed, sections: [...sections].slice(0, 10) };
  if (b.on > a.on) out.ticked = b.on - a.on;
  if (b.on < a.on) out.unticked = a.on - b.on;
  return out;
}

function merge(prev, next) {
  const changes = [...prev.changes];
  for (const c of next.changes) {
    const i = changes.findIndex((x) => x.field === c.field);
    if (i < 0) changes.push(c);
    else if (changes[i].from === c.to) changes.splice(i, 1); // reverted
    else changes[i] = { ...changes[i], to: c.to };
  }
  const body = (a, b) => {
    if (!a || !b) return a || b;
    const o = { linesAdded: a.linesAdded + b.linesAdded, linesRemoved: a.linesRemoved + b.linesRemoved,
      sections: [...new Set([...a.sections, ...b.sections])].slice(0, 10) };
    const t = (a.ticked || 0) - (a.unticked || 0) + (b.ticked || 0) - (b.unticked || 0);
    if (t > 0) o.ticked = t;
    if (t < 0) o.unticked = -t;
    return o;
  };
  const e = { ...next, before: prev.before, changes, merged: (prev.merged || 1) + 1 };
  const bs = body(prev.body, next.body);
  if (bs) e.body = bs;
  return e;
}

export function createChangeLog(ticketsDir, opts = {}) {
  const o = { ...LOG_DEFAULTS(), ...opts };
  const logDir = path.join(path.dirname(path.resolve(ticketsDir)), '.tk');
  const file = path.join(logDir, 'changes.log');
  const lastByTicket = new Map(); // ticket -> { entry, offset, at }

  function rotate() {
    if (o.keep <= 1) fs.truncateSync(file, 0);
    else {
      for (let i = o.keep - 1; i >= 1; i--) {
        const from = i === 1 ? file : `${file}.${i - 1}`;
        if (fs.existsSync(from)) fs.renameSync(from, `${file}.${i}`); // overwrites the oldest
      }
    }
    lastByTicket.clear();
  }

  /** entry: { ticket, action, changes?, body?, before?, after? } */
  function log(entry) {
    try {
      fs.mkdirSync(logDir, { recursive: true });
      const ign = path.join(logDir, '.gitignore');
      if (!fs.existsSync(ign)) fs.writeFileSync(ign, '*\n');
      const now = Date.now();
      let e = { ts: new Date(now).toISOString(), source: 'webui', changes: [], ...entry };
      if (!e.changes.length) delete e.changes;
      const prev = lastByTicket.get(e.ticket);
      const size = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (prev && e.action === 'edit' && prev.entry.action === 'edit' && now - prev.at <= o.coalesceMs
          && size === prev.offset + prev.len) {
        e = merge({ changes: [], ...prev.entry }, { changes: [], ...e });
        if (!e.changes.length) delete e.changes;
        fs.truncateSync(file, prev.offset);
      }
      const line = `${JSON.stringify(e)}\n`;
      let offset = fs.existsSync(file) ? fs.statSync(file).size : 0;
      if (offset > 0 && offset + Buffer.byteLength(line) > o.maxBytes) { rotate(); offset = 0; }
      fs.appendFileSync(file, line);
      lastByTicket.set(e.ticket, { entry: e, offset, len: Buffer.byteLength(line), at: now });
    } catch (err) {
      console.error(`change log failed: ${err.message}`);
    }
  }

  return { log, file, logDir };
}
