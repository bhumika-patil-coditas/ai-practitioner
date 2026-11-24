// Select each owner's open/overdue items, compose a draft, hand it to a sink — and never send (FR-F1–F8).
import crypto from 'node:crypto';
import { composeFollowup } from '../email/compose.js';
import { fold } from '../domain/roster.js';
import { findOwner } from './people-lookup.js';
import { SinkError } from '../errors.js';

/**
 * @typedef {{
 *   person: string, status: 'staged'|'drafted'|'previewed'|'skipped-duplicate'|'failed',
 *   subject?: string, to: string[], counts?: {overdue: number, open: number, undated: number, confirm: number},
 *   location?: string, id?: string, warnings: {code: string, message: string}[], error?: string
 * }} DraftOutcome
 * @typedef {{drafts: DraftOutcome[], unrouted: import('../db/repo.js').Item[], nothingToSend: string[], sink: string, today: string}} FollowupResult
 */

const slugify = (name) => fold(name).replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'person';

/** @param {import('../db/repo.js').Repository} repo @param {import('../db/repo.js').Person} person @param {string} today */
export function gatherGroups(repo, person, today) {
  const overdue = repo.listItems({ ownerIds: [person.id], statuses: ['overdue'], today });
  const openAll = repo.listItems({ ownerIds: [person.id], statuses: ['open'], today });
  return {
    overdue,
    open: openAll.filter((i) => i.dueDate),
    undated: openAll.filter((i) => !i.dueDate),
    confirm: repo.ambiguousItemsFor(person.id),
  };
}

function hashItemset(groups) {
  const all = [...groups.overdue, ...groups.open, ...groups.undated, ...groups.confirm]
    .map((i) => `${i.id}:${i.dueDate ?? ''}`).sort();
  return crypto.createHash('sha1').update(all.join('|')).digest('hex');
}

function emailFor(ctx, person) {
  const wanted = fold(person.fullName);
  for (const [name, v] of Object.entries(ctx.config.people)) {
    if (fold(name) === wanted && v.email) return v.email;
  }
  return person.email;
}

/**
 * @param {{repo: import('../db/repo.js').Repository, clock: {today: () => string, now: () => string}, config: import('../config.js').Config}} ctx
 * @param {{owner?: string, all?: boolean, sink: import('../email/sinks/index.js').DraftSink, force?: boolean}} opts
 * @returns {Promise<FollowupResult>}
 */
export async function runFollowup(ctx, { owner, all, sink, force = false }) {
  const today = ctx.clock.today();
  const people = all ? ctx.repo.allPeople() : [findOwner(ctx.repo, /** @type {string} */ (owner))];
  const persistent = sink.name !== 'stdout'; // previews are never recorded, so they never block a real run

  /** @type {DraftOutcome[]} */
  const drafts = [];
  const nothingToSend = [];

  for (const person of people) {
    const groups = gatherGroups(ctx.repo, person, today);
    if (groups.overdue.length + groups.open.length + groups.undated.length === 0) {
      nothingToSend.push(person.fullName);
      continue;
    }
    const email = emailFor(ctx, person);
    const draft = composeFollowup({ person, email, groups, today, signoff: ctx.config.followup.signoff });
    const base = { person: person.fullName, subject: draft.subject, to: draft.to, counts: draft.counts, warnings: draft.warnings };

    const hash = hashItemset(groups);
    if (persistent && !force) {
      const prior = ctx.repo.findDraft(person.id, hash);
      if (prior) {
        drafts.push({ ...base, status: 'skipped-duplicate', id: prior.externalId ?? undefined });
        continue;
      }
    }

    try {
      const res = await sink.createDraft(
        { to: draft.to, subject: draft.subject, body: draft.body },
        { personName: person.fullName, slug: slugify(person.fullName) },
      );
      if (res.status !== 'previewed') {
        ctx.repo.recordDraft({
          personId: person.id, itemsetHash: hash, sink: sink.name,
          status: res.status, externalId: res.id ?? null, subject: draft.subject, now: ctx.clock.now(),
        });
      }
      drafts.push({ ...base, status: res.status, ...(res.location ? { location: res.location } : {}), ...(res.id ? { id: res.id } : {}) });
    } catch (err) {
      if (!(err instanceof SinkError)) throw err;
      drafts.push({ ...base, status: 'failed', error: err.message });
    }
  }

  const unrouted = all
    ? ctx.repo.listItems({ today, statuses: ['open', 'overdue'], unassigned: true })
    : [];
  return { drafts, unrouted, nothingToSend, sink: sink.name, today };
}
