// Owner clause parsing ("Priya N. to send …") and resolution against attendees / roster (FR-I10–I14, D4). Pure.
import { candidatesFor, fold } from './roster.js';

/** @typedef {import('./roster.js').PersonName} PersonName */
/** @typedef {import('./roster.js').Qualifier} Qualifier */

export const GROUP_WORDS = new Set(['everyone', 'everybody', 'all', 'team', 'we']);
export const PLACEHOLDER_WORDS = new Set(['tbd', 'tba', 'someone', 'anyone', 'somebody', 'nobody', 'unassigned']);

// Imperative verbs that can start a task. "Update to the latest version" must not become owner "Update".
const NOT_A_NAME = new Set([
  'update', 'upgrade', 'add', 'fix', 'move', 'send', 'write', 'review', 'check', 'follow', 'set', 'run', 'prepare',
  'schedule', 'publish', 'finalise', 'finalize', 'draft', 'email', 'call', 'ask', 'confirm', 'share', 'book', 'create',
  'open', 'deploy', 'migrate', 'revert', 'refactor', 'respond', 'reply', 'remove', 'delete', 'rename', 'switch', 'talk',
  'sync', 'reach', 'back', 'go', 'get', 'make', 'test', 'plan', 'clean', 'collect', 'agree', 'decide',
]);

// Unicode-aware (\p{L}) so "José", "Zoë", "Søren", "Zoë Ng" are names too. Compiled with the `u` flag below.
const NAMEQ = String.raw`@?\p{L}[\p{L}'’-]*(?:\s+(?:\p{Lu}\.?|\p{Lu}\p{Ll}+))?`;
const CLAUSE = new RegExp(
  String.raw`^(?<owners>${NAMEQ}(?:\s*(?:&|,|\band\b)\s*${NAMEQ})*)` +
  String.raw`(?:\s*\((?:with|and|cc)\s+(?<helpers>[^)]+)\))?` +
  String.raw`(?<delim>\s*:\s*|\s+(?:[Tt]o|will|should)\s+)(?<task>.+)$`,
  'u',
);

/**
 * @typedef {{kind: 'name', label: string, first: string, qualifier: Qualifier|null}
 *   | {kind: 'group', label: string}
 *   | {kind: 'none', label: string}} OwnerToken
 */

/**
 * @param {string} part one owner (already split from "A & B")
 * @returns {OwnerToken|null}
 */
function classify(part) {
  const label = part.trim().replace(/^@/, '');
  const tokens = label.split(/\s+/);
  const first = tokens[0];
  const key = first.toLowerCase();
  if (GROUP_WORDS.has(key) && tokens.length === 1) return { kind: 'group', label };
  if (PLACEHOLDER_WORDS.has(key) && tokens.length === 1) return { kind: 'none', label };
  if (NOT_A_NAME.has(key)) return null;
  /** @type {Qualifier|null} */
  let qualifier = null;
  if (tokens.length > 1) {
    const rest = tokens.slice(1).join(' ');
    const initial = /^([A-Za-z])\.?$/.exec(rest);
    qualifier = initial ? { type: 'initial', value: fold(initial[1]) } : { type: 'last', value: fold(rest) };
  }
  return { kind: 'name', label, first, qualifier };
}

const WRAP = '(\\*\\*|__|\\*|_|`)';

/**
 * Notes often bold or code-format the owner ("**Sam** to …", "`Sam` to …", "**Sam:** …") or the whole line.
 * Remove that wrapper — only at the START of the text, so emphasis inside the task is never touched.
 * @param {string} input
 */
export function stripLeadingEmphasis(input) {
  let s = input.trim();
  s = s.replace(new RegExp(`^${WRAP}([^*_\`]+)\\1$`), '$2');                 // whole text wrapped
  s = s.replace(/^(\*\*|__)([^*_]+?:)\1/, '$2');                            // **Sam:** task
  s = s.replace(new RegExp(`^${WRAP}([^*_\`]+?)\\1(?=[\\s:])`), '$2');        // **Sam** to …
  return s.trim();
}

/**
 * Split "<owners> to <task>" off the front of an item's text.
 * Returns an empty `owners` list (and the text untouched) when no owner is recognisable.
 * @param {string} text
 * `viaColon` is true for "Name: task" form; callers should only trust it when the name resolves to a known person.
 * @returns {{owners: OwnerToken[], helpers: string|null, task: string, viaColon: boolean}}
 */
export function parseOwnerClause(rawText) {
  const text = stripLeadingEmphasis(rawText);
  const m = CLAUSE.exec(text);
  if (!m) return { owners: [], helpers: null, task: text, viaColon: false };
  const parts = m.groups.owners.split(/\s*(?:&|,|\band\b)\s*/).filter(Boolean);
  const owners = parts.map(classify);
  if (owners.some((o) => o === null)) return { owners: [], helpers: null, task: text, viaColon: false };
  return {
    owners: /** @type {OwnerToken[]} */ (owners),
    helpers: m.groups.helpers?.trim() ?? null,
    task: m.groups.task.trim(),
    viaColon: m.groups.delim.includes(':'),
  };
}

/**
 * @typedef {{kind: 'person', person: PersonName}
 *   | {kind: 'ambiguous', label: string, candidates: PersonName[]}
 *   | {kind: 'external', label: string}
 *   | {kind: 'group', label: string}
 *   | {kind: 'none', label: string}} ResolvedOwner
 */

/**
 * Attendees first, then the global roster; one candidate resolves, several are ambiguous, none is external.
 * Never guesses between people.
 * @param {OwnerToken} token
 * @param {PersonName[]} attendees
 * @param {PersonName[]} roster
 * @returns {ResolvedOwner}
 */
export function resolveOwner(token, attendees, roster) {
  if (token.kind !== 'name') return token;
  let cands = candidatesFor(token.first, token.qualifier, attendees);
  if (cands.length === 0) cands = candidatesFor(token.first, token.qualifier, roster);
  if (cands.length === 1) return { kind: 'person', person: cands[0] };
  if (cands.length > 1) return { kind: 'ambiguous', label: token.first, candidates: cands };
  return { kind: 'external', label: token.label };
}

/** Stable identity of an owner for de-duplication (FR-I20). */
export function ownerKey(resolved) {
  switch (resolved.kind) {
    case 'person': return `person:${fold(resolved.person.fullName)}`;
    case 'ambiguous': return `ambiguous:${fold(resolved.label)}:${resolved.candidates.map((c) => fold(c.fullName)).sort().join(',')}`;
    case 'external': return `external:${fold(resolved.label)}`;
    case 'group': return `group:${fold(resolved.label)}`;
    default: return 'none';
  }
}
