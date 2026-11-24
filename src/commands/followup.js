// `actiontrack followup <owner> | --all` — drafts only, never sends (FR-F1–F8).
import { createSink, SINK_NAMES } from '../email/sinks/index.js';
import { runFollowup } from '../services/followup-service.js';
import { ownerLabel } from './list.js';
import { paint } from '../format/table.js';
import { UsageError } from '../errors.js';

export const followupCommand = {
  name: 'followup',
  summary: 'Draft one follow-up email per owner (open + overdue items). Never sends.',
  usage: 'followup <owner> | --all [--sink file|stdout|mcp] [--dry-run] [--force]',
  options: {
    all: { type: 'boolean' },
    sink: { type: 'string' },
    'dry-run': { type: 'boolean' },
    force: { type: 'boolean' },
  },
  async run({ args, values, ctx }) {
    if (values.all ? args.length > 0 : args.length === 0) {
      throw new UsageError('usage: actiontrack followup <owner>   or   actiontrack followup --all');
    }
    const owner = args.join(' '); // quotes are optional: `followup Priya Nair` == `followup "Priya Nair"`
    if (values.sink !== undefined && !SINK_NAMES.includes(values.sink)) {
      throw new UsageError(`--sink must be one of ${SINK_NAMES.join(', ')} (got "${values.sink}")`);
    }
    const sinkName = values['dry-run'] ? 'stdout' : (values.sink ?? ctx.config.followup.sink);
    const sink = createSink(sinkName, ctx);

    let result;
    try {
      result = await runFollowup(ctx, { owner, all: values.all, sink, force: values.force });
    } finally {
      await sink.close?.();
    }

    if (values.json) {
      ctx.io.out(JSON.stringify({
        sink: result.sink, today: result.today, sent: false,
        drafts: result.drafts, nothingToSend: result.nothingToSend,
        unrouted: result.unrouted.map((i) => ({ id: i.id, owner: ownerLabel(i), task: i.task, dueDate: i.dueDate })),
      }, null, 2));
      return result.drafts.some((d) => d.status === 'failed') ? 1 : 0;
    }

    const c = ctx.io.color;
    if (sinkName !== 'stdout') ctx.io.out(`Follow-up drafts (sink: ${result.sink}) as of ${result.today}`);
    for (const d of result.drafts) {
      const n = d.counts;
      const summary = n ? `${n.overdue} overdue, ${n.open + n.undated} open${n.confirm ? `, ${n.confirm} to confirm` : ''}` : '';
      const to = d.to.length ? d.to.join(', ') : 'no recipient';
      if (d.status === 'failed') ctx.io.out(`  ${paint('red', '✗', c)} ${d.person} — FAILED: ${d.error}`);
      else if (d.status === 'skipped-duplicate') {
        ctx.io.out(`  • ${d.person} — skipped: an identical draft already exists${d.id ? ` (${d.id})` : ''} (use --force to create another)`);
      } else if (d.status !== 'previewed') {
        ctx.io.out(`  ${paint('green', '✓', c)} ${d.person} <${to}> — ${summary} → ${d.status}${d.location ? ` ${d.location}` : ''}${d.id ? ` (draft ${d.id})` : ''}`);
      }
      // "no recipient" is reported once for everyone below, not once per draft; skipped duplicates need no warning.
      if (d.status !== 'skipped-duplicate') {
        for (const w of d.warnings) if (w.code !== 'missing-recipient') ctx.io.out(`      ! ${w.code}: ${w.message}`);
      }
    }
    const noRecipient = result.drafts.filter((d) => d.status !== 'skipped-duplicate' && d.status !== 'failed' && d.warnings.some((w) => w.code === 'missing-recipient'));
    if (noRecipient.length) {
      ctx.io.out(`  ! No email address configured for: ${noRecipient.map((d) => d.person).join(', ')}`,
        '    Add them under "people" in actiontrack.config.json (see actiontrack.config.example.json) before sending.');
    }
    if (result.drafts.length === 0) ctx.io.out('No follow-ups needed: no open or overdue items.');
    if (values.all && result.nothingToSend.length) ctx.io.out(`  (nothing to follow up for: ${result.nothingToSend.join(', ')})`);

    if (result.unrouted.length) {
      ctx.io.out('', paint('yellow', `Not emailed — these open items have no single owner (${result.unrouted.length}):`, c));
      for (const i of result.unrouted) ctx.io.out(`  #${i.id} [${ownerLabel(i)}] ${i.task}${i.dueDate ? ` (due ${i.dueDate})` : ''}`);
    }
    ctx.io.out('\nDrafts only — no email was sent.');
    return result.drafts.some((d) => d.status === 'failed') ? 1 : 0;
  },
};
