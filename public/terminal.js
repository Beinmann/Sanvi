// Terminal: interactive `claude` sessions in the browser (xterm.js, vendored) as an alternative to the chat panel.
// Output arrives over SSE (base64), input and size go back by POST. Several sessions live side by side (tabs); every
// one keeps its stream open while another is shown. Closing a tab ends its process; hiding the panel does not.
// Only active when the server runs with --agents. `start({ dir, prompt })` opens one, `openTicket(file)` the ticket's.
import { Terminal } from './xterm.mjs';
import { FitAddon } from './addon-fit.mjs';

export function initTerminal({ el, api, toast, button, project = () => '', ticketTitle = (file) => file }) {
  const panel = el('aside', { class: 'chatpanel termpanel', 'aria-label': 'Terminal with Claude Code', hidden: true });
  const tabs = el('div', { class: 'termtabs', role: 'tablist' });
  const status = el('span', { class: 'muted chatmeta' });
  const hosts = el('div', { class: 'termstack' });
  panel.append(
    el('div', { class: 'chathead' }, el('strong', {}, 'Terminal'), status, el('span', { style: 'flex:1' }),
      el('button', { type: 'button', title: 'Hide the panel; the sessions keep running', onclick: () => hide() }, 'Hide'),
      el('button', { type: 'button', title: 'End the current session', onclick: () => current && close(current.id) }, 'End session')),
    tabs, hosts);
  document.body.append(panel);
  const sessions = new Map(); // id -> { id, label, ticket, host, term, fit, source, observer, tab }
  let current = null;

  const decode = (b64) => Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const paintTabs = () => tabs.replaceChildren(...[...sessions.values()].map((s) => el('span', { class: `termtab${s === current ? ' on' : ''}`, role: 'tab', 'aria-selected': String(s === current) },
    el('button', { type: 'button', title: s.cwd, onclick: () => show(s.id) }, s.label),
    el('button', { type: 'button', class: 'termx', title: 'End this session', 'aria-label': `End ${s.label}`, onclick: () => close(s.id) }, '×'))));

  function show(id) {
    const s = sessions.get(id);
    if (!s) return;
    current = s;
    for (const o of sessions.values()) o.host.hidden = o !== s;
    panel.hidden = false;
    status.textContent = s.cwd;
    paintTabs();
    s.fit.fit();
    s.term.focus();
  }

  function drop(id) { // the view of a session goes away (ended or closed)
    const s = sessions.get(id);
    if (!s) return;
    sessions.delete(id);
    s.source.close(); s.observer.disconnect(); s.term.dispose(); s.host.remove();
    if (current === s) { current = null; const next = [...sessions.keys()].pop(); if (next) show(next); else hide(); }
    paintTabs();
  }

  function close(id) { drop(id); api('DELETE', `agent/terminals/${id}`).catch(() => {}); }

  function hide() { panel.hidden = true; button.focus(); }

  function attach(made, label) {
    if (sessions.has(made.id)) return show(made.id);
    const host = el('div', { class: 'termhost' });
    hosts.append(host);
    const term = new Terminal({ cursorBlink: true, fontSize: 14, scrollback: 5000, convertEol: false });
    const fit = new FitAddon();
    term.loadAddon(fit);
    panel.hidden = false;
    term.open(host);
    fit.fit();
    const source = new EventSource(`/api/agent/terminals/${made.id}/stream`);
    source.onmessage = (m) => term.write(decode(m.data));
    source.addEventListener('exit', () => drop(made.id)); // the process ended: the session is no longer shown
    let queue = Promise.resolve(); // keystrokes must arrive in order
    term.onData((data) => { queue = queue.then(() => api('POST', `agent/terminals/${made.id}/input`, { data })).catch(() => {}); });
    const observer = new ResizeObserver(() => {
      if (panel.hidden || host.hidden) return;
      fit.fit();
      api('POST', `agent/terminals/${made.id}/resize`, { cols: term.cols, rows: term.rows }).catch(() => {});
    });
    observer.observe(host);
    sessions.set(made.id, { id: made.id, label, cwd: made.cwd, ticket: made.ticket, host, term, fit, source, observer });
    show(made.id);
  }

  async function start({ dir = '', prompt = '' } = {}) {
    panel.hidden = false;
    try {
      const made = await api('POST', 'agent/terminals', { dir, prompt, project: project(), cols: 100, rows: 30 });
      attach(made, `Terminal ${sessions.size + 1}`);
    } catch (e) { if (!sessions.size) panel.hidden = true; toast(`Terminal failed: ${e.message}`); }
  }

  /** Shows the ticket's session, or starts one (the server decides: it reuses a running one). */
  async function openTicket(file) {
    const known = [...sessions.values()].find((s) => s.ticket === file);
    if (known) return show(known.id);
    try {
      const made = await api('POST', 'agent/terminals/ticket', { file, cols: 100, rows: 30 });
      attach(made, ticketTitle(file));
    } catch (e) { toast(`Terminal failed: ${e.message}`); }
  }

  // Fallback for the exit event (e.g. a dropped stream): sessions the server no longer lists are not shown.
  setInterval(async () => {
    if (!sessions.size) return;
    try {
      const live = new Set((await api('GET', 'agent/terminals')).map((t) => t.id));
      for (const id of [...sessions.keys()]) if (!live.has(id)) drop(id);
    } catch { /* offline: try again later */ }
  }, 5000);

  // The tab closing must not leave processes running (the server also ends them when nobody watches).
  window.addEventListener('pagehide', () => { for (const id of sessions.keys()) fetch(`/api/agent/terminals/${id}/stop`, { method: 'POST', keepalive: true }); });
  button.addEventListener('click', () => { if (!panel.hidden) hide(); else if (sessions.size) show(current?.id ?? [...sessions.keys()][0]); else start(); });

  return { start, openTicket, hide, isOpen: () => !panel.hidden, count: () => sessions.size };
}
