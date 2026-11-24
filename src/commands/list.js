// `actiontrack list` — filters, derived status, table / JSON output (FR-L1–L7).
import { deriveStatus, STATUSES } from '../domain/status.js';
import { parseDueArg } from '../domain/dates.js';
import { findOwner, namesFor } from '../services/people-lookup.js';
import { paint, renderTable } from '../format/table.js';
import { UsageError } from '../errors.js';

/** How an item's owner reads in a table. */
export function ownerLabel(item) {
  switch (item.ownerKind) {
    case 'person': return item.ownerName;
    case 'ambiguous': return `${item.ownerLabel} (ambiguous)`;
    case 'external': return `${item.ownerLabel} (unknown)`;
    case 'group': return `(${String(item.ownerLabel).toLowerCase()})`;
    default: return '—';
  }
}

/** JSON shape shared by `list --json`. */
export function itemToJson(repo, item, occurrences, today) {
  return {
    id: item.id,
    status: deriveStatus(item, today),
    owner: {
      kind: item.ownerKind,
      name: item.ownerName,
      label: item.ownerLabel,
      candidates: namesFor(repo, item.ownerCandidates),
    },
    task: item.task,
    dueDate: item.dueDate,
    completedAt: item.completedAt,
    completedBy: item.completedBy,
    firstSeen: item.firstMeeting,
    lastSeen: item.lastMeeting,
    occurrences: occurrences ?? [],
  };
}

export const listCommand = {
  name: 'list',
  summary: 'Show action items (filters: --owner, --status, --due-before, --unassigned)',
  usage: 'list [--owner <name>] [--status open|done|overdue] [--due-before <date>] [--unassigned] [--json]',
  options: {
    owner: { type: 'string' },
    status: { type: 'string' },
    'due-before': { type: 'string' },
    unassigned: { type: 'boolean' },
  },
  run({ args, values, ctx }) {
    // `--owner Priya Nair` (no quotes) reaches us as owner="Priya" + a stray "Nair": treat the strays as the rest of the name.
    let ownerQuery = values.owner;
    if (args.length) {
      if (ownerQuery === undefined) {
        throw new UsageError(`unexpected argument "${args[0]}". If it is part of a name, use --owner "${args.join(' ')}" (usage: actiontrack ${listCommand.usage})`);
      }
      ownerQuery = [ownerQuery, ...args].join(' ');
    }
    const today = ctx.clock.today();

    /** @type {('open'|'done'|'overdue')[]|undefined} */
    let statuses;
    if (values.status !== undefined) {
      if (!STATUSES.includes(values.status)) throw new UsageError(`--status must be one of ${STATUSES.join(', ')} (got "${values.status}")`);
      statuses = [values.status];
    }

    let dueBefore;
    if (values['due-before'] !== undefined) {
      dueBefore = parseDueArg(values['due-before'], today);
      if (!dueBefore) throw new UsageError(`--due-before: "${values['due-before']}" is not a date (use YYYY-MM-DD or e.g. "friday", "end of month")`);
    }

    let ownerIds;
    if (ownerQuery !== undefined) {
      const person = findOwner(ctx.repo, ownerQuery, { missing: 'null' });
      if (!person) {
        const known = ctx.repo.allPeople().map((p) => p.fullName).join(', ') || 'none ingested yet';
        ctx.io.err(`no person matches "${ownerQuery}" (known: ${known})`);
        ownerIds = [];
      } else {
        ownerIds = [person.id];
      }
    }

    const items = ctx.repo.listItems({ today, statuses, dueBefore, ownerIds, unassigned: values.unassigned });

    if (values.json) {
      const occ = ctx.repo.occurrencesFor(items.map((i) => i.id));
      ctx.io.out(JSON.stringify({ today, count: items.length, items: items.map((i) => itemToJson(ctx.repo, i, occ.get(i.id), today)) }, null, 2));
      return 0;
    }

    if (items.length === 0) {
      ctx.io.out('No matching items.');
      return 0;
    }
    const rows = items.map((i) => {
      const status = deriveStatus(i, today);
      const more = i.occurrenceCount > 1 ? ` (+${i.occurrenceCount - 1})` : '';
      return {
        id: String(i.id),
        status: status.toUpperCase(),
        owner: ownerLabel(i),
        due: i.dueDate ?? '—',
        task: i.task,
        source: i.lastMeeting ? `${i.lastMeeting.filename}${more}` : '',
        _status: status,
      };
    });
    const colourStatus = (text, row) => paint({ overdue: 'red', done: 'dim', open: 'green' }[row._status], text, ctx.io.color);
    ctx.io.out(renderTable([
      { header: 'ID', key: 'id' },
      { header: 'STATUS', key: 'status', paint: colourStatus },
      { header: 'OWNER', key: 'owner' },
      { header: 'DUE', key: 'due' },
      { header: 'TASK', key: 'task' },
      { header: 'SOURCE', key: 'source' },
    ], rows));
    const count = (s) => rows.filter((r) => r._status === s).length;
    ctx.io.out(`\n${rows.length} ${rows.length === 1 ? 'item' : 'items'} (${count('overdue')} overdue, ${count('open')} open, ${count('done')} done) as of ${today}`);
    return 0;
  },
};
