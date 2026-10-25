// Terminal: the interactive `claude` CLI in the browser (xterm.js, vendored) as an alternative to the chat panel.
// Output arrives over SSE (base64), input and size go back by POST. Closing the panel ends the process.
// Only active when the server runs with --agents. `start({ dir, prompt })` opens one programmatically.
import { Terminal } from './xterm.mjs';
import { FitAddon } from './addon-fit.mjs';

export function initTerminal({ el, api, toast, button, project = () => '' }) {
  const panel = el('aside', { class: 'chatpanel termpanel', 'aria-label': 'Terminal with Claude Code', hidden: true });
  document.body.append(panel);
  let session = null; // { id, term, fit, source, observer, send }

  const decode = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));

  function end() { // ends the process and drops the view
    if (!session) return;
    const s = session;
    session = null;
    s.source.close(); s.observer.disconnect(); s.term.dispose();
    api('DELETE', `agent/terminals/${s.id}`).catch(() => {});
  }

  function close() { end(); panel.hidden = true; panel.replaceChildren(); button.focus(); }

  async function start({ dir = '', prompt = '' } = {}) {
    end();
    const host = el('div', { class: 'termhost' });
    const status = el('span', { class: 'muted chatmeta' }, 'starting…');
    panel.replaceChildren(
      el('div', { class: 'chathead' }, el('strong', {}, 'Terminal'), status, el('span', { style: 'flex:1' }),
        el('button', { type: 'button', title: 'End the session and close', onclick: close }, 'Close (ends the session)')),
      host);
    panel.hidden = false;
    const term = new Terminal({ cursorBlink: true, fontSize: 14, scrollback: 5000, convertEol: false });
    const fit = new FitAddon();
    term.loadAddon(fit);
    term.open(host);
    fit.fit();
    let made;
    try { made = await api('POST', 'agent/terminals', { dir, prompt, project: project(), cols: term.cols, rows: term.rows }); } catch (e) {
      term.dispose(); panel.hidden = true; panel.replaceChildren(); toast(`Terminal failed: ${e.message}`); return;
    }
    const source = new EventSource(`/api/agent/terminals/${made.id}/stream`);
    source.onmessage = (m) => term.write(decode(m.data));
    source.addEventListener('exit', () => { status.textContent = 'ended'; source.close(); });
    let queue = Promise.resolve(); // keystrokes must arrive in order
    const send = (data) => { queue = queue.then(() => api('POST', `agent/terminals/${made.id}/input`, { data })).catch(() => {}); };
    term.onData(send);
    const sync = () => { fit.fit(); api('POST', `agent/terminals/${made.id}/resize`, { cols: term.cols, rows: term.rows }).catch(() => {}); };
    const observer = new ResizeObserver(() => { if (!panel.hidden) sync(); });
    observer.observe(host);
    session = { id: made.id, term, fit, source, observer, send };
    status.textContent = made.cwd;
    term.focus();
  }

  // The tab closing must not leave the process running (the server also ends it when nobody watches).
  window.addEventListener('pagehide', () => { if (session) fetch(`/api/agent/terminals/${session.id}/stop`, { method: 'POST', keepalive: true }); });
  button.addEventListener('click', () => (panel.hidden ? start() : close()));

  return { start, close, isOpen: () => !panel.hidden };
}
