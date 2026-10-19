// Plan limits of the Claude account (5-hour and weekly windows), as the Claude CLI itself reads them.
// The OAuth token stays on the server; the UI only gets percentages and reset times.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const URL_USAGE = 'https://api.anthropic.com/api/oauth/usage';
const WINDOWS = [['fiveHour', 'five_hour', '5-hour'], ['sevenDay', 'seven_day', 'Weekly']];

function readToken(configDir) {
  const file = path.join(configDir || process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude'), '.credentials.json');
  try { return JSON.parse(fs.readFileSync(file, 'utf8')).claudeAiOauth?.accessToken || null; } catch { return null; }
}

/** `{ claude: { fiveHour: { percent, resetsAt }, sevenDay: {...} } }` or `{ claude: { error } }`; never throws. */
export function createLimits({ fetchFn = fetch, configDir, ttlMs = 30_000, now = Date.now } = {}) {
  let cached = null;
  let at = 0;
  async function load() {
    const token = readToken(configDir);
    if (!token) return { error: 'no Claude login found (run `claude` and log in)' };
    try {
      const res = await fetchFn(URL_USAGE, { headers: { authorization: `Bearer ${token}`, 'anthropic-beta': 'oauth-2025-04-20', accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
      if (!res.ok) return { error: `usage query failed (HTTP ${res.status})` };
      const body = await res.json();
      const out = { fetchedAt: new Date(now()).toISOString() };
      for (const [key, field, label] of WINDOWS) {
        const w = body[field];
        if (w && typeof w.utilization === 'number') out[key] = { label, percent: w.utilization, resetsAt: w.resets_at || null };
      }
      return Object.keys(out).length > 1 ? out : { error: 'usage response had no limit windows' };
    } catch (e) { return { error: `usage query failed: ${e.message}` }; }
  }
  return {
    /** Cached for `ttlMs` so several tabs do not hammer the API; `force` skips the cache (manual refresh). */
    async get(force = false) {
      if (!force && cached && now() - at < ttlMs) return { claude: cached };
      const fresh = await load();
      if (fresh.error && cached && !cached.error) return { claude: { ...cached, stale: fresh.error } };
      cached = fresh; at = now();
      return { claude: cached };
    },
  };
}
