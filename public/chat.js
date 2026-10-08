// Chat with the agent (stage 1: one page, one chat at a time). Only active when the server runs with --agents.
import { renderMarkdown } from './md.js';

export function initChat({ el, show, api, toast, view }) {
  let chat = null; // the open chat, as last fetched
  let draft = '';

  async function open(id) {
    chat = id ? await api('GET', `agent/chats/${id}`) : await api('POST', 'agent/chats');
    paint();
  }

  async function render() {
    try {
      if (!chat) {
        const list = await api('GET', 'agent/chats');
        await open(list.length ? list[list.length - 1].id : null);
      } else paint();
    } catch (e) { toast(`Chat failed: ${e.message}`); }
  }

  async function onEvent(msg) {
    if (location.hash !== '#/chat' || !chat || msg.id !== chat.id) return;
    try { chat = await api('GET', `agent/chats/${chat.id}`); paint(); } catch { /* next event retries */ }
  }

  function bubble(m) {
    const body = el('div', { class: 'md' });
    if (m.role === 'user') body.textContent = m.text;
    else body.innerHTML = m.text ? renderMarkdown(m.text) : '';
    return el('div', { class: `msg ${m.role}` },
      el('div', { class: 'who' }, m.role === 'user' ? 'You' : 'Claude'),
      body,
      m.tools?.length ? el('div', { class: 'tools' }, `used: ${m.tools.join(', ')}`) : null);
  }

  async function submit() {
    const text = draft.trim();
    if (!text || chat.state === 'running') return;
    try { chat = await api('POST', `agent/chats/${chat.id}/messages`, { text }); draft = ''; paint(); } catch (e) { toast(`Not sent: ${e.message}`); }
  }

  function paint() {
    const running = chat.state === 'running';
    const input = el('textarea', {
      rows: 3, placeholder: 'Message Claude (Ctrl+Enter to send)', 'aria-label': 'Message',
      oninput: (e) => { draft = e.target.value; },
      onkeydown: (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); submit(); } },
    });
    input.value = draft;
    const log = el('div', { class: 'chatlog' },
      chat.messages.length ? chat.messages.map(bubble) : el('p', { class: 'muted' }, `Runs in ${chat.cwd}. Claude can read files and edit them there, nothing else.`));
    show(view, el('div', { class: 'chat' },
      el('div', { class: 'chathead' },
        el('h2', {}, chat.title),
        el('span', { class: 'muted' }, running ? 'answering…' : chat.costUsd ? `cost so far $${chat.costUsd.toFixed(3)}` : ''),
        el('button', { type: 'button', onclick: async () => { chat = null; draft = ''; await open(null); } }, 'New chat')),
      log,
      chat.error ? el('div', { class: 'banner err' }, chat.error) : null,
      el('div', { class: 'chatinput' }, input,
        running
          ? el('button', { type: 'button', onclick: () => api('POST', `agent/chats/${chat.id}/cancel`).catch((e) => toast(e.message)) }, 'Cancel')
          : el('button', { type: 'button', class: 'primary', onclick: submit }, 'Send'))));
    log.scrollTop = log.scrollHeight;
    if (!running) input.focus();
  }

  return { render, onEvent };
}
