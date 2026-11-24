// `actiontrack done <id...>` — mark items done (FR-D1–D3).
import { UsageError } from '../errors.js';

export const doneCommand = {
  name: 'done',
  summary: 'Mark one or more items as done',
  usage: 'done <id...>',
  options: {},
  run({ args, values, ctx }) {
    if (args.length === 0) throw new UsageError('usage: actiontrack done <id...>');
    const bad = args.find((a) => !/^\d+$/.test(a));
    if (bad !== undefined) throw new UsageError(`item ids are positive integers (got "${bad}")`);

    const today = ctx.clock.today();
    const now = ctx.clock.now();
    const results = [];
    for (const arg of args) {
      const id = Number(arg);
      const outcome = ctx.repo.markDone(id, today, now);
      const item = outcome === 'missing' ? null : ctx.repo.getItem(id);
      results.push({ id, outcome, task: item?.task ?? null });
    }

    if (values.json) {
      ctx.io.out(JSON.stringify({ results }, null, 2));
    } else {
      for (const r of results) {
        if (r.outcome === 'done') ctx.io.out(`✓ #${r.id} marked done: ${r.task}`);
        else if (r.outcome === 'already') ctx.io.out(`• #${r.id} was already done: ${r.task}`);
        else ctx.io.err(`✗ #${r.id} not found`);
      }
    }
    return results.some((r) => r.outcome === 'missing') ? 1 : 0;
  },
};
