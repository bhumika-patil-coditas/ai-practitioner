import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { ingestFolder } from '../../src/services/ingest-service.js';
import { createClock } from '../../src/clock.js';
import { loadConfig } from '../../src/config.js';
import { UsageError } from '../../src/errors.js';
import { memoryRepo, makeNotesFolder, note, tempDir } from '../helpers.js';

const ctxFor = (repo = memoryRepo(), config = loadConfig({ cwd: tempDir(), env: {} })) => ({
  repo, config, clock: createClock({ today: '2026-10-15', env: {} }),
});
const ingest = (ctx, files) => ingestFolder(ctx, makeNotesFolder(files));
const items = (ctx) => ctx.repo.listItems({ today: '2026-10-15' });
const byTask = (ctx, text) => items(ctx).filter((i) => i.task.includes(text));

describe('duplicates across meetings (FR-I20–I22)', () => {
  const chain = {
    '2026-09-01-a.md': note({ date: '2026-09-01', attendees: ['Priya Nair', 'Sam Okafor'], items: ['- [ ] Priya to send the revised quote to Acme by Friday'] }),
    '2026-09-08-b.md': note({ date: '2026-09-08', attendees: ['Priya Nair', 'Sam Okafor'], items: ['- [ ] Priya N. to send revised quote to Acme — by Friday'] }),
    '2026-09-15-c.md': note({ date: '2026-09-15', attendees: ['Priya Nair', 'Sam Okafor'], items: ['- [x] Priya to send the revised quote to Acme'] }),
  };
  test('the revised-quote chain collapses to ONE done item with 3 occurrences and the latest deadline', () => {
    const ctx = ctxFor();
    const r = ingest(ctx, chain);
    assert.equal(r.items.created, 1);
    assert.equal(r.occurrences, 3);
    const [item] = items(ctx);
    assert.equal(item.status, 'done');
    assert.equal(item.occurrenceCount, 3);
    assert.equal(item.dueDate, '2026-09-11'); // slipped from 09-04; the done mention has no date and does not erase it
    assert.equal(item.ownerName, 'Priya Nair');
    assert.equal(item.firstMeeting.date, '2026-09-01');
    assert.equal(item.lastMeeting.date, '2026-09-15');
  });
  test('result does not depend on filename order', () => {
    const renamed = Object.fromEntries(Object.entries(chain).map(([k, v], i) => [`z${3 - i}-${k}`, v]));
    const ctx = ctxFor();
    ingest(ctx, renamed);
    const [item] = items(ctx);
    assert.equal(item.status, 'done');
    assert.equal(item.dueDate, '2026-09-11');
  });
  test('the same text in one note twice is one item with two occurrences', () => {
    const ctx = ctxFor();
    ingest(ctx, { 'a.md': note({ attendees: ['Sam Okafor'], items: ['- [ ] Sam to ship it', '- [ ] Sam to ship it'] }) });
    assert.equal(items(ctx).length, 1);
    assert.equal(items(ctx)[0].occurrenceCount, 2);
  });
  test('near-miss wording stays separate (first vs updated wireframes)', () => {
    const ctx = ctxFor();
    ingest(ctx, {
      'a.md': note({ date: '2026-09-01', attendees: ['Anita Desai'], items: ['- [ ] Anita to share first wireframes by Thursday'] }),
      'b.md': note({ date: '2026-09-15', attendees: ['Anita Desai'], items: ['- [ ] Anita to share updated wireframes by Thursday'] }),
    });
    assert.equal(items(ctx).length, 2);
  });
});

describe('two people with the same first name (FR-I11, I23)', () => {
  const both = ['Priya Nair', 'Priya Shah', 'Sam Okafor'];
  test('both in the room ⇒ ambiguous with candidates; never assigned to either', () => {
    const ctx = ctxFor();
    const r = ingest(ctx, { 'a.md': note({ attendees: both, items: ['- [ ] Priya to sign off the checklist by Monday'] }) });
    const [i] = items(ctx);
    assert.equal(i.ownerKind, 'ambiguous');
    assert.equal(i.ownerId, null);
    assert.equal(i.ownerCandidates.length, 2);
    assert.deepEqual(r.warnings.filter((w) => w.code === 'ambiguous-owner').map((w) => w.line), [6]);
    assert.equal(ctx.repo.listItems({ today: '2026-10-15', ownerIds: ctx.repo.allPeople().map((p) => p.id) }).length, 0);
  });
  test('initials resolve them to different people with distinct items', () => {
    const ctx = ctxFor();
    ingest(ctx, { 'a.md': note({ attendees: both, items: ['- [ ] Priya N. to notify customers', '- [ ] Priya S. to notify customers'] }) });
    const rows = items(ctx);
    assert.equal(rows.length, 2);
    assert.deepEqual(rows.map((r) => r.ownerName).sort(), ['Priya Nair', 'Priya Shah']);
  });
  test('only one of them in the meeting ⇒ resolved without guessing', () => {
    const ctx = ctxFor();
    ingest(ctx, { 'a.md': note({ attendees: ['Priya Shah', 'Sam Okafor'], items: ['- [ ] Priya to run the tests'] }) });
    ctx.repo.upsertPerson('Priya Nair'); // exists elsewhere in the org
    assert.equal(items(ctx)[0].ownerName, 'Priya Shah');
  });
  test('note without attendees: roster fallback — unique first name resolves, shared one is ambiguous', () => {
    const ctx = ctxFor();
    ingest(ctx, {
      'a-roster.md': note({ date: '2026-09-01', attendees: ['Rahul Mehta', 'Rahul Verma', 'Sam Okafor'], items: [] }),
      'b-noattendees.md': note({ date: '2026-09-23', items: ['- [ ] Rahul to rebase the branch', '- [ ] Sam to rotate keys'] }),
    });
    assert.equal(byTask(ctx, 'rebase')[0].ownerKind, 'ambiguous');
    assert.equal(byTask(ctx, 'rotate')[0].ownerName, 'Sam Okafor');
  });
  test('roster from an EARLIER ingest still disambiguates a later folder', () => {
    const ctx = ctxFor();
    ingest(ctx, { 'a.md': note({ attendees: ['Rahul Mehta', 'Rahul Verma'], items: [] }) });
    ingest(ctx, { 'b.md': note({ date: '2026-09-23', items: ['- [ ] Rahul to rebase the branch'] }) });
    assert.equal(byTask(ctx, 'rebase')[0].ownerKind, 'ambiguous');
  });
});

describe('items with no owner / no date (FR-I12, I13)', () => {
  test('group, placeholder and ownerless items are stored, flagged, and findable as unassigned', () => {
    const ctx = ctxFor();
    const r = ingest(ctx, {
      'a.md': note({ attendees: ['Sam Okafor'], items: [
        '- [ ] Everyone to review the prototype', '- [ ] TBD to write the changelog',
        '- [ ] Someone to update the CRM notes', '- [ ] Book the venue by Friday',
      ] }),
    });
    const rows = ctx.repo.listItems({ today: '2026-10-15', unassigned: true });
    assert.equal(rows.length, 4);
    assert.deepEqual(rows.map((i) => i.ownerKind).sort(), ['group', 'none', 'none', 'none']);
    assert.equal(r.warnings.filter((w) => w.code === 'no-owner').length, 4);
    assert.equal(rows.find((i) => i.task === 'Book the venue').dueDate, '2026-09-04');
  });
  test('no due date ⇒ stored with null date, never overdue, flagged', () => {
    const ctx = ctxFor();
    const r = ingest(ctx, { 'a.md': note({ date: '2026-01-05', attendees: ['Sam Okafor'], items: ['- [ ] Sam to share the VPN guide'] }) });
    assert.equal(items(ctx)[0].dueDate, null);
    assert.equal(ctx.repo.listItems({ today: '2030-01-01', statuses: ['overdue'] }).length, 0);
    assert.equal(r.warnings.filter((w) => w.code === 'no-due-date').length, 1);
  });
  test('joint owners create one item each; helpers do not own', () => {
    const ctx = ctxFor();
    ingest(ctx, { 'a.md': note({ attendees: ['Anita Desai', 'Rahul Mehta', 'Lena Fischer', 'Priya Nair'], items: [
      '- [ ] Anita & Rahul to agree on the API by Wednesday',
      '- [ ] Lena (with Priya) to collect feedback',
    ] }) });
    assert.deepEqual(byTask(ctx, 'agree').map((i) => i.ownerName).sort(), ['Anita Desai', 'Rahul Mehta']);
    const feedback = byTask(ctx, 'collect')[0];
    assert.equal(feedback.ownerName, 'Lena Fischer');
    assert.match(feedback.task, /\(with Priya\)/);
  });
  test('an unknown name is kept as an "external" owner and flagged', () => {
    const ctx = ctxFor();
    const r = ingest(ctx, { 'a.md': note({ attendees: ['Sam Okafor'], items: ['- [ ] Zed to send the PO'] }) });
    assert.equal(items(ctx)[0].ownerKind, 'external');
    assert.equal(r.warnings.some((w) => w.code === 'unknown-owner'), true);
  });
  test('"Note: …" with an unknown name is text, not an owner', () => {
    const ctx = ctxFor();
    ingest(ctx, { 'a.md': note({ attendees: ['Sam Okafor'], items: ['- [ ] Note: remember the milk by Friday'] }) });
    const [i] = items(ctx);
    assert.equal(i.ownerKind, 'none');
    assert.equal(i.task, 'Note: remember the milk');
    assert.equal(i.dueDate, '2026-09-04');
  });
});

describe('malformed notes: skip and report, never crash (FR-I2, I27)', () => {
  const good = note({ attendees: ['Sam Okafor'], items: ['- [ ] Sam to ship it'] });
  const files = {
    'good.md': good,
    'binary.md': Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x00, 0xff, 0xfe]),
    'empty.md': '',
    'no-date.md': '# Meeting: x\nAttendees: Sam Okafor\n- [ ] Sam to ghost',
    '2026-10-03-bad-date.md': '# Meeting: x\nDate: sometime last week\n- [ ] Sam to ghost',
  };
  test('bad files are reported with reasons and contribute nothing; the good one is ingested', () => {
    const ctx = ctxFor();
    const r = ingest(ctx, files);
    assert.equal(r.scanned, 5);
    assert.equal(r.ingested, 1);
    assert.equal(r.skipped, 4);
    const reasons = Object.fromEntries(r.files.filter((f) => f.status === 'skipped').map((f) => [f.file, f.reason]));
    assert.deepEqual(reasons, {
      'binary.md': 'not-text', 'empty.md': 'empty', 'no-date.md': 'missing-date', '2026-10-03-bad-date.md': 'invalid-date',
    });
    assert.equal(r.files.find((f) => f.file === '2026-10-03-bad-date.md').hint, 'filename suggests 2026-10-03');
    assert.deepEqual(items(ctx).map((i) => i.task), ['ship it']);
    assert.equal(ctx.repo.countMeetings(), 1);
  });
  test('a folder of only bad files ingests nothing and does not throw', () => {
    const ctx = ctxFor();
    const r = ingest(ctx, { 'x.md': Buffer.from([0, 1, 2]), 'y.md': 'no header' });
    assert.equal(r.ingested, 0);
    assert.equal(items(ctx).length, 0);
  });
  test('a note that BECOMES malformed keeps its previously stored items', () => {
    const ctx = ctxFor();
    const dir = makeNotesFolder({ 'a.md': good });
    ingestFolder(ctx, dir);
    fs.writeFileSync(path.join(dir, 'a.md'), Buffer.from([0, 0, 0]));
    const r = ingestFolder(ctx, dir);
    assert.equal(r.skipped, 1);
    assert.equal(items(ctx).length, 1);
  });
  test('an unreadable path inside the folder is reported, not thrown', () => {
    const ctx = ctxFor();
    const dir = makeNotesFolder({ 'good.md': good });
    fs.mkdirSync(path.join(dir, 'dir.md')); // a directory named *.md is not a file: ignored
    const r = ingestFolder(ctx, dir);
    assert.equal(r.ingested, 1);
  });
});

describe('scanning rules', () => {
  test('recurses, skips dot-dirs and node_modules, ignores non-.md, accepts .MD', () => {
    const ctx = ctxFor();
    const r = ingest(ctx, {
      'top.md': note({ attendees: ['Sam Okafor'], items: ['- [ ] Sam to a'] }),
      'sub/deep/nested.MD': note({ attendees: ['Sam Okafor'], items: ['- [ ] Sam to b'] }),
      '.hidden/secret.md': note({ attendees: ['Sam Okafor'], items: ['- [ ] Sam to c'] }),
      'node_modules/pkg/readme.md': note({ attendees: ['Sam Okafor'], items: ['- [ ] Sam to d'] }),
      'draft.txt': '- [ ] Sam to e',
    });
    assert.equal(r.scanned, 2);
    assert.deepEqual(items(ctx).map((i) => i.task).sort(), ['a', 'b']);
  });
  test('missing folder / file instead of folder are usage errors', () => {
    const ctx = ctxFor();
    assert.throws(() => ingestFolder(ctx, path.join(tempDir(), 'nope')), UsageError);
    const f = path.join(tempDir(), 'f.md');
    fs.writeFileSync(f, 'x');
    assert.throws(() => ingestFolder(ctx, f), UsageError);
  });
});

describe('idempotency and change handling (FR-I24–I26)', () => {
  const files = {
    'a.md': note({ date: '2026-09-01', attendees: ['Sam Okafor', 'Karan Joshi'], items: ['- [ ] Sam to ship it by Friday', '- [ ] Karan to pay up'] }),
  };
  test('re-ingesting an unchanged folder changes nothing and keeps ids', () => {
    const ctx = ctxFor();
    const dir = makeNotesFolder(files);
    ingestFolder(ctx, dir);
    const before = items(ctx).map((i) => [i.id, i.task, i.status, i.dueDate]);
    const r = ingestFolder(ctx, dir);
    assert.deepEqual(r.items, { created: 0, updated: 0, unchanged: 2, removed: 0 });
    assert.deepEqual(r.files.map((f) => f.status), ['unchanged']);
    assert.deepEqual(items(ctx).map((i) => [i.id, i.task, i.status, i.dueDate]), before);
    assert.equal(ctx.repo.countOccurrences(), 2);
  });
  test('editing a note updates items (checked ⇒ done) and reports "changed"', () => {
    const ctx = ctxFor();
    const dir = makeNotesFolder(files);
    ingestFolder(ctx, dir);
    fs.writeFileSync(path.join(dir, 'a.md'), files['a.md'].replace('- [ ] Karan to pay up', '- [x] Karan to pay up'));
    const r = ingestFolder(ctx, dir);
    assert.equal(r.files[0].status, 'changed');
    assert.deepEqual(r.items, { created: 0, updated: 1, unchanged: 1, removed: 0 });
    assert.equal(byTask(ctx, 'pay up')[0].status, 'done');
  });
  test('removing an item from a note removes the item', () => {
    const ctx = ctxFor();
    const dir = makeNotesFolder(files);
    ingestFolder(ctx, dir);
    fs.writeFileSync(path.join(dir, 'a.md'), files['a.md'].replace('- [ ] Karan to pay up\n', ''));
    const r = ingestFolder(ctx, dir);
    assert.equal(r.items.removed, 1);
    assert.deepEqual(items(ctx).map((i) => i.task), ['ship it']);
  });
  test('a manual "done" survives re-ingest, even of a changed note (FR-I24)', () => {
    const ctx = ctxFor();
    const dir = makeNotesFolder(files);
    ingestFolder(ctx, dir);
    const id = byTask(ctx, 'ship')[0].id;
    ctx.repo.markDone(id, '2026-10-01', '2026-10-01T00:00:00.000Z');
    fs.writeFileSync(path.join(dir, 'a.md'), `${files['a.md']}\n- [ ] Sam to ship it by Friday\n`);
    ingestFolder(ctx, dir);
    ingestFolder(ctx, dir);
    const item = ctx.repo.getItem(id);
    assert.equal(item.status, 'done');
    assert.equal(item.completedBy, 'manual');
  });
  test('ingesting a new folder with overlapping items merges instead of duplicating', () => {
    const ctx = ctxFor();
    ingest(ctx, files);
    const r = ingest(ctx, { 'later.md': note({ date: '2026-09-20', attendees: ['Sam Okafor'], items: ['- [x] Sam to ship it'] }) });
    assert.equal(r.items.created, 0);
    assert.equal(r.items.updated, 1);
    assert.equal(byTask(ctx, 'ship')[0].status, 'done');
    assert.equal(byTask(ctx, 'ship')[0].occurrenceCount, 2);
  });
  test('ingest is atomic: a storage failure mid-run leaves the DB untouched', () => {
    const ctx = ctxFor();
    const realAdd = ctx.repo.addOccurrence.bind(ctx.repo);
    let n = 0;
    ctx.repo.addOccurrence = (o) => { if ((n += 1) === 2) throw new Error('disk full'); return realAdd(o); };
    assert.throws(() => ingest(ctx, files), /disk full/);
    assert.equal(ctx.repo.countMeetings(), 0);
    assert.equal(items(ctx).length, 0);
    assert.equal(ctx.repo.allPeople().length, 0);
  });
});

describe('config people seed the roster and emails', () => {
  test('emails from config are stored on people', () => {
    const cfgDir = tempDir();
    fs.writeFileSync(path.join(cfgDir, 'actiontrack.config.json'), JSON.stringify({ people: { 'Sam Okafor': { email: 'sam@example.com' } } }));
    const ctx = ctxFor(memoryRepo(), loadConfig({ cwd: cfgDir, env: {} }));
    ingest(ctx, { 'a.md': note({ attendees: ['Sam Okafor'], items: ['- [ ] Sam to go'] }) });
    assert.equal(ctx.repo.allPeople().find((p) => p.fullName === 'Sam Okafor').email, 'sam@example.com');
  });
});
