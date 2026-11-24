import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { memoryRepo } from '../helpers.js';
import { migrate, LATEST_VERSION } from '../../src/db/migrations.js';
import { DatabaseSync } from 'node:sqlite';
import { StorageError } from '../../src/errors.js';

const NOW = '2026-10-15T00:00:00.000Z';

/** Insert a meeting + occurrence(s) for one item the way the ingest service does. */
function seed(repo) {
  const priya = repo.upsertPerson('Priya Nair');
  let seq = 0;
  const meeting = (date, filename = `${date}.md`) => repo.upsertMeeting({
    path: `/n/${filename}`, filename, title: `M ${date}`, meetingDate: date, attendees: [], contentHash: `h${seq += 1}`, now: NOW,
  });
  const item = (key = 'person:priya nair|send quote', task = 'send quote') => repo.upsertItem({
    dedupeKey: key, ownerKind: 'person', ownerId: priya, ownerLabel: 'Priya', ownerCandidates: [], task, now: NOW,
  });
  const occ = (itemId, meetingId, o = {}) => repo.addOccurrence({
    itemId, meetingId, lineNo: o.lineNo ?? 5, kind: 'checkbox', checked: o.checked ?? false,
    task: o.task ?? 'send quote', rawText: '- [ ] x', dueDate: o.due ?? null,
  });
  return { priya, meeting, item, occ };
}

const one = (repo, id) => repo.getItem(id);

describe('schema & migrations (FR-G4)', () => {
  test('fresh DB is migrated to the latest version with foreign keys enforced', () => {
    const repo = memoryRepo();
    assert.equal(repo.db.prepare('PRAGMA user_version').get().user_version, LATEST_VERSION);
    assert.throws(() => repo.db.prepare(
      `INSERT INTO occurrences (item_id, meeting_id, line_no, kind, checked, task, raw_text) VALUES (999, 999, 1, 'checkbox', 0, 't', 'r')`).run(), /FOREIGN KEY/);
  });
  test('migrate is idempotent', () => {
    const repo = memoryRepo();
    migrate(repo.db);
    migrate(repo.db);
    assert.equal(repo.db.prepare('PRAGMA user_version').get().user_version, LATEST_VERSION);
  });
  test('a database from a newer tool version is refused', () => {
    const db = new DatabaseSync(':memory:');
    db.exec(`PRAGMA user_version = ${LATEST_VERSION + 1}`);
    assert.throws(() => migrate(db), StorageError);
  });
  test('CHECK constraints: status values, owner/owner_id consistency', () => {
    const repo = memoryRepo();
    assert.throws(() => repo.db.prepare(
      `INSERT INTO items (dedupe_key, owner_kind, task, status, created_at, updated_at) VALUES ('k','none','t','overdue','n','n')`).run(), /CHECK/);
    assert.throws(() => repo.db.prepare(
      `INSERT INTO items (dedupe_key, owner_kind, task, created_at, updated_at) VALUES ('k','person','t','n','n')`).run(), /CHECK/);
  });
  test('dedupe_key is unique', () => {
    const repo = memoryRepo();
    const { item } = seed(repo);
    const a = item();
    const b = item();
    assert.equal(a.created, true);
    assert.equal(b.created, false);
    assert.equal(a.id, b.id);
  });
});

describe('people', () => {
  test('upsert is case-insensitive and updates email', () => {
    const repo = memoryRepo();
    const a = repo.upsertPerson('Priya Nair');
    const b = repo.upsertPerson('priya nair', 'p@example.com');
    assert.equal(a, b);
    assert.equal(repo.allPeople()[0].email, 'p@example.com');
    assert.equal(repo.allPeople()[0].lastName, 'Nair');
  });
  test('a person with the same first name is a different person', () => {
    const repo = memoryRepo();
    repo.upsertPerson('Priya Nair');
    repo.upsertPerson('Priya Shah');
    assert.equal(repo.allPeople().length, 2);
  });
});

describe('recomputeItems — merge rules (FR-I22, I24)', () => {
  test('status follows the latest mention; completed_at is that meeting date', () => {
    const repo = memoryRepo();
    const { meeting, item, occ } = seed(repo);
    const { id } = item();
    occ(id, meeting('2026-09-01'));
    occ(id, meeting('2026-09-15'), { checked: true });
    repo.recomputeItems([id], NOW);
    const r = one(repo, id);
    assert.equal(r.status, 'done');
    assert.equal(r.completedAt, '2026-09-15');
    assert.equal(r.completedBy, 'notes');
    assert.equal(r.occurrenceCount, 2);
  });
  test('latest is decided by meeting date, not insertion order', () => {
    const repo = memoryRepo();
    const { meeting, item, occ } = seed(repo);
    const { id } = item();
    occ(id, meeting('2026-09-15'), { checked: true }); // inserted first, but later in time…
    occ(id, meeting('2026-09-01'));                    // …than this one
    repo.recomputeItems([id], NOW);
    assert.equal(one(repo, id).status, 'done');
  });
  test('a later open mention reopens a notes-completed item', () => {
    const repo = memoryRepo();
    const { meeting, item, occ } = seed(repo);
    const { id } = item();
    occ(id, meeting('2026-09-01'), { checked: true });
    occ(id, meeting('2026-09-15'));
    repo.recomputeItems([id], NOW);
    const r = one(repo, id);
    assert.equal(r.status, 'open');
    assert.equal(r.completedAt, null);
  });
  test('a new date replaces the old deadline (slipped)', () => {
    const repo = memoryRepo();
    const { meeting, item, occ } = seed(repo);
    const { id } = item();
    occ(id, meeting('2026-09-01'), { due: '2026-09-04' });
    occ(id, meeting('2026-09-08'), { due: '2026-09-11' });
    repo.recomputeItems([id], NOW);
    assert.equal(one(repo, id).dueDate, '2026-09-11');
  });
  test('a later mention WITHOUT a date keeps the earlier deadline', () => {
    const repo = memoryRepo();
    const { meeting, item, occ } = seed(repo);
    const { id } = item();
    occ(id, meeting('2026-09-28'), { due: '2026-10-02' });
    occ(id, meeting('2026-10-14'));
    repo.recomputeItems([id], NOW);
    assert.equal(one(repo, id).dueDate, '2026-10-02');
  });
  test('task text follows the most recent wording; first/last meeting tracked', () => {
    const repo = memoryRepo();
    const { meeting, item, occ } = seed(repo);
    const { id } = item();
    const m1 = meeting('2026-09-01');
    const m2 = meeting('2026-09-08');
    occ(id, m1, { task: 'send the revised quote to Acme' });
    occ(id, m2, { task: 'send revised quote to Acme' });
    repo.recomputeItems([id], NOW);
    const r = one(repo, id);
    assert.equal(r.task, 'send revised quote to Acme');
    assert.equal(r.firstMeeting.date, '2026-09-01');
    assert.equal(r.lastMeeting.date, '2026-09-08');
  });
  test('manual done is sticky even if a later note lists it open or checked', () => {
    const repo = memoryRepo();
    const { meeting, item, occ } = seed(repo);
    const { id } = item();
    occ(id, meeting('2026-09-01'));
    repo.recomputeItems([id], NOW);
    assert.equal(repo.markDone(id, '2026-10-01', NOW), 'done');
    occ(id, meeting('2026-09-20'));
    repo.recomputeItems([id], NOW);
    const r = one(repo, id);
    assert.equal(r.status, 'done');
    assert.equal(r.completedBy, 'manual');
    assert.equal(r.completedAt, '2026-10-01');
  });
  test('items whose occurrences all disappeared are deleted — unless completed manually', () => {
    const repo = memoryRepo();
    const { meeting, item, occ } = seed(repo);
    const a = item('k1|a', 'a').id;
    const b = item('k2|b', 'b').id;
    const m = meeting('2026-09-01');
    occ(a, m, { lineNo: 1 });
    occ(b, m, { lineNo: 2 });
    repo.recomputeItems([a, b], NOW);
    repo.markDone(b, '2026-10-01', NOW);
    repo.deleteOccurrencesForMeeting(m);
    const { deleted } = repo.recomputeItems([a, b], NOW);
    assert.deepEqual(deleted, [a]);
    assert.equal(one(repo, a), null);
    assert.equal(one(repo, b).status, 'done');
  });
  test('recompute is idempotent (no spurious updates)', () => {
    const repo = memoryRepo();
    const { meeting, item, occ } = seed(repo);
    const { id } = item();
    occ(id, meeting('2026-09-01'), { due: '2026-09-04' });
    repo.recomputeItems([id], NOW);
    const before = repo.snapshotItems([id]);
    repo.recomputeItems([id], '2027-01-01T00:00:00.000Z');
    assert.deepEqual(repo.snapshotItems([id]), before);
  });
});

describe('listItems filters (FR-L2–L6)', () => {
  const TODAY = '2026-10-15';
  function fixture() {
    const repo = memoryRepo();
    const { meeting, item, occ } = seed(repo);
    const m = meeting('2026-09-01');
    const mk = (key, task, { due = null, checked = false, line }) => {
      const { id } = item(key, task);
      occ(id, m, { lineNo: line, due, checked, task });
      return id;
    };
    const ids = {
      overdue: mk('k|overdue', 'overdue one', { due: '2026-10-01', line: 1 }),
      today: mk('k|today', 'due today', { due: TODAY, line: 2 }),
      future: mk('k|future', 'future one', { due: '2026-11-01', line: 3 }),
      nodate: mk('k|nodate', 'no date', { line: 4 }),
      done: mk('k|done', 'finished', { due: '2026-09-02', checked: true, line: 5 }),
    };
    repo.recomputeItems(Object.values(ids), NOW);
    return { repo, ids };
  }
  const names = (rows) => rows.map((r) => r.task);

  test('overdue = open and due strictly before today', () => {
    const { repo } = fixture();
    assert.deepEqual(names(repo.listItems({ today: TODAY, statuses: ['overdue'] })), ['overdue one']);
  });
  test('open excludes overdue, includes due-today and undated', () => {
    const { repo } = fixture();
    assert.deepEqual(names(repo.listItems({ today: TODAY, statuses: ['open'] })), ['due today', 'future one', 'no date']);
  });
  test('done', () => {
    const { repo } = fixture();
    assert.deepEqual(names(repo.listItems({ today: TODAY, statuses: ['done'] })), ['finished']);
  });
  test('several statuses OR together', () => {
    const { repo } = fixture();
    assert.deepEqual(names(repo.listItems({ today: TODAY, statuses: ['overdue', 'open'] })), ['overdue one', 'due today', 'future one', 'no date']);
  });
  test('default order: overdue, open (dated first, undated last), done', () => {
    const { repo } = fixture();
    assert.deepEqual(names(repo.listItems({ today: TODAY })), ['overdue one', 'due today', 'future one', 'no date', 'finished']);
  });
  test('--due-before is strict and excludes undated items', () => {
    const { repo } = fixture();
    assert.deepEqual(names(repo.listItems({ today: TODAY, dueBefore: TODAY })), ['overdue one', 'finished']);
    assert.deepEqual(names(repo.listItems({ today: TODAY, dueBefore: '2026-10-02' })), ['overdue one', 'finished']);
    assert.deepEqual(names(repo.listItems({ today: TODAY, dueBefore: '2026-10-01' })), ['finished']);
  });
  test('owner filter; empty owner list matches nothing', () => {
    const { repo } = fixture();
    const priya = repo.allPeople()[0].id;
    assert.equal(repo.listItems({ today: TODAY, ownerIds: [priya] }).length, 5);
    assert.equal(repo.listItems({ today: TODAY, ownerIds: [] }).length, 0);
    assert.equal(repo.listItems({ today: TODAY, ownerIds: [9999] }).length, 0);
  });
  test('unassigned shows non-person owners only', () => {
    const { repo } = fixture();
    repo.upsertItem({ dedupeKey: 'none|x', ownerKind: 'none', ownerId: null, ownerLabel: null, ownerCandidates: [], task: 'orphan', now: NOW });
    assert.deepEqual(names(repo.listItems({ today: TODAY, unassigned: true })), ['orphan']);
  });
  test('ambiguousItemsFor matches only candidate people and only open items', () => {
    const repo = memoryRepo();
    const a = repo.upsertPerson('Priya Nair');
    const b = repo.upsertPerson('Priya Shah');
    const c = repo.upsertPerson('Sam Okafor');
    repo.upsertItem({ dedupeKey: 'amb|x', ownerKind: 'ambiguous', ownerId: null, ownerLabel: 'Priya', ownerCandidates: [a, b], task: 'confirm me', now: NOW });
    assert.deepEqual(repo.ambiguousItemsFor(a).map((i) => i.task), ['confirm me']);
    assert.deepEqual(repo.ambiguousItemsFor(b).map((i) => i.task), ['confirm me']);
    assert.deepEqual(repo.ambiguousItemsFor(c), []);
  });
});

describe('markDone', () => {
  test('done / already / missing', () => {
    const repo = memoryRepo();
    const { item } = seed(repo);
    const { id } = item();
    assert.equal(repo.markDone(id, '2026-10-15', NOW), 'done');
    assert.equal(repo.markDone(id, '2026-10-16', NOW), 'already');
    assert.equal(repo.markDone(12345, '2026-10-15', NOW), 'missing');
    const r = repo.getItem(id);
    assert.equal(r.completedAt, '2026-10-15'); // not overwritten by the second call
  });
});

describe('transactions & drafts', () => {
  test('rollback leaves nothing behind', () => {
    const repo = memoryRepo();
    assert.throws(() => repo.transaction(() => { repo.upsertPerson('Sam Okafor'); throw new Error('boom'); }), /boom/);
    assert.equal(repo.allPeople().length, 0);
  });
  test('nested transactions join the outer one', () => {
    const repo = memoryRepo();
    assert.throws(() => repo.transaction(() => {
      repo.transaction(() => repo.upsertPerson('Sam Okafor'));
      throw new Error('outer fails');
    }), /outer fails/);
    assert.equal(repo.allPeople().length, 0);
  });
  test('draft records are found by person + item-set hash', () => {
    const repo = memoryRepo();
    const p = repo.upsertPerson('Sam Okafor');
    assert.equal(repo.findDraft(p, 'h1'), null);
    repo.recordDraft({ personId: p, itemsetHash: 'h1', sink: 'file', status: 'staged', externalId: null, subject: 's', now: NOW });
    assert.equal(repo.findDraft(p, 'h1').status, 'staged');
    assert.equal(repo.findDraft(p, 'h2'), null);
  });
});
