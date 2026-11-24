// Pure: items → a plain-text email payload (FR-F3, FR-F4). Gmail's `body` is plain text, so no Markdown here.
import { daysBetween, WEEKDAY_NAMES, weekday } from '../domain/dates.js';
import { sentenceCase } from '../domain/normalize.js';

/**
 * @typedef {import('../db/repo.js').Item} Item
 * @typedef {{to: string[], subject: string, body: string}} DraftPayload
 * @typedef {{overdue: Item[], open: Item[], undated: Item[], confirm: Item[]}} FollowupGroups
 */

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const fmtDate = (iso) => `${WEEKDAY_NAMES[weekday(iso)]} ${iso}`;
const source = (item) => (item.lastMeeting ? `from "${item.lastMeeting.title}", ${item.lastMeeting.date}` : '');

/**
 * @param {{person: {fullName: string, firstName: string}, email: string|null, groups: FollowupGroups, today: string, signoff?: string}} input
 * @returns {DraftPayload & {warnings: {code: string, message: string}[], counts: {overdue: number, open: number, undated: number, confirm: number}}}
 */
export function composeFollowup({ person, email, groups, today, signoff = 'Thanks,' }) {
  const { overdue, open, undated, confirm } = groups;
  const openCount = open.length + undated.length;

  const subjectParts = [`${openCount} open`, `${overdue.length} overdue`];
  if (confirm.length) subjectParts.push(`${confirm.length} to confirm`);
  const subject = `Action items: ${subjectParts.join(', ')} (as of ${today})`;

  const line = (item, detail) => [`  [#${item.id}] ${sentenceCase(item.task)}`, `        ${detail}`];
  const section = (title, items, detailFor) => (items.length
    ? ['', `${title} (${items.length})`, ...items.flatMap((i) => line(i, detailFor(i)))]
    : []);
  const join = (...parts) => parts.filter(Boolean).join(' · ');

  const body = [
    `Hi ${person.firstName},`,
    '',
    `Here ${overdue.length + openCount === 1 ? 'is' : 'are'} your open action ${overdue.length + openCount === 1 ? 'item' : 'items'} from our recent meetings, as of ${today}.`,
    ...section('OVERDUE', overdue, (i) => join(
      `Was due ${fmtDate(i.dueDate)} (${plural(daysBetween(i.dueDate, today), 'day')} overdue)`, source(i))),
    ...section('OPEN', open, (i) => {
      const d = daysBetween(today, i.dueDate);
      return join(`Due ${fmtDate(i.dueDate)} (${d === 0 ? 'today' : `in ${plural(d, 'day')}`})`, source(i));
    }),
    ...section('NO DUE DATE', undated, (i) => join('No due date', source(i))),
    ...(confirm.length
      ? ['', `PLEASE CONFIRM (${confirm.length}) — the notes say "${person.firstName}" but could not tell which ${person.firstName}; reply if these are yours`,
        ...confirm.flatMap((i) => line(i, join(i.dueDate ? `Due ${fmtDate(i.dueDate)}` : 'No due date', source(i))))]
      : []),
    '',
    'If any of these are already done, let me know and I will update the tracker.',
    '',
    signoff,
  ].join('\n');

  /** @type {{code: string, message: string}[]} */
  const warnings = [];
  if (!email) warnings.push({ code: 'missing-recipient', message: `no email address configured for ${person.fullName}; add one under "people" in the config before sending` });

  return {
    to: email ? [email] : [],
    subject,
    body,
    warnings,
    counts: { overdue: overdue.length, open: open.length, undated: undated.length, confirm: confirm.length },
  };
}
