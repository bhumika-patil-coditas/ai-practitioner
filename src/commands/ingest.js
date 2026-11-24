// `actiontrack ingest <folder>` — thin wrapper; all rules live in the service (FR-I*).
import { ingestFolder } from '../services/ingest-service.js';
import { formatIngestReport } from '../format/report.js';
import { UsageError } from '../errors.js';

export const ingestCommand = {
  name: 'ingest',
  summary: 'Parse every .md meeting note in <folder> and store its action items',
  usage: 'ingest <folder> [--strict]',
  options: { strict: { type: 'boolean' } },
  /** @returns {number} exit code */
  run({ args, values, ctx }) {
    if (args.length !== 1) throw new UsageError('usage: actiontrack ingest <folder> [--strict]');
    const report = ingestFolder(ctx, args[0]);
    ctx.io.out(values.json ? JSON.stringify(report, null, 2) : formatIngestReport(report, { color: ctx.io.color }));
    return values.strict && report.skipped > 0 ? 3 : 0;
  },
};
