import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { buildInfo, commitsBehind, versionLine } from '../src/about.js';

test('buildInfo has a version; commit is a short hash or empty', () => {
  const b = buildInfo();
  assert.match(b.version, /^\d+\.\d+\.\d+/);
  assert.match(b.commit, /^([0-9a-f]{7})?$/);
  assert.match(versionLine(b), /^sanvi \d/);
});

test('commitsBehind is 0 for the current HEAD and for unknown input', () => {
  assert.equal(commitsBehind(''), 0);
  assert.equal(commitsBehind(buildInfo().full), 0);
});

test('tk --version prints the version line', () => {
  const out = execFileSync(process.execPath, [new URL('../bin/tk.js', import.meta.url).pathname, '--version'], { encoding: 'utf8' });
  assert.match(out, /^sanvi \d+\.\d+\.\d+/);
});
