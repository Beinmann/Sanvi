import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createTicketServer } from '../src/server.js';
import { renderMarkdown, splitSummary } from '../public/md.js';

async function setup() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-srv-'));
  fs.writeFileSync(path.join(dir, '001-a.md'), '---\nstatus: open\n---\n# A\n');
  const app = createTicketServer({ dir });
  const { port } = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  const j = (method, p, body, headers = {}) => fetch(base + p, {
    method, headers: body ? { 'content-type': 'application/json', ...headers } : headers, body: body && JSON.stringify(body),
  });
  return { app, dir, base, port, j };
}

test('list, save, conflict, create', async () => {
  const { app, dir, j } = await setup();
  try {
    const list = await (await j('GET', '/api/tickets')).json();
    assert.equal(list.length, 1);
    assert.equal(list[0].body, undefined);
    const full = await (await j('GET', '/api/tickets?bodies=1')).json();
    assert.match(full[0].body, /# A/);

    const t = await (await j('GET', '/api/tickets/001-a.md')).json();
    let r = await j('PUT', '/api/tickets/001-a.md', { version: t.version, fields: { status: 'done' } });
    assert.equal(r.status, 200);

    r = await j('PUT', '/api/tickets/001-a.md', { version: t.version, fields: { status: 'open' } });
    assert.equal(r.status, 409);
    assert.equal((await r.json()).current.status, 'done');
    assert.match(fs.readFileSync(path.join(dir, '001-a.md'), 'utf8'), /status: done/);

    r = await j('POST', '/api/tickets', { title: 'New one' });
    assert.equal(r.status, 201);
    assert.equal((await r.json()).file, '002-new-one.md');

    r = await j('POST', '/api/ideas', { text: 'Quick thought about X. More.' });
    assert.equal(r.status, 201);
    const idea = await r.json();
    assert.equal(idea.status, 'design');
    assert.equal(idea.title, 'Quick thought about X');
    assert.equal((await j('POST', '/api/ideas', { text: ' ' })).status, 400);
    r = await j('POST', '/api/ideas', { text: 'Filed under a project', area: 'billing' });
    assert.equal((await r.json()).area, 'billing');

    const cur = await (await j('GET', '/api/tickets/001-a.md')).json();
    r = await j('POST', '/api/tickets/001-a.md/notes', { version: cur.version, text: 'a comment' });
    assert.match((await r.clone().json()).note, /^- \d{4}-\d\d-\d\d \d\d:\d\d: a comment$/); // the added line, for clients holding a draft
    assert.equal(r.status, 200);
    assert.match(fs.readFileSync(path.join(dir, '001-a.md'), 'utf8'), /## Notes\n\n- \d{4}-\d\d-\d\d \d\d:\d\d: a comment\n$/);
    assert.equal((await j('POST', '/api/tickets/001-a.md/notes', { version: cur.version, text: 'again' })).status, 409);

    assert.equal((await j('GET', '/api/tickets/..%2Fx.md')).status, 404);
  } finally { await app.close(); }
});

test('refuses foreign host, cross-origin and non-json writes', async () => {
  const { app, port, base, j } = await setup();
  try {
    const r = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/api/tickets', headers: { host: `evil.example:${port}` } }, resolve);
    });
    assert.equal(r.statusCode, 403);
    r.resume();
    const viaProxy = await new Promise((resolve) => {
      http.get({ host: '127.0.0.1', port, path: '/api/config', headers: { host: `4321.box.localhost:${port}` } }, resolve);
    });
    assert.equal(viaProxy.statusCode, 200);
    viaProxy.resume();
    assert.equal((await j('POST', '/api/tickets', { title: 'x' }, { origin: 'http://evil.example' })).status, 403);
    const plain = await fetch(`${base}/api/tickets`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{"title":"x"}' });
    assert.equal(plain.status, 415);
  } finally { await app.close(); }
});

test('SSE announces file changes', async () => {
  const { app, dir, port } = await setup();
  try {
    const got = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no event')), 3000);
      http.get({ host: '127.0.0.1', port, path: '/api/events' }, (res) => {
        res.on('data', (c) => {
          if (String(c).includes('"changed"')) { clearTimeout(timer); res.destroy(); resolve(); }
          else if (String(c).includes('retry')) fs.writeFileSync(path.join(dir, '001-a.md'), '---\nstatus: done\n---\n# A\n');
        });
      });
    });
    await got;
  } finally { await app.close(); }
});

test('markdown renderer escapes html and handles basics', () => {
  const h = renderMarkdown('# T\n\n<script>x</script> **b** `c<d>` [x](javascript:alert(1)) [ok](https://e.com)\n\n- [x] done\n  - nested\n- [ ] todo\n\n```\n<b>\n```');
  assert.ok(!h.includes('<script>'));
  assert.ok(h.includes('<strong>b</strong>'));
  assert.ok(h.includes('<code>c&lt;d&gt;</code>'));
  assert.ok(!h.includes('href="javascript'));
  assert.ok(h.includes('href="https://e.com"'));
  assert.ok(h.includes('<input type="checkbox" disabled checked>'));
  assert.match(h, /<ul><li>.*done.*<ul><li>nested<\/li><\/ul><\/li><li>.*todo/s);
  assert.ok(h.includes('<pre><code>&lt;b&gt;</code></pre>'));
});

test('serves the frontend modules', async () => {
  const { app, base } = await setup();
  try {
    // every module the frontend imports (transitively) must be served
    const todo = ['app.js'];
    const seen = new Set();
    while (todo.length) {
      const name = todo.pop();
      if (seen.has(name)) continue;
      seen.add(name);
      const r = await fetch(`${base}/${name}`);
      assert.equal(r.status, 200, name);
      assert.match(r.headers.get('content-type'), /javascript/);
      for (const m of (await r.text()).matchAll(/(?:from\s*|import\s*\(\s*)['"]\.\/([\w.-]+\.js)['"]/g)) todo.push(m[1]);
    }
    assert.ok(seen.size > 1, 'follows imports');
    for (const p of ['/', '/style.css']) assert.equal((await fetch(base + p)).status, 200, p);
    for (const p of ['/..%2fsrc%2fserver.js', '/.hidden.js', '/nope.js', '/package.json']) assert.equal((await fetch(base + p)).status, 404, p);
  } finally { await app.close(); }
});

test('PUT /api/config reorders statuses', async () => {
  const { app, dir, j } = await setup();
  try {
    const r = await j('PUT', '/api/config', { statuses: ['done', 'open'] });
    assert.equal(r.status, 200);
    assert.deepEqual((await r.json()).statuses, ['done', 'open']);
    assert.equal((await j('PUT', '/api/config', { statuses: 'nope' })).status, 400);
  } finally { await app.close(); }
});

test('splitSummary: leading Summary section is lifted out, optional, ends at next heading', () => {
  const body = '# T\n\n## Summary\n- did x\n- To test: y\n\n## Problem\ntext\n';
  const r = splitSummary(body);
  assert.equal(r.summary, '- did x\n- To test: y');
  assert.equal(r.rest, '# T\n\n## Problem\ntext\n');
  assert.deepEqual(splitSummary('# T\n\n## Problem\nx'), { summary: null, rest: '# T\n\n## Problem\nx' });
  assert.equal(splitSummary('# T\n## Summary\n\n## P').summary, null); // empty section: ignored
  assert.equal(splitSummary('# T\n## summary\nok').summary, 'ok');
});

test('image attachments: upload, serve, limits, validate', async () => {
  const { app, dir, base } = await setup();
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const up = (body, type = 'image/png', file = '001-a.md') => fetch(`${base}/api/tickets/${file}/assets`, { method: 'POST', headers: { 'content-type': type }, body });
  try {
    let r = await up(png);
    assert.equal(r.status, 201);
    assert.equal((await r.json()).path, 'assets/001-1.png');
    assert.equal((await (await up(png)).json()).path, 'assets/001-2.png');
    r = await fetch(`${base}/assets/001-1.png`);
    assert.equal(r.status, 200);
    assert.equal(r.headers.get('content-type'), 'image/png');
    assert.deepEqual(Buffer.from(await r.arrayBuffer()), png);
    assert.equal((await fetch(`${base}/assets/..%2F001-a.md`)).status, 404);
    assert.equal((await fetch(`${base}/assets/001-a.md`)).status, 404);
    assert.equal((await up(png, 'image/svg+xml')).status, 400);
    assert.equal((await up(Buffer.from('<script>'), 'image/png')).status, 400);
    assert.equal((await up(Buffer.concat([png, Buffer.alloc(5 * 1024 * 1024)]))).status, 400);
    assert.equal((await up(png, 'image/png', 'nope.md')).status, 404);
    assert.equal((await fetch(`${base}/api/tickets/001-a.md/assets`, { method: 'POST', headers: { 'content-type': 'image/png', origin: 'http://evil.example' }, body: png })).status, 403);
    assert.equal(fs.readdirSync(path.join(dir, 'assets')).length, 2);
  } finally { await app.close(); }
});

test('markdown renders relative images only', () => {
  assert.match(renderMarkdown('![shot](assets/001-1.png)'), /<img src="assets\/001-1.png" alt="shot"/);
  assert.doesNotMatch(renderMarkdown('![x](https://evil.example/a.png)'), /<img/);
  assert.doesNotMatch(renderMarkdown('![x](javascript:alert(1))'), /<img/);
});

test('trash API: delete with version check, list, restore, purge', async () => {
  const { app, dir, j } = await setup();
  try {
    const t = await (await j('GET', '/api/tickets/001-a.md')).json();
    assert.equal((await j('DELETE', '/api/tickets/001-a.md', { version: 'stale' })).status, 409);
    assert.equal((await j('DELETE', '/api/tickets/001-a.md', {})).status, 400);
    assert.equal((await j('DELETE', '/api/tickets/001-a.md', { version: t.version })).status, 200);
    assert.equal((await (await j('GET', '/api/tickets')).json()).length, 0);
    const trash = await (await j('GET', '/api/trash')).json();
    assert.equal(trash.length, 1);
    assert.equal(trash[0].daysLeft, 30);
    const r = await j('POST', `/api/trash/${trash[0].key}/restore`, {});
    assert.equal(r.status, 200);
    assert.equal((await (await j('GET', '/api/tickets')).json()).length, 1);
    const t2 = await (await j('GET', '/api/tickets/001-a.md')).json();
    await j('DELETE', '/api/tickets/001-a.md', { version: t2.version });
    const k = (await (await j('GET', '/api/trash')).json())[0].key;
    assert.equal((await j('DELETE', `/api/trash/${k}`, {})).status, 200);
    assert.equal((await (await j('GET', '/api/trash')).json()).length, 0);
    assert.equal((await j('POST', '/api/trash/999/restore', {})).status, 404);
  } finally { await app.close(); }
});

test('serves the svg icon', async () => {
  const { app, base } = await setup();
  try {
    const r = await fetch(`${base}/icon.svg`);
    assert.equal(r.status, 200);
    assert.match(r.headers.get('content-type'), /image\/svg\+xml/);
  } finally { await app.close(); }
});
