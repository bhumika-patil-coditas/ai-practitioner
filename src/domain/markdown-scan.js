// One pass over the lines of a note that marks which lines must never be mined for action items:
// fenced code blocks, HTML comments (single- or multi-line) and blockquotes (FR-I7). Pure.

/**
 * @typedef {{no: number, text: string, skipped: false} | {no: number, text: string, skipped: true, reason: 'fence'|'comment'|'quote'}} ScannedLine
 */

const FENCE_OPEN = /^ {0,3}(`{3,}|~{3,})/;

/**
 * @param {string[]} lines
 * @param {number} [startLine] 1-based line number of lines[0]
 * @returns {ScannedLine[]}
 */
export function scanLines(lines, startLine = 1) {
  /** @type {ScannedLine[]} */
  const out = [];
  let fence = null; // {char, len} while inside a fenced block
  let inComment = false;

  lines.forEach((raw, idx) => {
    const no = startLine + idx;

    if (fence) {
      const close = new RegExp(`^ {0,3}${fence.char === '`' ? '`' : '~'}{${fence.len},}\\s*$`).exec(raw);
      if (close) fence = null;
      out.push({ no, text: raw, skipped: true, reason: 'fence' });
      return;
    }

    // Strip HTML comments, remembering whether we are still inside one at end of line.
    let text = '';
    let sawComment = inComment;
    let i = 0;
    while (i < raw.length) {
      if (inComment) {
        const end = raw.indexOf('-->', i);
        if (end === -1) { i = raw.length; break; }
        inComment = false;
        i = end + 3;
      } else {
        const start = raw.indexOf('<!--', i);
        if (start === -1) { text += raw.slice(i); break; }
        text += raw.slice(i, start);
        sawComment = true;
        inComment = true;
        i = start + 4;
      }
    }
    if (sawComment && text.trim() === '') {
      out.push({ no, text: '', skipped: true, reason: 'comment' });
      return;
    }

    const open = FENCE_OPEN.exec(text);
    if (open) {
      fence = { char: open[1][0], len: open[1].length };
      out.push({ no, text, skipped: true, reason: 'fence' });
      return;
    }

    if (/^ {0,3}>/.test(text)) {
      out.push({ no, text, skipped: true, reason: 'quote' });
      return;
    }

    out.push({ no, text, skipped: false });
  });

  return out;
}
