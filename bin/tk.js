#!/usr/bin/env node
// Optional helper CLI. Ticket files may always be edited by hand; this just
// makes the common operations (and format checks) quick for humans and agents.
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  register, unregister, listInstances, findInstance, stopInstance, waitForInstance, logPath,
} from '../src/instances.js';
import {
  listTickets, findTicket, saveTicket, createTicket, createIdea, addNote, validate, readConfig,
  ConflictError, NotFoundError, ValidationError,
} from '../src/core.js';

const HELP = `tk — helper for Markdown tickets (optional; editing the files by hand is fine)

usage: tk [--dir <tickets dir>] <command>

  list [--status S] [--area A] [--json]   list tickets
  show <id|slug> [--json]                 print a ticket
  idea "<text>"                           quick capture: status design, title derived from the text
  note <id|slug> "<text>"                 append a timestamped line to the ticket's ## Notes
  new "<title>" [--area A] [--status S] [--priority P]
                                          create the next ticket from the standard template
  status <id|slug> <status>               change status in the frontmatter only
  validate                                check format; exit 1 on errors
  serve [--port 4321] [--host 127.0.0.1] [--allow-host a,b]
                                          run the web UI in the foreground (hosts *.localhost are always allowed)
  start [--port 4321] [--host ..] [--allow-host ..]
                                          run the web UI in the background; free port if taken, prints the URL
  stop [--all | --port N]                 stop the instance for the tickets dir (or all / the one on a port)
  ps                                      list running instances; stale entries are cleaned up

The tickets dir is --dir, $TK_DIR, or the nearest ./tickets (searching upwards).`;

function parseArgs(argv) {
  const flags = {};
  const pos = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json') flags.json = true;
    else if (a === '--all') flags.all = true;
    else if (a === '-d') flags.dir = argv[++i];
    else if (a === '--auto-port') flags['auto-port'] = true;
    else if (a.startsWith('--')) flags[a.slice(2)] = argv[++i];
    else pos.push(a);
  }
  return { flags, pos };
}

function findDir(flag) {
  const given = flag || process.env.TK_DIR;
  if (given) return path.resolve(given);
  for (let d = process.cwd(); ; d = path.dirname(d)) {
    const cand = path.join(d, 'tickets');
    if (fs.existsSync(cand) && fs.statSync(cand).isDirectory()) return cand;
    if (path.dirname(d) === d) break;
  }
  throw new ValidationError('no tickets dir found (use --dir or $TK_DIR)');
}

const brief = (t) => `${t.id}  ${(t.status || '-').padEnd(12)} ${(t.area || '').padEnd(14)} ${t.title}`;

async function main() {
  const { flags, pos } = parseArgs(process.argv.slice(2));
  const [cmd, ...rest] = pos;
  if (!cmd || cmd === 'help' || flags.help) return console.log(HELP);
  const noDir = cmd === 'ps' || (cmd === 'stop' && (flags.all || flags.port));
  const dir = noDir ? null : findDir(flags.dir);
  const out = (data, text) => console.log(flags.json ? JSON.stringify(data, null, 2) : text);

  switch (cmd) {
    case 'list': {
      let all = listTickets(dir);
      if (flags.status) all = all.filter((t) => t.status === flags.status);
      if (flags.area) all = all.filter((t) => t.area === flags.area);
      out(all.map(({ body, ...t }) => t), all.map(brief).join('\n'));
      break;
    }
    case 'show': {
      if (!rest[0]) throw new ValidationError('usage: tk show <id|slug>');
      const t = findTicket(dir, rest[0]);
      out(t, fs.readFileSync(path.join(dir, t.file), 'utf8').trimEnd());
      break;
    }
    case 'idea': {
      if (!rest[0]) throw new ValidationError('usage: tk idea "<text>"');
      const t = createIdea(dir, { text: rest.join(' ') });
      out(t, path.join(dir, t.file));
      break;
    }
    case 'note': {
      if (!rest[0] || !rest[1]) throw new ValidationError('usage: tk note <id|slug> "<text>"');
      const f = findTicket(dir, rest[0]);
      const t = addNote(dir, f.file, rest.slice(1).join(' '), f.version);
      out(t, brief(t));
      break;
    }
    case 'new': {
      if (!rest[0]) throw new ValidationError('usage: tk new "<title>"');
      const t = createTicket(dir, { title: rest.join(' '), area: flags.area, status: flags.status, priority: flags.priority });
      out(t, path.join(dir, t.file));
      break;
    }
    case 'status': {
      if (!rest[0] || !rest[1]) throw new ValidationError('usage: tk status <id|slug> <status>');
      const known = readConfig(dir).statuses;
      if (!known.includes(rest[1])) console.error(`warning: "${rest[1]}" is not in ${known.join(' | ')}`);
      const cur = findTicket(dir, rest[0]);
      const t = saveTicket(dir, cur.file, { fields: { status: rest[1] } }, cur.version);
      out(t, brief(t));
      break;
    }
    case 'validate': {
      const problems = validate(dir);
      out(problems, problems.length ? problems.map((p) => `${p.level.padEnd(5)} ${p.file}: ${p.message}`).join('\n') : 'ok');
      if (problems.some((p) => p.level === 'error')) process.exitCode = 1;
      break;
    }
    case 'ps': {
      const all = listInstances();
      out(all, all.length ? all.map((e) => `${String(e.pid).padEnd(8)} ${e.url}  ${e.dir}`).join('\n') : 'no running instances');
      break;
    }
    case 'start': {
      const running = findInstance(dir);
      if (running) { console.log(`already running (pid ${running.pid}): ${running.url}\n${dir}`); break; }
      const log = logPath(dir);
      fs.mkdirSync(path.dirname(log), { recursive: true });
      const fd = fs.openSync(log, 'a');
      const args = [fileURLToPath(import.meta.url), '--dir', dir, 'serve', '--auto-port'];
      for (const k of ['port', 'host', 'allow-host']) if (flags[k]) args.push(`--${k}`, flags[k]);
      const child = spawn(process.execPath, args, { detached: true, stdio: ['ignore', fd, fd] });
      child.unref();
      const e = await waitForInstance(dir, child.pid);
      if (!e) throw new ValidationError(`server did not start; see ${log}`);
      console.log(`started (pid ${e.pid}): ${e.url}\n${dir}\nlog: ${log}`);
      break;
    }
    case 'stop': {
      const targets = flags.all ? listInstances()
        : flags.port ? listInstances().filter((e) => e.port === Number(flags.port))
          : [findInstance(dir)].filter(Boolean);
      if (!targets.length) { console.log('nothing to stop'); break; }
      for (const e of targets) {
        const ok = await stopInstance(e);
        console.log(`${ok ? 'stopped' : 'FAILED to stop'} pid ${e.pid}: ${e.url}  ${e.dir}`);
        if (!ok) process.exitCode = 1;
      }
      break;
    }
    case 'serve': {
      const existing = findInstance(dir);
      if (existing) throw new ValidationError(`already running for this dir (pid ${existing.pid}): ${existing.url}`);
      const { createTicketServer } = await import('../src/server.js');
      const app = createTicketServer({ dir, allowedHosts: (flags['allow-host'] || '').split(',').filter(Boolean) });
      const host = flags.host || '127.0.0.1';
      const want = flags.port === undefined ? 4321 : Number(flags.port);
      let addr;
      try { addr = await app.listen(want, host); } catch (e) {
        // An explicit --port is honoured strictly; otherwise fall back to any free port when asked to.
        if (e.code !== 'EADDRINUSE' || !flags['auto-port'] || flags.port !== undefined) throw e;
        addr = await app.listen(0, host);
      }
      const url = `http://localhost:${addr.port}`;
      register({ dir, pid: process.pid, port: addr.port, host, url, started: new Date().toISOString() });
      const bye = () => { unregister(dir, process.pid); process.exit(0); };
      process.on('SIGINT', bye);
      process.on('SIGTERM', bye);
      process.on('exit', () => unregister(dir, process.pid));
      console.log(`serving ${dir}\n${url}`);
      break;
    }
    default:
      throw new ValidationError(`unknown command "${cmd}"\n\n${HELP}`);
  }
}

main().catch((e) => {
  if (e instanceof ConflictError) console.error('error: ticket changed while updating; retry');
  else if (e instanceof NotFoundError || e instanceof ValidationError) console.error(`error: ${e.message}`);
  else console.error(e);
  process.exitCode = 1;
});
