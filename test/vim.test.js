import test from 'node:test';
import assert from 'node:assert/strict';
import { Vim } from '../public/vim.js';

// type("dd") etc.; "<Esc>", "<C-r>", "<CR>" are special tokens
function run(text, keys, { cur = 0, host = {} } = {}) {
  const v = new Vim(text, host);
  v.cur = cur;
  for (const tok of keys.match(/<[^>]+>|./gs)) {
    if (tok === '<Esc>') v.key('Escape');
    else if (tok === '<CR>') v.key('Enter');
    else if (tok === '<C-r>') v.key('r', { ctrl: true });
    else if (v.mode === 'insert') { if (tok !== undefined) v.sync(v.text.slice(0, v.cur) + tok + v.text.slice(v.cur), v.cur + 1); }
    else v.key(tok);
  }
  return v;
}

test('h l 0 $ motions stay on the line', () => {
  assert.equal(run('abc\ndef', 'l$').cur, 2);
  assert.equal(run('abc\ndef', '$l').cur, 2);
  assert.equal(run('abc\ndef', '$0').cur, 0);
  assert.equal(run('abc\ndef', 'h').cur, 0);
});

test('j k keep column, G and gg', () => {
  assert.equal(run('abcd\nxy\nabcd', 'lllj').cur, 6); // clamped on short line
  assert.equal(run('abcd\nxy\nabcd', 'lllj' + 'j').cur, 11); // want column restored (col 3)
  assert.equal(run('a\nb\nc', 'G').cur, 4);
  assert.equal(run('a\nb\nc', 'Ggg').cur, 0);
  assert.equal(run('a\nb\nc', '2G').cur, 2);
});

test('w b e', () => {
  const t = 'foo bar.baz  qux';
  assert.equal(run(t, 'w').cur, 4);
  assert.equal(run(t, 'ww').cur, 7);
  assert.equal(run(t, '3w').cur, 8);
  assert.equal(run(t, '$b').cur, 13);
  assert.equal(run(t, 'e').cur, 2);
});

test('x, dd, dw, d$, counts', () => {
  assert.equal(run('abc', 'x').text, 'bc');
  assert.equal(run('a\nb\nc', 'jdd').text, 'a\nc');
  assert.equal(run('a\nb\nc', 'Gdd').text, 'a\nb');
  assert.equal(run('a\nb\nc', '2dd').text, 'c');
  assert.equal(run('foo bar', 'dw').text, 'bar');
  assert.equal(run('foo bar\nnext', 'wdw').text, 'foo \nnext');
  assert.equal(run('foo bar', 'wd$').text, 'foo ');
  assert.equal(run('a\nb\nc', 'dj').text, 'c');
  assert.equal(run('a\nb\nc', 'dG').text, '');
});

test('yank and paste, linewise and charwise', () => {
  assert.equal(run('a\nb', 'yyjp').text, 'a\nb\na');
  assert.equal(run('a\nb', 'yyP').text, 'a\na\nb');
  assert.equal(run('abc', 'ylp').text, 'aabc');
  assert.equal(run('ab', 'xp').text, 'ba');
  assert.equal(run('a\nb\nc', 'ddp').text, 'b\na\nc');
});

test('insert: i a o O A I and Esc', () => {
  assert.equal(run('ac', 'ib<Esc>', { cur: 1 }).text, 'abc');
  assert.equal(run('ac', 'ab<Esc>').text, 'abc');
  assert.equal(run('a\nc', 'ob<Esc>').text, 'a\nb\nc');
  assert.equal(run('a\nc', 'Ob<Esc>').text, 'b\na\nc');
  assert.equal(run('ab', 'Ac<Esc>').text, 'abc');
  assert.equal(run('  ab', 'Ix<Esc>').text, '  xab');
  const v = run('ab', 'ix<Esc>');
  assert.equal(v.mode, 'normal');
});

test('change: cw, cc, C', () => {
  assert.equal(run('foo bar', 'cwX<Esc>').text, 'X bar');
  assert.equal(run('a\nb\nc', 'jccX<Esc>').text, 'a\nX\nc');
  assert.equal(run('foo bar', 'wCX<Esc>').text, 'foo X');
});

test('undo / redo', () => {
  const v = run('one\ntwo', 'ddu');
  assert.equal(v.text, 'one\ntwo');
  assert.equal(run('one\ntwo', 'dduu').message, 'Already at oldest change');
  assert.equal(run('one\ntwo', 'ddu<C-r>').text, 'two');
  assert.equal(run('ab', 'ix<Esc>u').text, 'ab'); // one undo reverts a whole insert
  assert.equal(run('ab', 'ixy<Esc>u').text, 'ab');
});

test('visual mode: v d, v y p, V d', () => {
  assert.equal(run('abcdef', 'vlld').text, 'def');
  assert.equal(run('abcdef', 'vly$p').text, 'abcdefab');
  assert.equal(run('a\nb\nc', 'Vjd').text, 'c');
  assert.equal(run('abc', 'vlc' + 'X<Esc>').text, 'Xc');
  assert.equal(run('abc', 'v<Esc>').mode, 'normal');
});

test('search: / n N with wrap', () => {
  const t = 'foo bar foo baz foo';
  const v = run(t, '/foo<CR>');
  assert.equal(v.cur, 8);
  v.key('n'); assert.equal(v.cur, 16);
  v.key('n'); assert.equal(v.cur, 0); // wraps
  v.key('N'); assert.equal(v.cur, 16);
  assert.match(run(t, '/zzz<CR>').message, /E486/);
});

test('ex commands: :w :q :q! :wq and unknown', async () => {
  const calls = [];
  const host = { onSave: () => { calls.push('w'); return Promise.resolve(); }, onQuit: (f) => calls.push(f ? 'q!' : 'q') };
  run('x', ':w<CR>', { host });
  run('x', ':q<CR>', { host });
  run('x', ':q!<CR>', { host });
  run('x', ':wq<CR>', { host });
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(calls, ['w', 'q', 'q!', 'w', 'q']);
  assert.match(run('x', ':foo<CR>').message, /E492/);
  assert.equal(run('x', ':ab<Esc>').mode, 'normal');
});

test('normal mode swallows printable keys but passes Ctrl+S and Tab through', () => {
  const v = new Vim('abc');
  assert.equal(v.key('z'), true);
  assert.equal(v.key('s', { ctrl: true }), false);
  assert.equal(v.key('Tab'), false);
  assert.equal(v.text, 'abc');
});

test('onChange fires on edits', () => {
  const seen = [];
  run('abc', 'x', { host: { onChange: (t) => seen.push(t) } });
  assert.deepEqual(seen, ['bc']);
});
