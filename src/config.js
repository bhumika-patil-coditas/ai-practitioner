// Optional JSON config: owner emails and follow-up sink settings (plan §5). Validated on load.
import fs from 'node:fs';
import path from 'node:path';
import { UsageError } from './errors.js';

export const DEFAULT_CONFIG_NAME = 'actiontrack.config.json';
export const SINKS = ['file', 'stdout', 'mcp'];

/**
 * @typedef {{command: string, args: string[], tool: string, timeoutMs: number}} McpConfig
 * @typedef {{
 *   path: string|null,
 *   people: Record<string, {email: string|null}>,
 *   followup: {sink: 'file'|'stdout'|'mcp', draftsDir: string, signoff: string, mcp: McpConfig|null}
 * }} Config
 */

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * @param {{configPath?: string, cwd?: string, env?: Record<string, string|undefined>}} [opts]
 * @returns {Config}
 */
export function loadConfig({ configPath, cwd = process.cwd(), env = process.env } = {}) {
  const explicit = configPath ?? env.ACTIONTRACK_CONFIG;
  const file = path.resolve(cwd, explicit ?? DEFAULT_CONFIG_NAME);

  /** @type {any} */
  let raw = {};
  let used = null;
  if (fs.existsSync(file)) {
    try {
      raw = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new UsageError(`config ${file}: invalid JSON (${err.message})`);
    }
    used = file;
  } else if (explicit) {
    throw new UsageError(`config file not found: ${file}`);
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new UsageError(`config ${file}: top level must be an object`);

  const people = {};
  for (const [name, v] of Object.entries(raw.people ?? {})) {
    const email = v?.email ?? null;
    if (email !== null && (typeof email !== 'string' || !EMAIL.test(email))) {
      throw new UsageError(`config: people["${name}"].email is not a valid email address`);
    }
    people[name] = { email };
  }

  const f = raw.followup ?? {};
  const sink = f.sink ?? 'file';
  if (!SINKS.includes(sink)) throw new UsageError(`config: followup.sink must be one of ${SINKS.join(', ')} (got "${sink}")`);
  if (f.draftsDir !== undefined && typeof f.draftsDir !== 'string') throw new UsageError('config: followup.draftsDir must be a string');
  if (f.signoff !== undefined && typeof f.signoff !== 'string') throw new UsageError('config: followup.signoff must be a string');

  /** @type {McpConfig|null} */
  let mcp = null;
  if (f.mcp !== undefined) {
    const m = f.mcp;
    if (!m || typeof m.command !== 'string' || !m.command) throw new UsageError('config: followup.mcp.command must be a non-empty string');
    if (m.args !== undefined && (!Array.isArray(m.args) || m.args.some((a) => typeof a !== 'string'))) {
      throw new UsageError('config: followup.mcp.args must be an array of strings');
    }
    if (m.timeoutMs !== undefined && (!Number.isFinite(m.timeoutMs) || m.timeoutMs <= 0)) {
      throw new UsageError('config: followup.mcp.timeoutMs must be a positive number');
    }
    mcp = { command: m.command, args: m.args ?? [], tool: m.tool ?? 'create_draft', timeoutMs: m.timeoutMs ?? 20000 };
  }

  return {
    path: used,
    people,
    followup: {
      sink,
      draftsDir: path.resolve(cwd, f.draftsDir ?? path.join('.actiontrack', 'drafts')),
      signoff: f.signoff ?? 'Thanks,',
      mcp,
    },
  };
}
