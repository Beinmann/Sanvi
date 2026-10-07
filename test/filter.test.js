import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, formatQuery, matchTicket } from '../public/filter.js';

const T = (o) => ({ title: 'Fix login', body: 'Details about OAuth', status: 'open', area: 'ui', priority: 'high', ...o });
const m = (t, q) => matchTicket(t, parseQuery(q));

test('empty query matches everything', () => {
  assert.ok(m(T(), ''));
  assert.ok(m(T(), '   '));
});

test('free text searches title and body, case-insensitive, AND', () => {
  assert.ok(m(T(), 'login'));
  assert.ok(m(T(), 'OAUTH'));
  assert.ok(m(T(), 'login oauth'));
  assert.ok(!m(T(), 'login nothing'));
});

test('include and exclude filters', () => {
  assert.ok(m(T(), 'area:ui'));
  assert.ok(!m(T(), 'area:research'));
  assert.ok(m(T(), '-area:research'));
  assert.ok(!m(T(), '-area:ui'));
  assert.ok(m(T(), 'status:open,blocked'));
  assert.ok(!m(T({ status: 'done' }), 'status:open,blocked'));
  assert.ok(!m(T({ status: 'blocked' }), '-status:open,blocked'));
});

test('filters combine with AND, including text', () => {
  assert.ok(m(T(), 'login area:ui -status:done priority:high'));
  assert.ok(!m(T(), 'login area:ui priority:low'));
});

test('empty value means unset', () => {
  assert.ok(m(T({ area: '' }), 'area:'));
  assert.ok(!m(T(), 'area:'));
  assert.ok(m(T(), '-area:'));
});

test('unknown keys and stray syntax are text', () => {
  assert.deepEqual(parseQuery('foo:bar -x:y').words, ['foo:bar', '-x:y']);
  assert.ok(!m(T(), 'foo:bar'));
  assert.ok(m(T({ body: 'see foo:bar' }), 'foo:bar'));
  assert.doesNotThrow(() => parseQuery(':::  - -: ,'));
});

test('missing fields do not throw', () => {
  assert.ok(m({}, ''));
  assert.ok(m({}, 'area:'));
  assert.ok(!m({}, 'x'));
});

test('formatQuery round-trips normalised', () => {
  assert.equal(formatQuery(parseQuery('Login -area:Research status:open,blocked')), 'login -area:research status:open,blocked');
});
