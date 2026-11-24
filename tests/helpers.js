// Shared test helpers. Tests never touch a real DB path, the real clock, or Gmail.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openRepository } from '../src/db/open.js';

export const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
export const NOTES_DIR = path.join(ROOT, 'notes');
export const BIN = path.join(ROOT, 'bin', 'actiontrack.js');

export const memoryRepo = () => openRepository(':memory:');

/** Fresh temp directory, removed by the caller (or ignored; the OS cleans temp). */
export function tempDir(prefix = 'actiontrack-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** Write `{relativePath: contents}` into a new temp folder and return its path. */
export function makeNotesFolder(files) {
  const dir = tempDir('notes-');
  for (const [name, content] of Object.entries(files)) {
    const full = path.join(dir, name);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content);
  }
  return dir;
}

/** Build a minimal valid note. */
export function note({ title = 'Meeting', date = '2026-09-01', attendees = [], items = [] } = {}) {
  const head = `# Meeting: ${title}\nDate: ${date}\n${attendees.length ? `Attendees: ${attendees.join(', ')}\n` : ''}`;
  return `${head}\n## Action items\n${items.join('\n')}\n`;
}

// ---- in-process CLI runner (fast; no child process) ---------------------------------------------
import { Writable } from 'node:stream';
import { main } from '../src/cli.js';

function sink() {
  let text = '';
  const stream = new Writable({ write(chunk, _enc, cb) { text += chunk.toString(); cb(); } });
  return { stream, get text() { return text; } };
}

/**
 * Run the CLI in-process with captured output.
 * @param {string[]} argv
 * @param {{env?: Record<string,string>, cwd?: string}} [opts]
 * @returns {Promise<{code: number, out: string, err: string}>}
 */
export async function runCli(argv, { env = {}, cwd = ROOT } = {}) {
  const out = sink();
  const err = sink();
  const code = await main(argv, { env: { ...env }, cwd, stdout: out.stream, stderr: err.stream });
  return { code, out: out.text, err: err.text };
}

/**
 * A self-contained workspace: temp DB + notes folder (+ optional config). `run(...args)` always passes --db and --today.
 * @param {{files?: Record<string,string>, config?: object, today?: string}} [opts]
 */
export function workspace({ files = {}, config, today = '2026-10-15' } = {}) {
  const dir = tempDir('ws-');
  const notes = makeNotesFolder(files);
  const db = path.join(dir, 'test.db');
  if (config) fs.writeFileSync(path.join(dir, 'actiontrack.config.json'), JSON.stringify(config));
  const run = (...args) => runCli(['--db', db, '--today', today, ...args], { cwd: dir });
  return { dir, notes, db, run, today };
}
