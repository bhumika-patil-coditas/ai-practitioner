import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { workspace, note, ROOT } from '../helpers.js';

const FAKE = path.join(ROOT, 'tests', 'fixtures', 'fake-mcp-server.mjs');

const FILES = {
  '2026-09-01-a.md': note({
    date: '2026-09-01', title: 'Kickoff', attendees: ['Priya Nair', 'Rahul Mehta', 'Sam Okafor', 'Karan Joshi'],
    items: [
      '- [ ] Priya to send the revised quote by Friday',
      '- [ ] Sam to share the VPN guide',
      '- [ ] Everyone to review the prototype',
      '- [ ] Karan to pay the vendor by 2026-11-01',
      '- [x] Rahul to set up staging',
    ],
  }),
  '2026-09-08-b.md': note({
    date: '2026-09-08', title: 'Billing sync', attendees: ['Priya Nair', 'Priya Shah', 'Karan Joshi'],
    items: [
      '- [ ] Priya to sign off the checklist by Monday',
      '- [ ] Priya S. to run rounding tests by 2026-10-20',
      '- [ ] Karan to refund customers',
    ],
  }),
};

async function ready(opts = {}) {
  const ws = workspace({ files: FILES, ...opts });
  const r = await ws.run('ingest', ws.notes);
  assert.equal(r.code, 0, r.err);
  return ws;
}
const listJson = async (ws, ...args) => JSON.parse((await ws.run('list', '--json', ...args)).out);
const tasks = (j) => j.items.map((i) => i.task);

describe('list (FR-L1–L7)', () => {
  test('default: overdue → open (dated first) → done, with the summary footer', async () => {
    const ws = await ready();
    const r = await ws.run('list');
    assert.equal(r.code, 0);
    const lines = r.out.split('\n');
    assert.match(lines[0], /^ID\s+STATUS\s+OWNER\s+DUE\s+TASK\s+SOURCE$/);
    const statuses = lines.slice(2).map((l) => /\b(OVERDUE|OPEN|DONE)\b/.exec(l)?.[1]).filter(Boolean);
    assert.deepEqual(statuses, [...statuses].sort((a, b) => ['OVERDUE', 'OPEN', 'DONE'].indexOf(a) - ['OVERDUE', 'OPEN', 'DONE'].indexOf(b)));
    assert.match(r.out, /8 items \(2 overdue, 5 open, 1 done\) as of 2026-10-15/);
  });
  test('--status overdue / open / done are mutually exclusive', async () => {
    const ws = await ready();
    assert.deepEqual(tasks(await listJson(ws, '--status', 'overdue')), ['send the revised quote', 'sign off the checklist']);
    const open = await listJson(ws, '--status', 'open');
    assert.equal(open.count, 5);
    assert.ok(open.items.every((i) => i.status === 'open'));
    assert.deepEqual(tasks(await listJson(ws, '--status', 'done')), ['set up staging']);
  });
  test('--owner by full name, by "First I.", and with filters ANDed', async () => {
    const ws = await ready();
    assert.deepEqual(tasks(await listJson(ws, '--owner', 'Priya Nair')), ['send the revised quote']);
    assert.deepEqual(tasks(await listJson(ws, '--owner', 'priya n.')), ['send the revised quote']);
    assert.deepEqual(tasks(await listJson(ws, '--owner', 'Karan', '--status', 'open')), ['pay the vendor', 'refund customers']);
    assert.deepEqual(tasks(await listJson(ws, '--owner', 'Karan', '--status', 'overdue')), []);
  });
  test('--owner with a shared first name fails with exit 2 and names both people (FR-L4)', async () => {
    const ws = await ready();
    const r = await ws.run('list', '--owner', 'Priya');
    assert.equal(r.code, 2);
    assert.match(r.err, /Priya Nair, Priya Shah/);
    assert.equal(r.out, '');
  });
  test('--owner with nobody matching ⇒ empty result, hint on stderr, exit 0', async () => {
    const ws = await ready();
    const r = await ws.run('list', '--owner', 'Nobody');
    assert.equal(r.code, 0);
    assert.match(r.out, /No matching items/);
    assert.match(r.err, /no person matches "Nobody"/);
  });
  test('--due-before: ISO and phrases; strict; excludes undated', async () => {
    const ws = await ready();
    assert.deepEqual(tasks(await listJson(ws, '--due-before', '2026-09-14')), ['send the revised quote']);
    assert.deepEqual(tasks(await listJson(ws, '--due-before', '2026-09-15')), ['send the revised quote', 'sign off the checklist']);
    // today is Thu 2026-10-15; "friday" = 2026-10-16
    assert.equal((await listJson(ws, '--due-before', 'friday')).count, 2);
    assert.equal((await listJson(ws, '--due-before', 'end of month')).count, 3); // + the 2026-10-20 rounding tests
    const bad = await ws.run('list', '--due-before', 'banana');
    assert.equal(bad.code, 2);
  });
  test('--unassigned lists group / placeholder / ambiguous owners', async () => {
    const ws = await ready();
    const j = await listJson(ws, '--unassigned');
    assert.deepEqual(tasks(j).sort(), ['review the prototype', 'sign off the checklist']);
    assert.deepEqual(j.items.map((i) => i.owner.kind).sort(), ['ambiguous', 'group']);
    assert.deepEqual(j.items.find((i) => i.owner.kind === 'ambiguous').owner.candidates, ['Priya Nair', 'Priya Shah']);
  });
  test('table renders ambiguous / group owners readably', async () => {
    const ws = await ready();
    const r = await ws.run('list', '--unassigned');
    assert.match(r.out, /Priya \(ambiguous\)/);
    assert.match(r.out, /\(everyone\)/);
  });
  test('--json carries occurrences and derived status', async () => {
    const ws = await ready();
    const j = await listJson(ws, '--owner', 'Priya Nair');
    assert.equal(j.today, '2026-10-15');
    assert.equal(j.items[0].status, 'overdue');
    assert.equal(j.items[0].occurrences[0].lineNo, 6);
    assert.equal(j.items[0].dueDate, '2026-09-04');
  });
  test('empty database ⇒ friendly message; bad flags/args are usage errors', async () => {
    const ws = workspace();
    const r = await ws.run('list');
    assert.equal(r.code, 0);
    assert.match(r.out, /No matching items/);
    assert.equal((await ws.run('list', 'extra')).code, 2);
    assert.equal((await ws.run('list', '--status', 'late')).code, 2);
    assert.equal((await ws.run('list', '--bogus')).code, 2);
    assert.equal((await ws.run('ingest', '--owner', 'x', ws.notes)).code, 2); // option belongs to another command
  });
});

describe('done (FR-D1–D3)', () => {
  const idOf = async (ws, task) => (await listJson(ws)).items.find((i) => i.task === task).id;

  test('marks done; list reflects it; idempotent', async () => {
    const ws = await ready();
    const id = await idOf(ws, 'share the VPN guide');
    const a = await ws.run('done', String(id));
    assert.equal(a.code, 0);
    assert.match(a.out, new RegExp(`✓ #${id} marked done: share the VPN guide`));
    const b = await ws.run('done', String(id));
    assert.equal(b.code, 0);
    assert.match(b.out, /already done/);
    const done = await listJson(ws, '--status', 'done');
    assert.ok(tasks(done).includes('share the VPN guide'));
    assert.equal(done.items.find((i) => i.id === id).completedBy, 'manual');
    assert.equal(done.items.find((i) => i.id === id).completedAt, '2026-10-15');
  });
  test('several ids; an unknown id exits 1 but the others are still processed', async () => {
    const ws = await ready();
    const a = await idOf(ws, 'share the VPN guide');
    const b = await idOf(ws, 'refund customers');
    const r = await ws.run('done', String(a), '9999', String(b));
    assert.equal(r.code, 1);
    assert.match(r.err, /#9999 not found/);
    assert.deepEqual((await listJson(ws, '--status', 'done')).items.map((i) => i.id).sort(), [a, b, ...[(await idOf(ws, 'set up staging'))]].sort());
  });
  test('non-integer / missing id ⇒ exit 2', async () => {
    const ws = await ready();
    assert.equal((await ws.run('done', 'abc')).code, 2);
    assert.equal((await ws.run('done', '1.5')).code, 2);
    assert.equal((await ws.run('done')).code, 2);
  });
  test('stays done after re-ingesting the same notes (sticky)', async () => {
    const ws = await ready();
    const id = await idOf(ws, 'share the VPN guide');
    await ws.run('done', String(id));
    await ws.run('ingest', ws.notes);
    assert.equal((await listJson(ws, '--status', 'done')).items.some((i) => i.id === id), true);
  });
});

describe('followup (FR-F1–F8)', () => {
  const cfg = { people: { 'Karan Joshi': { email: 'karan@example.com' } } };
  const fjson = async (ws, ...args) => JSON.parse((await ws.run('followup', '--json', ...args)).out);
  const readDraft = (d) => JSON.parse(fs.readFileSync(d.location, 'utf8'));

  test('one owner → one staged draft with the right content and recipient; nothing is sent', async () => {
    const ws = await ready({ config: cfg });
    const j = await fjson(ws, 'Karan Joshi');
    assert.equal(j.sent, false);
    assert.equal(j.drafts.length, 1);
    const [d] = j.drafts;
    assert.equal(d.status, 'staged');
    assert.deepEqual(d.counts, { overdue: 0, open: 1, undated: 1, confirm: 0 });
    const payload = readDraft(d);
    assert.deepEqual(payload.to, ['karan@example.com']);
    assert.equal(payload.subject, 'Action items: 2 open, 0 overdue (as of 2026-10-15)');
    assert.match(payload.body, /Pay the vendor/);
    assert.match(payload.body, /Refund customers/);
    assert.deepEqual(d.warnings, []);
  });
  test('subject counts match `list` for the same owner', async () => {
    const ws = await ready();
    const l = await listJson(ws, '--owner', 'Priya Nair');
    const overdue = l.items.filter((i) => i.status === 'overdue').length;
    const d = (await fjson(ws, 'Priya Nair')).drafts[0];
    assert.equal(d.counts.overdue, overdue);
    assert.equal(d.counts.open + d.counts.undated, l.items.filter((i) => i.status === 'open').length);
  });
  test('missing email ⇒ draft still produced with empty To and a missing-recipient warning', async () => {
    const ws = await ready();
    const d = (await fjson(ws, 'Karan Joshi')).drafts[0];
    assert.deepEqual(readDraft(d).to, []);
    assert.deepEqual(d.warnings.map((w) => w.code), ['missing-recipient']);
  });
  test('ambiguous / unknown owner names never produce a draft', async () => {
    const ws = await ready();
    const a = await ws.run('followup', 'Priya');
    assert.equal(a.code, 2);
    assert.match(a.err, /Priya Nair, Priya Shah/);
    const b = await ws.run('followup', 'Nobody');
    assert.equal(b.code, 1);
    assert.match(b.err, /no person matches/);
    assert.equal(fs.existsSync(path.join(ws.dir, '.actiontrack', 'drafts')), false);
  });
  test('"please confirm": ambiguous items are offered to BOTH candidates, not assigned', async () => {
    const ws = await ready();
    for (const who of ['Priya Nair', 'Priya Shah']) {
      const d = (await fjson(ws, who)).drafts[0];
      assert.equal(d.counts.confirm, 1, who);
      assert.match(readDraft(d).body, /PLEASE CONFIRM \(1\)[\s\S]*Sign off the checklist/);
    }
    const karan = (await fjson(ws, 'Karan Joshi', '--force')).drafts[0];
    assert.equal(karan.counts.confirm, 0);
  });
  test('person with nothing open ⇒ no draft', async () => {
    const ws = await ready();
    const r = await ws.run('followup', 'Rahul Mehta');
    assert.equal(r.code, 0);
    assert.match(r.out, /No follow-ups needed/);
  });
  test('duplicate guard: same item set is skipped; --force overrides; changes make a new draft', async () => {
    const ws = await ready();
    assert.equal((await fjson(ws, 'Karan Joshi')).drafts[0].status, 'staged');
    assert.equal((await fjson(ws, 'Karan Joshi')).drafts[0].status, 'skipped-duplicate');
    assert.equal((await fjson(ws, 'Karan Joshi', '--force')).drafts[0].status, 'staged');
    const refund = (await listJson(ws, '--owner', 'Karan Joshi')).items.find((i) => i.task === 'refund customers').id;
    await ws.run('done', String(refund));
    assert.equal((await fjson(ws, 'Karan Joshi')).drafts[0].status, 'staged'); // item set changed
  });
  test('--dry-run previews on stdout, writes nothing, records nothing (so a real run is not blocked)', async () => {
    const ws = await ready();
    const dry = await ws.run('followup', 'Karan Joshi', '--dry-run');
    assert.equal(dry.code, 0);
    assert.match(dry.out, /preview only — nothing saved, nothing sent/);
    assert.match(dry.out, /Drafts only — no email was sent/);
    assert.equal(fs.existsSync(path.join(ws.dir, '.actiontrack', 'drafts')), false);
    assert.equal((await fjson(ws, 'Karan Joshi')).drafts[0].status, 'staged');
  });
  test('--all: one draft per routable person + an unrouted report; no overdue spam for done-only people', async () => {
    const ws = await ready();
    const j = await fjson(ws, '--all');
    assert.deepEqual(j.drafts.map((d) => d.person).sort(), ['Karan Joshi', 'Priya Nair', 'Priya Shah', 'Sam Okafor']);
    assert.deepEqual(j.nothingToSend, ['Rahul Mehta']);
    assert.deepEqual(j.unrouted.map((u) => u.task).sort(), ['review the prototype', 'sign off the checklist']);
    const text = (await ws.run('followup', '--all', '--force')).out;
    assert.match(text, /Not emailed — these open items have no single owner \(2\)/);
    assert.match(text, /Drafts only — no email was sent\./);
  });
  test('usage errors: needs an owner or --all, not both; unknown sink', async () => {
    const ws = await ready();
    assert.equal((await ws.run('followup')).code, 2);
    assert.equal((await ws.run('followup', 'Karan Joshi', '--all')).code, 2);
    assert.equal((await ws.run('followup', 'Karan Joshi', '--sink', 'smtp')).code, 2);
  });

  describe('through an MCP server', () => {
    const mcpCfg = (extra = {}) => ({
      people: cfg.people,
      followup: { sink: 'mcp', mcp: { command: process.execPath, args: [FAKE], timeoutMs: 3000 }, ...extra },
    });
    test('creates the draft via create_draft, records its id, and the duplicate guard then applies', async () => {
      Object.assign(process.env, { FAKE_MCP_TOOLS: 'create_draft', FAKE_MCP_MODE: 'ok' });
      const ws = await ready({ config: mcpCfg() });
      const first = (await fjson(ws, 'Karan Joshi')).drafts[0];
      assert.equal(first.status, 'drafted');
      assert.equal(first.id, 'draft-1');
      const again = (await fjson(ws, 'Karan Joshi')).drafts[0];
      assert.equal(again.status, 'skipped-duplicate');
      assert.equal(again.id, 'draft-1');
    });
    test('--all through MCP reuses one server process for all drafts', async () => {
      const log = path.join(ws0().dir, 'mcp.log');
      Object.assign(process.env, { FAKE_MCP_TOOLS: 'create_draft', FAKE_MCP_MODE: 'ok', FAKE_MCP_LOG: log });
      const ws = await ready({ config: mcpCfg() });
      const j = await fjson(ws, '--all');
      assert.equal(j.drafts.filter((d) => d.status === 'drafted').length, 4);
      const calls = fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
      assert.equal(calls.filter((c) => c.method === 'initialize').length, 1);
      assert.equal(calls.filter((c) => c.method === 'tools/call').length, 4);
      assert.ok(calls.every((c) => !/send/i.test(c.tool ?? '')));
      delete process.env.FAKE_MCP_LOG;
    });
    test('a failing server is reported per owner, exit 1, and nothing is recorded as drafted', async () => {
      Object.assign(process.env, { FAKE_MCP_TOOLS: 'create_draft', FAKE_MCP_MODE: 'tool-error' });
      const ws = await ready({ config: mcpCfg() });
      const r = await ws.run('followup', '--all', '--json');
      assert.equal(r.code, 1);
      const j = JSON.parse(r.out);
      assert.equal(j.drafts.length, 4);
      assert.ok(j.drafts.every((d) => d.status === 'failed' && /quota exceeded/.test(d.error)));
      Object.assign(process.env, { FAKE_MCP_MODE: 'ok' });
      assert.equal((await fjson(ws, 'Karan Joshi')).drafts[0].status, 'drafted'); // a retry is not blocked by the failure
    });
    test('a server that only exposes a send tool is refused end-to-end', async () => {
      Object.assign(process.env, { FAKE_MCP_TOOLS: 'send_email', FAKE_MCP_MODE: 'ok' });
      const ws = await ready({ config: mcpCfg() });
      const r = await ws.run('followup', 'Karan Joshi', '--json');
      assert.equal(r.code, 1);
      assert.match(JSON.parse(r.out).drafts[0].error, /does not offer the draft tool/);
      Object.assign(process.env, { FAKE_MCP_TOOLS: 'create_draft' });
    });
    test('configuring a send-like tool is refused up front', async () => {
      const ws = await ready({ config: { followup: { sink: 'mcp', mcp: { command: process.execPath, args: [FAKE], tool: 'send_email' } } } });
      const r = await ws.run('followup', 'Karan Joshi');
      assert.equal(r.code, 1);
      assert.match(r.err, /never sends/);
    });
  });
});

function ws0() { return workspace(); }

describe('UX details found during the manual audit', () => {
  test('empty / wrong folder: succeeds but says so', async () => {
    const ws = workspace();
    const r = await ws.run('ingest', ws.notes);
    assert.equal(r.code, 0);
    assert.match(r.out, /No \.md files were found in that folder/);
  });
  test('"1 item" is singular', async () => {
    const ws = await ready();
    const r = await ws.run('list', '--owner', 'Rahul Mehta');
    assert.match(r.out, /\n1 item \(/);
  });
  test('--all reports missing recipients ONCE, not per draft', async () => {
    const ws = await ready();
    const r = await ws.run('followup', '--all');
    assert.equal((r.out.match(/missing-recipient/g) ?? []).length, 0);
    assert.equal((r.out.match(/No email address configured for:/g) ?? []).length, 1);
    assert.match(r.out, /No email address configured for: .*Karan Joshi.*Priya Nair/);
  });
  test('a person with an email configured is not in the "no address" line', async () => {
    const ws = await ready({ config: { people: { 'Karan Joshi': { email: 'karan@example.com' } } } });
    const r = await ws.run('followup', '--all');
    assert.doesNotMatch(r.out, /No email address configured for:.*Karan/);
  });
});

describe('messy real-world notes (regression for the audit findings)', () => {
  const messy = {
    'a.md': [
      '# Meeting: Messy formats', 'Date: 2026-09-07', 'Attendees: José García, Sam Okafor, Anita Desai', '',
      '- [ ] **Sam** to book the room by Friday',
      '- [ ] __Anita__ to send the deck by 10 Sep',
      '1. [ ] José to review the doc by Wednesday',
      '2) [x] Sam to ship the fix',
      '\t- [ ] Anita to follow up with legal',
      '- [ ] `Sam` to rotate keys',
      '- [ ] **Anita:** write the summary',
      '- [ ] Anita to plan the demo next Monday',
    ].join('\n'),
    'b-slash-date.md': '# Meeting: x\nDate: 09/10/2026\nAttendees: Sam Okafor\n- [ ] Sam to ghost',
  };
  test('every notation yields an item with the right owner and date; the ambiguous date format is skipped, not guessed', async () => {
    const ws = workspace({ files: messy });
    const r = JSON.parse((await ws.run('ingest', ws.notes, '--json')).out);
    assert.equal(r.lines, 8);
    assert.deepEqual(r.files.filter((f) => f.status === 'skipped').map((f) => [f.file, f.reason]), [['b-slash-date.md', 'invalid-date']]);
    assert.match(r.files.find((f) => f.reason === 'invalid-date').detail, /use YYYY-MM-DD/);
    const j = JSON.parse((await ws.run('list', '--json')).out);
    const by = (t) => j.items.find((i) => i.task === t);
    assert.equal(by('book the room').owner.name, 'Sam Okafor');
    assert.equal(by('book the room').dueDate, '2026-09-11');
    assert.equal(by('send the deck').owner.name, 'Anita Desai');
    assert.equal(by('review the doc').owner.name, 'José García');       // numbered "1." item
    assert.equal(by('review the doc').dueDate, '2026-09-09');
    assert.equal(by('ship the fix').status, 'done');                     // numbered "2)" item, checked
    assert.equal(by('follow up with legal').owner.name, 'Anita Desai');  // tab-indented
    assert.equal(by('rotate keys').owner.name, 'Sam Okafor');            // `Sam`
    assert.equal(by('write the summary').owner.name, 'Anita Desai');     // **Anita:**
    assert.equal(by('plan the demo').dueDate, '2026-09-14');             // "next Monday" from Mon 09-07 → following week
  });
});

describe('unquoted multi-word names (reported by the user: `list --owner Priya Nair` was rejected)', () => {
  test('list --owner Priya Nair == list --owner "Priya Nair"', async () => {
    const ws = await ready();
    const quoted = await ws.run('list', '--owner', 'Priya Nair');
    const bare = await ws.run('list', '--owner', 'Priya', 'Nair');
    assert.equal(bare.code, 0);
    assert.equal(bare.out, quoted.out);
    assert.match(bare.out, /Priya Nair/);
  });
  test('works with other flags after it, and with the initial form "Priya N."', async () => {
    const ws = await ready();
    const r = await ws.run('list', '--owner', 'Priya', 'N.', '--status', 'overdue');
    assert.equal(r.code, 0);
    assert.match(r.out, /send the revised quote/);
    assert.doesNotMatch(r.out, /Priya Shah/);
  });
  test('ambiguity is still refused when only the first name is given', async () => {
    const ws = await ready();
    assert.equal((await ws.run('list', '--owner', 'Priya')).code, 2);
  });
  test('a stray word with no --owner is a usage error that suggests the fix', async () => {
    const ws = await ready();
    const r = await ws.run('list', 'Nair');
    assert.equal(r.code, 2);
    assert.match(r.err, /use --owner "Nair"/);
  });
  test('followup Karan Joshi (no quotes) works like followup "Karan Joshi"', async () => {
    const ws = await ready();
    const r = await ws.run('followup', 'Karan', 'Joshi', '--json');
    assert.equal(r.code, 0);
    assert.equal(JSON.parse(r.out).drafts[0].person, 'Karan Joshi');
    assert.equal((await ws.run('followup', 'Priya')).code, 2); // still ambiguous
  });
});
