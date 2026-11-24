import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDays, daysBetween, endOfMonth, extractDue, isValidIso, makeIso, parseAbsoluteDate, weekday,
} from '../../src/domain/dates.js';

describe('day arithmetic', () => {
  test('makeIso / isValidIso reject impossible dates', () => {
    assert.equal(makeIso(2028, 2, 29), '2028-02-29');
    assert.equal(makeIso(2026, 2, 29), null);
    assert.equal(isValidIso('2026-02-30'), false);
    assert.equal(isValidIso('2026-09-01'), true);
    assert.equal(isValidIso('9/1/2026'), false);
  });
  test('addDays crosses month and year boundaries', () => {
    assert.equal(addDays('2026-09-30', 1), '2026-10-01');
    assert.equal(addDays('2026-12-31', 1), '2027-01-01');
    assert.equal(addDays('2026-03-01', -1), '2026-02-28');
  });
  test('weekday is ISO (Mon=1..Sun=7)', () => {
    assert.equal(weekday('2026-09-14'), 1); // Monday
    assert.equal(weekday('2026-10-10'), 6); // Saturday
    assert.equal(weekday('2026-10-11'), 7); // Sunday
  });
  test('daysBetween and endOfMonth', () => {
    assert.equal(daysBetween('2026-09-01', '2026-09-11'), 10);
    assert.equal(daysBetween('2026-09-11', '2026-09-01'), -10);
    assert.equal(endOfMonth(2026, 9), '2026-09-30');
    assert.equal(endOfMonth(2028, 2), '2028-02-29');
  });
});

describe('parseAbsoluteDate (note headers)', () => {
  const cases = [
    ['2026-09-01', '2026-09-01', null],
    ['9 September 2026', '2026-09-09', null],
    ['Monday, 14 September 2026', '2026-09-14', 1],
    ['September 9, 2026', '2026-09-09', null],
    ['  3rd Oct 2026 ', '2026-10-03', null],
  ];
  for (const [input, iso, wd] of cases) {
    test(`parses "${input}"`, () => {
      const r = parseAbsoluteDate(input);
      assert.equal(r.iso, iso);
      assert.equal(r.weekdayPrefix, wd);
    });
  }
  test('unparseable text', () => {
    assert.deepEqual(parseAbsoluteDate('sometime last week'), { error: 'unparseable' });
    assert.deepEqual(parseAbsoluteDate(''), { error: 'unparseable' });
    assert.deepEqual(parseAbsoluteDate(undefined), { error: 'unparseable' });
  });
  test('well-formed but impossible date', () => {
    assert.deepEqual(parseAbsoluteDate('2026-02-30'), { error: 'invalid' });
    assert.deepEqual(parseAbsoluteDate('31 June 2026'), { error: 'invalid' });
  });
  test('year is mandatory in headers', () => {
    assert.deepEqual(parseAbsoluteDate('9 September'), { error: 'unparseable' });
  });
});

describe('extractDue — every phrase found in the sample corpus', () => {
  // [reference meeting date, input, expected due, expected remaining task]
  const cases = [
    ['2026-09-01', 'send the revised quote to Acme by Friday', '2026-09-04', 'send the revised quote to Acme'],
    ['2026-09-01', 'share first wireframes by Thursday', '2026-09-03', 'share first wireframes'],
    ['2026-09-01', 'set up the staging environment by 2026-09-08', '2026-09-08', 'set up the staging environment'],
    ['2026-09-03', 'export last quarter invoices by 10 Sep', '2026-09-10', 'export last quarter invoices'],
    ['2026-09-03', 'review the schema mapping doc by Monday', '2026-09-07', 'review the schema mapping doc'],
    ['2026-09-03', 'draft the test plan for invoice rounding by end of next week', '2026-09-11', 'draft the test plan for invoice rounding'],
    ['2026-09-08', 'send revised quote to Acme — by Friday', '2026-09-11', 'send revised quote to Acme'],
    ['2026-09-08', 'finish login screen by Wed', '2026-09-09', 'finish login screen'],
    ['2026-09-02', 'open the repo access request by tomorrow', '2026-09-03', 'open the repo access request'],
    ['2026-09-10', "pull Acme's usage report for the last 6 months by tomorrow", '2026-09-11', "pull Acme's usage report for the last 6 months"],
    ['2026-09-14', 'finalise the welcome-email copy by Wed 16 Sep', '2026-09-16', 'finalise the welcome-email copy'],
    ['2026-09-14', 'write acceptance tests for the signup flow by 18 Sep', '2026-09-18', 'write acceptance tests for the signup flow'],
    ['2026-09-14', 'collect 5 customer quotes for the landing page by end of month', '2026-09-30', 'collect 5 customer quotes for the landing page'],
    ['2026-09-18', 'audit colour contrast on the dashboard by Mon', '2026-09-21', 'audit colour contrast on the dashboard'],
    ['2026-09-21', 'write the postmortem by EOD tomorrow', '2026-09-22', 'write the postmortem'],
    ['2026-09-21', 'add a regression test for double charge by 25 Sep', '2026-09-25', 'add a regression test for double charge'],
    ['2026-09-24', 'collect 5 customer quotes for the landing page by 2 Oct', '2026-10-02', 'collect 5 customer quotes for the landing page'],
    ['2026-09-29', 'schedule cutover for Saturday 10 Oct', '2026-10-10', 'schedule cutover'],
    ['2026-09-29', 'freeze invoice edits from 9 Oct', '2026-10-09', 'freeze invoice edits'],
    ['2026-09-29', 'run the invoice rounding tests by Thursday', '2026-10-01', 'run the invoice rounding tests'],
    ['2026-09-30', 'finalise the Q4 sales targets by Oct 3rd', '2026-10-03', 'finalise the Q4 sales targets'],
    ['2026-09-30', 'validate targets against the budget by Oct 5th', '2026-10-05', 'validate targets against the budget'],
    ['2026-09-30', 'run the customer survey, results due 15 October', '2026-10-15', 'run the customer survey'],
    ['2026-09-30', 'propose the on-call rotation by mid-October', '2026-10-15', 'propose the on-call rotation'],
    ['2026-09-30', 'submit their Q4 goals by 7 Oct', '2026-10-07', 'submit their Q4 goals'],
    ['2026-09-30', 'circulate the offsite summary tomorrow', '2026-10-01', 'circulate the offsite summary'],
    ['2026-10-02', 'cut cloud costs by 10% — proposal by 2026-10-09', '2026-10-09', 'cut cloud costs by 10% — proposal'],
    ['2026-10-02', 'share the Q4 pipeline forecast by Wednesday', '2026-10-07', 'share the Q4 pipeline forecast'],
    ['2026-10-05', 'start SSO spike by next Tuesday', '2026-10-13', 'start SSO spike'],
    ['2026-10-06', 'demo the portal to Acme on 2026-10-14', '2026-10-14', 'demo the portal to Acme'],
    ['2026-10-08', 'circulate the go/no-go summary by EOD', '2026-10-08', 'circulate the go/no-go summary'],
    ['2026-10-14', 'send the final contract to legal by tomorrow', '2026-10-15', 'send the final contract to legal'],
  ];
  for (const [ref, input, due, task] of cases) {
    test(`[${ref}] ${input}`, () => {
      const r = extractDue(input, ref);
      assert.equal(r.due, due);
      assert.equal(r.task, task);
      assert.equal(r.invalid, false);
    });
  }
});

describe('extractDue — rules', () => {
  test('"by <weekday>" is strictly after the meeting day', () => {
    // 2026-09-14 is a Monday: "by Monday" means next Monday, not today.
    assert.equal(extractDue('x by Monday', '2026-09-14').due, '2026-09-21');
    assert.equal(extractDue('x by Tuesday', '2026-09-14').due, '2026-09-15');
  });
  test('"next <weekday>" is in the following Mon–Sun week', () => {
    assert.equal(extractDue('x by next Tuesday', '2026-10-05').due, '2026-10-13'); // Monday meeting
    assert.equal(extractDue('x by next Monday', '2026-10-09').due, '2026-10-12'); // Friday meeting
  });
  test('weekday prefix on a date is ignored in favour of the date', () => {
    assert.equal(extractDue('x by Fri 16 Sep', '2026-09-14').due, '2026-09-16');
  });
  test('year defaults to the meeting year and rolls forward for far-past dates', () => {
    assert.equal(extractDue('x by 5 Jan', '2026-12-20').due, '2027-01-05');
    assert.equal(extractDue('x by Oct 3rd', '2026-10-05').due, '2026-10-03'); // 2 days past: keep
    assert.equal(extractDue('x by mid-January', '2026-12-20').due, '2027-01-15');
  });
  test('explicit year wins', () => {
    assert.equal(extractDue('x by 5 January 2030', '2026-12-20').due, '2030-01-05');
  });
  test('end of week / month / month-name deadlines', () => {
    assert.equal(extractDue('x by end of week', '2026-09-02').due, '2026-09-04');
    assert.equal(extractDue('x by end of the month', '2026-02-10').due, '2026-02-28');
    assert.equal(extractDue('x by November', '2026-10-14').due, '2026-11-30');
    assert.equal(extractDue('x by next week', '2026-09-02').due, '2026-09-11');
  });
  test('today / EOD resolve to the meeting day', () => {
    assert.equal(extractDue('x today', '2026-09-02').due, '2026-09-02');
    assert.equal(extractDue('x by EOD', '2026-09-02').due, '2026-09-02');
  });
  test('non-dates are left in the task and produce no due date (FR-I17)', () => {
    for (const text of [
      'cut cloud costs by 10%',
      "pull Acme's usage report for the last 6 months",
      'schedule the quarterly business review for November',
      'snapshot the production DB before cutover',
      'reconcile September ledger',
      'update the Monday report',
      'review Friday\'s demo notes',
      'monitor uptime monitoring',
      'write 5 customer quotes',
    ]) {
      const r = extractDue(text, '2026-10-14');
      assert.equal(r.due, null, text);
      assert.equal(r.task, text, text);
    }
  });
  test('impossible calendar date is flagged invalid, not guessed (FR-I19)', () => {
    const r = extractDue('send report by 2026-02-30', '2026-02-01');
    assert.equal(r.due, null);
    assert.equal(r.invalid, true);
    assert.equal(r.task, 'send report');
  });
  test('rightmost date phrase wins and only it is removed', () => {
    const r = extractDue('draft by 10 Sep, final by 20 Sep', '2026-09-01');
    assert.equal(r.due, '2026-09-20');
    assert.equal(r.task, 'draft by 10 Sep, final');
  });
  test('text with no date is only tidied', () => {
    const r = extractDue('  share   the VPN guide. ', '2026-09-02');
    assert.equal(r.due, null);
    assert.equal(r.task, 'share the VPN guide');
  });
});

describe('extractDue — bare "next <weekday>" (regression: needed a preposition)', () => {
  test('"next Monday" without by/on is a deadline', () => {
    const r = extractDue('review the plan next Monday', '2026-09-11'); // Friday
    assert.equal(r.due, '2026-09-14');
    assert.equal(r.task, 'review the plan');
  });
  test('a bare weekday without "next" is still NOT a deadline', () => {
    assert.equal(extractDue('review the Monday report', '2026-09-11').due, null);
    assert.equal(extractDue('prepare Friday', '2026-09-11').due, null);
  });
});
