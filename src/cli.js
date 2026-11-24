// Argument parsing, command dispatch, and the ONLY place errors become exit codes and messages (plan §6, FR-G1/G2).
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { ActionTrackError, UsageError } from './errors.js';
import { createClock } from './clock.js';
import { loadConfig } from './config.js';
import { openRepository } from './db/open.js';
import { ingestCommand } from './commands/ingest.js';
import { listCommand } from './commands/list.js';
import { doneCommand } from './commands/done.js';
import { followupCommand } from './commands/followup.js';

const COMMANDS = [ingestCommand, listCommand, doneCommand, followupCommand];

const GLOBAL_OPTIONS = {
  db: { type: 'string' },
  today: { type: 'string' },
  config: { type: 'string' },
  json: { type: 'boolean' },
  help: { type: 'boolean', short: 'h' },
  version: { type: 'boolean', short: 'v' },
};

function version() {
  const pkg = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
  return JSON.parse(fs.readFileSync(pkg, 'utf8')).version;
}

function helpText() {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  return [
    'actiontrack — track action items from meeting notes; draft (never send) follow-up emails',
    '',
    'Usage: actiontrack [global options] <command> [args]',
    '',
    'Commands:',
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width)}  ${c.summary}`),
    '',
    'Global options:',
    '  --db <path>      database file (default ./.actiontrack/actiontrack.db, env ACTIONTRACK_DB)',
    '  --today <date>   pretend today is YYYY-MM-DD (env ACTIONTRACK_TODAY)',
    '  --config <path>  config file (default ./actiontrack.config.json, env ACTIONTRACK_CONFIG)',
    '  --json           machine-readable output',
    '  -h, --help       show help (also: actiontrack <command> --help)',
    '  -v, --version    show version',
    '',
    'Usage per command:',
    ...COMMANDS.map((c) => `  actiontrack ${c.usage}`),
  ].join('\n');
}

/**
 * @param {string[]} argv
 * @param {{env?: Record<string, string|undefined>, cwd?: string, stdout?: NodeJS.WritableStream & {isTTY?: boolean}, stderr?: NodeJS.WritableStream}} [runtime]
 * @returns {Promise<number>} exit code
 */
export async function main(argv, { env = process.env, cwd = process.cwd(), stdout = process.stdout, stderr = process.stderr } = {}) {
  const io = {
    out: (...parts) => { stdout.write(`${parts.join('\n')}\n`); },
    err: (...parts) => { stderr.write(`${parts.join('\n')}\n`); },
    color: Boolean(stdout.isTTY) && !env.NO_COLOR,
  };
  let repo = null;
  try {
    const allOptions = { ...GLOBAL_OPTIONS };
    for (const c of COMMANDS) Object.assign(allOptions, c.options);

    let parsed;
    try {
      parsed = parseArgs({ args: argv, options: allOptions, allowPositionals: true, strict: true });
    } catch (err) {
      throw new UsageError(`${err.message.split('\n')[0]} (see: actiontrack --help)`);
    }
    const { values, positionals } = parsed;
    const [name, ...args] = positionals;

    if (values.version) { io.out(version()); return 0; }
    if (!name) { io.out(helpText()); return values.help || argv.length === 0 ? 0 : 2; }
    if (name === 'help') { io.out(helpText()); return 0; }

    const command = COMMANDS.find((c) => c.name === name);
    if (!command) throw new UsageError(`unknown command "${name}" (commands: ${COMMANDS.map((c) => c.name).join(', ')})`);
    if (values.help) { io.out(`Usage: actiontrack ${command.usage}\n\n${command.summary}`); return 0; }

    const allowed = new Set([...Object.keys(GLOBAL_OPTIONS), ...Object.keys(command.options)]);
    const stray = Object.keys(values).find((k) => !allowed.has(k));
    if (stray) throw new UsageError(`--${stray} is not valid for "${command.name}" (usage: actiontrack ${command.usage})`);

    const clock = createClock({ today: values.today, env });
    const config = loadConfig({ configPath: values.config, cwd, env });
    const dbPath = values.db ?? env.ACTIONTRACK_DB ?? path.join(cwd, '.actiontrack', 'actiontrack.db');
    repo = openRepository(dbPath);

    return await command.run({ args, values, ctx: { repo, clock, config, io } });
  } catch (err) {
    if (err instanceof ActionTrackError) {
      io.err(`error: ${err.message}`);
      return err.exitCode;
    }
    io.err(`error: unexpected failure: ${err && err.message ? err.message : err}`);
    if (env.ACTIONTRACK_DEBUG && err && err.stack) io.err(err.stack);
    return 1;
  } finally {
    repo?.close();
  }
}
