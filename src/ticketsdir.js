// Locating the tickets dir, and offering to create one when `tk start` / `tk serve` run without any.
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

/** The nearest `tickets` directory from `from` upwards, or null. */
export function findTicketsDir(from) {
  for (let d = from; ; d = path.dirname(d)) {
    const cand = path.join(d, 'tickets');
    if (fs.existsSync(cand) && fs.statSync(cand).isDirectory()) return cand;
    if (path.dirname(d) === d) return null;
  }
}

function askOnTerminal(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

/**
 * Ask whether to create `<cwd>/tickets`. Returns the new dir, or null when declined or when there is no
 * interactive terminal (nothing is created then). `ask` and `isTTY` are injectable for tests.
 */
export async function offerTicketsDir(cwd, { isTTY = !!process.stdin.isTTY, ask = askOnTerminal } = {}) {
  if (!isTTY) return null;
  const target = path.join(cwd, 'tickets');
  const answer = String(await ask(`No tickets dir found. Create ${target} and start Sanvi there? [y/N] `)).trim().toLowerCase();
  if (answer !== 'y' && answer !== 'yes') return null;
  fs.mkdirSync(target, { recursive: true });
  return target;
}
