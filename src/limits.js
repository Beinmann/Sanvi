// Plan limits of the Claude account (5-hour and weekly windows), as the Claude CLI itself reports them: every
// headless run emits a `rate_limit_event` with the utilization of both windows. So no token is read and no
// private endpoint is called: figures are recorded from the agent runs, and a manual refresh makes one tiny run.
import os from 'node:os';
import { startRun } from './agent.js';

const WINDOWS = [['fiveHour', 'five_hour', '5-hour'], ['sevenDay', 'seven_day', 'Weekly']];

/** Pulls `{ fiveHour: { label, percent, resetsAt }, sevenDay: {...} }` out of a stream event, or null if it has none. */
export function parseRateLimitEvent(ev) {
  const info = ev?.type === 'rate_limit_event' ? ev.rate_limit_info : null;
  if (!info) return null;
  const windows = { ...info.unifiedWindows };
  if (info.rateLimitType && typeof info.utilization === 'number' && !windows[info.rateLimitType]) windows[info.rateLimitType] = { utilization: info.utilization, resetsAt: info.resetsAt };
  const out = {};
  for (const [key, field, label] of WINDOWS) {
    const w = windows[field];
    if (w && typeof w.utilization === 'number') out[key] = { label, percent: w.utilization * 100, resetsAt: typeof w.resetsAt === 'number' ? new Date(w.resetsAt * 1000).toISOString() : null };
  }
  return Object.keys(out).length ? out : null;
}

// The cheapest run that still produces the event: smallest model, no tools, a one-word answer.
async function defaultProbe(run = startRun) {
  const r = run({ prompt: 'Reply with ok.', cwd: os.tmpdir(), tools: [], model: 'haiku', maxBudgetUsd: 0.05 });
  let found = null;
  r.onEvent((ev) => { found = parseRateLimitEvent(ev) || found; });
  const d = await r.done;
  if (found) return found;
  throw new Error(d.error || 'the Claude CLI reported no limits');
}

/** `{ claude: { fiveHour, sevenDay, fetchedAt } }` or `{ claude: { error } }`; never throws. */
export function createLimits({ probe = defaultProbe, now = Date.now } = {}) {
  let cached = null;
  return {
    /** Called with every event of every agent run; keeps the newest figures for free. */
    record(ev) {
      const w = parseRateLimitEvent(ev);
      if (w) cached = { ...(cached?.error ? null : cached), ...w, stale: undefined, fetchedAt: new Date(now()).toISOString() };
    },
    /** Cached figures; a probe run happens only when there are none yet or when `force` is set (manual refresh). */
    async get(force = false) {
      if (cached && !cached.error && !force) return { claude: cached };
      try {
        cached = { ...(await probe()), fetchedAt: new Date(now()).toISOString() };
      } catch (e) {
        if (cached && !cached.error) return { claude: { ...cached, stale: e.message } };
        cached = { error: `could not read the limits from the Claude CLI: ${e.message}` };
      }
      return { claude: cached };
    },
  };
}
