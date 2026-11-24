// Folder → parsed notes → resolved owners → de-duplicated items in the database (FR-I1–I27).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { parseNote } from '../domain/note-parser.js';
import { extractDue } from '../domain/dates.js';
import { resolveOwner, ownerKey } from '../domain/owner.js';
import { buildRoster, makePerson } from '../domain/roster.js';
import { dedupeKey } from '../domain/normalize.js';
import { UsageError } from '../errors.js';

/**
 * @typedef {{code: string, file: string, line?: number, message: string}} IngestWarning
 * @typedef {{file: string, status: 'new'|'changed'|'unchanged'|'skipped', reason?: string, detail?: string, hint?: string,
 *            lines?: number, date?: string}} FileReport
 * @typedef {{
 *   folder: string, scanned: number, ingested: number, skipped: number,
 *   lines: number, occurrences: number,
 *   items: {created: number, updated: number, unchanged: number, removed: number},
 *   files: FileReport[], warnings: IngestWarning[], warningCounts: Record<string, number>
 * }} IngestReport
 */

/** Recursively list `.md` files, skipping dot-directories and node_modules. Sorted for determinism. */
export function findMarkdownFiles(root) {
  /** @type {string[]} */
  const out = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.md')) out.push(full);
    }
  };
  walk(root);
  return out.sort();
}

/**
 * @param {{repo: import('../db/repo.js').Repository, clock: {now: () => string}, config: import('../config.js').Config}} ctx
 * @param {string} folder
 * @returns {IngestReport}
 */
export function ingestFolder({ repo, clock, config }, folder) {
  const root = path.resolve(folder);
  let stat;
  try { stat = fs.statSync(root); } catch { throw new UsageError(`folder not found: ${folder}`); }
  if (!stat.isDirectory()) throw new UsageError(`not a folder: ${folder}`);

  /** @type {FileReport[]} */
  const files = [];
  /** @type {IngestWarning[]} */
  const warnings = [];
  const warn = (code, file, message, line) => warnings.push({ code, file, message, ...(line ? { line } : {}) });

  // ---- pass 1: read + parse every file; one bad file never stops the run (FR-I2) ---------------
  const paths = findMarkdownFiles(root);
  /** @type {{abs: string, rel: string, filename: string, hash: string, note: import('../domain/note-parser.js').ParsedNote}[]} */
  const parsed = [];
  for (const abs of paths) {
    const rel = path.relative(root, abs).split(path.sep).join('/');
    const filename = path.basename(abs);
    try {
      const buf = fs.readFileSync(abs);
      const result = parseNote(buf, { filename });
      if (!result.ok) {
        files.push({ file: rel, status: 'skipped', reason: result.reason, detail: result.detail, ...(result.hint ? { hint: result.hint } : {}) });
        continue;
      }
      parsed.push({ abs, rel, filename, hash: crypto.createHash('sha256').update(buf).digest('hex'), note: result.note });
    } catch (err) {
      const reason = err && err.code && /^E[A-Z]+$/.test(err.code) ? 'read-error' : 'internal-error';
      files.push({ file: rel, status: 'skipped', reason, detail: String(err && err.message ? err.message : err) });
    }
  }
  parsed.sort((a, b) => a.note.date.localeCompare(b.note.date) || a.filename.localeCompare(b.filename));

  // ---- roster: everyone seen in these notes, earlier ingests, and the config (FR-I14) -----------
  const rosterNames = [
    ...parsed.flatMap((p) => p.note.attendees),
    ...repo.allPeople().map((p) => p.fullName),
    ...Object.keys(config.people),
  ];
  const roster = buildRoster(rosterNames);

  const now = clock.now();
  let lines = 0;
  let occurrenceCount = 0;
  let created = 0;
  const touched = new Set();
  const createdIds = new Set();

  // ---- pass 2: persist everything atomically (FR-I26) ------------------------------------------
  const { before, deleted } = repo.transaction(() => {
    for (const [name, v] of Object.entries(config.people)) repo.upsertPerson(name, v.email);
    for (const p of roster) repo.upsertPerson(p.fullName);

    // Reprocess every valid note each run; the hash only decides the reported status (see spec FR-I25).
    const pending = [];
    for (const p of parsed) {
      const existing = repo.getMeetingByPath(p.abs);
      const meetingId = repo.upsertMeeting({
        path: p.abs, filename: p.filename, title: p.note.title, meetingDate: p.note.date,
        attendees: p.note.attendees, contentHash: p.hash, now,
      });
      for (const id of repo.itemIdsForMeeting(meetingId)) touched.add(id);
      repo.deleteOccurrencesForMeeting(meetingId);
      pending.push({ p, meetingId, status: !existing ? 'new' : existing.contentHash === p.hash ? 'unchanged' : 'changed' });
    }
    const idsBefore = [...touched];

    for (const { p, meetingId, status } of pending) {
      const { note } = p;
      for (const w of note.warnings) warn(w.code, p.rel, w.message, w.line);
      const attendeesP = note.attendees.map(makePerson);

      for (const occ of note.occurrences) {
        lines += 1;
        let { task, due } = occ;
        let tokens = occ.owners;
        let resolvedList = tokens.map((t) => resolveOwner(t, attendeesP, roster));

        // "Note: remember the milk" — a colon form whose name is unknown is just text, not an owner.
        if (occ.viaColon && resolvedList.length === 1 && resolvedList[0].kind === 'external') {
          const whole = extractDue(occ.fullText, note.date);
          task = whole.task; due = whole.due; tokens = []; resolvedList = [];
        }
        if (resolvedList.length === 0) resolvedList = [{ kind: 'none', label: '' }];

        const seenKeys = new Set();
        for (const resolved of resolvedList) {
          const key = ownerKey(resolved);
          if (seenKeys.has(key)) continue;
          seenKeys.add(key);

          const person = resolved.kind === 'person' ? resolved.person : null;
          const ownerId = person ? repo.upsertPerson(person.fullName) : null;
          const candidates = resolved.kind === 'ambiguous' ? resolved.candidates.map((c) => repo.upsertPerson(c.fullName)) : [];
          const label = resolved.kind === 'person' ? person.firstName
            : resolved.kind === 'none' && resolved.label === '' ? null : resolved.label;

          const item = repo.upsertItem({
            dedupeKey: dedupeKey(key, task), ownerKind: resolved.kind, ownerId, ownerLabel: label,
            ownerCandidates: candidates, task, now,
          });
          if (item.created) { created += 1; createdIds.add(item.id); }
          touched.add(item.id);
          repo.addOccurrence({
            itemId: item.id, meetingId, lineNo: occ.lineNo, kind: occ.kind, checked: occ.checked,
            task, rawText: occ.raw, dueDate: due,
          });
          occurrenceCount += 1;

          // Attention warnings (open items only — nobody needs nagging about finished work).
          if (!occ.checked) {
            if (resolved.kind === 'ambiguous') {
              warn('ambiguous-owner', p.rel, `"${resolved.label}" could be ${resolved.candidates.map((c) => c.fullName).join(' or ')}: ${task}`, occ.lineNo);
            } else if (resolved.kind === 'external') {
              warn('unknown-owner', p.rel, `"${resolved.label}" is not a known person: ${task}`, occ.lineNo);
            } else if (resolved.kind === 'group' || resolved.kind === 'none') {
              warn('no-owner', p.rel, `${resolved.label ? `"${resolved.label}"` : 'no owner'}: ${task}`, occ.lineNo);
            }
            if (!due) warn('no-due-date', p.rel, task, occ.lineNo);
          }
        }
      }
      files.push({ file: p.rel, status, lines: note.occurrences.length, date: note.date });
    }

    const snapshotBefore = repo.snapshotItems(idsBefore.filter((id) => !createdIds.has(id)));
    // Items attached to by this run that already existed (e.g. from another folder) also need a "before".
    const extra = [...touched].filter((id) => !createdIds.has(id) && !snapshotBefore.has(id));
    for (const [k, v] of repo.snapshotItems(extra)) snapshotBefore.set(k, v);
    const { deleted: removed } = repo.recomputeItems([...touched], now);
    return { before: snapshotBefore, deleted: removed };
  });

  // ---- counts ------------------------------------------------------------------------------------
  const after = repo.snapshotItems([...touched].filter((id) => !deleted.includes(id)));
  let updated = 0;
  let unchanged = 0;
  for (const [id, snap] of before) {
    if (deleted.includes(id)) continue;
    if (after.get(id) === snap) unchanged += 1; else updated += 1;
  }

  files.sort((a, b) => a.file.localeCompare(b.file));
  const warningCounts = {};
  for (const w of warnings) warningCounts[w.code] = (warningCounts[w.code] ?? 0) + 1;
  for (const f of files) if (f.status === 'skipped') warningCounts[`skipped:${f.reason}`] = (warningCounts[`skipped:${f.reason}`] ?? 0) + 1;

  return {
    folder: root,
    scanned: paths.length,
    ingested: parsed.length,
    skipped: files.filter((f) => f.status === 'skipped').length,
    lines,
    occurrences: occurrenceCount,
    items: { created, updated, unchanged, removed: deleted.length },
    files,
    warnings,
    warningCounts,
  };
}
