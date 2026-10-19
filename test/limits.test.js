import test from 'node:test';
import assert from 'node:assert/strict';
import { createLimits, parseRateLimitEvent } from '../src/limits.js';

// Shape printed by `claude -p --output-format stream-json`.
const event = (five, seven) => ({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', rateLimitType: 'five_hour', resetsAt: 1792448400, unifiedWindows: { five_hour: { utilization: five, resetsAt: 1792448400 }, seven_day: { utilization: seven, resetsAt: 1792540800 } } } });

test('maps the 5-hour and weekly windows of a rate_limit_event to percentages', () => {
  const w = parseRateLimitEvent(event(0.485, 0.1));
  assert.equal(Math.round(w.fiveHour.percent * 10) / 10, 48.5);
  assert.equal(w.sevenDay.percent, 10);
  assert.equal(w.fiveHour.resetsAt, '2026-10-19T22:20:00.000Z');
  assert.equal(parseRateLimitEvent({ type: 'assistant' }), null);
  assert.equal(parseRateLimitEvent({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed' } }), null);
});

test('events of agent runs are recorded and served without a probe run', async () => {
  let probes = 0;
  const l = createLimits({ probe: async () => { probes++; return parseRateLimitEvent(event(0.2, 0.2)); } });
  l.record({ type: 'assistant' });
  l.record(event(0.3, 0.4));
  const { claude } = await l.get();
  assert.equal(probes, 0);
  assert.equal(claude.fiveHour.percent, 30);
  assert.equal(claude.sevenDay.percent, 40);
});

test('a probe runs only when there are no figures or on a forced refresh; failed refresh keeps old figures as stale', async () => {
  let probes = 0; let fail = false;
  const l = createLimits({ probe: async () => { probes++; if (fail) throw new Error('offline'); return parseRateLimitEvent(event(0.1, 0.1)); } });
  await l.get(); await l.get();
  assert.equal(probes, 1);
  await l.get(true);
  assert.equal(probes, 2);
  fail = true;
  const r = await l.get(true);
  assert.equal(r.claude.fiveHour.percent, 10);
  assert.match(r.claude.stale, /offline/);
});

test('reports a failed probe as an error instead of throwing', async () => {
  const l = createLimits({ probe: async () => { throw new Error('"claude" not found'); } });
  assert.match((await l.get()).claude.error, /not found/);
});
