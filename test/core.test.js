import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listTickets, readTicket, saveTicket, createTicket, findTicket, validate, readConfig, writeStatuses, writeProjects,
  ConflictError, ValidationError, slugify, createIdea, ideaTitle, addNote,
  deleteTicket, listTrash, restoreTicket, purgeTrash, purgeTrashItem, saveAsset,
} from '../src/core.js';

const SAMPLE = `---
status: open   # open | done
area: ui
custom: keep me
---

# Sample ticket

## Problem / motivation

Because.

## Acceptance criteria

- [ ] one
- [x] two
`;

function tmp() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-'));
  fs.writeFileSync(path.join(dir, '001-sample-ticket.md'), SAMPLE);
  return dir;
}

test('parses frontmatter, title and progress', () => {
  const t = readTicket(tmp(), '001-sample-ticket.md');
  assert.equal(t.id, '001');
  assert.equal(t.status, 'open');
  assert.equal(t.area, 'ui');
  assert.equal(t.title, 'Sample ticket');
  assert.deepEqual(t.progress, { done: 1, total: 2 });
});

test('status change touches only the status line', () => {
  const dir = tmp();
  const t = readTicket(dir, '001-sample-ticket.md');
  saveTicket(dir, t.file, { fields: { status: 'done' } }, t.version);
  const raw = fs.readFileSync(path.join(dir, t.file), 'utf8');
  assert.equal(raw, SAMPLE.replace('status: open   # open | done', 'status: done'));
});

test('no-op save does not rewrite the file', () => {
  const dir = tmp();
  const t = readTicket(dir, '001-sample-ticket.md');
  const before = fs.statSync(path.join(dir, t.file)).mtimeMs;
  const r = saveTicket(dir, t.file, { fields: { status: 'open', area: 'ui' }, body: t.body }, t.version);
  assert.equal(r.version, t.version);
  assert.equal(fs.statSync(path.join(dir, t.file)).mtimeMs, before);
});

test('stale version is refused and nothing is written', () => {
  const dir = tmp();
  const t = readTicket(dir, '001-sample-ticket.md');
  fs.appendFileSync(path.join(dir, t.file), '\nedited elsewhere\n');
  const after = fs.readFileSync(path.join(dir, t.file), 'utf8');
  assert.throws(() => saveTicket(dir, t.file, { body: 'mine' }, t.version), ConflictError);
  assert.equal(fs.readFileSync(path.join(dir, t.file), 'utf8'), after);
});

test('clearing and adding optional fields', () => {
  const dir = tmp();
  let t = readTicket(dir, '001-sample-ticket.md');
  t = saveTicket(dir, t.file, { fields: { priority: 'high' } }, t.version);
  assert.equal(t.priority, 'high');
  t = saveTicket(dir, t.file, { fields: { priority: '', area: '' } }, t.version);
  assert.equal(t.priority, '');
  assert.equal(t.area, '');
  assert.equal(t.fields.custom, 'keep me');
});

test('rejects multi-line field values and bad names', () => {
  const dir = tmp();
  const t = readTicket(dir, '001-sample-ticket.md');
  assert.throws(() => saveTicket(dir, t.file, { fields: { status: 'a\nb: c' } }, t.version), ValidationError);
  assert.throws(() => saveTicket(dir, t.file, { fields: { 'a b': 'x' } }, t.version), ValidationError);
  assert.throws(() => saveTicket(dir, '../x.md', {}, 'v'));
});

test('values needing quotes round-trip', () => {
  const dir = tmp();
  let t = readTicket(dir, '001-sample-ticket.md');
  t = saveTicket(dir, t.file, { fields: { area: 'a: b # c' } }, t.version);
  assert.equal(t.area, 'a: b # c');
});

test('create uses next id, slug and first status', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '_config.yml'), 'statuses:\n  - todo\n  - done\n');
  const t = createTicket(dir, { title: 'Fix: the Ünïcode thing!', area: 'cli' });
  assert.equal(t.file, '002-fix-the-unicode-thing.md');
  assert.equal(t.status, 'todo');
  assert.equal(t.title, 'Fix: the Ünïcode thing!');
  assert.equal(listTickets(dir).length, 2);
  assert.throws(() => createTicket(dir, { title: '  ' }), ValidationError);
});

test('findTicket by id, number and slug', () => {
  const dir = tmp();
  for (const ref of ['001', '1', 'sample-ticket', '001-sample-ticket']) assert.equal(findTicket(dir, ref).id, '001');
});

test('config: flow list, block list, default', () => {
  const dir = tmp();
  assert.equal(readConfig(dir).configured, false);
  fs.writeFileSync(path.join(dir, '_config.yml'), 'statuses: [a, "b", c]\n');
  assert.deepEqual(readConfig(dir).statuses, ['a', 'b', 'c']);
  fs.writeFileSync(path.join(dir, '_config.yml'), 'statuses:\n  - x  # first\n  - y\n');
  assert.deepEqual(readConfig(dir).statuses, ['x', 'y']);
});

test('validate flags problems but tolerates unknown statuses', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '002-bad.md'), '# no frontmatter\n');
  fs.writeFileSync(path.join(dir, '003-odd.md'), '---\nstatus: weird\n---\n# T\n## Problem\n## Acceptance criteria\n');
  const p = validate(dir);
  assert.ok(p.some((x) => x.file === '002-bad.md' && x.level === 'error'));
  assert.ok(p.some((x) => x.file === '003-odd.md' && x.level === 'warn' && /weird/.test(x.message)));
  assert.ok(!p.some((x) => x.file === '001-sample-ticket.md'));
});

test('slugify', () => {
  assert.equal(slugify('  Hello,   World! '), 'hello-world');
  assert.equal(slugify('日本語'), 'ticket');
});

test('createIdea derives a title and keeps the text verbatim', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-idea-'));
  try {
    const t = createIdea(dir, { text: 'Let me capture ideas fast. Second sentence here.\nMore detail.' });
    assert.equal(t.status, 'design');
    assert.equal(t.title, 'Let me capture ideas fast');
    assert.match(t.body, /Second sentence here\.\nMore detail\./);
    assert.throws(() => createIdea(dir, { text: '  ' }), /required/);
    assert.throws(() => createIdea(dir, { text: 5 }), /string/);
    assert.equal(ideaTitle('x'.repeat(100)).length <= 61, true);
    assert.match(ideaTitle('word '.repeat(30)), /word…$/);
  } finally { fs.rmSync(dir, { recursive: true }); }
});

test('writeStatuses: replaces flow/block list in place, keeps other lines, validates', () => {
  const dir = tmp();
  writeStatuses(dir, ['b', 'a']);
  assert.deepEqual(readConfig(dir).statuses, ['b', 'a']);
  fs.writeFileSync(path.join(dir, '_config.yml'), 'name: x\nstatuses:\n  - x  # first\n  - y\nother: 1\n');
  writeStatuses(dir, ['y', 'x']);
  assert.equal(fs.readFileSync(path.join(dir, '_config.yml'), 'utf8'), 'name: x\nstatuses: [y, x]\nother: 1\n');
  assert.throws(() => writeStatuses(dir, ['a', 'a']), /distinct/);
  assert.throws(() => writeStatuses(dir, []), /statuses/);
  assert.throws(() => writeStatuses(dir, ['a,b']), /statuses/);
});

test('writeStatuses: removing a status keeps the other config lines and never touches tickets', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '_config.yml'), 'name: x\nstatuses: [a, b, c]\nother: 1\n');
  fs.writeFileSync(path.join(dir, '001-t.md'), '---\nstatus: b\n---\n\n# T\n');
  writeStatuses(dir, ['a', 'c']);
  assert.equal(fs.readFileSync(path.join(dir, '_config.yml'), 'utf8'), 'name: x\nstatuses: [a, c]\nother: 1\n');
  assert.equal(readTicket(dir, '001-t.md').status, 'b');
});

test('addNote appends to Notes, creates the section, keeps the rest and handles CRLF', () => {
  const dir = tmp();
  const now = new Date(2026, 9, 7, 9, 5);
  try {
    fs.writeFileSync(path.join(dir, '001-a.md'), SAMPLE + '\n## Notes\n\n- 2026-10-01: first\n\n## After\n\nx\n');
    let t = addNote(dir, '001-a.md', 'tried it\nstill broken', readTicket(dir, '001-a.md').version, now);
    const raw = fs.readFileSync(path.join(dir, '001-a.md'), 'utf8');
    assert.match(raw, /- 2026-10-01: first\n- 2026-10-07 09:05: tried it\n  still broken\n\n## After\n\nx\n$/);
    assert.ok(raw.startsWith(SAMPLE.slice(0, 40)));

    fs.writeFileSync(path.join(dir, '002-b.md'), SAMPLE);
    addNote(dir, '002-b.md', 'hi', readTicket(dir, '002-b.md').version, now);
    assert.match(fs.readFileSync(path.join(dir, '002-b.md'), 'utf8'), /- \[x\] two\n\n## Notes\n\n- 2026-10-07 09:05: hi\n$/);

    fs.writeFileSync(path.join(dir, '003-c.md'), SAMPLE.replace(/\n/g, '\r\n') + '\r\n## Notes   \r\n');
    addNote(dir, '003-c.md', 'crlf', readTicket(dir, '003-c.md').version, now);
    const crlf = fs.readFileSync(path.join(dir, '003-c.md'), 'utf8');
    assert.match(crlf, /## Notes\s*\r\n\r\n- 2026-10-07 09:05: crlf\r\n$/);
    assert.equal(/[^\r]\n/.test(crlf.slice(crlf.indexOf('# Sample'))), false); // body stays CRLF

    assert.throws(() => addNote(dir, '001-a.md', 'x', 'stale', now), ConflictError);
    assert.throws(() => addNote(dir, '001-a.md', '  ', t.version, now), ValidationError);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('validate warns about dangling image links', () => {
  const dir = tmp();
  try {
    fs.mkdirSync(path.join(dir, 'assets'));
    fs.writeFileSync(path.join(dir, 'assets', 'ok.png'), 'x');
    fs.writeFileSync(path.join(dir, '001-a.md'), SAMPLE + '\n![a](assets/ok.png)\n![b](assets/gone.png)\n![c](https://x.example/c.png)\n![d](../../etc/passwd)\n');
    const msgs = validate(dir).map((p) => p.message);
    assert.deepEqual(msgs.filter((m) => m.startsWith('image')), ['image not found: assets/gone.png', 'image not found: ../../etc/passwd']);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('trash: delete, list, restore, id reuse, retention, images', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-trash-'));
  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(8)]);
  try {
    fs.writeFileSync(path.join(dir, '001-a.md'), SAMPLE);
    fs.writeFileSync(path.join(dir, '002-b.md'), SAMPLE);
    const img = saveAsset(dir, '001-a.md', png, 'image/png');
    fs.writeFileSync(path.join(dir, '001-a.md'), SAMPLE + `\n![x](${img})\n`);
    const t = readTicket(dir, '001-a.md');
    assert.throws(() => deleteTicket(dir, '001-a.md', 'stale'), ConflictError);
    const day = 86_400_000;
    const gone = deleteTicket(dir, '001-a.md', t.version, Date.now() - 29 * day);
    assert.deepEqual(listTickets(dir).map((x) => x.file), ['002-b.md']);
    assert.equal(fs.existsSync(path.join(dir, img)), false);
    assert.equal(listTrash(dir).length, 1);
    assert.equal(listTrash(dir)[0].daysLeft, 1);
    assert.equal(validate(dir).filter((p) => p.file.includes('001')).length, 0);
    assert.equal(createTicket(dir, { title: 'new' }).id, '003'); // id 001 stays reserved, 002 is taken

    // restore: same name when free
    let r = restoreTicket(dir, gone.key);
    assert.equal(r.file, '001-a.md');
    assert.equal(fs.existsSync(path.join(dir, img)), true);
    assert.equal(listTrash(dir).length, 0);

    // restore when the id was reused: next free id, links and image names follow, a note says why
    const t2 = readTicket(dir, '001-a.md');
    const g2 = deleteTicket(dir, '001-a.md', t2.version);
    fs.writeFileSync(path.join(dir, '001-other.md'), SAMPLE);
    r = restoreTicket(dir, g2.key);
    assert.equal(r.id, '004');
    assert.match(r.body, /assets\/004-1\.png/);
    assert.match(r.body, /Restored from the trash; the old id #001/);
    assert.equal(fs.existsSync(path.join(dir, 'assets', '004-1.png')), true);

    // retention
    const old = deleteTicket(dir, '002-b.md', readTicket(dir, '002-b.md').version, Date.now() - 31 * day);
    const fresh = deleteTicket(dir, '001-other.md', readTicket(dir, '001-other.md').version);
    assert.equal(purgeTrash(dir), 1);
    assert.deepEqual(listTrash(dir).map((x) => x.key), [fresh.key]);
    assert.throws(() => restoreTicket(dir, old.key), /not in the trash/);
    purgeTrashItem(dir, fresh.key);
    assert.equal(listTrash(dir).length, 0);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
});

test('project field and projects config list', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-proj-'));
  const t = createTicket(dir, { title: 'In a project', project: 'billing' });
  assert.equal(t.project, 'billing');
  assert.equal(saveTicket(dir, t.file, { fields: { project: '' } }, t.version).project, '');
  assert.deepEqual(readConfig(dir).projects, []);
  writeProjects(dir, ['a', 'b']);
  assert.deepEqual(readConfig(dir).projects, ['a', 'b']);
  writeStatuses(dir, ['open', 'done']);
  writeProjects(dir, ['a', 'b', 'c']);
  const cfg = readConfig(dir);
  assert.deepEqual(cfg.projects, ['a', 'b', 'c']);
  assert.deepEqual(cfg.statuses, ['open', 'done']);
  assert.throws(() => writeProjects(dir, ['a', 'a']));
});

test('parallel processes never get the same ticket id', async () => {
  const { spawn } = await import('node:child_process');
  const dir = tmp();
  const core = new URL('../src/core.js', import.meta.url).href;
  const run = (i) => new Promise((resolve, reject) => {
    const c = spawn(process.execPath, ['-e', `import('${core}').then((m) => console.log(m.createTicket(${JSON.stringify(dir)}, { title: 'Ticket ' + process.argv[1] }).id))`, String(i)]);
    let out = '';
    c.stdout.on('data', (d) => { out += d; });
    c.on('exit', (code) => (code === 0 ? resolve(out.trim()) : reject(new Error(`exit ${code}`))));
  });
  const ids = await Promise.all(Array.from({ length: 8 }, (_, i) => run(i)));
  assert.equal(new Set(ids).size, 8, ids.join(','));
  assert.deepEqual(validate(dir).filter((p) => /duplicate/.test(p.message)), []);
  fs.rmSync(path.join(dir, '001-sample-ticket.md'));
  assert.equal(Number(createTicket(dir, { title: 'After hard delete' }).id), 10); // markers keep ids from being reused
});

test('validate still reports hand-made duplicate ids', () => {
  const dir = tmp();
  fs.writeFileSync(path.join(dir, '001-other.md'), SAMPLE);
  assert.ok(validate(dir).some((p) => /duplicate id/.test(p.message)));
});
