import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createTicketServer } from '../src/server.js';
import { createChangeLog, summarizeBody } from '../src/changelog.js';

async function setup(log) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-log-'));
  const dir = path.join(root, 'tickets');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '001-a.md'), '---\nstatus: open\n---\n# A\n\n## AC\n\n- [ ] one\n');
  const app = createTicketServer({ dir, log });
  const { port } = await app.listen(0);
  const j = (method, p, body) => fetch(`http://127.0.0.1:${port}${p}`, {
    method, headers: body ? { 'content-type': 'application/json' } : {}, body: body && JSON.stringify(body),
  });
  const entries = () => {
    try { return fs.readFileSync(path.join(root, '.sanvi', 'changes.log'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; }
  };
  return { app, root, dir, j, entries };
}

test('logs create, status, edit and conflict; no bodies; ignores hand edits', async () => {
  const { app, root, dir, j, entries } = await setup({ coalesceMs: 0 });
  try {
    await j('POST', '/api/tickets', { title: 'Second', area: 'ui' });
    let t = await (await j('GET', '/api/tickets/001-a.md')).json();
    const r1 = await (await j('PUT', '/api/tickets/001-a.md', { version: t.version, fields: { status: 'done' } })).json();
    const r2 = await (await j('PUT', '/api/tickets/001-a.md', { version: r1.version, body: r1.body.replace('- [ ] one', '- [x] one\nSECRET text') })).json();
    assert.equal((await j('PUT', '/api/tickets/001-a.md', { version: t.version, fields: { status: 'open' } })).status, 409);
    await j('PUT', '/api/tickets/001-a.md', { version: r2.version, fields: { status: 'done' } }); // no-op
    fs.appendFileSync(path.join(dir, '001-a.md'), 'hand edit\n');

    const e = entries();
    assert.deepEqual(e.map((x) => x.action), ['create', 'status', 'edit', 'conflict']);
    assert.deepEqual(e[1].changes, [{ field: 'status', from: 'open', to: 'done' }]);
    assert.equal(e[2].body.ticked, 1);
    assert.deepEqual(e[2].body.sections, ['AC']);
    assert.equal(e[3].before, t.version);
    assert.ok(!fs.readFileSync(path.join(root, '.sanvi', 'changes.log'), 'utf8').includes('SECRET'));
    assert.equal(fs.readFileSync(path.join(root, '.sanvi', '.gitignore'), 'utf8'), '*\n');
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('rapid edits of one ticket coalesce into one entry', async () => {
  const { app, root, j, entries } = await setup({ coalesceMs: 60_000 });
  try {
    let t = await (await j('GET', '/api/tickets/001-a.md')).json();
    for (const n of ['x', 'y', 'z']) {
      t = await (await j('PUT', '/api/tickets/001-a.md', { version: t.version, body: `${t.body}${n}\n` })).json();
    }
    const e = entries();
    assert.equal(e.length, 1);
    assert.equal(e[0].merged, 3);
    assert.equal(e[0].body.linesAdded, 3);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('log rotates by size and keeps a fixed number of files', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-rot-'));
  const dir = path.join(root, 'tickets'); fs.mkdirSync(dir);
  try {
    const { log, file, logDir } = createChangeLog(dir, { maxBytes: 300, keep: 3, coalesceMs: 0 });
    for (let i = 0; i < 40; i++) log({ ticket: '001', action: 'status', changes: [{ field: 'status', from: 'a', to: String(i) }] });
    const files = fs.readdirSync(logDir).filter((f) => f.startsWith('changes.log')).sort();
    assert.deepEqual(files, ['changes.log', 'changes.log.1', 'changes.log.2']);
    for (const f of files) assert.ok(fs.statSync(path.join(logDir, f)).size <= 300);
    assert.ok(fs.readFileSync(file, 'utf8').includes('"39"'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('logging failure never blocks a save', async () => {
  const { app, root, dir, j } = await setup({ coalesceMs: 0 });
  try {
    fs.writeFileSync(path.join(root, '.sanvi'), 'a file, so the log dir cannot be created');
    const t = await (await j('GET', '/api/tickets/001-a.md')).json();
    const r = await j('PUT', '/api/tickets/001-a.md', { version: t.version, fields: { status: 'done' } });
    assert.equal(r.status, 200);
    assert.match(fs.readFileSync(path.join(dir, '001-a.md'), 'utf8'), /status: done/);
  } finally { await app.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('summarizeBody counts lines and sections', () => {
  const s = summarizeBody('# T\n\n## A\nx\n', '# T\n\n## A\nx\ny\n\n## B\nz\n');
  assert.equal(s.linesAdded, 3);
  assert.deepEqual(s.sections, ['A', 'B']);
});

test('data dir: .tk is migrated to .sanvi, never overwritten', async () => {
  const { dataDir } = await import('../src/datadir.js');
  const mk = () => { const r = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-mig-')); fs.mkdirSync(path.join(r, 'tickets')); return r; };
  const warnings = [];
  const warn = (m) => warnings.push(m);
  const a = mk(), b = mk(), c = mk();
  try {
    fs.mkdirSync(path.join(a, '.tk')); fs.writeFileSync(path.join(a, '.tk', 'changes.log'), 'old\n');
    assert.equal(dataDir(path.join(a, 'tickets'), warn), path.join(a, '.sanvi'));
    assert.equal(fs.readFileSync(path.join(a, '.sanvi', 'changes.log'), 'utf8'), 'old\n');
    assert.ok(!fs.existsSync(path.join(a, '.tk')));
    assert.equal(warnings.length, 0);

    for (const d of ['.tk', '.sanvi']) { fs.mkdirSync(path.join(b, d)); fs.writeFileSync(path.join(b, d, 'f'), d); }
    dataDir(path.join(b, 'tickets'), warn);
    assert.equal(fs.readFileSync(path.join(b, '.tk', 'f'), 'utf8'), '.tk');
    assert.equal(fs.readFileSync(path.join(b, '.sanvi', 'f'), 'utf8'), '.sanvi');
    assert.equal(warnings.length, 1);

    assert.equal(dataDir(path.join(c, 'tickets'), warn), path.join(c, '.sanvi'));
    assert.ok(!fs.existsSync(path.join(c, '.sanvi')) && !fs.existsSync(path.join(c, '.tk')));
    assert.equal(warnings.length, 1);
  } finally { for (const r of [a, b, c]) fs.rmSync(r, { recursive: true, force: true }); }
});
