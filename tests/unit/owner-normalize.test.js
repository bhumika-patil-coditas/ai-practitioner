import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { parseOwnerClause, resolveOwner, ownerKey } from '../../src/domain/owner.js';
import { buildRoster, matchPeople, makePerson, fold } from '../../src/domain/roster.js';
import { normalizeTask, dedupeKey, sentenceCase } from '../../src/domain/normalize.js';
import { deriveStatus } from '../../src/domain/status.js';

const roster = buildRoster([
  'Priya Nair', 'Priya Shah', 'Rahul Mehta', 'Rahul Verma', 'Anita Desai', 'Sam Okafor', 'Karan Joshi', 'Meera Iyer', 'Lena Fischer',
]);
const people = (...names) => names.map(makePerson);

describe('parseOwnerClause (FR-I10, I12, I13)', () => {
  test('first name + "to"', () => {
    const r = parseOwnerClause('Priya to send the revised quote to Acme');
    assert.deepEqual(r.owners, [{ kind: 'name', label: 'Priya', first: 'Priya', qualifier: null }]);
    assert.equal(r.task, 'send the revised quote to Acme');
    assert.equal(r.viaColon, false);
  });
  test('name + initial qualifier', () => {
    const [o] = parseOwnerClause('Priya N. to send revised quote').owners;
    assert.deepEqual(o.qualifier, { type: 'initial', value: 'n' });
    const [s] = parseOwnerClause('Priya S. to run the tests').owners;
    assert.deepEqual(s.qualifier, { type: 'initial', value: 's' });
  });
  test('full name', () => {
    const [o] = parseOwnerClause('Priya Nair to send it').owners;
    assert.deepEqual(o.qualifier, { type: 'last', value: 'nair' });
  });
  test('@handle with colon', () => {
    const r = parseOwnerClause('@anita: audit colour contrast on the dashboard');
    assert.equal(r.owners[0].first, 'anita');
    assert.equal(r.task, 'audit colour contrast on the dashboard');
    assert.equal(r.viaColon, true);
  });
  test('joint owners with & / and / comma', () => {
    assert.deepEqual(parseOwnerClause('Anita & Rahul to agree on the API').owners.map((o) => o.first), ['Anita', 'Rahul']);
    assert.deepEqual(parseOwnerClause('Sam and Karan to meet').owners.map((o) => o.first), ['Sam', 'Karan']);
    assert.deepEqual(parseOwnerClause('Sam, Karan to meet').owners.map((o) => o.first), ['Sam', 'Karan']);
  });
  test('"(with X)" helper does not become an owner', () => {
    const r = parseOwnerClause('Lena (with Priya) to collect user feedback');
    assert.deepEqual(r.owners.map((o) => o.first), ['Lena']);
    assert.equal(r.helpers, 'Priya');
    assert.equal(r.task, 'collect user feedback');
  });
  test('group words and placeholders', () => {
    assert.deepEqual(parseOwnerClause('Everyone to review the prototype').owners, [{ kind: 'group', label: 'Everyone' }]);
    assert.deepEqual(parseOwnerClause('Team to decide on the launch date').owners, [{ kind: 'group', label: 'Team' }]);
    assert.deepEqual(parseOwnerClause('TBD to write the changelog').owners, [{ kind: 'none', label: 'TBD' }]);
    assert.deepEqual(parseOwnerClause('Someone to update the CRM notes').owners, [{ kind: 'none', label: 'Someone' }]);
  });
  test('"will" and "should" delimiters', () => {
    assert.equal(parseOwnerClause('Sam will rotate keys').task, 'rotate keys');
    assert.equal(parseOwnerClause('Sam should rotate keys').task, 'rotate keys');
  });
  test('no recognisable owner ⇒ untouched text', () => {
    for (const t of ['Refresh the brand kit', 'Update to the latest version', 'follow up to the customer', 'send the deck']) {
      const r = parseOwnerClause(t);
      assert.deepEqual(r.owners, [], t);
      assert.equal(r.task, t, t);
    }
  });
});

describe('resolveOwner — same first name (FR-I11, D4)', () => {
  const tok = (s) => parseOwnerClause(`${s} to x`).owners[0];

  test('unique attendee resolves', () => {
    const r = resolveOwner(tok('Priya'), people('Priya Nair', 'Rahul Mehta'), roster);
    assert.equal(r.kind, 'person');
    assert.equal(r.person.fullName, 'Priya Nair');
  });
  test('both Priyas in the room ⇒ ambiguous, never guessed', () => {
    const r = resolveOwner(tok('Priya'), people('Priya Nair', 'Priya Shah', 'Sam Okafor'), roster);
    assert.equal(r.kind, 'ambiguous');
    assert.deepEqual(r.candidates.map((c) => c.fullName), ['Priya Nair', 'Priya Shah']);
  });
  test('initial qualifier disambiguates even when both attend', () => {
    const att = people('Priya Nair', 'Priya Shah');
    assert.equal(resolveOwner(tok('Priya N.'), att, roster).person.fullName, 'Priya Nair');
    assert.equal(resolveOwner(tok('Priya S.'), att, roster).person.fullName, 'Priya Shah');
    assert.equal(resolveOwner(tok('Priya Shah'), att, roster).person.fullName, 'Priya Shah');
  });
  test('no attendees ⇒ falls back to roster: unique resolves, duplicates are ambiguous', () => {
    assert.equal(resolveOwner(tok('Sam'), [], roster).person.fullName, 'Sam Okafor');
    assert.equal(resolveOwner(tok('Rahul'), [], roster).kind, 'ambiguous');
  });
  test('attendee list that lacks the name still falls back to roster', () => {
    assert.equal(resolveOwner(tok('Meera'), people('Sam Okafor'), roster).person.fullName, 'Meera Iyer');
  });
  test('@handle and case-insensitivity', () => {
    assert.equal(resolveOwner(tok('@anita'), people('Anita Desai'), roster).person.fullName, 'Anita Desai');
    assert.equal(resolveOwner(tok('ANITA'), people('Anita Desai'), roster).person.fullName, 'Anita Desai');
  });
  test('unknown name ⇒ external, label preserved', () => {
    const r = resolveOwner(tok('Zed'), people('Sam Okafor'), roster);
    assert.deepEqual(r, { kind: 'external', label: 'Zed' });
  });
  test('group / none pass straight through', () => {
    assert.equal(resolveOwner(tok('Everyone'), [], roster).kind, 'group');
    assert.equal(resolveOwner(tok('TBD'), [], roster).kind, 'none');
  });
  test('accents are folded when matching', () => {
    const r = buildRoster(['Zoë Ng']);
    assert.equal(resolveOwner(tok('Zoe'), [], r).person.fullName, 'Zoë Ng');
  });
});

describe('ownerKey', () => {
  test('different Priyas have different keys; ambiguous key is order independent', () => {
    const a = ownerKey({ kind: 'person', person: makePerson('Priya Nair') });
    const b = ownerKey({ kind: 'person', person: makePerson('Priya Shah') });
    assert.notEqual(a, b);
    const x = ownerKey({ kind: 'ambiguous', label: 'Priya', candidates: people('Priya Nair', 'Priya Shah') });
    const y = ownerKey({ kind: 'ambiguous', label: 'priya', candidates: people('Priya Shah', 'Priya Nair') });
    assert.equal(x, y);
    assert.equal(ownerKey({ kind: 'none', label: 'TBD' }), 'none');
  });
});

describe('roster matching for CLI owner queries', () => {
  const rows = roster;
  test('full name, first name, initial form', () => {
    assert.deepEqual(matchPeople('Priya Nair', rows).map((p) => p.fullName), ['Priya Nair']);
    assert.deepEqual(matchPeople('priya n.', rows).map((p) => p.fullName), ['Priya Nair']);
    assert.deepEqual(matchPeople('Priya', rows).map((p) => p.fullName), ['Priya Nair', 'Priya Shah']);
    assert.deepEqual(matchPeople('Karan', rows).map((p) => p.fullName), ['Karan Joshi']);
    assert.deepEqual(matchPeople('Nobody', rows), []);
  });
  test('fold', () => assert.equal(fold("O'Neil Zoë"), 'oneil zoe'));
});

describe('normalizeTask / dedupeKey (D6)', () => {
  const same = [
    ['send the revised quote to Acme', 'send revised quote to Acme'],
    ['Send the revised quote to Acme.', 'send revised quote to acme'],
    ['estimate the SSO work', 'estimate SSO work'],
    ["book the renewal call with Acme's CTO", "book the renewal call with Acme’s CTO"],
    ['fix the pagination bug', 'Fix  the  Pagination  Bug'],
  ];
  for (const [a, b] of same) test(`same: "${a}" ≡ "${b}"`, () => assert.equal(normalizeTask(a), normalizeTask(b)));

  const different = [
    ['share first wireframes', 'share updated wireframes'],
    ['collect 5 customer quotes for the landing page', 'publish the customer quotes'],
    ['fix the pagination bug', 'fix the top three critical bugs'],
  ];
  for (const [a, b] of different) test(`different: "${a}" ≢ "${b}"`, () => assert.notEqual(normalizeTask(a), normalizeTask(b)));

  test('same task, different owner ⇒ different dedupe key (FR-I23)', () => {
    assert.notEqual(dedupeKey('person:priya nair', 'x'), dedupeKey('person:priya shah', 'x'));
  });
  test('sentenceCase keeps acronyms', () => {
    assert.equal(sentenceCase('start SSO spike'), 'Start SSO spike');
    assert.equal(sentenceCase(''), '');
  });
});

describe('deriveStatus (FR-L2)', () => {
  const today = '2026-10-15';
  test('done wins', () => assert.equal(deriveStatus({ status: 'done', dueDate: '2026-01-01' }, today), 'done'));
  test('past due is overdue', () => assert.equal(deriveStatus({ status: 'open', dueDate: '2026-10-14' }, today), 'overdue'));
  test('due today is still open', () => assert.equal(deriveStatus({ status: 'open', dueDate: today }, today), 'open'));
  test('future is open', () => assert.equal(deriveStatus({ status: 'open', dueDate: '2026-10-16' }, today), 'open'));
  test('no due date is never overdue', () => assert.equal(deriveStatus({ status: 'open', dueDate: null }, today), 'open'));
});

describe('owner clause — markdown emphasis around the owner (regression: owner was lost)', () => {
  const first = (t) => parseOwnerClause(t).owners.map((o) => o.first);
  test('**bold**, __bold__, *italic*, _italic_ and `code` names', () => {
    for (const t of ['**Sam** to book the room', '__Sam__ to book the room', '*Sam* to book the room', '_Sam_ to book the room', '`Sam` to book the room']) {
      assert.deepEqual(first(t), ['Sam'], t);
      assert.equal(parseOwnerClause(t).task, 'book the room', t);
    }
  });
  test('"**Sam:** task" and a fully bold line', () => {
    assert.deepEqual(first('**Sam:** book the room'), ['Sam']);
    assert.equal(parseOwnerClause('**Sam to book the room**').task, 'book the room');
    assert.deepEqual(first('**Sam & Anita** to pair'), ['Sam', 'Anita']);
  });
  test('emphasis inside the task is left alone', () => {
    assert.equal(parseOwnerClause('Sam to fix the **login** bug and __init__ docs').task, 'fix the **login** bug and __init__ docs');
  });
  test('no-owner text with wrapper is still unwrapped for the task', () => {
    assert.equal(parseOwnerClause('**Fix login bug**').task, 'Fix login bug');
  });
});

describe('owner clause — non-ASCII names (regression: "José to …" lost its owner)', () => {
  test('accented and non-Latin-1 letters count as name characters', () => {
    for (const [text, first] of [['José to review the doc', 'José'], ['Zoë Ng to translate it', 'Zoë'], ['Søren to deploy', 'Søren'], ['@zoë: ship it', 'zoë']]) {
      assert.deepEqual(parseOwnerClause(text).owners.map((o) => o.first), [first], text);
    }
  });
  test('they resolve against accented attendees, with or without the accent typed', () => {
    const att = buildRoster(['José García', 'Sam Okafor']).map((p) => p);
    for (const t of ['José', 'Jose']) {
      const tok = parseOwnerClause(`${t} to x`).owners[0];
      assert.equal(resolveOwner(tok, att, att).person.fullName, 'José García', t);
    }
  });
});
