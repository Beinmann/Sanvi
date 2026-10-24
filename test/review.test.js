import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { newReportPath, listReviews, readReview, reviewPrompt, reviewRunOpts } from '../src/review.js';
import { createTicketServer } from '../src/server.js';

const setup = () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-review-'));
  const dir = path.join(root, 'tickets');
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, '001-a.md'), '---\nstatus: testing\n---\n# A\n');
  return dir;
};

test('report paths carry the ticket id and a repeated review gets a new file', () => {
  const dir = setup();
  const now = new Date('2026-01-02T03:04:05Z');
  const a = newReportPath(dir, '001', now);
  fs.writeFileSync(a, '# one');
  const b = newReportPath(dir, '001', now);
  assert.match(path.basename(a), /^001-20260102-030405\.md$/);
  assert.notEqual(a, b);
  fs.writeFileSync(b, '# two');
  fs.writeFileSync(path.join(path.dirname(a), '0010-20260102-030405.md'), 'other ticket');
  assert.deepEqual(listReviews(dir, '001').map((r) => r.name), [path.basename(b), path.basename(a)]);
  assert.equal(readReview(dir, path.basename(a)).text, '# one');
  assert.throws(() => readReview(dir, '../x.md'), /invalid/);
  assert.deepEqual(listReviews(dir, '002'), []);
});

test('review prompt names the report and the run may write only that file', () => {
  const p = reviewPrompt({ ticketsDir: '/t', file: '001-a.md', report: '/r/001-x.md' });
  assert.match(p, /\/r\/001-x\.md/);
  assert.match(p, /acceptance criterion/);
  const o = reviewRunOpts({ ticketsDir: '/t', report: '/r/001-x.md' });
  assert.ok(o.allowedTools.includes('Write(//r/001-x.md)'));
  assert.ok(!o.allowedTools.includes('Edit'));
});

test('review endpoint starts a review chat; reports are listed and served read-only', async () => {
  const dir = setup();
  const calls = [];
  const run = (opts) => { calls.push(opts); return { onEvent() {}, done: new Promise(() => {}), cancel() {} }; };
  const app = createTicketServer({ dir, agents: true, agentRun: run, chatsFile: null });
  const { port } = await app.listen(0);
  const j = (m, p, b) => fetch(`http://127.0.0.1:${port}${p}`, { method: m, headers: { 'content-type': 'application/json' }, body: m === 'GET' ? undefined : JSON.stringify(b ?? {}) });
  try {
    assert.deepEqual(await (await j('GET', '/api/reviews?id=001')).json(), []);
    const r = await j('POST', '/api/agent/review', { file: '001-a.md' });
    assert.equal(r.status, 201);
    assert.equal((await r.json()).kind, 'review');
    assert.match(calls[0].prompt, /reviews\/001-\d{8}-\d{6}\.md/);
    assert.equal((await j('POST', '/api/agent/review', { file: '001-a.md' })).status, 400); // still running
    assert.equal((await j('POST', '/api/agent/review', { file: 'nope.md' })).status, 404);
    fs.writeFileSync(path.join(dir, '..', '.sanvi', 'reviews', '001-20260101-000000.md'), '# done');
    const list = await (await j('GET', '/api/reviews?id=001')).json();
    assert.equal(list.length, 1);
    assert.equal((await (await j('GET', `/api/reviews/${list[0].name}`)).json()).text, '# done');
    assert.equal((await j('GET', '/api/reviews/..%2Fx.md')).status, 400);
  } finally { await app.close(); }
  const off = createTicketServer({ dir, chatsFile: null });
  const p2 = (await off.listen(0)).port;
  try {
    const r = await fetch(`http://127.0.0.1:${p2}/api/agent/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"file":"001-a.md"}' });
    assert.equal(r.status, 403);
  } finally { await off.close(); }
});
