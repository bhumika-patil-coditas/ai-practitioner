// Parse one meeting note into a header + unresolved occurrences (FR-I1–I9, I15–I19). Pure: no I/O, no clock.
// Owner *resolution* needs the roster built from all notes, so it happens later in the ingest service (FR-I14).
import { parseFrontMatter, splitList } from './frontmatter.js';
import { scanLines } from './markdown-scan.js';
import { extractActionLines } from './action-lines.js';
import { parseOwnerClause, stripLeadingEmphasis } from './owner.js';
import { extractDue, isValidIso, parseAbsoluteDate, weekday } from './dates.js';
import { buildRoster } from './roster.js';

/**
 * @typedef {{code: string, message: string, line?: number}} Warning
 * @typedef {{
 *   lineNo: number, kind: 'checkbox'|'action'|'table', checked: boolean, raw: string,
 *   owners: import('./owner.js').OwnerToken[], viaColon: boolean, fullText: string,
 *   task: string, due: string|null, duePhrase: string|null
 * }} ParsedOccurrence
 * @typedef {{
 *   filename: string, title: string, date: string, attendees: string[],
 *   occurrences: ParsedOccurrence[], warnings: Warning[]
 * }} ParsedNote
 * @typedef {{ok: true, note: ParsedNote} | {ok: false, reason: string, detail: string, hint?: string}} ParseResult
 */

const HEADER_SCAN_LINES = 40;

const fail = (reason, detail, hint) => ({ ok: false, reason, detail, ...(hint ? { hint } : {}) });

/**
 * @param {Buffer|string} input raw file bytes (preferred) or already-decoded text
 * @param {{filename: string}} opts
 * @returns {ParseResult}
 */
export function parseNote(input, { filename }) {
  // ---- decode ---------------------------------------------------------------------------------
  let text;
  if (typeof input === 'string') {
    text = input;
  } else {
    if (input.includes(0)) return fail('not-text', 'file contains NUL bytes (binary data)');
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(input);
    } catch {
      return fail('not-text', 'file is not valid UTF-8 text');
    }
  }
  text = text.replace(/^﻿/, '').replace(/\r\n?/g, '\n');
  if (!text.trim()) return fail('empty', 'file is empty');
  const lines = text.split('\n');

  // ---- header ---------------------------------------------------------------------------------
  /** @type {Warning[]} */
  const warnings = [];
  let title = null;
  let dateRaw = null;
  /** @type {string[]|null} */
  let attendeeNames = null;

  const fm = parseFrontMatter(lines);
  if (fm) {
    title = asString(fm.data.title);
    dateRaw = asString(fm.data.date);
    const a = fm.data.attendees;
    if (a !== undefined) attendeeNames = Array.isArray(a) ? a : splitList(a);
  } else {
    for (let i = 0; i < Math.min(lines.length, HEADER_SCAN_LINES); i += 1) {
      const line = lines[i];
      if (/^##\s/.test(line)) break; // header block ends at the first section
      let m;
      if (title === null && (m = /^#\s+(?:meeting\s*:\s*)?(.+?)\s*$/i.exec(line))) title = m[1];
      else if (dateRaw === null && (m = /^\s*date\s*:\s*(.*?)\s*$/i.exec(line))) dateRaw = m[1];
      else if (attendeeNames === null && (m = /^\s*attendees?\s*:\s*(.*?)\s*$/i.exec(line))) attendeeNames = m[1].split(/[,;]/);
    }
  }

  const hint = filenameDate(filename);
  if (!dateRaw) return fail('missing-date', 'no "Date:" found in the note header', hint ? `filename suggests ${hint}` : undefined);
  const parsed = parseAbsoluteDate(dateRaw);
  if ('error' in parsed) {
    return fail('invalid-date', `Date: "${dateRaw}" is ${parsed.error === 'invalid' ? 'not a real calendar date' : 'not a recognisable date (use YYYY-MM-DD, "9 September 2026" or "September 9, 2026")'}`,
      hint ? `filename suggests ${hint}` : undefined);
  }
  const date = parsed.iso;
  if (parsed.weekdayPrefix && parsed.weekdayPrefix !== weekday(date)) {
    warnings.push({ code: 'weekday-mismatch', message: `date "${dateRaw}" names a different weekday than ${date}` });
  }
  if (!title) {
    title = filename.replace(/\.[^.]+$/, '');
    warnings.push({ code: 'missing-title', message: `no title; using filename "${title}"` });
  }
  const attendees = buildRoster(attendeeNames ?? []).map((p) => p.fullName);
  if (attendees.length === 0) {
    warnings.push({ code: 'missing-attendees', message: 'no attendees listed; owners will be matched against everyone known' });
  }

  // ---- action items ---------------------------------------------------------------------------
  const startLine = fm ? fm.endLine + 1 : 1;
  const scanned = scanLines(lines.slice(startLine - 1), startLine);
  /** @type {ParsedOccurrence[]} */
  const occurrences = [];
  for (const al of extractActionLines(scanned)) {
    const clause = parseOwnerClause(al.text);
    let taskText = clause.task;
    const dueRes = extractDue(taskText, date);
    taskText = dueRes.task;
    if (clause.helpers) taskText = `${taskText} (with ${clause.helpers})`;
    if (!taskText) {
      warnings.push({ code: 'empty-task', message: `no task text left after parsing: "${al.text}"`, line: al.lineNo });
      continue;
    }
    if (dueRes.invalid) {
      warnings.push({ code: 'invalid-due', message: `"${dueRes.phrase}" is not a real date`, line: al.lineNo });
    }
    occurrences.push({
      lineNo: al.lineNo,
      kind: al.kind,
      checked: al.checked,
      raw: al.raw,
      owners: clause.owners,
      viaColon: clause.viaColon,
      fullText: stripLeadingEmphasis(al.text),
      task: taskText,
      due: dueRes.due,
      duePhrase: dueRes.phrase,
    });
  }

  return { ok: true, note: { filename, title, date, attendees, occurrences, warnings } };
}

function asString(v) {
  if (Array.isArray(v)) return v.join(', ') || null;
  return v ? String(v) : null;
}

/** ISO date at the start of a filename, if it is a real date. */
function filenameDate(filename) {
  const m = /^(\d{4}-\d{2}-\d{2})/.exec(filename);
  return m && isValidIso(m[1]) ? m[1] : null;
}
