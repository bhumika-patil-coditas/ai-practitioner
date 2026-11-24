// Recognises action-item lines in the non-skipped lines of a note (FR-I6, FR-I8). Pure.
//
// Three notations are supported:
//   1. checkbox bullets   `- [ ] …`, `* [x] …`, `+ [X] …` at any indent
//   2. `ACTION: …` lines
//   3. table rows under a header naming Owner and Action (optionally Due)

/**
 * @typedef {{lineNo: number, kind: 'checkbox'|'action'|'table', checked: boolean, text: string, raw: string}} ActionLine
 */

// Bullets (-, *, +) and numbered checklists ("1. [ ]", "2) [x]") are all action items.
const CHECKBOX = /^\s*(?:[-*+]|\d{1,3}[.)])\s+\[([ xX])\]\s*(.*)$/;
const ACTION = /^\s*(?:[-*+]\s+)?action\s*:\s*(.+)$/i;
const SEPARATOR = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const EMPTY_CELL = /^(?:|-|—|–|n\/a|tbd|none)$/i;

/** @param {string} line */
function cells(line) {
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|')) s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function columnIndex(header, names) {
  return header.findIndex((h) => names.includes(h.toLowerCase()));
}

/**
 * @param {import('./markdown-scan.js').ScannedLine[]} scanned
 * @returns {ActionLine[]}
 */
export function extractActionLines(scanned) {
  /** @type {ActionLine[]} */
  const found = [];
  /** @type {{owner: number, action: number, due: number} | null} */
  let table = null;

  for (let i = 0; i < scanned.length; i += 1) {
    const line = scanned[i];
    if (line.skipped) { table = null; continue; }
    const { text, no } = line;

    if (table) {
      if (text.trim().startsWith('|')) {
        const row = cells(text);
        const owner = row[table.owner] ?? '';
        const action = row[table.action] ?? '';
        const due = table.due >= 0 ? (row[table.due] ?? '') : '';
        if (action && !EMPTY_CELL.test(action)) {
          const who = EMPTY_CELL.test(owner) ? '' : `${owner} to `;
          const when = EMPTY_CELL.test(due) ? '' : ` by ${due}`;
          found.push({ lineNo: no, kind: 'table', checked: false, text: `${who}${action}${when}`, raw: text });
        }
        continue;
      }
      table = null;
    }

    // Table header: a pipe row naming Owner + Action, followed by a |---| separator.
    if (text.includes('|') && i + 1 < scanned.length && !scanned[i + 1].skipped && SEPARATOR.test(scanned[i + 1].text)) {
      const header = cells(text);
      const owner = columnIndex(header, ['owner', 'who', 'assignee']);
      const action = columnIndex(header, ['action', 'task', 'action item']);
      if (owner >= 0 && action >= 0) {
        table = { owner, action, due: columnIndex(header, ['due', 'due date', 'deadline', 'when']) };
        i += 1; // consume the separator row
        continue;
      }
    }

    const cb = CHECKBOX.exec(text);
    if (cb) {
      if (cb[2].trim()) found.push({ lineNo: no, kind: 'checkbox', checked: cb[1] !== ' ', text: cb[2].trim(), raw: text });
      continue;
    }

    const act = ACTION.exec(text);
    if (act) found.push({ lineNo: no, kind: 'action', checked: false, text: act[1].trim(), raw: text });
  }
  return found;
}
