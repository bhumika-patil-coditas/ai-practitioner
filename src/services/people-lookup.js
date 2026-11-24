// Resolve a user-typed owner name to exactly one person — or fail loudly. Never picks between same-name people (FR-L4, FR-F1).
import { matchPeople } from '../domain/roster.js';
import { NotFoundError, UsageError } from '../errors.js';

/**
 * @param {import('../db/repo.js').Repository} repo
 * @param {string} query
 * @param {{missing: 'null'|'throw'}} [opts] what to do when nobody matches
 * @returns {import('../db/repo.js').Person|null}
 */
export function findOwner(repo, query, { missing = 'throw' } = {}) {
  const people = repo.allPeople();
  const matches = matchPeople(query, people);
  if (matches.length === 1) return matches[0];
  if (matches.length > 1) {
    throw new UsageError(
      `"${query}" matches more than one person: ${matches.map((m) => m.fullName).join(', ')}. Use the full name (or "First I." initial).`,
    );
  }
  if (missing === 'null') return null;
  const known = people.map((p) => p.fullName).join(', ') || '(nobody ingested yet — run "actiontrack ingest <folder>")';
  throw new NotFoundError(`no person matches "${query}". Known people: ${known}`);
}

/** @param {import('../db/repo.js').Repository} repo @param {number[]} ids @returns {string[]} */
export function namesFor(repo, ids) {
  const byId = new Map(repo.allPeople().map((p) => [p.id, p.fullName]));
  return ids.map((id) => byId.get(id)).filter(Boolean);
}
