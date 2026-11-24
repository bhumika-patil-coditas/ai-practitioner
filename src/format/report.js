// Human-readable ingest report (FR-I27).
import { paint } from './table.js';

const ATTENTION = [
  ['ambiguous-owner', 'Ambiguous owner — same first name, not guessed'],
  ['no-owner', 'No individual owner'],
  ['unknown-owner', 'Owner not a known person'],
];

/** @param {import('../services/ingest-service.js').IngestReport} r @param {{color?: boolean}} [opts] */
export function formatIngestReport(r, { color = false } = {}) {
  const out = [];
  out.push(`Ingested notes from ${r.folder}`);
  out.push(`  Files:  ${r.scanned} scanned · ${r.ingested} ingested · ${r.skipped} skipped`);
  out.push(`  Lines:  ${r.lines} action lines → ${r.occurrences} item mentions`);
  out.push(`  Items:  ${r.items.created} new · ${r.items.updated} updated · ${r.items.unchanged} unchanged · ${r.items.removed} removed`);

  if (r.scanned === 0) {
    out.push('', paint('yellow', 'No .md files were found in that folder — check the path (sub-folders are searched; dot-folders and node_modules are skipped).', color));
  }

  const skipped = r.files.filter((f) => f.status === 'skipped');
  if (skipped.length) {
    out.push('', paint('yellow', `Skipped (${skipped.length}) — not ingested, nothing changed:`, color));
    for (const f of skipped) {
      out.push(`  ✗ ${f.file} — ${f.reason}: ${f.detail}${f.hint ? ` (${f.hint})` : ''}`);
    }
  }

  const attention = ATTENTION.map(([code, title]) => [title, r.warnings.filter((w) => w.code === code)]).filter(([, ws]) => ws.length);
  if (attention.length) {
    out.push('', paint('yellow', 'Needs attention:', color));
    for (const [title, ws] of attention) {
      out.push(`  ${title} (${ws.length}):`);
      for (const w of ws) out.push(`    ${w.file}${w.line ? `:${w.line}` : ''}  ${w.message}`);
    }
  }

  const notes = [];
  const count = (code) => r.warnings.filter((w) => w.code === code).length;
  if (count('no-due-date')) notes.push(`${count('no-due-date')} open item mentions have no due date`);
  for (const code of ['missing-attendees', 'missing-title', 'weekday-mismatch', 'invalid-due', 'empty-task']) {
    const ws = r.warnings.filter((w) => w.code === code);
    if (ws.length) notes.push(`${code}: ${ws.map((w) => `${w.file}${w.line ? `:${w.line}` : ''}`).join(', ')}`);
  }
  if (notes.length) {
    out.push('', 'Notes:');
    for (const n of notes) out.push(`  • ${n}`);
  }
  return out.join('\n');
}
