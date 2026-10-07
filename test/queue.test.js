import test from 'node:test';
import assert from 'node:assert/strict';
import { serialQueue, coalesce, isTransient, describeFailure } from '../public/queue.js';

const tick = (ms = 5) => new Promise((r) => setTimeout(r, ms));

test('serialQueue runs tasks one at a time, in order, even after a failure', async () => {
  const run = serialQueue();
  const log = [];
  let active = 0;
  const task = (name, fail) => async () => {
    assert.equal(++active, 1, 'never two at once');
    log.push(`start ${name}`); await tick(); log.push(`end ${name}`); active--;
    if (fail) throw new Error(name);
  };
  const results = await Promise.allSettled([run(task('a')), run(task('b', true)), run(task('c'))]);
  assert.deepEqual(results.map((r) => r.status), ['fulfilled', 'rejected', 'fulfilled']);
  assert.deepEqual(log, ['start a', 'end a', 'start b', 'end b', 'start c', 'end c']);
});

test('coalesce: one run in flight, at most one more for any number of calls', async () => {
  let runs = 0;
  const f = coalesce(async () => { runs++; await tick(); });
  await Promise.all([f(), f(), f(), f()]);
  assert.equal(runs, 2);
  await f();
  assert.equal(runs, 3);
});

test('transient failures and messages', () => {
  assert.ok(isTransient(Object.assign(new Error('x'), { status: 502 })));
  assert.ok(isTransient(new TypeError('network')));
  assert.ok(!isTransient(Object.assign(new Error('x'), { status: 409 })));
  assert.ok(!isTransient(Object.assign(new Error('x'), { status: 400 })));
  assert.equal(describeFailure(400, 'Bad Request', { error: 'title is required' }), 'title is required');
  assert.match(describeFailure(502, 'Bad Gateway', {}), /Server not reachable \(HTTP 502/);
  assert.match(describeFailure(0), /not reachable/);
  assert.equal(describeFailure(418, '', {}), 'HTTP 418');
});

import { compact } from '../public/util.js';
test('compact drops null, undefined and false but keeps nodes, text and nested lists', () => {
  assert.deepEqual(compact(null, 'a', false, undefined, ['b', null, ['c', false]], 0), ['a', 'b', 'c', 0]);
  assert.deepEqual(compact(null, null), []);
});
