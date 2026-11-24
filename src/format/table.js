// Plain-text table and colour helpers. No ANSI unless explicitly enabled (FR-G5).

const CODES = { red: 31, green: 32, yellow: 33, dim: 2, bold: 1 };

/** @param {keyof typeof CODES} color @param {string} text @param {boolean} enabled */
export function paint(color, text, enabled) {
  return enabled ? `\u001b[${CODES[color]}m${text}\u001b[0m` : text;
}

/**
 * @param {{header: string, key: string, paint?: (value: string, row: any) => string}[]} columns
 * @param {Record<string, string>[]} rows
 * @returns {string}
 */
export function renderTable(columns, rows) {
  const widths = columns.map((c) => Math.max(c.header.length, ...rows.map((r) => String(r[c.key] ?? '').length)));
  const line = (cells) => cells.join('  ').trimEnd();
  const out = [line(columns.map((c, i) => c.header.padEnd(widths[i])))];
  out.push(line(widths.map((w) => '-'.repeat(w))));
  for (const r of rows) {
    out.push(line(columns.map((c, i) => {
      const raw = String(r[c.key] ?? '');
      const padded = raw.padEnd(widths[i]);
      return c.paint ? c.paint(padded, r) : padded;
    })));
  }
  return out.join('\n');
}
