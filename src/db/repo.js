// The only module that contains SQL. Services and commands receive a Repository by injection.
import { makePerson } from '../domain/roster.js';

/**
 * @typedef {{id: number, fullName: string, firstName: string, lastName: string, email: string|null}} Person
 * @typedef {{
 *   id: number, dedupeKey: string, ownerKind: 'person'|'ambiguous'|'external'|'group'|'none',
 *   ownerId: number|null, ownerName: string|null, ownerLabel: string|null, ownerCandidates: number[],
 *   task: string, status: 'open'|'done', dueDate: string|null, completedAt: string|null,
 *   completedBy: 'notes'|'manual'|null, occurrenceCount: number,
 *   firstMeeting: {date: string, filename: string, title: string}|null,
 *   lastMeeting: {date: string, filename: string, title: string}|null
 * }} Item
 * @typedef {{
 *   meetingDate: string, filename: string, title: string, lineNo: number, kind: string,
 *   checked: boolean, rawText: string, dueDate: string|null
 * }} OccurrenceView
 */

const ITEM_SELECT = `
  SELECT i.*, p.full_name AS owner_name,
         fm.meeting_date AS fm_date, fm.filename AS fm_file, fm.title AS fm_title,
         lm.meeting_date AS lm_date, lm.filename AS lm_file, lm.title AS lm_title,
         (SELECT COUNT(*) FROM occurrences o WHERE o.item_id = i.id) AS occurrence_count
  FROM items i
  LEFT JOIN people p    ON p.id  = i.owner_id
  LEFT JOIN meetings fm ON fm.id = i.first_meeting_id
  LEFT JOIN meetings lm ON lm.id = i.last_meeting_id`;

/** @returns {Item} */
function mapItem(r) {
  return {
    id: r.id,
    dedupeKey: r.dedupe_key,
    ownerKind: r.owner_kind,
    ownerId: r.owner_id,
    ownerName: r.owner_name,
    ownerLabel: r.owner_label,
    ownerCandidates: JSON.parse(r.owner_candidates),
    task: r.task,
    status: r.status,
    dueDate: r.due_date,
    completedAt: r.completed_at,
    completedBy: r.completed_by,
    occurrenceCount: r.occurrence_count,
    firstMeeting: r.fm_date ? { date: r.fm_date, filename: r.fm_file, title: r.fm_title } : null,
    lastMeeting: r.lm_date ? { date: r.lm_date, filename: r.lm_file, title: r.lm_title } : null,
  };
}

const mapPerson = (r) => ({ id: r.id, fullName: r.full_name, firstName: r.first_name, lastName: r.last_name, email: r.email });

export class Repository {
  /** @param {import('node:sqlite').DatabaseSync} db */
  constructor(db) {
    this.db = db;
    this.depth = 0;
  }

  close() { this.db.close(); }

  /** Runs `fn` atomically; nested calls join the outer transaction. */
  transaction(fn) {
    if (this.depth > 0) return fn();
    this.db.exec('BEGIN');
    this.depth += 1;
    try {
      const result = fn();
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    } finally {
      this.depth -= 1;
    }
  }

  // ------------------------------------------------------------------ people

  /** @param {string} fullName @param {string|null} [email] @returns {number} person id */
  upsertPerson(fullName, email = null) {
    const p = makePerson(fullName);
    const found = this.db.prepare('SELECT id FROM people WHERE lower(full_name) = lower(?)').get(p.fullName);
    if (found) {
      if (email) this.db.prepare('UPDATE people SET email = ? WHERE id = ?').run(email, found.id);
      return found.id;
    }
    const res = this.db.prepare('INSERT INTO people (full_name, first_name, last_name, email) VALUES (?, ?, ?, ?)')
      .run(p.fullName, p.firstName, p.lastName, email);
    return Number(res.lastInsertRowid);
  }

  /** @returns {Person[]} */
  allPeople() {
    return this.db.prepare('SELECT * FROM people ORDER BY full_name').all().map(mapPerson);
  }

  /** @param {number} id @returns {Person|null} */
  getPerson(id) {
    const r = this.db.prepare('SELECT * FROM people WHERE id = ?').get(id);
    return r ? mapPerson(r) : null;
  }

  // ---------------------------------------------------------------- meetings

  /** @param {string} path @returns {{id: number, contentHash: string}|null} */
  getMeetingByPath(path) {
    const r = this.db.prepare('SELECT id, content_hash FROM meetings WHERE path = ?').get(path);
    return r ? { id: r.id, contentHash: r.content_hash } : null;
  }

  /**
   * @param {{path: string, filename: string, title: string, meetingDate: string, attendees: string[], contentHash: string, now: string}} m
   * @returns {number}
   */
  upsertMeeting(m) {
    const row = this.db.prepare(`
      INSERT INTO meetings (path, filename, title, meeting_date, attendees, content_hash, ingested_at)
      VALUES (:path, :filename, :title, :date, :attendees, :hash, :now)
      ON CONFLICT(path) DO UPDATE SET filename = :filename, title = :title, meeting_date = :date,
        attendees = :attendees, content_hash = :hash, ingested_at = :now
      RETURNING id`).get({
      path: m.path, filename: m.filename, title: m.title, date: m.meetingDate,
      attendees: JSON.stringify(m.attendees), hash: m.contentHash, now: m.now,
    });
    return row.id;
  }

  /** @param {number} meetingId @returns {number[]} ids of items that had occurrences in this meeting */
  itemIdsForMeeting(meetingId) {
    return this.db.prepare('SELECT DISTINCT item_id FROM occurrences WHERE meeting_id = ?').all(meetingId).map((r) => r.item_id);
  }

  deleteOccurrencesForMeeting(meetingId) {
    this.db.prepare('DELETE FROM occurrences WHERE meeting_id = ?').run(meetingId);
  }

  countMeetings() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM meetings').get().n;
  }

  // ------------------------------------------------------------------- items

  /**
   * Finds the item with this dedupe key or creates it.
   * @param {{dedupeKey: string, ownerKind: string, ownerId: number|null, ownerLabel: string|null, ownerCandidates: number[], task: string, now: string}} i
   * @returns {{id: number, created: boolean}}
   */
  upsertItem(i) {
    const found = this.db.prepare('SELECT id FROM items WHERE dedupe_key = ?').get(i.dedupeKey);
    if (found) return { id: found.id, created: false };
    const res = this.db.prepare(`
      INSERT INTO items (dedupe_key, owner_kind, owner_id, owner_label, owner_candidates, task, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, 'open', ?, ?)`)
      .run(i.dedupeKey, i.ownerKind, i.ownerId, i.ownerLabel, JSON.stringify(i.ownerCandidates), i.task, i.now, i.now);
    return { id: Number(res.lastInsertRowid), created: true };
  }

  /** @param {{itemId: number, meetingId: number, lineNo: number, kind: string, checked: boolean, task: string, rawText: string, dueDate: string|null}} o */
  addOccurrence(o) {
    this.db.prepare(`
      INSERT OR IGNORE INTO occurrences (item_id, meeting_id, line_no, kind, checked, task, raw_text, due_date)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(o.itemId, o.meetingId, o.lineNo, o.kind, o.checked ? 1 : 0, o.task, o.rawText, o.dueDate);
  }

  /** Comparable snapshot used to count created/updated/unchanged items. @param {number[]} ids */
  snapshotItems(ids) {
    /** @type {Map<number, string>} */
    const out = new Map();
    const stmt = this.db.prepare('SELECT id, task, status, due_date, completed_at, completed_by, last_meeting_id FROM items WHERE id = ?');
    for (const id of ids) {
      const r = stmt.get(id);
      if (r) out.set(id, JSON.stringify([r.task, r.status, r.due_date, r.completed_at, r.completed_by, r.last_meeting_id]));
    }
    return out;
  }

  /**
   * Recompute derived item fields from occurrences (plan §3.5) — independent of ingest order, so idempotent.
   * Items left with no occurrences are removed unless they were completed manually.
   * @param {number[]} ids
   * @param {string} now ISO timestamp for updated_at
   * @returns {{deleted: number[]}}
   */
  recomputeItems(ids, now) {
    const deleted = [];
    const getItem = this.db.prepare('SELECT * FROM items WHERE id = ?');
    const getOcc = this.db.prepare(`
      SELECT o.*, m.meeting_date FROM occurrences o JOIN meetings m ON m.id = o.meeting_id
      WHERE o.item_id = ? ORDER BY m.meeting_date, m.filename, o.line_no`);
    const update = this.db.prepare(`
      UPDATE items SET task = :task, status = :status, due_date = :due, completed_at = :completedAt, completed_by = :completedBy,
        first_meeting_id = :first, last_meeting_id = :last, updated_at = :now WHERE id = :id`);
    const remove = this.db.prepare('DELETE FROM items WHERE id = ?');

    for (const id of new Set(ids)) {
      const item = getItem.get(id);
      if (!item) continue;
      const occ = getOcc.all(id);
      if (occ.length === 0) {
        if (item.completed_by !== 'manual') { remove.run(id); deleted.push(id); }
        continue;
      }
      const latest = occ.at(-1);
      const withDue = [...occ].reverse().find((o) => o.due_date);
      let status = latest.checked ? 'done' : 'open';
      let completedAt = status === 'done' ? latest.meeting_date : null;
      let completedBy = status === 'done' ? 'notes' : null;
      if (item.completed_by === 'manual') { // a manual completion is never reopened by ingest (FR-I24)
        status = 'done'; completedAt = item.completed_at; completedBy = 'manual';
      }
      const next = {
        task: latest.task, status, due: withDue ? withDue.due_date : null, completedAt, completedBy,
        first: occ[0].meeting_id, last: latest.meeting_id,
      };
      const changed = next.task !== item.task || next.status !== item.status || next.due !== item.due_date
        || next.completedAt !== item.completed_at || next.completedBy !== item.completed_by
        || next.last !== item.last_meeting_id || next.first !== item.first_meeting_id;
      if (changed) update.run({ ...next, now, id });
    }
    return { deleted };
  }

  /**
   * @param {number} id @param {string} today YYYY-MM-DD @param {string} now ISO timestamp
   * @returns {'done'|'already'|'missing'}
   */
  markDone(id, today, now) {
    const r = this.db.prepare('SELECT status FROM items WHERE id = ?').get(id);
    if (!r) return 'missing';
    if (r.status === 'done') return 'already';
    this.db.prepare(`UPDATE items SET status = 'done', completed_at = ?, completed_by = 'manual', updated_at = ? WHERE id = ?`)
      .run(today, now, id);
    return 'done';
  }

  /**
   * Filter items. All filters AND together; `statuses` are OR-ed derived statuses (open excludes overdue).
   * @param {{ownerIds?: number[], statuses?: ('open'|'done'|'overdue')[], dueBefore?: string, unassigned?: boolean, today: string}} f
   * @returns {Item[]}
   */
  listItems(f) {
    const where = [];
    /** @type {Record<string, string|number>} */
    const params = { today: f.today };
    if (f.ownerIds) {
      if (f.ownerIds.length === 0) return [];
      where.push(`i.owner_id IN (${f.ownerIds.map((id, n) => { params[`o${n}`] = id; return `:o${n}`; }).join(',')})`);
    }
    if (f.unassigned) where.push(`i.owner_kind <> 'person'`);
    if (f.dueBefore) { where.push('i.due_date IS NOT NULL AND i.due_date < :dueBefore'); params.dueBefore = f.dueBefore; }
    if (f.statuses && f.statuses.length > 0) {
      const preds = {
        done: `i.status = 'done'`,
        overdue: `(i.status = 'open' AND i.due_date IS NOT NULL AND i.due_date < :today)`,
        open: `(i.status = 'open' AND (i.due_date IS NULL OR i.due_date >= :today))`,
      };
      where.push(`(${f.statuses.map((s) => preds[s]).join(' OR ')})`);
    }
    const sql = `${ITEM_SELECT}
      ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
      ORDER BY CASE WHEN i.status = 'done' THEN 2 WHEN i.due_date IS NOT NULL AND i.due_date < :today THEN 0 ELSE 1 END,
               i.due_date IS NULL, i.due_date, i.id`;
    return this.db.prepare(sql).all(params).map(mapItem);
  }

  /** @param {number} id @returns {Item|null} */
  getItem(id) {
    const r = this.db.prepare(`${ITEM_SELECT} WHERE i.id = ?`).get(id);
    return r ? mapItem(r) : null;
  }

  /** Open items whose owner could be this person but is ambiguous (follow-up "please confirm"). @returns {Item[]} */
  ambiguousItemsFor(personId) {
    return this.db.prepare(`${ITEM_SELECT}
      WHERE i.owner_kind = 'ambiguous' AND i.status = 'open'
        AND EXISTS (SELECT 1 FROM json_each(i.owner_candidates) j WHERE j.value = ?)
      ORDER BY i.due_date IS NULL, i.due_date, i.id`).all(personId).map(mapItem);
  }

  /** @param {number[]} itemIds @returns {Map<number, OccurrenceView[]>} */
  occurrencesFor(itemIds) {
    /** @type {Map<number, OccurrenceView[]>} */
    const out = new Map();
    const stmt = this.db.prepare(`
      SELECT o.*, m.meeting_date, m.filename, m.title FROM occurrences o JOIN meetings m ON m.id = o.meeting_id
      WHERE o.item_id = ? ORDER BY m.meeting_date, m.filename, o.line_no`);
    for (const id of itemIds) {
      out.set(id, stmt.all(id).map((r) => ({
        meetingDate: r.meeting_date, filename: r.filename, title: r.title, lineNo: r.line_no, kind: r.kind,
        checked: r.checked === 1, rawText: r.raw_text, dueDate: r.due_date,
      })));
    }
    return out;
  }

  countOccurrences() {
    return this.db.prepare('SELECT COUNT(*) AS n FROM occurrences').get().n;
  }

  // ----------------------------------------------------------------- drafts

  /** @returns {{id: number, status: string, externalId: string|null}|null} */
  findDraft(personId, itemsetHash) {
    const r = this.db.prepare('SELECT id, status, external_id FROM followup_drafts WHERE person_id = ? AND itemset_hash = ? ORDER BY id DESC LIMIT 1')
      .get(personId, itemsetHash);
    return r ? { id: r.id, status: r.status, externalId: r.external_id } : null;
  }

  /** @param {{personId: number, itemsetHash: string, sink: string, status: 'staged'|'drafted', externalId: string|null, subject: string, now: string}} d */
  recordDraft(d) {
    this.db.prepare(`
      INSERT INTO followup_drafts (person_id, itemset_hash, sink, status, external_id, subject, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(d.personId, d.itemsetHash, d.sink, d.status, d.externalId, d.subject, d.now);
  }
}
