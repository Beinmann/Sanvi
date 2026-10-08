// Chats with an agent: one record per chat, one agent run per message (the agent's own session keeps the context).
// Kept in memory and saved to `file` (outside any repo) so chats survive a restart; `notify(chatId)` pushes a live update.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRun as defaultRun } from './agent.js';
import { ValidationError, NotFoundError } from './core.js';

// A directory the agent may run in: absolute (or ~/...), existing, resolved through symlinks.
export function resolveDir(input) {
  let p = String(input ?? '').trim();
  if (p === '~' || p.startsWith('~/')) p = path.join(os.homedir(), p.slice(1));
  if (!path.isAbsolute(p)) throw new ValidationError('directory must be an absolute path (or start with ~/)');
  try {
    const real = fs.realpathSync(p);
    if (!fs.statSync(real).isDirectory()) throw new Error('not a directory');
    return real;
  } catch { throw new ValidationError(`not a directory: ${p}`); }
}

export function createChats({ cwd, file, check, notify = () => {}, run = defaultRun, maxRuns = 2, log = () => {} }) {
  const chats = new Map();
  let dirs = {}; // project name -> directory its chats start in
  let running = 0;
  const pending = []; // ids of chats waiting for a free slot

  const persisted = ({ active, ...c }) => c;
  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ chats: [...chats.values()].map(persisted), dirs }));
      fs.renameSync(`${file}.tmp`, file);
    } catch (e) { console.error(`could not save chats: ${e.message}`); }
  }
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    dirs = Array.isArray(saved) ? {} : saved.dirs || {};
    for (const c of Array.isArray(saved) ? saved : saved.chats) {
      if (c.state === 'running' || c.state === 'queued') { // the run died with the previous server
        c.state = 'failed'; c.error = 'interrupted by a server restart';
        c.messages.at(-1).text ||= '(interrupted)';
      }
      chats.set(c.id, { ...c, active: null });
    }
  } catch { /* no saved chats yet, or unreadable: start empty */ }

  const touch = (id) => { save(); notify(id); };

  const get = (id) => {
    const c = chats.get(id);
    if (!c) throw new NotFoundError(`no such chat: ${id}`);
    return c;
  };
  const view = (c) => ({ id: c.id, title: c.title, kind: c.kind || 'chat', outcome: c.outcome || null, warning: c.warning || null, cwd: c.cwd, state: c.state, error: c.error, costUsd: c.costUsd, messages: c.messages, created: c.created });

  const dirFor = (project) => (project && dirs[project]) || cwd;

  // `dir` is explicit; otherwise the project's remembered directory; otherwise the default.
  function create({ dir, project, title = 'New chat', kind = 'chat', runOpts, meta, preamble } = {}) {
    const c = { id: crypto.randomUUID(), title, kind, runOpts, meta, preamble, cwd: dir ? resolveDir(dir) : dirFor(project), state: 'idle', error: null, costUsd: 0, sessionId: null, messages: [], created: new Date().toISOString(), active: null };
    chats.set(c.id, c);
    touch(c.id);
    return view(c);
  }

  // `text` is what the chat shows; `prompt` (default: the same) is what the agent gets.
  // `queue: true` waits for a free slot instead of failing when too many runs are active.
  function send(id, text, { prompt, queue = false } = {}) {
    const c = get(id);
    text = String(text || '').trim();
    if (!text) throw new ValidationError('message is empty');
    if (c.state === 'running' || c.state === 'queued') throw new ValidationError('this chat is still answering');
    if (running >= maxRuns && !queue) throw new ValidationError(`too many agent runs at once (max ${maxRuns})`);

    const first = !c.messages.length;
    if (first && (c.title === 'New chat' || c.kind === 'ask')) c.title = `${c.kind === 'ask' ? 'Ask: ' : ''}${text.replace(/\s+/g, ' ').slice(0, 60)}`;
    c.messages.push({ role: 'user', text });
    c.messages.push({ role: 'assistant', text: '', tools: [] });
    c.error = null;
    c.prompt = prompt || (first && c.preamble ? `${c.preamble}\n\n${text}` : text);
    c.outcome = null;
    c.warning = null;
    if (running >= maxRuns) { c.state = 'queued'; pending.push(c.id); touch(c.id); return view(c); }
    launch(c);
    return view(c);
  }

  function launch(c) {
    const reply = c.messages.at(-1);
    c.state = 'running';
    running++;
    const started = Date.now();
    log({ chat: c.id, action: 'agent-start' });

    const r = run({ prompt: c.prompt, cwd: c.cwd, resume: c.sessionId, ...c.runOpts });
    c.active = r;
    r.onEvent((ev) => {
      if (ev.type !== 'assistant' || !Array.isArray(ev.message?.content)) return;
      for (const part of ev.message.content) {
        if (part.type === 'text') reply.text += (reply.text ? '\n\n' : '') + part.text;
        else if (part.type === 'tool_use') reply.tools.push(part.name);
      }
      touch(c.id);
    });
    r.done.then((d) => {
      running--;
      c.active = null;
      if (d.sessionId) c.sessionId = d.sessionId;
      if (d.costUsd) c.costUsd += d.costUsd;
      if (d.ok) {
        c.state = 'idle'; if (!reply.text) reply.text = d.text;
        const verdict = check?.(c, d) || {};
        const warnings = [verdict.warning, d.denials ? `${d.denials} tool call${d.denials > 1 ? 's were' : ' was'} refused (a headless run cannot ask for permission)` : null].filter(Boolean);
        c.outcome = d.denials ? 'problems' : verdict.outcome || 'ok';
        c.warning = warnings.join('; ') || null;
      }
      else { c.state = d.cancelled ? 'idle' : 'failed'; c.error = d.error; if (d.cancelled) reply.text += '\n\n(cancelled)'; }
      log({ chat: c.id, action: d.ok ? 'agent-finish' : d.cancelled ? 'agent-cancel' : 'agent-fail', seconds: Math.round((Date.now() - started) / 1000), costUsd: d.costUsd });
      touch(c.id);
      while (running < maxRuns && pending.length) { const next = chats.get(pending.shift()); if (next?.state === 'queued') launch(next); }
    });
    touch(c.id);
  }

  // Claude keeps sessions per directory, so a chat can only change directory before its first message.
  function setCwd(id, dir) {
    const c = get(id);
    if (c.messages.length) throw new ValidationError('the directory cannot change once the chat has started; open a new chat');
    c.cwd = resolveDir(dir);
    touch(c.id);
    return view(c);
  }

  function setProjectDir(project, dir) {
    project = String(project || '').trim();
    if (!project) throw new ValidationError('project is required');
    if (dir) dirs[project] = resolveDir(dir); else delete dirs[project];
    save();
    return { ...dirs };
  }

  function cancel(id) {
    const c = get(id);
    if (c.state === 'queued') { pending.splice(pending.indexOf(id), 1); c.state = 'idle'; c.messages.at(-1).text = '(cancelled)'; touch(id); }
    c.active?.cancel();
    return view(c);
  }

  function remove(id) {
    const c = get(id);
    if (c.state === 'running' || c.state === 'queued') throw new ValidationError('cancel the running answer first');
    chats.delete(id);
    save(); notify(id);
  }

  return {
    create, send, cancel, remove, setCwd, setProjectDir,
    defaultDir: cwd,
    dirs: () => ({ ...dirs }),
    get: (id) => view(get(id)),
    list: () => [...chats.values()].map(({ id, title, state, created, kind, outcome, meta }) => ({ id, title, state, created, kind: kind || 'chat', outcome: outcome || null, ticket: meta?.file || null })).sort((a, b) => b.created.localeCompare(a.created)),
  };
}
