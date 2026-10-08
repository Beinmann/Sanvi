import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listScratch, addScratch, deleteScratch, promoteScratch, parseScratch, listTickets, validate,
  ConflictError, ValidationError, NotFoundError,
} from '../src/core.js';
import { createTicketServer } from '../src/server.js';

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), 'tk-scratch-'));
const FILE = (d) => path.join(d, 'NOTES.md');
const at = new Date(2026, 9, 8, 9, 5);

test('add creates the file, appends, indents continuation lines', () => {
  const d = tmp();
  assert.deepEqual(listScratch(d).notes, []);
  addScratch(d, 'first', undefined, at);
  const r = addScratch(d, 'second\nline two', undefined, at);
  assert.equal(fs.readFileSync(FILE(d), 'utf8'), '# Notes\n\n- 2026-10-08 09:05: first\n- 2026-10-08 09:05: second\n  line two\n');
  assert.deepEqual(r.notes.map((n) => [n.stamp, n.text]), [['2026-10-08 09:05', 'first'], ['2026-10-08 09:05', 'second\nline two']]);
  assert.throws(() => addScratch(d, '  '), ValidationError);
});

test('hand-edited files: free text kept, plain items and blank lines tolerated', () => {
  const d = tmp();
  fs.writeFileSync(FILE(d), 'Intro text\n\n- plain item\n\n  still plain\n- 2026-01-02: dated only\n\nTrailing prose\n');
  const { notes } = listScratch(d);
  assert.deepEqual(notes.map((n) => [n.stamp, n.text]), [['', 'plain item\n\nstill plain'], ['2026-01-02', 'dated only']]);
  addScratch(d, 'new', undefined, at);
  const raw = fs.readFileSync(FILE(d), 'utf8');
  assert.match(raw, /^Intro text\n/);
  assert.match(raw, /Trailing prose\n\n- 2026-10-08 09:05: new\n$/);
  assert.equal(listScratch(d).notes.length, 3);
});

test('version check gives a conflict instead of overwriting', () => {
  const d = tmp();
  const v = addScratch(d, 'one', undefined, at).version;
  addScratch(d, 'two', v, at); // fresh version: fine
  assert.throws(() => addScratch(d, 'three', v, at), ConflictError);
  assert.throws(() => deleteScratch(d, 0, v), ConflictError);
  assert.throws(() => deleteScratch(d, 0), ConflictError); // version is required
  assert.equal(listScratch(d).notes.length, 2);
});

test('delete removes only that item', () => {
  const d = tmp();
  addScratch(d, 'a\nmore', undefined, at); addScratch(d, 'b', undefined, at);
  const r = deleteScratch(d, 0, listScratch(d).version);
  assert.deepEqual(r.notes.map((n) => n.text), ['b']);
  assert.throws(() => deleteScratch(d, 5, r.version), NotFoundError);
});

test('promote creates an idea ticket and marks the note', () => {
  const d = tmp();
  addScratch(d, 'Look into X.\nDetails', undefined, at);
  const v = listScratch(d).version;
  const r = promoteScratch(d, 0, v, { project: 'ui' });
  assert.equal(r.ticket.id, '001');
  assert.equal(r.ticket.project, 'ui');
  assert.match(r.ticket.body, /Look into X\.\nDetails/);
  assert.equal(r.notes[0].promoted, '001');
  assert.equal(r.notes[0].text, 'Look into X.\nDetails');
  assert.match(fs.readFileSync(FILE(d), 'utf8'), /Look into X\. → #001\n {2}Details/);
  assert.throws(() => promoteScratch(d, 0, r.version), ValidationError);
  assert.equal(listTickets(d).length, 1);
});

test('NOTES.md is not a ticket and does not trip validate', () => {
  const d = tmp();
  addScratch(d, 'x', undefined, at);
  assert.equal(listTickets(d).length, 0);
  assert.deepEqual(validate(d), []);
});

test('HTTP API: add, list, conflict, promote, delete', async () => {
  const d = tmp();
  const app = createTicketServer({ dir: d });
  const { port } = await app.listen(0);
  const j = (method, p, body) => fetch(`http://127.0.0.1:${port}/api${p}`, { method, headers: { 'content-type': 'application/json' }, body: body && JSON.stringify(body) });
  try {
    let r = await j('POST', '/scratch', { text: 'hello' });
    assert.equal(r.status, 201);
    const { version } = await r.json();
    r = await j('POST', '/scratch', { text: 'stale', version: 'nope' });
    assert.equal(r.status, 409);
    r = await j('DELETE', '/scratch/0', {});
    assert.equal(r.status, 400);
    r = await j('POST', '/scratch/0/promote', { version });
    assert.equal(r.status, 200);
    const p = await r.json();
    assert.equal(p.notes[0].promoted, p.ticket.id);
    r = await j('DELETE', '/scratch/0', { version: p.version });
    assert.equal(r.status, 200);
    assert.deepEqual((await (await j('GET', '/scratch')).json()).notes, []);
  } finally { await app.close(); }
});
