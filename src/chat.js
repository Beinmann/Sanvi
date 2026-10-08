// Chats with an agent: one record per chat, one agent run per message (the agent's own session keeps the context).
// Held in memory; `notify(chatId)` tells the server to push a live update.
import crypto from 'node:crypto';
import { startRun as defaultRun } from './agent.js';
import { ValidationError, NotFoundError } from './core.js';

export function createChats({ cwd, notify = () => {}, run = defaultRun, maxRuns = 2, log = () => {} }) {
  const chats = new Map();
  let running = 0;

  const get = (id) => {
    const c = chats.get(id);
    if (!c) throw new NotFoundError(`no such chat: ${id}`);
    return c;
  };
  const view = (c) => ({ id: c.id, title: c.title, cwd: c.cwd, state: c.state, error: c.error, costUsd: c.costUsd, messages: c.messages, created: c.created });

  function create() {
    const c = { id: crypto.randomUUID(), title: 'New chat', cwd, state: 'idle', error: null, costUsd: 0, sessionId: null, messages: [], created: new Date().toISOString(), active: null };
    chats.set(c.id, c);
    notify(c.id);
    return view(c);
  }

  function send(id, text) {
    const c = get(id);
    text = String(text || '').trim();
    if (!text) throw new ValidationError('message is empty');
    if (c.state === 'running') throw new ValidationError('this chat is still answering');
    if (running >= maxRuns) throw new ValidationError(`too many agent runs at once (max ${maxRuns})`);

    if (!c.messages.length) c.title = text.replace(/\s+/g, ' ').slice(0, 60);
    c.messages.push({ role: 'user', text });
    const reply = { role: 'assistant', text: '', tools: [] };
    c.messages.push(reply);
    c.state = 'running';
    c.error = null;
    running++;
    const started = Date.now();
    log({ chat: c.id, action: 'agent-start' });

    const r = run({ prompt: text, cwd: c.cwd, resume: c.sessionId });
    c.active = r;
    r.onEvent((ev) => {
      if (ev.type !== 'assistant' || !Array.isArray(ev.message?.content)) return;
      for (const part of ev.message.content) {
        if (part.type === 'text') reply.text += (reply.text ? '\n\n' : '') + part.text;
        else if (part.type === 'tool_use') reply.tools.push(part.name);
      }
      notify(c.id);
    });
    r.done.then((d) => {
      running--;
      c.active = null;
      if (d.sessionId) c.sessionId = d.sessionId;
      if (d.costUsd) c.costUsd += d.costUsd;
      if (d.ok) { c.state = 'idle'; if (!reply.text) reply.text = d.text; }
      else { c.state = d.cancelled ? 'idle' : 'failed'; c.error = d.error; if (d.cancelled) reply.text += '\n\n(cancelled)'; }
      log({ chat: c.id, action: d.ok ? 'agent-finish' : d.cancelled ? 'agent-cancel' : 'agent-fail', seconds: Math.round((Date.now() - started) / 1000), costUsd: d.costUsd });
      notify(c.id);
    });
    notify(c.id);
    return view(c);
  }

  function cancel(id) {
    const c = get(id);
    c.active?.cancel();
    return view(c);
  }

  return {
    create, send, cancel,
    get: (id) => view(get(id)),
    list: () => [...chats.values()].map(({ id, title, state, created }) => ({ id, title, state, created })),
  };
}
