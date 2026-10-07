// Pure helpers for the timestamped lines in a ticket's `## Notes`, shared by the server (addNote in
// src/core.js) and the browser (to apply the same line to an unsaved description draft).
const pad2 = (n) => String(n).padStart(2, '0');
export const noteStamp = (d) => `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())} ${pad2(d.getHours())}:${pad2(d.getMinutes())}`;

// `- YYYY-MM-DD HH:MM: text`; continuation lines are indented. Always joined with "\n".
export const formatNote = (text, now = new Date()) =>
  `- ${noteStamp(now)}: ${text.trim().split(/\r\n|\n|\r/).map((l, i) => (i && l.trim() ? `  ${l.trimEnd()}` : l.trimEnd())).join('\n')}`;

// Append `item` at the end of the `## Notes` section of `body` (section created if missing); keeps the body's line endings.
export function insertNote(body, item) {
  const eol = body.includes('\r\n') ? '\r\n' : '\n';
  const lines = body.split(/\r\n|\n/);
  const line = item.replace(/\n/g, eol);
  const start = lines.findIndex((l) => /^##\s+Notes\s*$/i.test(l));
  let out;
  if (start < 0) {
    while (lines.length && !lines[lines.length - 1].trim()) lines.pop();
    out = [...lines, ...(lines.length ? [''] : []), '## Notes', '', line, ''];
  } else {
    let end = lines.findIndex((l, i) => i > start && /^#{1,2}\s/.test(l));
    if (end < 0) end = lines.length;
    let last = end;
    while (last > start + 1 && !lines[last - 1].trim()) last--;
    const tail = lines.slice(end);
    out = [...lines.slice(0, last), ...(last === start + 1 ? [''] : []), line, ...(tail.length ? ['', ...tail] : [''])];
  }
  return out.join(eol);
}
