import test from 'node:test';
import assert from 'node:assert/strict';
import { matches, step, navigate, isTyping } from '../public/keys.js';

test('matches: all tokens, case-insensitive, # ignored', () => {
  assert.ok(matches('#005 Keyboard-first workflow', '005 key'));
  assert.ok(matches('#005 Keyboard-first workflow', '#005'));
  assert.ok(!matches('#005 Keyboard', 'table'));
  assert.ok(matches('anything', ''));
});

test('step: within and across columns, skipping empty ones', () => {
  const cols = [['a', 'b', 'c'], [], ['d'], ['e', 'f']];
  assert.deepEqual(step(cols, null, 'next'), { col: 0, row: 0 });
  assert.deepEqual(step(cols, { col: 0, row: 2 }, 'next'), { col: 0, row: 2 });
  assert.deepEqual(step(cols, { col: 0, row: 1 }, 'prev'), { col: 0, row: 0 });
  assert.deepEqual(step(cols, { col: 0, row: 2 }, 'right'), { col: 2, row: 0 });
  assert.deepEqual(step(cols, { col: 3, row: 1 }, 'left'), { col: 2, row: 0 });
  assert.deepEqual(step(cols, { col: 3, row: 1 }, 'right'), { col: 3, row: 1 });
  assert.equal(step([[], []], null, 'next'), null);
});

test('isTyping', () => {
  assert.ok(isTyping({ tagName: 'TEXTAREA' }));
  assert.ok(isTyping({ tagName: 'SELECT' }));
  assert.ok(!isTyping({ tagName: 'A' }));
  assert.ok(!isTyping(null));
});

test('navigate: selection, last selection and vanished selection', () => {
  const cols = [['a', 'b'], [], ['c', 'd']];
  assert.equal(navigate(cols, 'a', null, 'next'), 'b');
  assert.equal(navigate(cols, 'b', null, 'right'), 'd');
  assert.equal(navigate(cols, null, 'd', 'next'), 'd');     // nothing selected: come back to the last one
  assert.equal(navigate(cols, null, 'c', 'left'), 'c');
  assert.equal(navigate(cols, null, 'gone', 'next'), 'a');  // the last one vanished: first card
  assert.equal(navigate(cols, 'gone', null, 'next'), 'a');  // the selection vanished
  assert.equal(navigate(cols, null, null, 'right'), 'a');
  assert.equal(navigate([[], []], null, null, 'next'), null);
});

import { parseTicketRef, ticketsByRef } from '../public/keys.js';

test('parseTicketRef: #20, #020 and 20 are ticket ids, text is not', () => {
  assert.equal(parseTicketRef('#20'), 20);
  assert.equal(parseTicketRef('#020'), 20);
  assert.equal(parseTicketRef(' 20 '), 20);
  assert.equal(parseTicketRef('20a'), null);
  assert.equal(parseTicketRef('table'), null);
  assert.equal(parseTicketRef(''), null);
});

test('ticketsByRef: exact id first, else id prefix', () => {
  const ts = ['002', '020', '021', '200'].map((id) => ({ id }));
  assert.deepEqual(ticketsByRef(ts, 20).map((t) => t.id), ['020']);
  assert.deepEqual(ticketsByRef(ts, 2).map((t) => t.id), ['002']);
  assert.deepEqual(ticketsByRef(ts, 21).map((t) => t.id), ['021']);
  assert.deepEqual(ticketsByRef([{ id: '020' }, { id: '021' }, { id: '200' }], 2).map((t) => t.id), ['020', '021', '200']);
});
