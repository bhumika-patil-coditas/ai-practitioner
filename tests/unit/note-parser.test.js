import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseNote } from '../../src/domain/note-parser.js';

const NOTES = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'notes');
const corpus = (name) => fs.readFileSync(path.join(NOTES, name));
const ok = (input, filename = 'x.md') => {
  const r = parseNote(input, { filename });
  assert.equal(r.ok, true, JSON.stringify(r));
  return r.note;
};

describe('headers (FR-I4)', () => {
  test('# Meeting: title + Date + Attendees', () => {
    const n = ok('# Meeting: Quote portal kickoff\nDate: 2026-09-01\nAttendees: Priya Nair, Rahul Mehta\n\n- [ ] Priya to send it by Friday');
    assert.equal(n.title, 'Quote portal kickoff');
    assert.equal(n.date, '2026-09-01');
    assert.deepEqual(n.attendees, ['Priya Nair', 'Rahul Mehta']);
    assert.equal(n.warnings.length, 0);
  });
  test('front matter with inline list; line numbers stay absolute', () => {
    const n = ok('---\ntitle: Team standup\ndate: 2026-09-16\nattendees: [Anita Desai, Lena Fischer]\n---\n\n- [ ] Lena to draft it by 2026-09-21');
    assert.equal(n.title, 'Team standup');
    assert.deepEqual(n.attendees, ['Anita Desai', 'Lena Fischer']);
    assert.equal(n.occurrences[0].lineNo, 7);
    assert.equal(n.occurrences[0].due, '2026-09-21');
  });
  test('long-form and weekday-prefixed dates', () => {
    assert.equal(ok('# Meeting: A\nDate: 9 September 2026\n').date, '2026-09-09');
    const n = ok('# Meeting: A\nDate: Monday, 14 September 2026\n');
    assert.equal(n.date, '2026-09-14');
    assert.equal(n.warnings.length, 2 - 1); // only missing-attendees
  });
  test('weekday that disagrees with the date ⇒ warning, still parsed', () => {
    const n = ok('# Meeting: A\nDate: Tuesday, 14 September 2026\nAttendees: Sam Okafor\n');
    assert.deepEqual(n.warnings.map((w) => w.code), ['weekday-mismatch']);
    assert.equal(n.date, '2026-09-14');
  });
  test('missing attendees / title ⇒ warnings, not failure (FR-I3)', () => {
    const n = ok('Date: 2026-09-23\n\n- [ ] Sam to rotate keys', '2026-09-23-standup.md');
    assert.deepEqual(n.warnings.map((w) => w.code).sort(), ['missing-attendees', 'missing-title']);
    assert.equal(n.title, '2026-09-23-standup');
  });
  test('duplicate attendee names collapse', () => {
    assert.deepEqual(ok('# Meeting: A\nDate: 2026-01-05\nAttendees: Sam Okafor, Sam Okafor ; Priya Nair\n').attendees, ['Priya Nair', 'Sam Okafor']);
  });
  test('CRLF line endings and a UTF-8 BOM are tolerated', () => {
    const n = ok(Buffer.from('﻿# Meeting: A\r\nDate: 2026-09-01\r\nAttendees: Sam Okafor\r\n\r\n- [ ] Sam to go by Friday\r\n'));
    assert.equal(n.date, '2026-09-01');
    assert.equal(n.occurrences.length, 1);
    assert.equal(n.occurrences[0].due, '2026-09-04');
  });
  test('a Date: line buried in the body is not a header', () => {
    const r = parseNote('# Meeting: A\n\n## Notes\nDate: 2026-09-01\n', { filename: 'x.md' });
    assert.equal(r.ok, false);
    assert.equal(r.reason, 'missing-date');
  });
});

describe('invalid notes are rejected with a reason, never thrown (FR-I1, I2, I5)', () => {
  const reason = (input, filename) => {
    const r = parseNote(input, { filename });
    assert.equal(r.ok, false);
    return r;
  };
  test('binary data', () => assert.equal(reason(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0, 1]), 'a.md').reason, 'not-text'));
  test('invalid UTF-8 without NULs', () => assert.equal(reason(Buffer.from([0xff, 0xfe, 0xc7, 0x80]), 'a.md').reason, 'not-text'));
  test('empty / whitespace-only', () => {
    assert.equal(reason('', 'a.md').reason, 'empty');
    assert.equal(reason(' \n\t\n', 'a.md').reason, 'empty');
  });
  test('missing date', () => assert.equal(reason('# Meeting: A\nAttendees: Sam Okafor\n', 'a.md').reason, 'missing-date'));
  test('empty Date value', () => assert.equal(reason('# Meeting: A\nDate:\n', 'a.md').reason, 'missing-date'));
  test('unparseable date carries a filename hint', () => {
    const r = reason('# Meeting: A\nDate: sometime last week\n', '2026-10-03-sales-pipeline.md');
    assert.equal(r.reason, 'invalid-date');
    assert.equal(r.hint, 'filename suggests 2026-10-03');
    assert.match(r.detail, /sometime last week/);
  });
  test('impossible calendar date', () => assert.equal(reason('# Meeting: A\nDate: 2026-02-30\n', 'a.md').reason, 'invalid-date'));
  test('no hint when the filename has no valid date', () => assert.equal(reason('# M\nDate: nope\n', 'notes.md').hint, undefined));
});

describe('action-item extraction inside a note', () => {
  const body = (items) => `# Meeting: A\nDate: 2026-09-30\nAttendees: Sam Okafor, Karan Joshi\n\n${items}\n`;

  test('traps: quote, fence and comment are never items (FR-I7)', () => {
    const n = ok(body([
      '> - [ ] Karan to refund affected customers by Friday',
      '```', '- [ ] Owner to remediate finding by <date>', '```',
      '<!-- - [ ] Sam to buy hardware tokens -->',
      '- [ ] Karan to refund affected customers',
    ].join('\n')));
    assert.equal(n.occurrences.length, 1);
    assert.equal(n.occurrences[0].task, 'refund affected customers');
    assert.equal(n.occurrences[0].due, null); // the quoted "by Friday" must not leak in
  });
  test('items outside an "Action items" section are found', () => {
    const n = ok(body('## Morning\n- [ ] Sam to a\n## Afternoon\nACTION: Karan to b tomorrow'));
    assert.deepEqual(n.occurrences.map((o) => o.kind), ['checkbox', 'action']);
    assert.equal(n.occurrences[1].due, '2026-10-01');
  });
  test('helpers are appended to the task, due phrase removed', () => {
    const n = ok(body('- [ ] Lena (with Priya) to collect feedback by 2026-09-25'));
    assert.equal(n.occurrences[0].task, 'collect feedback (with Priya)');
    assert.equal(n.occurrences[0].due, '2026-09-25');
    assert.deepEqual(n.occurrences[0].owners.map((o) => o.first), ['Lena']);
  });
  test('no owner: whole text is the task', () => {
    const o = ok(body('- [ ] Book the venue by Friday')).occurrences[0];
    assert.deepEqual(o.owners, []);
    assert.equal(o.task, 'Book the venue');
    assert.equal(o.due, '2026-10-02');
  });
  test('invalid due date ⇒ warning with line number, item kept', () => {
    const n = ok(body('- [ ] Sam to ship by 2026-02-30'));
    assert.equal(n.occurrences[0].due, null);
    assert.deepEqual(n.warnings.map((w) => [w.code, w.line]), [['invalid-due', 5]]);
  });
  test('a note with zero action items is valid', () => {
    assert.deepEqual(ok(body('Just discussion.')).occurrences, []);
  });
  test('checked state and raw line are retained', () => {
    const o = ok(body('- [x] Sam to ship it')).occurrences[0];
    assert.equal(o.checked, true);
    assert.equal(o.raw, '- [x] Sam to ship it');
  });
});

describe('real sample files', () => {
  test('scratch.md (binary) ⇒ not-text', () => {
    const r = parseNote(corpus('scratch.md'), { filename: 'scratch.md' });
    assert.equal(r.reason, 'not-text');
  });
  test('untitled.md ⇒ missing-date', () => {
    const r = parseNote(corpus('untitled.md'), { filename: 'untitled.md' });
    assert.equal(r.reason, 'missing-date');
  });
  test('2026-10-03-sales-pipeline.md ⇒ invalid-date with hint', () => {
    const r = parseNote(corpus('2026-10-03-sales-pipeline.md'), { filename: '2026-10-03-sales-pipeline.md' });
    assert.equal(r.reason, 'invalid-date');
    assert.equal(r.hint, 'filename suggests 2026-10-03');
  });
  test('security review: only the 4 real items; fence + comment ignored', () => {
    const n = ok(corpus('2026-10-09-security-review.md'), '2026-10-09-security-review.md');
    assert.deepEqual(n.occurrences.map((o) => o.task), [
      'enable MFA on all admin accounts',
      'patch the outdated express dependency',
      'document the incident response steps',
      'revoke access for the two ex-contractors',
    ]);
  });
  test('incident review: quoted refund is dropped, real refund has no due date', () => {
    const n = ok(corpus('2026-09-21-incident-review.md'), '2026-09-21-incident-review.md');
    assert.equal(n.occurrences.length, 4);
    const refund = n.occurrences.find((o) => o.task.startsWith('refund'));
    assert.equal(refund.due, null);
  });
  test('Q4 offsite: checkboxes (all markers, nested), ACTION: and table row = 9 lines', () => {
    const n = ok(corpus('2026-09-30-q4-offsite.md'), '2026-09-30-q4-offsite.md');
    assert.equal(n.occurrences.length, 9);
    assert.deepEqual(n.occurrences.map((o) => o.kind).filter((k) => k !== 'checkbox'), ['table', 'action']);
    assert.equal(n.attendees.length, 9);
  });
});
