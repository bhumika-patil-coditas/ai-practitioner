// Draft sinks. The interface has exactly one capability — creating a draft. There is no "send" anywhere (FR-F5).
//
// @typedef {{status: 'previewed'|'staged'|'drafted', id?: string, location?: string}} SinkResult
// @typedef {{name: string, createDraft(payload: import('../compose.js').DraftPayload, meta: {personName: string, slug: string}): Promise<SinkResult>, close?(): Promise<void>}} DraftSink
import { UsageError } from '../../errors.js';
import { createStdoutSink } from './stdout.js';
import { createFileSink } from './file.js';
import { createMcpSink } from './mcp.js';

export const SINK_NAMES = ['file', 'stdout', 'mcp'];

/**
 * @param {string} name
 * @param {{io: {out: (s: string) => void}, config: import('../../config.js').Config, clock: {now: () => string}}} ctx
 */
export function createSink(name, ctx) {
  switch (name) {
    case 'stdout': return createStdoutSink(ctx.io);
    case 'file': return createFileSink({ dir: ctx.config.followup.draftsDir, now: ctx.clock.now });
    case 'mcp': return createMcpSink(ctx.config.followup.mcp);
    default: throw new UsageError(`unknown sink "${name}" (choose one of ${SINK_NAMES.join(', ')})`);
  }
}
