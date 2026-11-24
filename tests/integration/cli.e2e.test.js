// Spawns the real executable (bin/actiontrack.js) — exit codes, stdout/stderr contract, shim behaviour (FR-G1–G5).
import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { BIN, NOTES_DIR, tempDir } from '../helpers.js';

function cli(args, { env = {}, cwd } = {}) {
  const dir = cwd ?? tempDir('e2e-');
  const r = spawnSync(process.execPath, [BIN, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, ...env },
  });
  return { code: r.status, out: r.stdout, err: r.stderr, dir };
}

describe('process-level contract', () => {
  test('--version and --help exit 0', () => {
    const v = cli(['--version']);
    assert.equal(v.code, 0);
    assert.match(v.out.trim(), /^\d+\.\d+\.\d+$/);
    const h = cli(['--help']);
    assert.equal(h.code, 0);
    for (const c of ['ingest', 'list', 'done', 'followup']) assert.match(h.out, new RegExp(`\\b${c}\\b`));
    assert.match(cli(['list', '--help']).out, /--due-before/);
  });
  test('no arguments prints help and exits 0; unknown command exits 2 with one "error:" line', () => {
    assert.equal(cli([]).code, 0);
    const r = cli(['frobnicate']);
    assert.equal(r.code, 2);
    assert.match(r.err, /^error: unknown command "frobnicate"/);
    assert.equal(r.err.trim().split('\n').length, 1);
    assert.equal(r.err.includes('    at '), false, 'no stack trace by default');
  });
  test('unknown flag exits 2; invalid --today exits 2', () => {
    assert.equal(cli(['list', '--nope']).code, 2);
    const r = cli(['--today', '2026-13-01', 'list']);
    assert.equal(r.code, 2);
    assert.match(r.err, /invalid --today/);
  });
  test('full flow through the real binary; piped output has no ANSI codes and no Node warnings', () => {
    const dir = tempDir('e2e-');
    const env = { ACTIONTRACK_DB: path.join(dir, 'x.db'), ACTIONTRACK_TODAY: '2026-10-15' };
    const ing = cli(['ingest', NOTES_DIR], { env, cwd: dir });
    assert.equal(ing.code, 0, ing.err);
    assert.match(ing.out, /31 ingested · 3 skipped/);
    assert.equal(ing.err, '', 'stderr must be empty — no ExperimentalWarning leaks');
    assert.doesNotMatch(ing.out, /\u001b\[/);

    const ls = cli(['list', '--owner', 'Karan Joshi', '--status', 'overdue'], { env, cwd: dir });
    assert.equal(ls.code, 0);
    assert.doesNotMatch(ls.out, /\u001b\[/);
    assert.match(ls.out, /7 items \(7 overdue, 0 open, 0 done\) as of 2026-10-15/);

    const fu = cli(['followup', 'Karan Joshi', '--dry-run'], { env, cwd: dir });
    assert.equal(fu.code, 0);
    assert.match(fu.out, /Drafts only — no email was sent\./);
    assert.equal(fu.err, '');
  });
  test('--strict exits 3 when notes were skipped; 0 otherwise', () => {
    const dir = tempDir('e2e-');
    const env = { ACTIONTRACK_DB: path.join(dir, 'x.db') };
    assert.equal(cli(['ingest', NOTES_DIR, '--strict'], { env, cwd: dir }).code, 3);
    const clean = tempDir('clean-');
    assert.equal(cli(['ingest', clean, '--strict'], { env, cwd: dir }).code, 0);
  });
  test('missing folder exits 2', () => {
    const dir = tempDir('e2e-');
    const env = { ACTIONTRACK_DB: path.join(dir, 'x.db') };
    const r = cli(['ingest', path.join(dir, 'nope')], { env, cwd: dir });
    assert.equal(r.code, 2);
    assert.match(r.err, /folder not found/);
  });
  test('a corrupt database file exits 1 with one clear line, no stack trace', () => {
    const dir = tempDir('e2e-');
    const db = path.join(dir, 'broken.db');
    writeFileSync(db, 'this is definitely not a sqlite database '.repeat(50));
    const r = cli(['list'], { env: { ACTIONTRACK_DB: db }, cwd: dir });
    assert.equal(r.code, 1);
    assert.match(r.err, /^error: cannot open database/);
    assert.equal(r.err.includes('    at '), false);
  });
  test('the database is created on first use inside ./.actiontrack by default', () => {
    const dir = tempDir('e2e-');
    const r = cli(['list'], { cwd: dir });
    assert.equal(r.code, 0);
    assert.match(r.out, /No matching items/);
    const fs = spawnSync(process.execPath, ['-e', "console.log(require('fs').existsSync('.actiontrack/actiontrack.db'))"], { cwd: dir, encoding: 'utf8' });
    assert.equal(fs.stdout.trim(), 'true');
  });
  test('--json output is valid JSON for every command', () => {
    const dir = tempDir('e2e-');
    const env = { ACTIONTRACK_DB: path.join(dir, 'x.db'), ACTIONTRACK_TODAY: '2026-10-15' };
    for (const args of [['ingest', NOTES_DIR, '--json'], ['list', '--json'], ['done', '6', '--json'], ['followup', 'Sam Okafor', '--json']]) {
      const r = cli(args, { env, cwd: dir });
      assert.doesNotThrow(() => JSON.parse(r.out), `${args.join(' ')}: ${r.out.slice(0, 80)}`);
    }
  });
});
