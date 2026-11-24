// Spec §9 acceptance scenarios A1–A10, run against the real 35-file corpus in notes/.
import { test, describe, before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, NOTES_DIR } from '../helpers.js';

let ws;
let report;
const json = async (...args) => JSON.parse((await ws.run(...args)).out);
const list = (...args) => json('list', '--json', ...args);
const find = (j, text, owner) => j.items.filter((i) => i.task.includes(text) && (!owner || i.owner.name === owner));
const one = (j, text, owner) => {
  const f = find(j, text, owner);
  assert.equal(f.length, 1, `expected exactly one item matching "${text}"${owner ? ` for ${owner}` : ''}, got ${f.length}`);
  return f[0];
};

before(async () => {
  ws = workspace({ today: '2026-10-15' });
  const r = await ws.run('ingest', NOTES_DIR, '--json');
  assert.equal(r.code, 0, r.err);
  report = JSON.parse(r.out);
});

describe('A1 — ingest the sample folder', () => {
  test('31 notes ingested, 3 skipped with the right reasons; the .txt is never read', () => {
    assert.equal(report.scanned, 34); // 34 .md files; the 35th file is a .txt
    assert.equal(report.ingested, 31);
    assert.equal(report.skipped, 3);
    const skipped = Object.fromEntries(report.files.filter((f) => f.status === 'skipped').map((f) => [f.file, f.reason]));
    assert.deepEqual(skipped, {
      'scratch.md': 'not-text',
      'untitled.md': 'missing-date',
      '2026-10-03-sales-pipeline.md': 'invalid-date',
    });
    assert.equal(report.files.some((f) => f.file.endsWith('.txt')), false);
    assert.equal(report.files.find((f) => f.file === '2026-10-03-sales-pipeline.md').hint, 'filename suggests 2026-10-03');
  });
  test('nothing from the malformed notes leaks in', async () => {
    const j = await list();
    assert.equal(find(j, 'chase').length, 0);        // untitled.md and sales-pipeline ("chase Orbit Labs")
    assert.equal(find(j, 'Orbit').filter((i) => /chase/.test(i.task)).length, 0);
    assert.equal(find(j, 'clean up duplicate leads').length, 0);
    assert.equal(find(j, 'slides').length, 0);
    assert.equal(find(j, 'Book the venue').length, 0);
  });
});

describe('A2 — extraction accuracy', () => {
  test('exactly 115 action lines: 113 checkboxes + 1 ACTION: + 1 table row', () => {
    assert.equal(report.lines, 115);
    // 118 raw checkbox-looking lines − 2 (untitled) − 2 (bad-date note) − 1 (fenced example) = 113, then + ACTION + table.
    assert.equal(report.occurrences, 116); // 115 lines + 1 extra for the joint "Anita & Rahul" item
  });
  test('traps: quoted wish, fenced example, commented-out purchase are absent', async () => {
    const j = await list();
    assert.equal(find(j, 'hardware tokens').length, 0);
    assert.equal(find(j, 'Owner to remediate').length, 0);
    assert.equal(find(j, 'remediate').length, 0);
    const refund = one(j, 'refund affected customers', 'Karan Joshi');
    assert.equal(refund.dueDate, null, 'the quoted "by Friday" must not leak onto the real refund item');
    assert.equal(refund.occurrences.length, 1);
  });
  test('all notations found: nested checkbox, *, +, [X], ACTION:, table row', async () => {
    const j = await list();
    assert.equal(one(j, 'validate targets against the budget', 'Karan Joshi').dueDate, '2026-10-05'); // nested
    assert.equal(one(j, 'run the customer survey', 'Lena Fischer').dueDate, '2026-10-15');           // * bullet
    assert.equal(one(j, 'propose the on-call rotation', 'Sam Okafor').dueDate, '2026-10-15');        // + bullet, mid-October
    assert.equal(one(j, 'approve the Q4 cloud spend', 'Karan Joshi').status, 'done');                // [X]
    assert.equal(one(j, 'circulate the offsite summary', 'Karan Joshi').dueDate, '2026-10-01');      // ACTION: … tomorrow
    assert.equal(one(j, 'Refresh the brand kit', 'Anita Desai').dueDate, '2026-10-09');              // table row
  });
  test('front-matter notes are parsed (09-16 and 09-30 standups)', async () => {
    const j = await list();
    assert.equal(one(j, 'draft the case study outline', 'Lena Fischer').dueDate, '2026-09-21');
    assert.equal(one(j, 'share the Q4 roadmap draft', 'Priya Nair').dueDate, '2026-10-02');
  });
  test('date phrases resolve against each meeting date', async () => {
    const j = await list();
    assert.equal(one(j, 'share first wireframes').dueDate, '2026-09-03');                 // Tue 09-01, "by Thursday"
    assert.equal(one(j, 'draft the test plan for invoice rounding').dueDate, '2026-09-11'); // Thu 09-03, "end of next week"
    assert.equal(one(j, 'collect 5 customer quotes').dueDate, '2026-10-02');              // latest mention "by 2 Oct" replaces "end of month"
    assert.equal(one(j, 'start SSO spike').dueDate, '2026-10-13');                        // Mon 10-05, "next Tuesday"
    assert.equal(one(j, 'write the postmortem').dueDate, '2026-09-22');                   // "by EOD tomorrow"
    assert.equal(one(j, 'schedule cutover').dueDate, '2026-10-10');                       // "for Saturday 10 Oct"
    assert.equal(one(j, 'finalise the Q4 sales targets').dueDate, '2026-10-03');          // "Oct 3rd"
  });
  test('non-dates are not turned into dates', async () => {
    const j = await list();
    assert.equal(one(j, 'cut cloud costs by 10%').dueDate, '2026-10-09');                 // "by 10%" stays in the task
    assert.equal(one(j, 'schedule the quarterly business review for November').dueDate, null);
    assert.equal(one(j, 'snapshot the production DB before cutover').dueDate, null);
  });
});

describe('A3 — duplicates across meetings', () => {
  test('the revised-quote chain is ONE done item with 3 occurrences', async () => {
    const j = await list('--owner', 'Priya Nair');
    const q = one(j, 'revised quote', 'Priya Nair');
    assert.equal(q.status, 'done');
    assert.equal(q.occurrences.length, 3);
    assert.deepEqual(q.occurrences.map((o) => o.meetingDate), ['2026-09-01', '2026-09-08', '2026-09-15']);
    assert.equal(q.dueDate, '2026-09-11'); // slipped from 09-04
  });
  test('other chains collapse and finish correctly', async () => {
    const j = await list();
    for (const [text, owner, n] of [
      ['set up the staging environment', 'Rahul Mehta', 2],
      ['confirm cloud budget with finance', 'Sam Okafor', 3],
      ['deploy the beta to staging', 'Rahul Mehta', 3],
      ['finalise the welcome-email copy', 'Anita Desai', 3],
      ['book the renewal call', 'Meera Iyer', 3],
      ['export last quarter invoices', 'Karan Joshi', 2],
    ]) {
      const it = one(j, text, owner);
      assert.equal(it.status, 'done', text);
      assert.equal(it.occurrences.length, n, text);
    }
    assert.equal(one(j, 'fix the pagination bug', 'Rahul Mehta').status, 'overdue'); // due 2026-09-23, still not done
    assert.equal(one(j, 'fix the pagination bug', 'Rahul Mehta').dueDate, '2026-09-23');
  });
  test('an undated re-mention keeps the earlier deadline (one-pager still due 10-02)', async () => {
    const it = one(await list(), 'renewal one-pager', 'Priya Nair');
    assert.equal(it.dueDate, '2026-10-02');
    assert.equal(it.status, 'overdue');
    assert.equal(it.occurrences.length, 2);
  });
  test('near-misses stay distinct', async () => {
    const j = await list();
    assert.equal(find(j, 'wireframes').length, 2);                   // first vs updated
    assert.equal(find(j, 'customer quotes').length, 2);              // collect vs publish
    assert.equal(find(j, 'pagination').length + find(j, 'critical bugs').length, 2);
  });
});

describe('A4 — two people with the same first name', () => {
  test('--owner Priya / Rahul is refused with both candidates named', async () => {
    for (const [q, a, b] of [['Priya', 'Priya Nair', 'Priya Shah'], ['Rahul', 'Rahul Mehta', 'Rahul Verma']]) {
      const r = await ws.run('list', '--owner', q);
      assert.equal(r.code, 2);
      assert.ok(r.err.includes(a) && r.err.includes(b), r.err);
      assert.equal((await ws.run('followup', q)).code, 2);
    }
  });
  test('initials and qualifiers route items to the right person', async () => {
    const j = await list();
    assert.equal(one(j, 'notify customers about the maintenance window').owner.name, 'Priya Nair');   // "Priya N."
    assert.equal(one(j, 'run the invoice rounding tests').owner.name, 'Priya Shah');                   // "Priya S."
    assert.equal(one(j, 'write acceptance tests for the signup flow').owner.name, 'Priya Shah');       // only Shah in the room
    assert.equal(one(j, 'prepare the renewal one-pager').owner.name, 'Priya Nair');                    // only Nair in the room
    assert.equal(one(j, 'fix the top three critical bugs').owner.name, 'Rahul Verma');
    assert.equal(one(j, 'fix the pagination bug').owner.name, 'Rahul Mehta');
  });
  test('ambiguous items (both in the room, or no attendees list) are never assigned', async () => {
    const j = await list('--unassigned');
    const amb = j.items.filter((i) => i.owner.kind === 'ambiguous');
    assert.deepEqual(amb.map((i) => i.task).sort(), [
      'circulate the go/no-go summary', 'own the hiring plan for the two QA roles', 'prepare the architecture overview',
      'rebase the feature branch', 'review Anita\'s PR', 'sign off the cutover checklist',
    ]);
    for (const i of amb) assert.equal(i.owner.candidates.length, 2);
    const noAttendees = amb.find((i) => i.task === 'rebase the feature branch'); // 09-23 standup has no Attendees line
    assert.deepEqual(noAttendees.owner.candidates, ['Rahul Mehta', 'Rahul Verma']);
    // …but Sam in that same attendee-less note is unique in the roster:
    assert.equal(one(await list(), 'rotate the staging credentials').owner.name, 'Sam Okafor');
  });
});

describe('A5 — items with no owner', () => {
  test('group / placeholder items are listed under --unassigned', async () => {
    const j = await list('--unassigned');
    const kinds = Object.fromEntries(j.items.filter((i) => i.owner.kind !== 'ambiguous').map((i) => [i.task, `${i.owner.kind}:${i.owner.label}`]));
    assert.deepEqual(kinds, {
      'review the prototype before the next review': 'group:Everyone',
      'submit their Q4 goals': 'group:Everyone',
      'decide on the launch date': 'group:Team',
      'write the design-system changelog': 'none:TBD',
      'update the CRM notes': 'none:Someone',
    });
  });
  test('joint owners and helpers: Anita & Rahul → two items; Lena (with Priya) → Lena', async () => {
    const j = await list();
    assert.deepEqual(find(j, 'agree on the component API').map((i) => i.owner.name).sort(), ['Anita Desai', 'Rahul Mehta']);
    assert.equal(one(j, 'collect user feedback on the prototype').owner.name, 'Lena Fischer');
    assert.equal(one(j, 'audit colour contrast').owner.name, 'Anita Desai'); // "@anita:"
  });
});

describe('A6 — overdue as of 2026-10-15', () => {
  test('Rahul Verma: only open items due before today', async () => {
    const j = await list('--owner', 'Rahul Verma', '--status', 'overdue');
    assert.deepEqual(j.items.map((i) => i.task).sort(), [
      'add idempotency keys to the payment call', 'estimate SSO work', 'fix the top three critical bugs',
      'patch the outdated express dependency', 'review the schema mapping doc', 'start SSO spike',
    ]);
    for (const i of j.items) {
      assert.equal(i.status, 'overdue');
      assert.ok(i.dueDate < '2026-10-15');
    }
  });
  test('due today is open, not overdue; undated items are never overdue', async () => {
    const j = await list();
    assert.equal(one(j, 'reconcile September ledger').status, 'open'); // due 2026-10-15
    assert.equal(one(j, 'refund affected customers').status, 'open');  // no date
    const overdue = await list('--status', 'overdue');
    assert.ok(overdue.items.every((i) => i.dueDate && i.dueDate < '2026-10-15'));
    assert.ok(overdue.items.every((i) => i.status === 'overdue'));
  });
  test('moving "today" changes overdue without touching the data', async () => {
    const early = JSON.parse((await ws.run('--today', '2026-09-05', 'list', '--status', 'overdue', '--json')).out);
    const late = JSON.parse((await ws.run('--today', '2027-01-01', 'list', '--status', 'overdue', '--json')).out);
    assert.ok(early.count < late.count);
  });
  test('--due-before', async () => {
    const j = await list('--due-before', '2026-09-05', '--status', 'overdue');
    assert.deepEqual(j.items.map((i) => i.task).sort(), ['open the repo access request', 'share first wireframes']);
  });
});

describe('A7/A8 — idempotency and manual completion', () => {
  test('re-ingest changes nothing; ids are stable', async () => {
    const before = (await list()).items.map((i) => [i.id, i.task, i.status, i.dueDate]);
    const r = JSON.parse((await ws.run('ingest', NOTES_DIR, '--json')).out);
    assert.deepEqual(r.items, { created: 0, updated: 0, unchanged: 93, removed: 0 });
    assert.ok(r.files.filter((f) => f.status !== 'skipped').every((f) => f.status === 'unchanged'));
    assert.deepEqual((await list()).items.map((i) => [i.id, i.task, i.status, i.dueDate]), before);
  });
  test('a manual done survives a re-ingest', async () => {
    const it = one(await list(), 'share the VPN guide', 'Sam Okafor');
    assert.equal(it.status, 'open');
    assert.equal((await ws.run('done', String(it.id))).code, 0);
    await ws.run('ingest', NOTES_DIR);
    const after = one(await list(), 'share the VPN guide', 'Sam Okafor');
    assert.equal(after.status, 'done');
    assert.equal(after.completedBy, 'manual');
  });
  test('--strict turns skipped notes into exit code 3', async () => {
    assert.equal((await ws.run('ingest', NOTES_DIR, '--strict')).code, 3);
  });
});

describe('A9/A10 — follow-up drafts', () => {
  const read = (d) => JSON.parse(fs.readFileSync(d.location, 'utf8'));
  let all;

  test('Karan Joshi: counts match `list`, content is sensible, nothing sent', async () => {
    const mine = await list('--owner', 'Karan Joshi');
    const overdue = mine.items.filter((i) => i.status === 'overdue').length;
    const open = mine.items.filter((i) => i.status === 'open').length;
    const r = JSON.parse((await ws.run('followup', 'Karan Joshi', '--json')).out);
    assert.equal(r.sent, false);
    assert.equal(r.drafts.length, 1);
    assert.deepEqual([r.drafts[0].counts.overdue, r.drafts[0].counts.open + r.drafts[0].counts.undated], [overdue, open]);
    assert.deepEqual([overdue, open], [7, 3]);
    const p = read(r.drafts[0]);
    assert.equal(p.subject, 'Action items: 3 open, 7 overdue (as of 2026-10-15)');
    assert.match(p.body, /Refund affected customers\n\s+No due date/);
    assert.doesNotMatch(p.body, /revoke access|approve the Q4 cloud spend/i); // done items excluded
  });

  test('--all: one draft per person with open work, plus an unrouted report', async () => {
    all = JSON.parse((await ws.run('followup', '--all', '--json', '--force')).out);
    assert.deepEqual(all.drafts.map((d) => d.person).sort(), [
      'Anita Desai', 'Karan Joshi', 'Lena Fischer', 'Meera Iyer', 'Priya Nair', 'Priya Shah', 'Rahul Mehta', 'Rahul Verma', 'Sam Okafor',
    ]);
    assert.ok(all.drafts.every((d) => d.status === 'staged'));
    assert.deepEqual(all.unrouted.map((u) => u.task).sort(), [
      'circulate the go/no-go summary', 'decide on the launch date', 'own the hiring plan for the two QA roles',
      'prepare the architecture overview', 'rebase the feature branch', 'review Anita\'s PR',
      'review the prototype before the next review', 'sign off the cutover checklist', 'submit their Q4 goals',
      'update the CRM notes', 'write the design-system changelog',
    ].sort());
  });
  test('ambiguous items are offered to both candidates in "please confirm"', () => {
    const body = (name) => read(all.drafts.find((d) => d.person === name)).body;
    for (const who of ['Priya Nair', 'Priya Shah']) {
      assert.match(body(who), /PLEASE CONFIRM \(\d\)[\s\S]*Sign off the cutover checklist/, who);
      assert.match(body(who), /Own the hiring plan/, who);
    }
    for (const who of ['Rahul Mehta', 'Rahul Verma']) {
      assert.match(body(who), /Rebase the feature branch/, who);
    }
    assert.doesNotMatch(body('Karan Joshi'), /PLEASE CONFIRM/);
  });
  test('no draft mentions the trap items', () => {
    for (const d of all.drafts) {
      const b = read(d).body;
      assert.doesNotMatch(b, /hardware tokens|remediate finding|book the venue/i);
    }
  });
  test('followup never sends: the JSON says so and only draft payloads exist on disk', () => {
    assert.equal(all.sent, false);
    const dir = path.join(ws.dir, '.actiontrack', 'drafts');
    const files = fs.readdirSync(dir, { recursive: true }).map(String);
    assert.ok(files.every((f) => /\.(json|txt)$|^[\w.-]+$/.test(f)));
  });
});
