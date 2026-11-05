// Which Sanvi instance this tab shows. The page and its static files always come from the instance that was opened; the
// data (API, streams, attachments) can come from another local instance through that instance's `/b/<id>/...` proxy.
// Kept per tab in sessionStorage, so another tab can show another instance and a reload keeps the choice.
const KEY = 'sanvi.backend';

function read() {
  try {
    const b = JSON.parse(sessionStorage.getItem(KEY) || 'null');
    return b && /^[0-9a-f]{12}$/.test(b.id) && typeof b.name === 'string' ? b : null;
  } catch { return null; }
}
const current = read();

/** { id, name } of the chosen other instance, or null when this tab shows the instance that served it. */
export const backend = () => current;
/** URL prefix of the chosen instance ('' for the serving one). */
export const prefix = () => (current ? `/b/${current.id}` : '');
/** Key for localStorage values that belong to one instance's board (current project, recent projects, ...). */
export const scoped = (key) => (current ? `${key}@${current.id}` : key);

/** Show another instance (or, with null, the serving one) and start over: the page reloads on the board. */
export function switchBackend(b) {
  try { if (b) sessionStorage.setItem(KEY, JSON.stringify({ id: b.id, name: b.name })); else sessionStorage.removeItem(KEY); } catch { /* not remembered */ }
  location.hash = '#/';
  location.reload();
}
