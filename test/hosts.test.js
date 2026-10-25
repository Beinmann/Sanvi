import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { createTicketServer } from '../src/server.js';
import { parseHosts, hostMatches, persistentHosts, hostsFile } from '../src/hosts.js';

test('parseHosts: lines and commas, comments, case', () => {
  assert.deepEqual(parseHosts('# devboxes\nBox.ts.net, other.test # note\n\n*.ts.net\n'), ['box.ts.net', 'other.test', '*.ts.net']);
  assert.deepEqual(parseHosts(undefined), []);
});

test('hostMatches: exact or *. suffix, never the bare suffix or a lookalike', () => {
  assert.ok(hostMatches('a.test', 'a.test'));
  assert.ok(hostMatches('*.ts.net', 'box.tail1.ts.net'));
  assert.ok(!hostMatches('*.ts.net', 'ts.net'));
  assert.ok(!hostMatches('*.ts.net', 'evilts.net'));
  assert.ok(!hostMatches('*.ts.net', 'ts.net.evil.example'));
  assert.ok(!hostMatches('a.test', 'b.test'));
});

test('persistentHosts: file and SANVI_ALLOW_HOSTS merge', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-hosts-'));
  fs.mkdirSync(path.join(dir, 'tickets'));
  const t = path.join(dir, 'tickets');
  assert.deepEqual(persistentHosts(t, {}), []);
  fs.mkdirSync(path.dirname(hostsFile(t)), { recursive: true });
  fs.writeFileSync(hostsFile(t), 'a.test\n');
  assert.deepEqual(persistentHosts(t, { SANVI_ALLOW_HOSTS: 'b.test' }), ['a.test', 'b.test']);
});

test('server: hosts from the file and wildcards pass, others stay 403 with a hint; edits apply live', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tk-hosts-'));
  const dir = path.join(root, 'tickets');
  fs.mkdirSync(dir);
  const app = createTicketServer({ dir, allowedHosts: ['*.flag.test'] });
  const addr = await app.listen(0, '127.0.0.1');
  const get = (host) => new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: addr.port, path: '/api/tickets', headers: { host } }, (res) => {
      let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => resolve({ status: res.statusCode, body }));
    }).on('error', reject);
  });
  try {
    const denied = await get('box.tail1.ts.net');
    assert.equal(denied.status, 403);
    assert.match(denied.body, /--allow-host box\.tail1\.ts\.net/);
    assert.match(denied.body, /allowed-hosts/);
    fs.mkdirSync(path.join(root, '.sanvi'), { recursive: true });
    fs.writeFileSync(path.join(root, '.sanvi', 'allowed-hosts'), '# mine\n*.ts.net\nsolo.test\n');
    assert.equal((await get('box.tail1.ts.net:4321')).status, 200);
    assert.equal((await get('solo.test')).status, 200);
    assert.equal((await get('x.flag.test')).status, 200);
    assert.equal((await get('evil.example')).status, 403);
    assert.equal((await get('ts.net')).status, 403);
    assert.equal((await get('other.test')).status, 403);
  } finally { await app.close(); }
});
