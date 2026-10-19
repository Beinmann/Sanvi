import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLimits } from '../src/limits.js';

const home = (token) => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-lim-'));
  if (token) fs.writeFileSync(path.join(d, '.credentials.json'), JSON.stringify({ claudeAiOauth: { accessToken: token } }));
  return d;
};
const ok = (body) => async () => ({ ok: true, status: 200, json: async () => body });

test('maps the 5-hour and weekly windows and sends the token only upstream', async () => {
  let seen;
  const l = createLimits({ configDir: home('tok'), fetchFn: async (u, o) => { seen = o.headers; return ok({ five_hour: { utilization: 42.5, resets_at: '2030-01-01T00:00:00Z' }, seven_day: { utilization: 10, resets_at: null } })(); } });
  const { claude } = await l.get();
  assert.equal(seen.authorization, 'Bearer tok');
  assert.equal(claude.fiveHour.percent, 42.5);
  assert.equal(claude.sevenDay.percent, 10);
  assert.ok(!JSON.stringify(claude).includes('tok"'));
});

test('caches until forced; keeps old figures (marked stale) when a refresh fails', async () => {
  let calls = 0; let fail = false;
  const l = createLimits({ configDir: home('t'), fetchFn: async () => { calls++; return fail ? { ok: false, status: 500 } : ok({ five_hour: { utilization: 1 } })(); } });
  await l.get(); await l.get();
  assert.equal(calls, 1);
  fail = true;
  const r = await l.get(true);
  assert.equal(calls, 2);
  assert.equal(r.claude.fiveHour.percent, 1);
  assert.match(r.claude.stale, /500/);
});

test('reports a missing login or failed query as an error instead of throwing', async () => {
  assert.match((await createLimits({ configDir: home(null) }).get()).claude.error, /login/);
  const l = createLimits({ configDir: home('t'), fetchFn: async () => { throw new Error('offline'); } });
  assert.match((await l.get()).claude.error, /offline/);
});
