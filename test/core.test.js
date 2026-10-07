import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listTickets, readTicket, saveTicket, createTicket, findTicket, validate, readConfig,
  ConflictError, ValidationError, slugify,
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
