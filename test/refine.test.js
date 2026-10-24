import test from 'node:test';
import assert from 'node:assert/strict';
import { refinePrompt, refineRunOpts } from '../src/refine.js';

test('refine prompt asks for a concise title replacing the placeholder', () => {
  const p = refinePrompt({ ticketsDir: '/t', file: '001-a.md', today: '2026-01-01' });
  assert.match(p, /Replace the title/);
  assert.match(p, /concise name of a few words/);
  assert.match(p, /whole idea/);
});

test('refine prompt tells the agent to set and clear the needs marker', () => {
  const p = refinePrompt({ ticketsDir: '/t', file: '001-a.md', today: '2026-01-01' });
  assert.match(p, /needs: input/);
  assert.match(p, /remove any "needs:" line/);
});

test('refine prompt explains how to split a ticket with tk new', () => {
  const p = refinePrompt({ ticketsDir: '/t', file: '001-a.md', project: 'p', today: '2026-01-01' });
  assert.match(p, /independently-shippable/);
  assert.match(p, /bin\/tk\.js new "<title>" --dir \/t --project p --problem "<one-line problem>" --criterion/);
  assert.match(p, /--note "Split off from 001-a\.md\."/);
  assert.doesNotMatch(p, /--body/);
  assert.match(p, /split off from 001-a\.md/);
  assert.match(p, /naming the new ticket ids/);
});

test('refine run may edit only its ticket and create new ones through tk new', () => {
  const o = refineRunOpts({ ticketsDir: '/t', file: '001-a.md' });
  assert.ok(o.allowedTools.includes('Edit(//t/001-a.md)'));
  assert.ok(o.allowedTools.some((r) => /^Bash\(node \S+bin\/tk\.js new:\*\)$/.test(r)));
  assert.ok(!o.allowedTools.some((r) => /^(Write|Edit\(\/\/t\/\*)/.test(r)));
  assert.equal(o.allowedTools.filter((r) => r.startsWith('Bash')).length, 1);
});

test('refine run has the Bash tool available (without it the tk new rule is useless) but no Write', () => {
  const o = refineRunOpts({ ticketsDir: '/t', file: '001-a.md' });
  assert.ok(o.tools.includes('Bash'));
  assert.ok(!o.tools.includes('Write'));
  const rule = o.allowedTools.find((r) => r.startsWith('Bash('));
  const cmd = refinePrompt({ ticketsDir: '/t', file: '001-a.md', today: '2026-01-01' }).match(/^ +(node \S+ new) /m)[1];
  assert.equal(rule, `Bash(${cmd}:*)`, 'the permitted command is the one the prompt gives');
});
