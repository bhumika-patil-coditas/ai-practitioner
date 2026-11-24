// Minimal front-matter reader (just enough YAML for `title`, `date`, `attendees`). Pure; no dependencies.

/**
 * @param {string[]} lines whole file split on "\n"
 * @returns {{data: Record<string, string|string[]>, endLine: number} | null}
 *   `endLine` is the 1-based line number of the closing `---`. Null when the file has no front matter.
 */
export function parseFrontMatter(lines) {
  if (lines.length === 0 || lines[0].trim() !== '---') return null;
  let close = -1;
  for (let i = 1; i < lines.length; i += 1) {
    if (lines[i].trim() === '---') { close = i; break; }
  }
  if (close === -1) return null;

  /** @type {Record<string, string|string[]>} */
  const data = {};
  let listKey = null;
  for (let i = 1; i < close; i += 1) {
    const line = lines[i];
    if (!line.trim() || line.trim().startsWith('#')) continue;
    const item = /^\s+-\s+(.*)$/.exec(line) || (listKey && /^-\s+(.*)$/.exec(line));
    if (item && listKey) {
      /** @type {string[]} */ (data[listKey]).push(unquote(item[1]));
      continue;
    }
    const kv = /^([A-Za-z_][\w-]*)\s*:\s*(.*)$/.exec(line);
    if (!kv) { listKey = null; continue; }
    const key = kv[1].toLowerCase();
    const value = kv[2].trim();
    if (value === '') { data[key] = []; listKey = key; continue; }
    listKey = null;
    data[key] = value.startsWith('[') && value.endsWith(']')
      ? splitList(value.slice(1, -1))
      : unquote(value);
  }
  return { data, endLine: close + 1 };
}

/** Split a comma-separated list, honouring simple quotes. */
export function splitList(s) {
  return s.split(',').map((x) => unquote(x.trim())).filter(Boolean);
}

function unquote(s) {
  const t = s.trim();
  if (t.length >= 2 && ((t[0] === '"' && t.at(-1) === '"') || (t[0] === "'" && t.at(-1) === "'"))) return t.slice(1, -1);
  return t;
}
