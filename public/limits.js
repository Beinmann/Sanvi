// Header display of the Claude plan limits (5-hour and weekly windows). Only used with --agents.
const EVERY_MS = 2 * 60 * 1000;

export function initLimits({ el, api, toast, node }) {
  let timer = null;
  const resetIn = (iso) => {
    const ms = Date.parse(iso) - Date.now();
    if (!(ms > 0)) return 'resets soon';
    const m = Math.round(ms / 60000);
    return m < 90 ? `resets in ${m} min` : m < 48 * 60 ? `resets in ${Math.round(m / 60)} h` : `resets in ${Math.round(m / 1440)} d`;
  };
  function paint(data) {
    const c = data?.claude;
    node.replaceChildren();
    node.hidden = false;
    if (!c || c.error) {
      node.append(el('span', { class: 'muted' }, 'Claude limits: n/a'));
      node.title = `${c?.error || 'no data'}\nClick to retry`;
      return;
    }
    const parts = ['fiveHour', 'sevenDay'].filter((k) => c[k]).map((k) => {
      const w = c[k];
      const pct = Math.round(w.percent);
      return el('span', { class: `lim${pct >= 90 ? ' hot' : pct >= 70 ? ' warm' : ''}`, title: `${w.label} limit: ${pct}% used${w.resetsAt ? `, ${resetIn(w.resetsAt)}` : ''}` }, `${k === 'fiveHour' ? '5h' : 'wk'} ${pct}%`);
    });
    node.append(...parts);
    node.title = `Claude plan limits (click to refresh)${c.stale ? `\nShowing older data: ${c.stale}` : ''}`;
  }
  async function refresh(force = false) {
    try { paint(await api('GET', `agent/limits${force ? '?refresh=1' : ''}`)); }
    catch (e) { paint({ claude: { error: e.message } }); }
  }
  node.addEventListener('click', () => refresh(true));
  return {
    start() { refresh(); clearInterval(timer); timer = setInterval(() => { if (!document.hidden) refresh(); }, EVERY_MS); },
    refresh: async () => { await refresh(true); toast('Claude limits refreshed'); },
  };
}
