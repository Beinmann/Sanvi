import test from 'node:test';
import assert from 'node:assert/strict';
import { formatNote, insertNote, noteStamp } from '../public/notes.js';

const now = new Date(2026, 9, 7, 9, 5);

test('formatNote stamps and indents continuation lines', () => {
  assert.equal(noteStamp(now), '2026-10-07 09:05');
  assert.equal(formatNote('  one\ntwo\r\n\nthree ', now), '- 2026-10-07 09:05: one\n  two\n\n  three');
});

test('insertNote appends at the end of Notes, creates the section, keeps CRLF', () => {
  const item = formatNote('hi', now);
  assert.equal(insertNote('# T\n\n## Notes\n\n- a\n\n## Later\nx\n', item), '# T\n\n## Notes\n\n- a\n- 2026-10-07 09:05: hi\n\n## Later\nx\n');
  assert.equal(insertNote('# T\n', item), '# T\n\n## Notes\n\n- 2026-10-07 09:05: hi\n');
  assert.equal(insertNote('# T\r\n\r\n## Notes\r\n- a\r\n', formatNote('x\ny', now)), '# T\r\n\r\n## Notes\r\n- a\r\n- 2026-10-07 09:05: x\r\n  y\r\n');
});

test('a draft with unsaved edits gets the same line the server added', () => {
  const disk = '# T\n\n## Notes\n\n- a\n';
  const draft = '# T edited\n\n## Notes\n\n- a\n- my unsaved note\n';
  const item = formatNote('c', now);
  assert.equal(insertNote(disk, item), '# T\n\n## Notes\n\n- a\n- 2026-10-07 09:05: c\n');
  assert.equal(insertNote(draft, item), '# T edited\n\n## Notes\n\n- a\n- my unsaved note\n- 2026-10-07 09:05: c\n');
});
