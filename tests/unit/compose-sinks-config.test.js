import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { composeFollowup } from '../../src/email/compose.js';
import { createFileSink } from '../../src/email/sinks/file.js';
import { createStdoutSink } from '../../src/email/sinks/stdout.js';
import { createMcpSink, extractId } from '../../src/email/sinks/mcp.js';
import { createSink } from '../../src/email/sinks/index.js';
import { McpClient, assertNotSend } from '../../src/email/mcp-client.js';
import { loadConfig } from '../../src/config.js';
import { createClock } from '../../src/clock.js';
import { SinkError, UsageError } from '../../src/errors.js';
import { tempDir, ROOT } from '../helpers.js';

const FAKE = path.join(ROOT, 'tests', 'fixtures', 'fake-mcp-server.mjs');
const person = { fullName: 'Priya Nair', firstName: 'Priya' };
const item = (id, task, dueDate, meeting = { title: 'Quote portal weekly', date: '2026-09-15', filename: 'x.md' }) => (
  { id, task, dueDate, lastMeeting: meeting });
const emptyGroups = { overdue: [], open: [], undated: [], confirm: [] };

describe('composeFollowup (FR-F3, F4)', () => {
  const groups = {
    overdue: [item(12, 'send the revised quote to Acme', '2026-09-11')],
    open: [item(31, 'start SSO spike', '2026-10-20')],
    undated: [item(40, 'set up the test data', null)],
    confirm: [item(27, 'sign off the cutover checklist', '2026-09-21', { title: 'Billing sync', date: '2026-09-17', filename: 'y.md' })],
  };
  const out = composeFollowup({ person, email: 'priya@example.com', groups, today: '2026-10-15' });

  test('subject carries the counts and the as-of date', () => {
    assert.equal(out.subject, 'Action items: 2 open, 1 overdue, 1 to confirm (as of 2026-10-15)');
  });
  test('recipient comes from the email argument', () => {
    assert.deepEqual(out.to, ['priya@example.com']);
    assert.deepEqual(out.warnings, []);
  });
  test('body has sections in order with ids, sentence-cased tasks, due info and source', () => {
    const b = out.body;
    const order = ['OVERDUE (1)', 'OPEN (1)', 'NO DUE DATE (1)', 'PLEASE CONFIRM (1)'].map((s) => b.indexOf(s));
    assert.ok(order.every((i) => i >= 0), 'all sections present');
    assert.deepEqual([...order].sort((x, y) => x - y), order, 'sections appear in order');
    assert.match(b, /^Hi Priya,/);
    assert.match(b, /\[#12\] Send the revised quote to Acme\n\s+Was due Fri 2026-09-11 \(34 days overdue\) · from "Quote portal weekly", 2026-09-15/);
    assert.match(b, /\[#31\] Start SSO spike\n\s+Due Tue 2026-10-20 \(in 5 days\)/);
    assert.match(b, /\[#40\] Set up the test data\n\s+No due date/);
    assert.match(b, /which Priya/);
    assert.match(b, /Thanks,$/);
  });
  test('plain text only: no Markdown markers', () => {
    assert.doesNotMatch(out.body, /(^|\n)\s*(#{1,6}\s|[*-]\s|\|)|\*\*|`/);
  });
  test('missing email ⇒ empty To and a warning, never an invented address', () => {
    const r = composeFollowup({ person, email: null, groups: { ...emptyGroups, open: groups.open }, today: '2026-10-15' });
    assert.deepEqual(r.to, []);
    assert.deepEqual(r.warnings.map((w) => w.code), ['missing-recipient']);
    assert.equal(r.subject, 'Action items: 1 open, 0 overdue (as of 2026-10-15)');
  });
  test('singular wording, "due today", "1 day overdue"', () => {
    const r = composeFollowup({
      person, email: null, today: '2026-10-15',
      groups: { ...emptyGroups, overdue: [item(1, 'x', '2026-10-14')] },
    });
    assert.match(r.body, /here is your open action item/i);
    assert.match(r.body, /\(1 day overdue\)/);
    const t = composeFollowup({ person, email: null, today: '2026-10-15', groups: { ...emptyGroups, open: [item(2, 'y', '2026-10-15')] } });
    assert.match(t.body, /\(today\)/);
  });
  test('custom sign-off', () => {
    assert.match(composeFollowup({ person, email: null, groups: { ...emptyGroups, open: groups.open }, today: '2026-10-15', signoff: 'Cheers,\nBhumika' }).body, /Cheers,\nBhumika$/);
  });
});

describe('sinks', () => {
  const payload = { to: ['a@example.com'], subject: 'S', body: 'B' };

  test('file sink writes json + txt under <dir>/<run>/', async () => {
    const dir = tempDir();
    const sink = createFileSink({ dir, now: () => '2026-10-15T00:00:00.000Z' });
    const res = await sink.createDraft(payload, { personName: 'Priya Nair', slug: 'priya-nair' });
    assert.equal(res.status, 'staged');
    assert.deepEqual(JSON.parse(fs.readFileSync(res.location, 'utf8')), payload);
    assert.match(fs.readFileSync(res.location.replace(/\.json$/, '.txt'), 'utf8'), /^To: a@example.com\nSubject: S\n\nB/);
    assert.match(res.location, /2026-10-15T00-00-00-000Z/);
  });
  test('file sink: an unwritable folder is a SinkError, not a crash', async () => {
    const blocker = path.join(tempDir(), 'afile');
    fs.writeFileSync(blocker, 'x'); // a FILE where the drafts directory should be
    const sink = createFileSink({ dir: path.join(blocker, 'drafts'), now: () => 'r' });
    await assert.rejects(sink.createDraft(payload, { personName: 'P', slug: 'p' }), (e) => e instanceof SinkError && /cannot write draft for P/.test(e.message));
  });
  test('stdout sink prints and reports "previewed"', async () => {
    const lines = [];
    const res = await createStdoutSink({ out: (s) => lines.push(s) }).createDraft({ ...payload, to: [] }, { personName: 'P', slug: 'p' });
    assert.equal(res.status, 'previewed');
    assert.match(lines.join('\n'), /no recipient/);
    assert.match(lines.join('\n'), /nothing sent/);
  });
  test('unknown sink name is a usage error', () => {
    assert.throws(() => createSink('smtp', { io: {}, config: { followup: {} }, clock: {} }), UsageError);
  });
  test('the sink interface offers no send capability', async () => {
    for (const sink of [createFileSink({ dir: tempDir(), now: () => 'x' }), createStdoutSink({ out() {} }), createMcpSink({ command: 'node', args: [], tool: 'create_draft', timeoutMs: 1000 })]) {
      assert.deepEqual(Object.keys(sink).filter((k) => /send/i.test(k)), [], sink.name);
    }
  });
});

describe('MCP sink + client — "never sends" (FR-F5, F6)', () => {
  const payload = { to: ['a@example.com'], subject: 'S', body: 'B' };
  const cfg = (env = {}, tool = 'create_draft') => {
    Object.assign(process.env, { FAKE_MCP_TOOLS: 'create_draft', FAKE_MCP_MODE: 'ok', ...env });
    return { command: process.execPath, args: [FAKE], tool, timeoutMs: 3000 };
  };
  const readLog = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);

  test('happy path: handshake → tools/list → exactly one tools/call with {to, subject, body}', async () => {
    const log = path.join(tempDir(), 'mcp.log');
    const sink = createMcpSink(cfg({ FAKE_MCP_LOG: log }));
    const res = await sink.createDraft(payload);
    await sink.close();
    assert.deepEqual(res, { status: 'drafted', id: 'draft-1' });
    const calls = readLog(log);
    assert.deepEqual(calls.map((c) => c.method), ['initialize', 'notifications/initialized', 'tools/list', 'tools/call']);
    assert.deepEqual(calls.at(-1).tool, 'create_draft');
    assert.deepEqual(calls.at(-1).args, payload);
  });
  test('one client is reused for several drafts', async () => {
    const log = path.join(tempDir(), 'mcp.log');
    const sink = createMcpSink(cfg({ FAKE_MCP_LOG: log }));
    const a = await sink.createDraft(payload);
    const b = await sink.createDraft(payload);
    await sink.close();
    assert.deepEqual([a.id, b.id], ['draft-1', 'draft-2']);
    assert.equal(readLog(log).filter((c) => c.method === 'initialize').length, 1);
  });
  test('NEGATIVE: a server that only offers a send tool is refused and tools/call is never issued', async () => {
    const log = path.join(tempDir(), 'mcp.log');
    const sink = createMcpSink(cfg({ FAKE_MCP_LOG: log, FAKE_MCP_TOOLS: 'send_email' }));
    await assert.rejects(sink.createDraft(payload), (e) => e instanceof SinkError && /does not offer the draft tool/.test(e.message));
    assert.equal(readLog(log).some((c) => c.method === 'tools/call'), false);
  });
  test('NEGATIVE: configuring a send-like tool fails before any process is spawned', () => {
    for (const tool of ['send_email', 'gmail_send_message', 'SendDraft']) {
      assert.throws(() => createMcpSink({ command: 'does-not-exist', args: [], tool, timeoutMs: 1000 }), (e) => e instanceof SinkError && /never sends/.test(e.message));
    }
  });
  test('NEGATIVE: McpClient.callTool itself refuses send-like names even if called directly', async () => {
    const log = path.join(tempDir(), 'mcp.log');
    const c = cfg({ FAKE_MCP_LOG: log, FAKE_MCP_TOOLS: 'create_draft,send_email' });
    const client = new McpClient(c);
    await client.start();
    await assert.rejects(client.callTool('send_email', payload), SinkError);
    await client.close();
    assert.equal(readLog(log).some((x) => x.method === 'tools/call'), false);
  });
  test('assertNotSend matches case-insensitively and allows draft tools', () => {
    assert.throws(() => assertNotSend('Gmail_SEND'), SinkError);
    assert.doesNotThrow(() => assertNotSend('create_draft'));
    assert.doesNotThrow(() => assertNotSend('create_gmail_draft'));
  });
  test('a tool-level error is reported, not swallowed', async () => {
    const sink = createMcpSink(cfg({ FAKE_MCP_MODE: 'tool-error' }));
    await assert.rejects(sink.createDraft(payload), /quota exceeded/);
    await sink.close();
  });
  test('request timeout', async () => {
    const c = cfg({ FAKE_MCP_MODE: 'hang' });
    c.timeoutMs = 300;
    const sink = createMcpSink(c);
    await assert.rejects(sink.createDraft(payload), /timed out/);
    await sink.close();
  });
  test('server crash mid-call', async () => {
    const sink = createMcpSink(cfg({ FAKE_MCP_MODE: 'crash' }));
    await assert.rejects(sink.createDraft(payload), /exited/);
    await sink.close();
  });
  test('spawn failure is a SinkError', async () => {
    const sink = createMcpSink({ command: 'definitely-not-a-real-binary-xyz', args: [], tool: 'create_draft', timeoutMs: 1000 });
    await assert.rejects(sink.createDraft(payload), SinkError);
  });
  test('sink "mcp" without config is a clear error', () => {
    assert.throws(() => createMcpSink(null), /followup\.mcp/);
  });
  test('extractId handles JSON, "id: x" text and nothing', () => {
    assert.equal(extractId('{"id":"r-1"}'), 'r-1');
    assert.equal(extractId('{"draft":{"id":"r-2"}}'), 'r-2');
    assert.equal(extractId('Draft created. id: abc123'), 'abc123');
    assert.equal(extractId(''), undefined);
    assert.equal(extractId('ok'), undefined);
  });
});

describe('config (plan §5)', () => {
  const write = (obj, raw) => {
    const dir = tempDir();
    fs.writeFileSync(path.join(dir, 'actiontrack.config.json'), raw ?? JSON.stringify(obj));
    return dir;
  };
  test('no file ⇒ defaults', () => {
    const c = loadConfig({ cwd: tempDir(), env: {} });
    assert.equal(c.path, null);
    assert.equal(c.followup.sink, 'file');
    assert.equal(c.followup.signoff, 'Thanks,');
    assert.deepEqual(c.people, {});
    assert.equal(c.followup.mcp, null);
  });
  test('valid file is loaded; mcp defaults applied', () => {
    const cwd = write({ people: { 'Priya Nair': { email: 'p@example.com' } }, followup: { sink: 'mcp', mcp: { command: 'node', args: ['s.js'] } } });
    const c = loadConfig({ cwd, env: {} });
    assert.equal(c.people['Priya Nair'].email, 'p@example.com');
    assert.deepEqual(c.followup.mcp, { command: 'node', args: ['s.js'], tool: 'create_draft', timeoutMs: 20000 });
  });
  test('invalid values are usage errors that name the key', () => {
    assert.throws(() => loadConfig({ cwd: write({ people: { X: { email: 'nope' } } }), env: {} }), /people\["X"\]\.email/);
    assert.throws(() => loadConfig({ cwd: write({ followup: { sink: 'smtp' } }), env: {} }), /followup\.sink/);
    assert.throws(() => loadConfig({ cwd: write({ followup: { mcp: {} } }), env: {} }), /followup\.mcp\.command/);
    assert.throws(() => loadConfig({ cwd: write(null, '{ not json'), env: {} }), /invalid JSON/);
    assert.throws(() => loadConfig({ cwd: write([]), env: {} }), UsageError);
  });
  test('an explicitly named config that does not exist is an error', () => {
    assert.throws(() => loadConfig({ configPath: 'nope.json', cwd: tempDir(), env: {} }), /not found/);
  });
});

describe('clock (FR-G3)', () => {
  test('pinned date drives today/now', () => {
    const c = createClock({ today: '2026-10-15', env: {} });
    assert.equal(c.today(), '2026-10-15');
    assert.equal(c.now(), '2026-10-15T00:00:00.000Z');
  });
  test('env var pins the date; flag wins over env', () => {
    assert.equal(createClock({ env: { ACTIONTRACK_TODAY: '2026-01-02' } }).today(), '2026-01-02');
    assert.equal(createClock({ today: '2026-03-04', env: { ACTIONTRACK_TODAY: '2026-01-02' } }).today(), '2026-03-04');
  });
  test('invalid dates are usage errors', () => {
    assert.throws(() => createClock({ today: '2026-02-30', env: {} }), UsageError);
    assert.throws(() => createClock({ today: 'friday', env: {} }), UsageError);
  });
  test('system clock yields a valid ISO date', () => {
    assert.match(createClock({ env: {} }).today(), /^\d{4}-\d{2}-\d{2}$/);
  });
});
