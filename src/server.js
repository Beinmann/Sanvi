// Local HTTP server: JSON API over the ticket files, static frontend, and an
// SSE stream that tells browsers when anything in the directory changed.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  listTickets, readTicket, saveTicket, createTicket, readConfig,
  ConflictError, NotFoundError, ValidationError,
} from './core.js';
import { createChangeLog, summarizeBody } from './changelog.js';

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'public');
const STATIC = {
  '/': ['index.html', 'text/html; charset=utf-8'],
  '/app.js': ['app.js', 'text/javascript; charset=utf-8'],
  '/md.js': ['md.js', 'text/javascript; charset=utf-8'],
  '/vim.js': ['vim.js', 'text/javascript; charset=utf-8'],
  '/style.css': ['style.css', 'text/css; charset=utf-8'],
};
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

export function createTicketServer({ dir, allowedHosts = [], log: logOpts }) {
  const extraHosts = new Set(allowedHosts.map((h) => h.toLowerCase()));
  // *.localhost always resolves to loopback in browsers, so it cannot be a DNS-rebinding vector.
  const hostAllowed = (h) => LOCAL_HOSTS.has(h) || h.endsWith('.localhost') || extraHosts.has(h);
  dir = path.resolve(dir);
  if (!fs.statSync(dir).isDirectory()) throw new Error(`not a directory: ${dir}`);
  const clients = new Set();
  const changelog = createChangeLog(dir, logOpts);

  const summary = ({ body, ...rest }) => rest;

  function configPayload() {
    const cfg = readConfig(dir);
    return { name: path.basename(path.dirname(dir)), statuses: cfg.statuses, configured: cfg.configured };
  }

  function logEdit(before, after) {
    const changes = [];
    for (const f of ['status', 'area', 'priority']) {
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
      if (!/^application\/json/.test(req.headers['content-type'] || '')) return send(res, 415, { error: 'content-type must be application/json' });
    }
    if (parts[0] === 'config' && method === 'GET') return send(res, 200, configPayload());
    if (parts[0] === 'events' && method === 'GET') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
      res.write('retry: 1000\n\n');
      clients.add(res);
      req.on('close', () => clients.delete(res));
      return;
    }
    if (parts[0] !== 'tickets') return send(res, 404, { error: 'not found' });
    if (parts.length === 1 && method === 'GET') return send(res, 200, url.searchParams.get('bodies') === '1' ? listTickets(dir) : listTickets(dir).map(summary));
    if (parts.length === 1 && method === 'POST') {
      const { title, area, status, priority } = await readJson(req);
      const t = createTicket(dir, { title, area, status, priority });
      changelog.log({ ticket: t.id, action: 'create', after: t.version,
        changes: ['status', 'area', 'priority'].filter((f) => t[f]).map((f) => ({ field: f, from: null, to: t[f] })) });
      return send(res, 201, t);
    }
    if (parts.length === 2 && method === 'GET') return send(res, 200, readTicket(dir, decodeURIComponent(parts[1])));
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
      if (url.pathname.startsWith('/api/')) return await api(req, res, url);
      const entry = STATIC[url.pathname];
      if (req.method === 'GET' && entry) {
        res.writeHead(200, { 'content-type': entry[1], 'cache-control': 'no-store' });
        return res.end(fs.readFileSync(path.join(PUBLIC, entry[0])));
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
