import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseFrontMatter } from '../../src/domain/frontmatter.js';
import { scanLines } from '../../src/domain/markdown-scan.js';
import { extractActionLines } from '../../src/domain/action-lines.js';

const lines = (s) => s.split('\n');
const items = (s) => extractActionLines(scanLines(lines(s)));

describe('frontmatter', () => {
  test('inline list, scalars, closing line number', () => {
    const fm = parseFrontMatter(lines('---\ntitle: Team standup\ndate: 2026-09-16\nattendees: [Anita Desai, Lena Fischer]\n---\nbody'));
    assert.deepEqual(fm.data, { title: 'Team standup', date: '2026-09-16', attendees: ['Anita Desai', 'Lena Fischer'] });
    assert.equal(fm.endLine, 5);
  });
  test('block list and quoted values', () => {
    const fm = parseFrontMatter(lines('---\ntitle: "Quoted: title"\nattendees:\n  - Sam Okafor\n  - \'Priya Nair\'\n---'));
    assert.equal(fm.data.title, 'Quoted: title');
    assert.deepEqual(fm.data.attendees, ['Sam Okafor', 'Priya Nair']);
  });
  test('keys are case-insensitive; blank/comment lines ignored', () => {
    const fm = parseFrontMatter(lines('---\n# comment\n\nDate: 2026-01-01\n---'));
    assert.equal(fm.data.date, '2026-01-01');
  });
  test('null when there is no front matter or it is unterminated', () => {
    assert.equal(parseFrontMatter(lines('# Meeting: x\nDate: 2026-01-01')), null);
    assert.equal(parseFrontMatter(lines('---\ndate: 2026-01-01\nno closing')), null);
    assert.equal(parseFrontMatter([]), null);
  });
});

describe('markdown-scan — regions that are never items (FR-I7)', () => {
  const skippedReasons = (s) => scanLines(lines(s)).filter((l) => l.skipped).map((l) => [l.no, l.reason]);

  test('fenced code (backticks and tildes, longer closing fence ok)', () => {
    assert.deepEqual(skippedReasons('a\n```\n- [ ] x\n```\nb'), [[2, 'fence'], [3, 'fence'], [4, 'fence']]);
    assert.deepEqual(skippedReasons('~~~\n- [ ] x\n~~~~\nb').map((x) => x[0]), [1, 2, 3]);
  });
  test('a shorter or different fence does not close the block', () => {
    const s = '````\n```\n- [ ] still inside\n~~~\n````\n- [ ] outside';
    assert.deepEqual(items(s).map((i) => i.text), ['outside']);
  });
  test('unclosed fence swallows the rest of the file', () => {
    assert.deepEqual(items('```\n- [ ] a\n- [ ] b'), []);
  });
  test('single-line and multi-line HTML comments', () => {
    assert.deepEqual(items('<!-- - [ ] Sam to buy tokens -->\n- [ ] real'), [
      { lineNo: 2, kind: 'checkbox', checked: false, text: 'real', raw: '- [ ] real' },
    ]);
    assert.deepEqual(items('<!--\n- [ ] hidden\n-->\n- [ ] shown').map((i) => i.text), ['shown']);
  });
  test('a trailing inline comment is stripped, the visible part is kept', () => {
    assert.deepEqual(items('- [ ] Karan to send it <!-- maybe -->').map((i) => i.text), ['Karan to send it']);
  });
  test('blockquotes', () => {
    assert.deepEqual(items('> - [ ] wish\n>- [ ] wish2\n- [ ] real').map((i) => i.text), ['real']);
  });
  test('line numbers are absolute', () => {
    assert.deepEqual(scanLines(['x', 'y'], 10).map((l) => l.no), [10, 11]);
  });
});

describe('action-lines — notations (FR-I6, FR-I8)', () => {
  test('all three bullet markers, [x] and [X], any indent', () => {
    const r = items('- [ ] a\n* [x] b\n+ [X] c\n    - [ ] d');
    assert.deepEqual(r.map((x) => [x.text, x.checked]), [['a', false], ['b', true], ['c', true], ['d', false]]);
    assert.ok(r.every((x) => x.kind === 'checkbox'));
  });
  test('no space after the bracket is tolerated; empty checkbox ignored', () => {
    assert.deepEqual(items('- [ ]Priya to send it\n- [ ]\n- [ ]   ').map((x) => x.text), ['Priya to send it']);
  });
  test('ACTION: lines (case-insensitive, optional bullet), but not headings or prose', () => {
    const r = items('ACTION: Karan to circulate\n- action: Sam to run\n## Action items\nAction items are below\nTake action now');
    assert.deepEqual(r.map((x) => [x.kind, x.text]), [['action', 'Karan to circulate'], ['action', 'Sam to run']]);
  });
  test('table rows become "<owner> to <action> by <due>"', () => {
    const r = items('| Owner | Action | Due |\n|-------|--------|-----|\n| Anita | Refresh the brand kit | 2026-10-09 |\n| Sam | Rotate keys | — |\n|  | Orphan row |  |\nafter');
    assert.deepEqual(r.map((x) => x.text), [
      'Anita to Refresh the brand kit by 2026-10-09',
      'Sam to Rotate keys',
      'Orphan row',
    ]);
    assert.ok(r.every((x) => x.kind === 'table' && !x.checked));
    assert.equal(r[0].lineNo, 3);
  });
  test('column order is taken from the header', () => {
    const r = items('| Due | Task | Who |\n|---|---|---|\n| Friday | Ship it | Rahul |');
    assert.deepEqual(r.map((x) => x.text), ['Rahul to Ship it by Friday']);
  });
  test('a pipe table without Owner/Action columns is not an action table', () => {
    assert.deepEqual(items('| Name | Role |\n|---|---|\n| Sam | Lead |'), []);
  });
  test('table ends at the first non-pipe line', () => {
    const r = items('| Owner | Action |\n|---|---|\n| A | one |\n\n| B | two |');
    assert.deepEqual(r.map((x) => x.text), ['A to one']);
  });
  test('prose that merely mentions a checkbox is ignored', () => {
    assert.deepEqual(items('We use [ ] boxes in notes.\n  see - [ ] later'), []);
  });
});

describe('action-lines — numbered checklists (regression: were silently dropped)', () => {
  test('"1. [ ]" and "2) [x]" are action items; plain numbered text is not', () => {
    const r = items('1. [ ] José to review the doc\n2) [x] Sam to ship it\n3. Sam to do something without a checkbox\n10. [ ] Anita to follow up');
    assert.deepEqual(r.map((x) => [x.text, x.checked]), [['José to review the doc', false], ['Sam to ship it', true], ['Anita to follow up', false]]);
  });
});
