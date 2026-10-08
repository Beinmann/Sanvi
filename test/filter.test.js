import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuery, formatQuery, matchTicket, idQuery } from '../public/filter.js';

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
  assert.ok(m(T({ project: 'billing' }), 'project:billing,web'));
  assert.ok(m(T(), 'project:') && !m(T({ project: 'x' }), 'project:'));
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

import { sortTickets } from '../public/filter.js';

test('sortTickets: keys, direction, status by column order', () => {
  const ts = [
    { file: '002-b.md', id: '002', title: 'Beta', status: 'done', priority: 'low', area: 'ui', progress: { done: 1, total: 2 } },
    { file: '010-a.md', id: '010', title: 'alpha', status: 'open', priority: 'high', area: '', progress: { done: 0, total: 0 } },
    { file: '003-c.md', id: '003', title: 'Gamma', status: 'open', priority: '', area: 'cli', progress: { done: 2, total: 2 } },
  ];
  const ids = (k, d, o) => sortTickets(ts, k, d, o).map((t) => t.id);
  assert.deepEqual(ids('id'), ['002', '003', '010']);
  assert.deepEqual(ids('id', 'desc'), ['010', '003', '002']);
  assert.deepEqual(ids('title'), ['010', '002', '003']);
  assert.deepEqual(ids('status', 'asc', ['open', 'done']), ['003', '010', '002']);
  assert.deepEqual(ids('priority'), ['010', '003', '002']);
  assert.deepEqual(ids('progress', 'desc'), ['003', '002', '010']);
  assert.deepEqual(ids('nope'), ['002', '003', '010']);
  assert.equal(ts[0].id, '002'); // input untouched
});

import { moveItem } from '../public/filter.js';

test('moveItem: takes the target position, input untouched', () => {
  const l = ['a', 'b', 'c', 'd'];
  assert.deepEqual(moveItem(l, 0, 2), ['b', 'c', 'a', 'd']);
  assert.deepEqual(moveItem(l, 3, 1), ['a', 'd', 'b', 'c']);
  assert.deepEqual(moveItem(l, 1, 1), l);
  assert.deepEqual(moveItem(l, 1, 9), l);
  assert.deepEqual(l, ['a', 'b', 'c', 'd']);
});

import { checkStatusName } from '../public/filter.js';

test('checkStatusName: normalises and validates', () => {
  assert.deepEqual(checkStatusName('  Re Opened ', ['open']), { name: 're-opened', error: null });
  assert.match(checkStatusName('', []).error, /name/);
  assert.match(checkStatusName('a,b', []).error, /letters/);
  assert.match(checkStatusName('-x', []).error, /letters/);
  assert.match(checkStatusName('Open', ['open']).error, /exists/);
});

import { scoreTicket, matchedOnlyInBody } from '../public/filter.js';

test('search: title ranks above body, title: filter, id lookup, in-text marker', () => {
  const inTitle = T({ id: '012', title: 'Table view', body: 'nothing' });
  const inBody = T({ id: '013', title: 'Other', body: 'mentions table somewhere' });
  const q = parseQuery('table');
  assert.ok(matchTicket(inTitle, q) && matchTicket(inBody, q));
  assert.ok(scoreTicket(inTitle, q) > scoreTicket(inBody, q));
  assert.ok(!matchedOnlyInBody(inTitle, q) && matchedOnlyInBody(inBody, q));
  assert.ok(scoreTicket(T({ title: 'Comfortable' }), q) < scoreTicket(inTitle, q)); // word-start beats mid-word
  const t = parseQuery('title:table');
  assert.ok(matchTicket(inTitle, t) && !matchTicket(inBody, t));
  assert.equal(formatQuery(t), 'title:table');
  assert.ok(matchTicket(inTitle, parseQuery('#12')) && !matchTicket(inBody, parseQuery('#12')));
  assert.ok(matchTicket(inTitle, parseQuery('12')));
  assert.ok(scoreTicket(inTitle, '12') >= 100);
  assert.ok(!matchTicket(T({ title: 'x', body: 'issue #12 here' }), parseQuery('#12'))); // #n is id only
  assert.ok(matchTicket(T({ title: 'x', body: 'port 4321' }), parseQuery('4321'))); // bare number still text
  assert.equal(scoreTicket(inTitle, ''), 0);
  assert.deepEqual(parseQuery('title:').words, ['title:']); // malformed stays text
});

test('id queries: #33, #033 and 33 find ticket 33; #33 only by id', () => {
  const t33 = T({ id: '033', title: 'Other' });
  assert.ok(m(t33, '#33') && m(t33, '#033') && m(t33, '33') && m(t33, '033'));
  assert.ok(!m(T({ id: '034', body: 'see #33 and 33' }), '#33')); // #n never matches text
  assert.ok(m(T({ id: '034', body: 'section 33' }), '33'));       // a bare number may match text
  assert.equal(idQuery(parseQuery('#033')), 33);
  assert.equal(idQuery(parseQuery('33')), 33);
  assert.equal(idQuery(parseQuery('#33 status:open')), null);
  assert.equal(idQuery(parseQuery('login')), null);
});
