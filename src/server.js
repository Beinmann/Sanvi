// Local HTTP server: JSON API over the ticket files, static frontend, and an
// SSE stream that tells browsers when anything in the directory changed.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  IDEA_STATUS, listTickets, readTicket, listScratch, addScratch, deleteScratch, promoteScratch, saveTicket, createTicket, createIdea, readConfig, addNote, deleteTicket, listTrash, restoreTicket, purgeTrashItem, purgeTrash, saveAsset, ASSET_DIR, ASSET_MIME, MAX_ASSET_BYTES,
  ConflictError, NotFoundError, ValidationError,
  writeStatuses,
} from './core.js';
import { formatNote } from '../public/notes.js';
import { buildInfo, commitsBehind } from './about.js';
import { createChangeLog, summarizeBody } from './changelog.js';
import { createChats } from './chat.js';
import { startRun } from './agent.js';
import { chatsPath } from './instances.js';
import { refinePrompt, refineRunOpts } from './refine.js';
import { projectView, projectInfo, saveProject, listDirs } from './projects.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
// Any top-level file in public/ is served by name, so new frontend modules need no route.
const STATIC_TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8', '.svg': 'image/svg+xml' };

function staticFile(pathname) {
  const name = pathname === '/' ? 'index.html' : pathname.slice(1);
  if (!/^[\w.-]+$/.test(name) || name.startsWith('.')) return null;
  const type = STATIC_TYPES[path.extname(name)];
  const file = path.join(PUBLIC, name);
  return type && fs.existsSync(file) ? [file, type] : null;
}
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function send(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(body);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > 1_000_000) { reject(new ValidationError('request too large')); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => {
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}')); }
      catch { reject(new ValidationError('invalid JSON')); }
    });
    req.on('error', reject);
  });
}

// Raw request body, capped; an oversized upload is drained (not destroyed) so the error response still arrives.
function readBuffer(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => { size += c.length; if (size <= limit) chunks.push(c); });
    req.on('end', () => (size > limit ? reject(new ValidationError(`image too large (max ${limit / 1024 / 1024} MB)`)) : resolve(Buffer.concat(chunks))));
    req.on('error', reject);
  });
}

export function createTicketServer({ dir, allowedHosts = [], log: logOpts, agents = false, agentRun = startRun, chatsFile, autoRefine = false }) {
  const extraHosts = new Set(allowedHosts.map((h) => h.toLowerCase()));
  // *.localhost always resolves to loopback in browsers, so it cannot be a DNS-rebinding vector.
  const hostAllowed = (h) => LOCAL_HOSTS.has(h) || h.endsWith('.localhost') || extraHosts.has(h);
  dir = path.resolve(dir);
  if (!fs.statSync(dir).isDirectory()) throw new Error(`not a directory: ${dir}`);
  const clients = new Set();
  const changelog = createChangeLog(dir, logOpts);
  try { purgeTrash(dir); } catch (e) { console.error(`trash purge failed: ${e.message}`); }

  const broadcast = (obj) => { for (const c of clients) c.write(`data: ${JSON.stringify(obj)}\n\n`); };
  // After a refine run: did the ticket change, and is it out of `design`?
  function checkRefine(c) {
    if (c.kind !== 'refine') return null;
    try {
      const t = readTicket(dir, c.meta.file);
      if (t.version === c.meta.before) return { outcome: 'problems', warning: 'the ticket was not changed' };
      if (t.status === IDEA_STATUS) return { outcome: 'questions', warning: 'refined, but the ticket is still in design: open questions are in its Notes' };
      return { outcome: 'ok' };
    } catch { return { outcome: 'problems', warning: 'the ticket could not be read afterwards' }; }
  }

  // Agent chats run `claude` on this machine, so they exist only when the server was started with --agents.
  const chats = agents ? createChats({
    cwd: path.dirname(dir),
    file: chatsFile === undefined ? chatsPath(dir) : chatsFile,
    check: checkRefine,
    projectInfo: (name) => projectInfo(dir, name),
    run: agentRun,
    notify: (id) => broadcast({ type: 'chat', id }),
    log: (e) => changelog.log({ ticket: '-', ...e }),
  }) : null;

  // Refine runs as its own chat, queued if the agent slots are busy; the user can open it from the chat list.
  function startRefine(file) {
    const t = readTicket(dir, file);
    if (chats.list().some((c) => c.ticket === file && (c.state === 'running' || c.state === 'queued'))) throw new ValidationError(`#${t.id} is already being refined`);
    const chat = chats.create({ project: t.project, kind: 'refine', meta: { file, before: t.version }, title: `Refine #${t.id}: ${t.title}`.slice(0, 80), runOpts: refineRunOpts({ ticketsDir: dir, file }) });
    chats.send(chat.id, `Refine ticket #${t.id} (${file}): rewrite it into problem, acceptance criteria and approach.`, { prompt: refinePrompt({ ticketsDir: dir, file, project: t.project, instructions: projectInfo(dir, t.project).instructions }), queue: true });
    return chat;
  }

  function startRefineAll() {
    const started = [];
    let skipped = 0;
    for (const t of listTickets(dir)) {
      if (t.status !== IDEA_STATUS) continue;
      try { startRefine(t.file); started.push(t.id); } catch { skipped++; }
    }
    return { started: started.length, skipped };
  }

  // A read-only chat about the board: tickets (the working directory) and the change log, no editing, no shell.
  function startAsk(question) {
    const logDir = path.join(path.dirname(dir), '.tk');
    const today = new Date().toISOString().slice(0, 10);
    // `//x` is an absolute path in a permission rule; reads outside these two directories are refused.
    const roots = [dir, ...(fs.existsSync(logDir) ? [logDir] : [])];
    const chat = chats.create({
      dir, kind: 'ask', title: 'Ask',
      runOpts: { permissionMode: 'default', tools: ['Read', 'Grep', 'Glob'], allowedTools: roots.flatMap((r) => ['Read', 'Grep', 'Glob'].map((t) => `${t}(/${r}/**)`)), addDirs: roots.slice(1) },
      preamble: `You answer questions about a ticket board, read-only. Today is ${today}. The tickets are the Markdown files in the current directory; README.md there explains the format (frontmatter with status, area, project, priority; sections; dated Notes). The change log (JSON lines, newest last) is ${path.join(logDir, 'changes.log')} if it exists. Be concise, refer to tickets as #NNN, and say so when the files do not answer the question.\n\nQuestion:`,
    });
    if (!String(question || '').trim()) return chat;
    chats.send(chat.id, question, { queue: true });
    return chats.get(chat.id);
  }

  const summary = ({ body, ...rest }) => rest;
  const build = buildInfo(); // fixed at start: what this process is running
  const started = new Date().toISOString();

  function configPayload() {
    const cfg = readConfig(dir);
    return { name: path.basename(path.dirname(dir)), statuses: cfg.statuses, configured: cfg.configured };
  }

  function logEdit(before, after) {
    const changes = [];
    for (const f of ['status', 'area', 'project', 'priority']) {
      if ((before[f] || '') !== (after[f] || '')) changes.push({ field: f, from: before[f] || null, to: after[f] || null });
    }
    const bodyChanged = before.body !== after.body;
    const onlyStatus = changes.length === 1 && changes[0].field === 'status' && !bodyChanged;
    changelog.log({
      ticket: after.id, action: onlyStatus ? 'status' : 'edit', before: before.version, after: after.version, changes,
      ...(bodyChanged ? { body: summarizeBody(before.body, after.body) } : {}),
    });
  }

  async function api(req, res, url) {
    const parts = url.pathname.split('/').filter(Boolean).slice(1); // drop "api"
    const method = req.method;
    if (method !== 'GET') {
      const origin = req.headers.origin;
      let originHost = null;
      try { originHost = origin && new URL(origin).host; } catch { /* malformed */ }
      if (origin && originHost !== req.headers.host) return send(res, 403, { error: 'cross-origin request refused' });
      const isUpload = parts.length === 3 && parts[0] === 'tickets' && parts[2] === 'assets';
      if (!isUpload && !/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'content-type must be application/json' });
    }
    if (parts[0] === 'config' && method === 'GET') return send(res, 200, configPayload());
    if (parts[0] === 'config' && method === 'PUT') {
      const { statuses } = await readJson(req);
      if (statuses === undefined) throw new ValidationError('statuses is required');
      writeStatuses(dir, statuses);
      return send(res, 200, configPayload());
    }
    if (parts[0] === 'about' && parts.length === 1 && method === 'GET') {
      return send(res, 200, {
        version: build.version, commit: build.commit, date: build.date, node: process.version,
        dir: path.basename(dir), tickets: listTickets(dir).length, started, behind: commitsBehind(build.full),
      });
    }
    if (parts[0] === 'agent') {
      if (parts.length === 1 && method === 'GET') return send(res, 200, { enabled: !!chats, autoRefine: !!(chats && autoRefine), ...(chats && { defaultDir: chats.defaultDir }) });
      if (!chats) return send(res, 403, { error: 'agent features are off (start the server with --agents)' });
      if (parts[1] === 'refine-all' && parts.length === 2 && method === 'POST') return send(res, 200, startRefineAll());
      if (parts[1] === 'ask' && parts.length === 2 && method === 'POST') return send(res, 201, startAsk((await readJson(req)).question));
      if (parts[1] === 'refine' && parts.length === 2 && method === 'POST') return send(res, 201, startRefine((await readJson(req)).file));
      if (parts[1] !== 'chats') return send(res, 404, { error: 'not found' });
      if (parts.length === 2 && method === 'GET') return send(res, 200, chats.list());
      if (parts.length === 2 && method === 'POST') return send(res, 201, chats.create(await readJson(req)));
      if (parts.length === 3 && method === 'PUT') return send(res, 200, chats.setCwd(parts[2], (await readJson(req)).dir));
      if (parts.length === 3 && method === 'GET') return send(res, 200, chats.get(parts[2]));
      if (parts.length === 3 && method === 'DELETE') { chats.remove(parts[2]); return send(res, 200, { ok: true }); }
      if (parts.length === 4 && parts[3] === 'messages' && method === 'POST') {
        const { text } = await readJson(req);
        return send(res, 202, chats.send(parts[2], text));
      }
      if (parts.length === 4 && parts[3] === 'cancel' && method === 'POST') return send(res, 200, chats.cancel(parts[2]));
      return send(res, 404, { error: 'not found' });
    }
    if (parts[0] === 'dirs' && parts.length === 1 && method === 'GET') { // directory picker: names of the machine's directories, so only with agents
      if (!chats) return send(res, 403, { error: 'the directory picker needs the server to be started with --agents' });
      return send(res, 200, listDirs(url.searchParams.get('path'), { hidden: url.searchParams.get('hidden') === '1' }));
    }
    if (parts[0] === 'projects' && parts.length === 1) {
      if (method === 'GET') return send(res, 200, projectView(dir));
      if (method === 'PUT') {
        const { name, dir: pdir, instructions } = await readJson(req);
        saveProject(dir, { name, dir: pdir, instructions });
        changelog.log({ ticket: '-', action: 'project', project: name || '' });
        return send(res, 200, projectView(dir));
      }
    }
    if (parts[0] === 'events' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 1000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (parts[0] === 'ideas' && parts.length === 1 && method === 'POST') {
      const { text, area, project } = await readJson(req);
      const t = createIdea(dir, { text, area, project });
      changelog.log({ ticket: t.id, action: 'create', after: t.version, changes: [{ field: 'status', from: null, to: t.status }] });
      if (autoRefine && chats) {
        try { startRefine(t.file); } catch (e) { console.error(`auto-refine of #${t.id} failed to start: ${e.message}`); }
      }
      return send(res, 201, t);
    }
    if (parts[0] === 'scratch') {
      if (parts.length === 1 && method === 'GET') return send(res, 200, listScratch(dir));
      if (parts.length === 1 && method === 'POST') {
        const { text, version } = await readJson(req);
        return send(res, 201, addScratch(dir, text, version));
      }
      const index = Number(parts[1]);
      if (!Number.isInteger(index) || index < 0) throw new ValidationError('invalid note index');
      const { version, project } = await readJson(req);
      if (!version) throw new ValidationError('version is required');
      if (parts.length === 2 && method === 'DELETE') return send(res, 200, deleteScratch(dir, index, version));
      if (parts.length === 3 && parts[2] === 'promote' && method === 'POST') {
        const r = promoteScratch(dir, index, version, { project });
        changelog.log({ ticket: r.ticket.id, action: 'create', after: r.ticket.version, changes: [{ field: 'status', from: null, to: r.ticket.status }] });
        return send(res, 200, r);
      }
      return send(res, 404, { error: 'not found' });
    }
    if (parts[0] === 'trash') {
      if (parts.length === 1 && method === 'GET') { purgeTrash(dir); return send(res, 200, listTrash(dir)); }
      if (parts.length === 3 && parts[2] === 'restore' && method === 'POST') {
        const t = restoreTicket(dir, decodeURIComponent(parts[1]));
        changelog.log({ ticket: t.id, action: 'restore', after: t.version });
        return send(res, 200, t);
      }
      if (parts.length === 2 && method === 'DELETE') {
        const key = decodeURIComponent(parts[1]);
        const item = listTrash(dir).find((x) => x.key === key);
        purgeTrashItem(dir, key);
        changelog.log({ ticket: item?.id ?? key, action: 'purge' });
        return send(res, 200, { ok: true });
      }
      return send(res, 404, { error: 'not found' });
    }
    if (parts[0] !== 'tickets') return send(res, 404, { error: 'not found' });
    if (parts.length === 2 && method === 'DELETE') {
      const { version } = await readJson(req);
      if (!version) throw new ValidationError('version is required');
      const file = decodeURIComponent(parts[1]);
      let item;
      try { item = deleteTicket(dir, file, version); } catch (e) {
        if (e instanceof ConflictError) changelog.log({ ticket: file.slice(0, 3), action: 'conflict', before: version, after: e.current?.version });
        throw e;
      }
      changelog.log({ ticket: item.id, action: 'delete', before: version });
      return send(res, 200, item);
    }
    if (parts.length === 1 && method === 'GET') return send(res, 200, url.searchParams.get('bodies') === '1' ? listTickets(dir) : listTickets(dir).map(summary));
    if (parts.length === 1 && method === 'POST') {
      const { title, area, project, status, priority } = await readJson(req);
      const t = createTicket(dir, { title, area, project, status, priority });
      changelog.log({ ticket: t.id, action: 'create', after: t.version,
        changes: ['status', 'area', 'project', 'priority'].filter((f) => t[f]).map((f) => ({ field: f, from: null, to: t[f] })) });
      return send(res, 201, t);
    }
    if (parts.length === 2 && method === 'GET') return send(res, 200, readTicket(dir, decodeURIComponent(parts[1])));
    if (parts.length === 3 && parts[2] === 'assets' && method === 'POST') {
      const buf = await readBuffer(req, MAX_ASSET_BYTES);
      const rel = saveAsset(dir, decodeURIComponent(parts[1]), buf, req.headers['content-type']);
      return send(res, 201, { path: rel });
    }
    if (parts.length === 3 && parts[2] === 'notes' && method === 'POST') {
      const { version, text } = await readJson(req);
      if (!version) throw new ValidationError('version is required');
      const file = decodeURIComponent(parts[1]);
      let before = null;
      try { before = readTicket(dir, file); } catch { /* addNote reports it */ }
      let t;
      const now = new Date();
      try { t = addNote(dir, file, text, version, now); } catch (e) {
        if (e instanceof ConflictError) {
          changelog.log({ ticket: before?.id ?? file.slice(0, 3), action: 'conflict', before: version, after: e.current?.version });
        }
        throw e;
      }
      if (before && t.version !== before.version) logEdit(before, t);
      return send(res, 200, { ...t, note: formatNote(text, now) }); // `note`: the line added, for clients holding a draft
    }
    if (parts.length === 2 && method === 'PUT') {
      const { version, fields, body } = await readJson(req);
      if (!version) throw new ValidationError('version is required');
      const file = decodeURIComponent(parts[1]);
      let before = null;
      try { before = readTicket(dir, file); } catch { /* saveTicket reports it */ }
      let t;
      try { t = saveTicket(dir, file, { fields, body }, version); } catch (e) {
        if (e instanceof ConflictError) {
          changelog.log({ ticket: before?.id ?? file.slice(0, 3), action: 'conflict', before: version, after: e.current?.version });
        }
        throw e;
      }
      if (before && t.version !== before.version) logEdit(before, t);
      return send(res, 200, t);
    }
    return send(res, 404, { error: 'not found' });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const host = (req.headers.host || '').replace(/:\d+$/, '').toLowerCase();
      if (!hostAllowed(host)) { res.writeHead(403, { 'content-type': 'text/plain' }); return res.end(`forbidden host "${host}" (start with --allow-host ${host} to permit)`); }
      const url = new URL(req.url, 'http://localhost');
      res.on('finish', () => { // failed requests go to the change log so a repeat can be diagnosed (409 is logged with detail elsewhere)
        if (res.statusCode >= 400 && res.statusCode !== 404 && res.statusCode !== 409) {
          changelog.log({ ticket: '-', action: 'http-error', method: req.method, path: url.pathname, status: res.statusCode });
        }
      });
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      const am = req.method === 'GET' && /^\/assets\/([\w-]+\.(png|jpg|gif|webp))$/.exec(url.pathname);
      if (am) { // only plain files in <tickets dir>/assets, by a whitelisted name
        const file = path.join(dir, ASSET_DIR, am[1]);
        if (fs.existsSync(file) && fs.statSync(file).isFile()) {
          res.writeHead(200, { 'content-type': ASSET_MIME[am[2]], 'x-content-type-options': 'nosniff', 'cache-control': 'no-cache' });
          return res.end(fs.readFileSync(file));
        }
        res.writeHead(404); return res.end('not found');
      }
      const entry = req.method === 'GET' && staticFile(url.pathname);
      if (entry) {
        res.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-store' });
        return res.end(fs.readFileSync(entry[0]));
      }
      res.writeHead(404); res.end('not found');
    } catch (e) {
      if (e instanceof ConflictError) return send(res, 409, { error: 'conflict', message: e.message, current: e.current });
      if (e instanceof NotFoundError) return send(res, 404, { error: e.message });
      if (e instanceof ValidationError) return send(res, 400, { error: e.message });
      console.error(e);
      if (!res.headersSent) send(res, 500, { error: 'internal error' });
    }
  });

  // Node closes idle keep-alive connections after 5 s by default; a proxy that reuses such a connection
  // answers 502 Bad Gateway. Stay open longer than typical proxy idle timeouts (60-ish seconds).
  server.keepAliveTimeout = 65_000;
  server.headersTimeout = 66_000;

  let timer = null;
  const watcher = fs.watch(dir, () => {
    clearTimeout(timer);
    timer = setTimeout(() => { for (const c of clients) c.write('data: {"type":"changed"}\n\n'); }, 80);
  });
  watcher.on('error', () => {});
  const heartbeat = setInterval(() => { for (const c of clients) c.write(': ping\n\n'); }, 25000);
  heartbeat.unref();

  return {
    server,
    dir,
    listen(port = 4321, host = '127.0.0.1') {
      return new Promise((resolve, reject) => {
        server.once('error', reject);
        server.listen(port, host, () => resolve(server.address()));
      });
    },
    close() {
      clearTimeout(timer); clearInterval(heartbeat); watcher.close();
      for (const c of clients) c.end();
      return new Promise((resolve) => { server.close(resolve); server.closeAllConnections?.(); });
    },
  };
}
