import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { collectSessions, formatSessions } from '../src/sessions.js';

test('sessions: lists terminals per instance, notes unreachable and terminal-off ones', async () => {
  const srv = http.createServer((req, res) => {
    res.setHeader('content-type', 'application/json');
    if (req.url === '/api/agent') return res.end(JSON.stringify({ enabled: true, terminal: true, tmux: null }));
    res.end(JSON.stringify([{ id: 'a', cwd: '~/p', ticket: '001-x.md', created: '2026-01-02T03:04:05.000Z' }, { id: 'b', cwd: '~/q', ticket: null, created: '2026-01-02T04:00:00.000Z' }]));
  });
  await new Promise((r) => srv.listen(0, '127.0.0.1', r));
  try {
    const live = { url: `http://127.0.0.1:${srv.address().port}`, dir: '/d1', pid: 1 };
    const dead = { url: 'http://127.0.0.1:1', dir: '/d2', pid: 2 };
    const results = await collectSessions([live, dead]);
    assert.deepEqual(results[0].sessions.map((s) => [s.kind, s.name]), [['ticket', '001-x.md'], ['shell', '']]);
    assert.equal(results[1].sessions, null);
    const text = formatSessions(results);
    assert.match(text, /ticket\s+001-x\.md\s+2026-01-02 03:04\s+~\/p/);
    assert.match(text, /not reachable/);
    assert.equal(formatSessions([]), 'no running instances');
  } finally { srv.close(); }
});
