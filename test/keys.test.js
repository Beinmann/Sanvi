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
