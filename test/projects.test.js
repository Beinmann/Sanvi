import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listProjectObjects, saveProject, projectView, projectInfo, projectProblems, PROJECTS_DIR } from '../src/projects.js';
import { createTicketServer } from '../src/server.js';

function setup(tickets = []) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-proj-'));
  tickets.forEach(([n, project], i) => fs.writeFileSync(path.join(dir, `00${i + 1}-t.md`), `---\nstatus: open\n${project ? `project: ${project}\n` : ''}---\n# T${i}\n`));
  return dir;
}

test('save and read back a project, including the default project and multi-line instructions', () => {
  const dir = setup();
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-repo-'));
  saveProject(dir, { name: 'Web App', dir: repo, instructions: 'Line one.\n\nLine two: with a colon.' });
  saveProject(dir, { name: '', instructions: 'For tickets without a project.' });
  const all = listProjectObjects(dir);
  assert.deepEqual(all.map((o) => o.name).sort(), ['', 'Web App']);
  const web = all.find((o) => o.name === 'Web App');
  assert.equal(web.dir, repo);
  assert.equal(web.instructions, 'Line one.\n\nLine two: with a colon.');
  assert.equal(projectInfo(dir, '').instructions, 'For tickets without a project.');
  assert.deepEqual(projectInfo(dir, 'unknown'), {});
  saveProject(dir, { name: 'Web App', dir: '', instructions: '' }); // overwrite in place
  assert.equal(listProjectObjects(dir).length, 2);
  assert.throws(() => saveProject(dir, { name: 'a\nb' }), /single line/);
});

test('hand-edited and odd files are tolerated', () => {
  const dir = setup();
  fs.mkdirSync(path.join(dir, PROJECTS_DIR));
  fs.writeFileSync(path.join(dir, PROJECTS_DIR, 'api.md'), 'just some text, no frontmatter\n');
  fs.writeFileSync(path.join(dir, PROJECTS_DIR, 'notes.txt'), 'ignored');
  fs.writeFileSync(path.join(dir, PROJECTS_DIR, 'broken.md'), '---\nname: "x\ndir\n---\nbody');
  const all = listProjectObjects(dir);
  assert.equal(all.find((o) => o.file === 'api.md').name, 'api'); // named after the file
  assert.equal(all.find((o) => o.file === 'api.md').instructions, 'just some text, no frontmatter');
  assert.equal(listProjectObjects(path.join(dir, 'nowhere')).length, 0);
  assert.throws(() => { saveProject(dir, { name: 'API' }); saveProject(dir, { name: 'api!' }); }, /same file/);
});

test('warnings: tickets without a project object, empty objects, directory missing', () => {
  const dir = setup([['a', 'web'], ['b', 'web'], ['c', 'ops'], ['d', '']]);
  saveProject(dir, { name: 'ops' }); // exists but empty
  saveProject(dir, { name: 'lost', dir: path.join(dir, 'does-not-exist') });
  const view = Object.fromEntries(projectView(dir).map((p) => [p.name, p]));
  assert.equal(view[''].label, 'default project');
  assert.deepEqual(view[''].warnings, []); // the default project is fine without an object
  assert.match(view.web.warnings[0], /2 tickets use this project, but it has no project object/);
  assert.equal(view.web.exists, false);
  assert.match(view.ops.warnings[0], /no information set/);
  assert.match(view.lost.warnings[0], /directory not found/);
  const problems = projectProblems(dir);
  assert.equal(problems.filter((p) => /has no project object/.test(p.message)).length, 2); // one per ticket of "web"
  assert.ok(problems.some((p) => p.file.endsWith('ops.md') && /no information set/.test(p.message)));
  assert.ok(problems.every((p) => p.level === 'warn'));
});

test('GET and PUT /api/projects, no agents needed', async () => {
  const dir = setup([['a', 'web']]);
  const app = createTicketServer({ dir });
  const { port } = await app.listen(0);
  const base = `http://127.0.0.1:${port}`;
  try {
    const before = await (await fetch(`${base}/api/projects`)).json();
    assert.deepEqual(before.map((p) => p.name), ['', 'web']);
    const r = await fetch(`${base}/api/projects`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ name: 'web', dir: os.tmpdir(), instructions: 'Be careful.' }) });
    assert.equal(r.status, 200);
    const web = (await r.json()).find((p) => p.name === 'web');
    assert.equal(web.exists, true);
    assert.equal(web.dirOk, true);
    assert.deepEqual(web.warnings, []);
    const cross = await fetch(`${base}/api/projects`, { method: 'PUT', headers: { 'content-type': 'application/json', origin: 'http://evil.example' }, body: '{}' });
    assert.equal(cross.status, 403);
  } finally { await app.close(); }
});

test('refine and chat use the project directory and instructions', async () => {
  const dir = setup([['a', 'web']]);
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tk-repo-')));
  saveProject(dir, { name: 'web', dir: repo, instructions: 'Never touch the build.' });
  const calls = [];
  const run = (opts) => { calls.push(opts); return { onEvent() {}, cancel() {}, done: new Promise(() => {}) }; };
  const app = createTicketServer({ dir, agents: true, agentRun: run, chatsFile: null });
  const { port } = await app.listen(0);
  const post = (p, b) => fetch(`http://127.0.0.1:${port}${p}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(b) });
  try {
    assert.equal((await post('/api/agent/refine', { file: '001-t.md' })).status, 201);
    assert.equal(calls[0].cwd, repo);
    assert.match(calls[0].prompt, /Instructions for project "web"[\s\S]*Never touch the build\./);
    const chat = await (await post('/api/agent/chats', { project: 'web' })).json();
    assert.equal(chat.cwd, repo);
    await post(`/api/agent/chats/${chat.id}/messages`, { text: 'hello' });
    assert.match(calls[1].prompt, /Never touch the build\.[\s\S]*hello$/);
  } finally { await app.close(); }
});
