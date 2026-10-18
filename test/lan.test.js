import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createTicketServer, bindHosts, isLoopback } from '../src/server.js';

test('bindHosts: loopback adds nothing, an IP allows itself, wildcard lists interfaces', () => {
  assert.deepEqual(bindHosts('127.0.0.1'), []);
  assert.deepEqual(bindHosts(undefined), []);
  assert.deepEqual(bindHosts('192.0.2.7'), ['192.0.2.7']);
  assert.deepEqual(bindHosts('fe80::1'), ['[fe80::1]']);
  for (const h of bindHosts('0.0.0.0')) assert.ok(!isLoopback(h.replace(/[[\]]/g, '')));
});

test('a LAN bind address passes the Host check, other hosts still 403', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-lan-'));
  const app = createTicketServer({ dir, bindHost: '192.0.2.7' });
  const addr = await app.listen(0, '127.0.0.1');
  // fetch() will not send a custom Host header, so use http.request.
  const get = (host) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: addr.port, path: '/api/tickets', headers: { host } }, (res) => { res.resume(); resolve({ status: res.statusCode }); }).on('error', reject);
  });
  try {
    assert.equal((await get(`192.0.2.7:${addr.port}`)).status, 200);
    assert.equal((await get(`evil.example:${addr.port}`)).status, 403);
    assert.equal((await get(`192.0.2.8:${addr.port}`)).status, 403);
  } finally { await app.close(); }
});
