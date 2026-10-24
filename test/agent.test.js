import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { startRun } from '../src/agent.js';

// A stand-in for the CLI that reports whether it leads its own session (so it has no controlling terminal to write to).
test('an agent run starts in its own session, without the launching terminal', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-'));
  const bin = path.join(dir, 'fake-claude');
  fs.writeFileSync(bin, '#!/bin/sh\nsid=$(ps -o sid= -p $$ | tr -d " ")\n[ "$sid" = "$$" ] && r=own-session || r=shared-session\necho "{\\"type\\":\\"result\\",\\"result\\":\\"$r\\",\\"total_cost_usd\\":0}"\n', { mode: 0o755 });
  const r = await startRun({ prompt: 'x', cwd: dir, bin }).done;
  assert.equal(r.text, 'own-session');
});

test('cancelling stops the whole process group of the run', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agent-'));
  const bin = path.join(dir, 'fake-claude');
  fs.writeFileSync(bin, '#!/bin/sh\nsleep 30 &\nwait\n', { mode: 0o755 });
  const run = startRun({ prompt: 'x', cwd: dir, bin });
  await new Promise((r) => setTimeout(r, 300));
  run.cancel();
  const r = await run.done;
  assert.equal(r.cancelled, true);
});
