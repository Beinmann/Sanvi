// Chats with an agent: one record per chat, one agent run per message (the agent's own session keeps the context).
// Kept in memory and saved to `file` (outside any repo) so chats survive a restart; `notify(chatId)` pushes a live update.
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRun as defaultRun } from './agent.js';
import { ValidationError, NotFoundError } from './core.js';

// A normal chat runs in auto permission mode and may also create files (Write), not only edit existing ones.
export function chatRunOpts() {
  return { permissionMode: 'auto', tools: ['Read', 'Grep', 'Glob', 'Edit', 'Write'] };
}

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

// Refine/implement runs share one agent session per kind + directory, so many small runs do not each start with a
// fresh context. Once the session holds `maxTokens` or more, the next run starts a new one. Env: TK_SESSION_REUSE=0
// switches it off, TK_SESSION_MAX_TOKENS changes the threshold.
export const DEFAULT_SESSION_TOKENS = 70000;
export function sessionReuseFromEnv(env = process.env) {
  const n = Number(env.TK_SESSION_MAX_TOKENS);
  return { enabled: !/^(0|off|false|no)$/i.test(env.TK_SESSION_REUSE || ''), maxTokens: n > 0 ? n : DEFAULT_SESSION_TOKENS };
}
const REUSE_KINDS = new Set(['refine', 'implement']);
// Context size after a turn: everything the model read plus what it wrote.
const contextTokens = (u) => (u ? (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.output_tokens || 0) : 0);

export function createChats({ cwd, file, check, sessionReuse = sessionReuseFromEnv(), projectInfo = () => ({}), finalize, abandon = () => {}, notify = () => {}, run = defaultRun, maxRuns = Infinity, log = () => {} }) {
  const chats = new Map();
  let running = 0;
  const pending = []; // ids of chats waiting for a free slot
  const sessions = new Map(); // `${kind}\0${cwd}` -> { sessionId, tokens }, for session reuse
  const busy = new Set(); // reuse keys with a run in flight (a session cannot serve two runs at once)

  const persisted = ({ active, ...c }) => c;
  function save() {
    if (!file) return;
    try {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(`${file}.tmp`, JSON.stringify({ chats: [...chats.values()].map(persisted), sessions: Object.fromEntries(sessions) }));
      fs.renameSync(`${file}.tmp`, file);
    } catch (e) { console.error(`could not save chats: ${e.message}`); }
  }
  try {
    const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
    for (const [k, v] of Object.entries(saved.sessions || {})) sessions.set(k, v);
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
  const view = (c) => ({ id: c.id, title: c.title, kind: c.kind || 'chat', outcome: c.outcome || null, warning: c.warning || null, cwd: c.cwd, state: c.state, error: c.error, costUsd: c.costUsd, messages: c.messages, created: c.created, report: c.meta?.report || null });

  // `dir` is explicit; otherwise the project's directory (from its project object); otherwise the default.
  // The project's instructions go to the agent with the first message.
  function create({ dir, project, title = 'New chat', kind = 'chat', runOpts, meta, preamble, ticketId } = {}) {
    const info = projectInfo(project || '') || {};
    let chatDir = cwd;
    let warning = null;
    if (dir) chatDir = resolveDir(dir);
    else if (info.dir) {
      try { chatDir = resolveDir(info.dir); } catch { warning = `the directory of project "${project || 'default project'}" (${info.dir}) was not found; using the default directory`; }
    }
    if (!preamble && info.instructions) preamble = `Instructions for project "${project || 'default project'}":\n${info.instructions}\n\nUser message:`;
    if (!runOpts && kind === 'chat') runOpts = chatRunOpts();
    const c = { id: crypto.randomUUID(), title, kind, runOpts, meta, preamble, ticketId: ticketId ? String(ticketId) : null, project: project || '', cwd: chatDir, state: 'idle', error: null, warning, costUsd: 0, sessionId: null, messages: [], created: new Date().toISOString(), active: null };
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

    start(c, reply, started, true);
    touch(c.id);
  }

  // One agent run for the chat's current prompt. A chat that already has a session resumes it; a fresh refine/implement
  // chat may take over the shared session of its kind + directory while that is small enough and not in use.
  function start(c, reply, started, mayReuse) {
    const key = `${c.kind}\0${c.cwd}`;
    let resume = c.sessionId;
    let reused = false;
    if (!resume && mayReuse && sessionReuse.enabled && REUSE_KINDS.has(c.kind) && !busy.has(key)) {
      const rec = sessions.get(key);
      if (rec && rec.tokens < sessionReuse.maxTokens) { resume = rec.sessionId; reused = true; }
    }
    const track = sessionReuse.enabled && REUSE_KINDS.has(c.kind) && !busy.has(key);
    if (track) busy.add(key);
    let tokens = 0;
    const r = run({ prompt: c.prompt, cwd: c.cwd, resume, ...c.runOpts });
    c.active = r;
    r.onEvent((ev) => {
      if (ev.type === 'assistant' && ev.message?.usage) tokens = contextTokens(ev.message.usage) || tokens;
      if (ev.type !== 'assistant' || !Array.isArray(ev.message?.content)) return;
      for (const part of ev.message.content) {
        if (part.type === 'text') reply.text += (reply.text ? '\n\n' : '') + part.text;
        else if (part.type === 'tool_use') reply.tools.push(part.name);
      }
      touch(c.id);
    });
    r.done.then((d) => {
      if (track) busy.delete(key);
      if (reused && !d.ok && !d.cancelled && !reply.text && !reply.tools.length) { // the old session is gone: start a fresh one
        sessions.delete(key);
        log({ chat: c.id, action: 'session-resume-failed' });
        return start(c, reply, started, false);
      }
      c.active = null;
      if (d.sessionId) c.sessionId = d.sessionId;
      if (track && d.ok && d.sessionId) sessions.set(key, { sessionId: d.sessionId, tokens });
      else if (track && !d.ok && reused) sessions.delete(key);
      if (d.costUsd) c.costUsd += d.costUsd;
      if (d.ok && finalize && c.kind === 'implement') { // post-run work (merge, maybe with another agent run); a failure there fails the chat
        const agent = (o) => followUp(c, reply, o);
        Promise.resolve().then(() => finalize(c, d, { agent })).catch((e) => ({ ok: false, error: e.message }))
          .then((v) => conclude(c, reply, started, v.ok ? d : { ...d, ok: false, error: v.error }));
      } else conclude(c, reply, started, d);
    });
  }

  // A further agent run inside the chat's current turn (e.g. resolving a merge conflict); its output joins the reply.
  function followUp(c, reply, { prompt, cwd, runOpts }) {
    const r = run({ prompt, cwd, ...runOpts });
    c.active = r;
    r.onEvent((ev) => {
      if (ev.type !== 'assistant' || !Array.isArray(ev.message?.content)) return;
      for (const part of ev.message.content) {
        if (part.type === 'text') reply.text += (reply.text ? '\n\n' : '') + part.text;
        else if (part.type === 'tool_use') reply.tools.push(part.name);
      }
      touch(c.id);
    });
    return r.done.then((d) => { c.active = null; if (d.costUsd) c.costUsd += d.costUsd; return d; });
  }

  function conclude(c, reply, started, d) {
    running--;
    if (d.ok) {
      c.state = 'idle'; if (!reply.text) reply.text = d.text;
      const verdict = check?.(c, d) || {};
      const warnings = [verdict.warning, d.denials ? `${d.denials} tool call${d.denials > 1 ? 's were' : ' was'} refused (a headless run cannot ask for permission)` : null].filter(Boolean);
      c.outcome = d.denials ? 'problems' : verdict.outcome || 'ok';
      c.warning = warnings.join('; ') || null;
    }
    else { c.state = d.cancelled ? 'idle' : 'failed'; c.error = d.error; if (d.cancelled) reply.text += `${reply.text ? '\n\n' : ''}(stopped)`; }
    log({ chat: c.id, action: d.ok ? 'agent-finish' : d.cancelled ? 'agent-cancel' : 'agent-fail', seconds: Math.round((Date.now() - started) / 1000), costUsd: d.costUsd });
    touch(c.id);
    while (running < maxRuns && pending.length) { const next = chats.get(pending.shift()); if (next?.state === 'queued') launch(next); }
  }

  // Claude keeps sessions per directory, so a chat can only change directory before its first message.
  function setCwd(id, dir) {
    const c = get(id);
    if (c.messages.length) throw new ValidationError('the directory cannot change once the chat has started; open a new chat');
    c.cwd = resolveDir(dir);
    touch(c.id);
    return view(c);
  }

  function cancel(id) {
    const c = get(id);
    if (c.state === 'queued') { pending.splice(pending.indexOf(id), 1); c.state = 'idle'; c.messages.at(-1).text = '(stopped)'; touch(id); }
    c.active?.cancel();
    return view(c);
  }

  function remove(id) {
    const c = get(id);
    if (c.state === 'running' || c.state === 'queued') throw new ValidationError('cancel the running answer first');
    chats.delete(id);
    try { abandon(c); } catch { /* cleanup is best effort */ }
    save(); notify(id);
  }

  return {
    create, send, cancel, remove, setCwd,
    defaultDir: cwd,
    // Cost recorded by Sanvi per provider; only Claude exists today, another provider adds a key.
    usage: () => ({ claude: { costUsd: [...chats.values()].reduce((sum, c) => sum + (c.costUsd || 0), 0), chats: chats.size } }),
    get: (id) => view(get(id)),
    list: () => [...chats.values()].map(({ id, title, state, created, kind, outcome, meta, ticketId, project }) => ({ id, title, state, created, kind: kind || 'chat', outcome: outcome || null, ticket: meta?.file || null, ticketId: ticketId || null, project: project || '', branch: meta?.wt?.branch || null, worktree: meta?.wt?.worktree || null })).sort((a, b) => b.created.localeCompare(a.created)),
  };
}
