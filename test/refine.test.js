import test from 'node:test';
import assert from 'node:assert/strict';
import { refinePrompt } from '../src/refine.js';

test('refine prompt asks for a concise title replacing the placeholder', () => {
  const p = refinePrompt({ ticketsDir: '/t', file: '001-a.md', today: '2026-01-01' });
  assert.match(p, /Replace the title/);
  assert.match(p, /concise name of a few words/);
  assert.match(p, /whole idea/);
});
