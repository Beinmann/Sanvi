// Minimal vim emulation for the ticket description editor. No dependencies.
//
// `Vim` is a pure state machine over (text, cursor): it knows nothing about the
// DOM, so it can be unit-tested in node. `attachVim` binds it to a <textarea>.
//
// Supported: modes normal / insert / visual (v) / visual-line (V);
// motions h j k l w b e 0 ^ $ gg G (with counts); operators d c y (with
// motions, doubled for lines, and on a visual selection); x X D C s S Y p P;
// i a I A o O; u and Ctrl-R; / n N search; :w :q :q! :wq :x ex commands.

const isWs = (c) => c === ' ' || c === '\t' || c === '\n' || c === undefined;
const isWord = (c) => /[A-Za-z0-9_]/.test(c);
const cls = (c) => (isWs(c) ? 0 : isWord(c) ? 1 : 2);

export const lineStart = (t, i) => t.lastIndexOf('\n', i - 1) + 1;
export const lineEnd = (t, i) => { const e = t.indexOf('\n', i); return e < 0 ? t.length : e; };
const firstNonBlank = (t, i) => { let j = lineStart(t, i); const e = lineEnd(t, i); while (j < e - 1 && /[ \t]/.test(t[j])) j++; return j; };

function wordNext(t, i) {
  let j = i;
  const c = cls(t[j]);
  if (c) while (j < t.length && cls(t[j]) === c) j++;
  while (j < t.length && cls(t[j]) === 0) j++;
  return j;
}
function wordPrev(t, i) {
  let j = i - 1;
  while (j > 0 && cls(t[j]) === 0) j--;
  if (j <= 0) return 0;
  const c = cls(t[j]);
  while (j > 0 && cls(t[j - 1]) === c) j--;
  return j;
}
function wordEnd(t, i) {
  let j = i + 1;
  while (j < t.length && cls(t[j]) === 0) j++;
  if (j >= t.length) return Math.max(0, t.length - 1);
  const c = cls(t[j]);
  while (j + 1 < t.length && cls(t[j + 1]) === c) j++;
  return j;
}

export class Vim {
  constructor(text = '', host = {}) {
    this.text = text;
    this.cur = 0;
    this.mode = 'normal'; // normal | insert | visual | vline | cmd
    this.host = host; // { onSave(): Promise|void, onQuit(force) }
    this.undo = []; this.redo = [];
    this.reg = { text: '', line: false };
    this.want = 0; // desired column for j/k
    this.anchor = 0;
    this.cmd = null; // { kind: ':' | '/', text, from }
    this.search = null;
    this.message = '';
    this.insSnap = null;
    this.resetPending();
  }

  resetPending() { this.count = ''; this.op = null; this.count2 = ''; this.g = false; }

  get status() {
    if (this.mode === 'cmd') return this.cmd.kind + this.cmd.text;
    if (this.message) return this.message;
    return { normal: 'NORMAL', insert: '-- INSERT --', visual: '-- VISUAL --', vline: '-- VISUAL LINE --' }[this.mode];
  }

  // ---- state helpers
  snap() { return { text: this.text, cur: this.cur }; }
  pushUndo(s = this.snap()) { this.undo.push(s); this.redo = []; if (this.undo.length > 500) this.undo.shift(); }
  clamp(i, insert = this.mode === 'insert') {
    const max = insert ? this.text.length : Math.max(0, this.text.length - 1);
    i = Math.max(0, Math.min(i, max));
    if (!insert && this.text[i] === '\n' && i > 0 && this.text[i - 1] !== '\n') i--; // never rest on the newline
    return i;
  }
  setCur(i, keepWant = false) {
    this.cur = this.clamp(i);
    if (!keepWant) this.want = this.cur - lineStart(this.text, this.cur);
  }
  replace(from, to, str) {
    this.text = this.text.slice(0, from) + str + this.text.slice(to);
    this.host.onChange?.(this.text);
  }

  // Called by the binding when the textarea changed under us (insert typing, click).
  sync(text, cur) {
    if (text !== this.text) { this.text = text; this.host.onChange?.(text); }
    this.cur = this.mode === 'insert' ? Math.max(0, Math.min(cur, text.length)) : this.clamp(cur);
  }

  // ---- motions: return target index, or null if unavailable. `lineWise` flags j/k/G/gg.
  motion(key, n, hasCount) {
    const t = this.text, i = this.cur;
    const col = (ls) => Math.min(ls + this.want, Math.max(ls, lineEnd(t, ls) - 1));
    switch (key) {
      case 'h': return Math.max(lineStart(t, i), i - n);
      case 'l': return Math.min(Math.max(lineStart(t, i), lineEnd(t, i) - 1), i + n);
      case 'w': { let j = i; for (let k = 0; k < n; k++) j = wordNext(t, j); return Math.min(j, t.length); }
      case 'b': { let j = i; for (let k = 0; k < n; k++) j = wordPrev(t, j); return j; }
      case 'e': { let j = i; for (let k = 0; k < n; k++) j = wordEnd(t, j); return j; }
      case '0': return lineStart(t, i);
      case '^': return firstNonBlank(t, i);
      case '$': { let j = i; for (let k = 1; k < n; k++) j = lineEnd(t, j) + 1; return Math.max(lineStart(t, j), lineEnd(t, j) - 1); }
      case 'j': { let ls = lineStart(t, i); for (let k = 0; k < n; k++) { const e = lineEnd(t, ls); if (e >= t.length) return k ? col(ls) : null; ls = e + 1; } return col(ls); }
      case 'k': { let ls = lineStart(t, i); for (let k = 0; k < n; k++) { if (ls === 0) return k ? col(ls) : null; ls = lineStart(t, ls - 1); } return col(ls); }
      case 'G': {
        if (!hasCount) return firstNonBlank(t, lineStart(t, t.length > 0 && t.endsWith('\n') ? t.length - 1 : t.length));
        let ls = 0; for (let k = 1; k < n; k++) { const e = lineEnd(t, ls); if (e >= t.length) break; ls = e + 1; }
        return firstNonBlank(t, ls);
      }
      case 'gg': {
        let ls = 0; for (let k = 1; k < n; k++) { const e = lineEnd(t, ls); if (e >= t.length) break; ls = e + 1; }
        return firstNonBlank(t, ls);
      }
      default: return undefined; // not a motion
    }
  }
  static LINEWISE = new Set(['j', 'k', 'G', 'gg']);
  static INCLUSIVE = new Set(['e', '$']);

  // ---- operators
  applyOp(op, from, to, line) {
    const t = this.text;
    if (line) {
      from = lineStart(t, from);
      to = lineEnd(t, to); // exclusive of trailing newline
      const hasNl = to < t.length;
      // include the newline that ends the range (or the one before, at EOF)
      if (hasNl) to++; else if (from > 0 && op !== 'c') from--;
      this.reg = { text: t.slice(from, to).replace(/^\n|\n$/g, '') + '\n', line: true };
      if (op === 'y') { this.setCur(Math.min(lineStart(t, this.cur), lineStart(t, from))); return; }
      this.pushUndo();
      if (op === 'c') {
        // keep one empty line to type into
        const keep = t[to - 1] === '\n' && to > from ? to - 1 : to;
        this.replace(from, keep, '');
        this.enterInsert(from, null);
        return;
      }
      this.replace(from, to, '');
      this.setCur(firstNonBlank(this.text, Math.min(from, this.text.length)));
      return;
    }
    this.reg = { text: t.slice(from, to), line: false };
    if (op === 'y') { this.setCur(from); return; }
    this.pushUndo();
    this.replace(from, to, '');
    if (op === 'c') this.enterInsert(from, null);
    else this.setCur(from);
  }

  enterInsert(at, snap = this.snap()) {
    this.mode = 'insert';
    this.insSnap = snap; // null: undo point already recorded
    this.cur = Math.max(0, Math.min(at, this.text.length));
    this.message = '';
  }
  leaveInsert() {
    if (this.insSnap && this.insSnap.text !== this.text) this.pushUndo(this.insSnap);
    this.insSnap = null;
    this.mode = 'normal';
    this.setCur(this.cur - (this.cur > lineStart(this.text, this.cur) ? 1 : 0));
  }

  // ---- search
  find(pat, from, dir) {
    if (!pat) return -1;
    let re;
    try { re = new RegExp(pat, 'g'); } catch { re = new RegExp(pat.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g'); }
    const t = this.text, hits = [];
    for (let m; (m = re.exec(t)); ) { hits.push(m.index); if (m[0] === '') re.lastIndex++; }
    if (!hits.length) return -1;
    if (dir > 0) return hits.find((h) => h > from) ?? hits[0];
    return [...hits].reverse().find((h) => h < from) ?? hits[hits.length - 1];
  }
  searchNext(dir) {
    if (!this.search) { this.message = 'E35: No previous regular expression'; return; }
    const j = this.find(this.search, this.cur, dir);
    if (j < 0) this.message = `E486: Pattern not found: ${this.search}`;
    else this.setCur(j);
  }

  // ---- ex commands
  runEx(line) {
    const [name, ...rest] = line.trim().split(/\s+/);
    const force = name.endsWith('!');
    const cmd = name.replace(/!$/, '');
    if (cmd === 'w') return this.host.onSave?.();
    if (cmd === 'q') return this.host.onQuit?.(force);
    if (cmd === 'wq' || cmd === 'x') return Promise.resolve(this.host.onSave?.()).then(() => this.host.onQuit?.(false));
    if (cmd !== '') this.message = `E492: Not an editor command: ${name}${rest.length ? ' ' + rest.join(' ') : ''}`;
  }

  // ---- key entry. Returns true when the key was consumed (caller should preventDefault).
  key(key, { ctrl = false, selection = false } = {}) {
    this.message = '';
    if (this.mode === 'insert') {
      // Ctrl+C leaves insert mode like Esc, but only without a selection, so copying still works
      if (key === 'Escape' || (ctrl && key === '[') || (ctrl && key === 'c' && !selection)) { this.leaveInsert(); return true; }
      return false;
    }
    if (this.mode === 'cmd') return this.cmdKey(key);
    if (ctrl) {
      if (key === 'r') { this.doRedo(); return true; }
      if (key === '[') { this.toNormal(); return true; }
      return false; // Ctrl+S etc. fall through to the app
    }
    if (key === 'Escape') { this.toNormal(); return true; }
    const arrow = { ArrowLeft: 'h', ArrowRight: 'l', ArrowUp: 'k', ArrowDown: 'j' }[key];
    if (arrow) return this.normalKey(arrow);
    if (key === 'Enter' || key === 'Backspace' || key === 'Delete') return true; // don't edit from normal mode
    if (key.length > 1) return false; // Tab, F-keys, Shift...: leave to the browser
    return this.normalKey(key);
  }

  toNormal() {
    if (this.mode === 'visual' || this.mode === 'vline') this.setCur(this.cur);
    this.mode = 'normal';
    this.resetPending();
  }

  cmdKey(key) {
    const c = this.cmd;
    if (key === 'Escape') { this.mode = c.back; this.cmd = null; return true; }
    if (key === 'Enter') {
      this.mode = c.back; this.cmd = null;
      if (c.kind === ':') this.runEx(c.text);
      else { this.search = c.text || this.search; this.searchNext(1); }
      return true;
    }
    if (key === 'Backspace') {
      if (c.text === '') { this.mode = c.back; this.cmd = null; } else c.text = c.text.slice(0, -1);
      return true;
    }
    if (key.length === 1) c.text += key;
    return true;
  }

  doUndo() {
    const s = this.undo.pop();
    if (!s) { this.message = 'Already at oldest change'; return; }
    this.redo.push(this.snap());
    this.text = s.text; this.host.onChange?.(this.text); this.setCur(s.cur);
  }
  doRedo() {
    const s = this.redo.pop();
    if (!s) { this.message = 'Already at newest change'; return; }
    this.undo.push(this.snap());
    this.text = s.text; this.host.onChange?.(this.text); this.setCur(s.cur);
  }

  normalKey(key) {
    const visual = this.mode === 'visual' || this.mode === 'vline';
    // counts (0 is a motion unless a count is in progress)
    if (/[0-9]/.test(key) && !(key === '0' && !(this.op ? this.count2 : this.count))) {
      if (this.op) this.count2 += key; else this.count += key;
      return true;
    }
    const n = (Number(this.count || 1)) * (Number(this.count2 || 1));
    const hasCount = !!(this.count || this.count2);

    // g-prefix
    if (this.g) {
      this.g = false;
      if (key === 'g') return this.doMotion('gg', n, hasCount, visual);
      this.resetPending(); return true;
    }
    if (key === 'g') { this.g = true; return true; }

    // operators
    if (key === 'd' || key === 'c' || key === 'y') {
      if (visual) return this.visualOp(key);
      if (this.op === key) { // dd / cc / yy
        const t = this.text; let to = this.cur;
        for (let k = 1; k < n; k++) { const e = lineEnd(t, to); if (e >= t.length) break; to = e + 1; }
        const op = this.op; this.resetPending();
        this.applyOp(op, this.cur, to, true);
        return true;
      }
      if (!this.op) { this.op = key; return true; }
      this.resetPending(); return true;
    }

    // motions
    if (this.motion(key, n, hasCount) !== undefined) return this.doMotion(key, n, hasCount, visual);

    if (this.op) { this.resetPending(); return true; } // operator + non-motion: cancel
    this.resetPending();
    return this.command(key, n, visual);
  }

  doMotion(key, n, hasCount, visual) {
    const target = this.motion(key, n, hasCount);
    const op = this.op;
    this.resetPending();
    if (target === null) return true;
    if (!op) {
      this.setCur(target, key === 'j' || key === 'k');
      return true;
    }
    let from = this.cur, to = target;
    if (Vim.LINEWISE.has(key)) { this.applyOp(op, Math.min(from, to), Math.max(from, to), true); return true; }
    if (from > to) [from, to] = [to, from];
    if (Vim.INCLUSIVE.has(key)) to++;
    // `cw` behaves like `ce` when on a non-blank
    if (op === 'c' && key === 'w' && !isWs(this.text[this.cur])) {
      to = wordEnd(this.text, this.cur - 0) + 1; // single word; counts approximated
      if (cls(this.text[this.cur + 1]) !== cls(this.text[this.cur])) to = this.cur + 1;
      from = this.cur;
    }
    // `dw` on the last word of a line must not join lines
    if (key === 'w' && this.text.slice(from, to).includes('\n')) to = from + this.text.slice(from).indexOf('\n');
    this.applyOp(op, from, to, false);
    return true;
  }

  selection() {
    let a = Math.min(this.anchor, this.cur), b = Math.max(this.anchor, this.cur);
    if (this.mode === 'vline') return [lineStart(this.text, a), lineEnd(this.text, b), true];
    return [a, Math.min(b + 1, this.text.length), false];
  }
  visualOp(op) {
    const [a, b, line] = this.selection();
    this.mode = 'normal';
    if (line) this.applyOp(op, a, b, true); else this.applyOp(op, a, b, false);
    if (op === 'y') this.setCur(a);
    return true;
  }

  command(key, n, visual) {
    const t = this.text, i = this.cur;
    if (visual) {
      switch (key) {
        case 'x': case 'X': case 'D': return this.visualOp('d');
        case 's': case 'C': case 'S': return this.visualOp('c');
        case 'v': if (this.mode === 'visual') this.toNormal(); else this.mode = 'visual'; return true;
        case 'V': if (this.mode === 'vline') this.toNormal(); else this.mode = 'vline'; return true;
        case 'o': [this.anchor, this.cur] = [this.cur, this.anchor]; return true;
        case 'p': case 'P': { const [a, b] = this.selection(); this.pushUndo(); const old = this.reg; this.reg = { text: t.slice(a, b), line: false }; this.replace(a, b, old.text); this.mode = 'normal'; this.setCur(a); return true; }
        default: break;
      }
    }
    switch (key) {
      case 'i': this.enterInsert(i); return true;
      case 'a': this.enterInsert(t.length && t[i] !== '\n' ? i + 1 : i); return true;
      case 'I': this.enterInsert(firstNonBlank(t, i)); return true;
      case 'A': this.enterInsert(lineEnd(t, i)); return true;
      case 'o': { const s = this.snap(); const e = lineEnd(t, i); this.pushUndo(s); this.replace(e, e, '\n'); this.enterInsert(e + 1, null); return true; }
      case 'O': { const s = this.snap(); const ls = lineStart(t, i); this.pushUndo(s); this.replace(ls, ls, '\n'); this.enterInsert(ls, null); return true; }
      case 'x': if (i < lineEnd(t, i)) { this.pushUndo(); const to = Math.min(i + n, lineEnd(t, i)); this.reg = { text: t.slice(i, to), line: false }; this.replace(i, to, ''); this.setCur(i); } return true;
      case 'X': { const from = Math.max(lineStart(t, i), i - n); if (from < i) { this.pushUndo(); this.reg = { text: t.slice(from, i), line: false }; this.replace(from, i, ''); this.setCur(from); } return true; }
      case 's': { this.pushUndo(); const to = Math.min(i + n, lineEnd(t, i)); this.reg = { text: t.slice(i, to), line: false }; this.replace(i, to, ''); this.enterInsert(i, null); return true; }
      case 'D': this.pushUndo(); this.reg = { text: t.slice(i, lineEnd(t, i)), line: false }; this.replace(i, lineEnd(t, i), ''); this.setCur(i - 1 < lineStart(this.text, i) ? i : i - 1); return true;
      case 'C': this.pushUndo(); this.reg = { text: t.slice(i, lineEnd(t, i)), line: false }; this.replace(i, lineEnd(t, i), ''); this.enterInsert(i, null); return true;
      case 'S': this.applyOp('c', i, i, true); return true;
      case 'Y': this.applyOp('y', i, i, true); return true;
      case 'p': case 'P': return this.paste(key === 'p', n);
      case 'u': this.doUndo(); return true;
      case 'v': this.mode = 'visual'; this.anchor = i; return true;
      case 'V': this.mode = 'vline'; this.anchor = i; return true;
      case ':': this.cmd = { kind: ':', text: '', back: visual ? 'normal' : this.mode }; this.mode = 'cmd'; if (visual) this.setCur(this.cur); return true;
      case '/': this.cmd = { kind: '/', text: '', back: this.mode }; this.mode = 'cmd'; return true;
      case 'n': this.searchNext(1); return true;
      case 'N': this.searchNext(-1); return true;
      default: return true; // swallow other printable keys so they don't type into the buffer
    }
  }

  paste(after, n) {
    if (!this.reg.text) return true;
    const t = this.text, i = this.cur;
    this.pushUndo();
    if (this.reg.line) {
      const body = this.reg.text.replace(/\n$/, '');
      const chunk = Array(n).fill(body).join('\n');
      if (after) {
        const e = lineEnd(t, i);
        this.replace(e, e, '\n' + chunk);
        this.setCur(firstNonBlank(this.text, e + 1));
      } else {
        const ls = lineStart(t, i);
        this.replace(ls, ls, chunk + '\n');
        this.setCur(firstNonBlank(this.text, ls));
      }
    } else {
      const at = after && t[i] !== undefined && t[i] !== '\n' ? i + 1 : i;
      const chunk = this.reg.text.repeat(n);
      this.replace(at, at, chunk);
      this.setCur(at + chunk.length - 1);
    }
    return true;
  }
}

// ---------------------------------------------------------------------------
// DOM binding. `host` = { onChange(text), onSave(), onQuit(force), onStatus(str, mode) }
// Where character offset `pos` sits inside the textarea (a hidden mirror with the same text metrics),
// in the coordinates of the textarea's offset parent. Used to paint a cursor where the browser's
// selection paints nothing (empty lines, end of text).
function caretBox(ta, pos) {
  const cs = getComputedStyle(ta);
  const mirror = document.createElement('div');
  // Same text box as the textarea: its content width excludes the scrollbar, so wrap points agree.
  for (const k of ['paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'fontFamily', 'fontSize', 'fontWeight', 'lineHeight', 'letterSpacing', 'tabSize', 'textIndent']) mirror.style[k] = cs[k];
  Object.assign(mirror.style, { boxSizing: 'border-box', width: `${ta.clientWidth}px`, border: '0', position: 'absolute', visibility: 'hidden', top: '0', left: '-9999px', whiteSpace: 'pre-wrap', overflowWrap: 'break-word', overflow: 'hidden' });
  const mark = document.createElement('span');
  mark.textContent = '\u200b';
  mirror.append(ta.value.slice(0, pos), mark);
  const glyph = document.createElement('span');
  glyph.textContent = 'x';
  mirror.append(glyph);
  document.body.append(mirror);
  const box = {
    left: ta.offsetLeft + ta.clientLeft + mark.offsetLeft - ta.scrollLeft, top: ta.offsetTop + ta.clientTop + mark.offsetTop - ta.scrollTop,
    width: glyph.offsetWidth, height: parseFloat(cs.lineHeight) || mark.offsetHeight,
  };
  mirror.remove();
  return box;
}

export function attachVim(ta, host) {
  const vim = new Vim(ta.value, { ...host });
  let shownMode = vim.mode;
  let cursorEl = null;
  let emptyAt = -1;
  const paintEmptyCursor = (pos) => {
    emptyAt = pos;
    if (pos < 0) { if (cursorEl) cursorEl.hidden = true; return; }
    if (!cursorEl?.isConnected) {
      if (!ta.parentNode) return;
      if (getComputedStyle(ta.parentNode).position === 'static') ta.parentNode.style.position = 'relative';
      cursorEl = document.createElement('div');
      cursorEl.className = 'vim-cursor';
      cursorEl.setAttribute('aria-hidden', 'true');
      ta.after(cursorEl);
    }
    const c = caretBox(ta, pos);
    const top0 = ta.offsetTop + ta.clientTop;
    const inside = c.top >= top0 && c.top + c.height <= top0 + ta.clientHeight;
    cursorEl.hidden = !inside;
    Object.assign(cursorEl.style, { left: `${c.left}px`, top: `${c.top}px`, width: `${c.width}px`, height: `${c.height}px` });
  };
  const repaint = () => { if (emptyAt >= 0) paintEmptyCursor(emptyAt); };
  ta.addEventListener('scroll', repaint);
  if (typeof ResizeObserver !== 'undefined') new ResizeObserver(repaint).observe(ta); // window or textarea resize re-wraps lines
  const show = () => {
    // Leaving insert mode re-selects the block cursor, which makes browsers scroll to it. The caret was
    // already visible while typing, so keep the scroll position (textarea and page) exactly as it was.
    const leaving = shownMode === 'insert' && vim.mode !== 'insert';
    const keep = leaving ? { top: ta.scrollTop, left: ta.scrollLeft, y: window.scrollY, x: window.scrollX } : null;
    shownMode = vim.mode;
    if (ta.value !== vim.text) ta.value = vim.text;
    const m = vim.mode;
    let a = vim.cur, b = vim.cur;
    if (m === 'insert') { /* caret managed natively */ }
    else if (m === 'visual' || m === 'vline') { const [s, e] = vim.selection(); a = s; b = e; }
    else if (m === 'cmd' && vim.cmd.back !== 'normal') { const [s, e] = vim.selection(); a = s; b = e; }
    else b = Math.min(a + 1, ta.value.length); // block cursor
    // A block over a newline or past the end paints nothing: use the (accent-coloured) native caret there.
    const empty = m === 'normal' && (ta.value[a] === undefined || ta.value[a] === '\n' || ta.value[a] === '\r');
    if (empty) b = a;
    paintEmptyCursor(empty ? a : -1);
    if (m !== 'insert') ta.setSelectionRange(a, b);
    if (keep) { ta.scrollTop = keep.top; ta.scrollLeft = keep.left; window.scrollTo(keep.x, keep.y); }
    ta.dataset.vim = m;
    host.onStatus?.(vim.status, m);
  };
  vim.host.onChange = (t) => host.onChange?.(t);
  ta.addEventListener('keydown', (e) => {
    if (e.isComposing || e.altKey) return;
    if (e.metaKey || (e.ctrlKey && !['r', '[', 'c'].includes(e.key))) return; // leave Ctrl+S etc. to the app
    // caret moved behind our back (mouse, focus restore after a re-render): adopt it
    if (vim.mode === 'insert' || (vim.mode === 'normal' && ta.selectionStart !== vim.cur)) vim.sync(ta.value, ta.selectionStart);
    const handled = vim.key(e.key, { ctrl: e.ctrlKey, selection: ta.selectionStart !== ta.selectionEnd });
    if (handled) e.preventDefault();
    show();
  });
  ta.addEventListener('input', () => { vim.sync(ta.value, ta.selectionStart); });
  ta.addEventListener('mouseup', () => { if (vim.mode === 'normal') { vim.sync(ta.value, ta.selectionStart); show(); } });
  ta.addEventListener('blur', () => { if (vim.mode === 'cmd') { vim.mode = vim.cmd.back; vim.cmd = null; show(); } });
  show();
  return vim;
}
