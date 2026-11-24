// The only source of "now" (FR-G3). `--today` / ACTIONTRACK_TODAY pin it for reproducible output and tests.
import { isValidIso } from './domain/dates.js';
import { UsageError } from './errors.js';

/**
 * @param {{today?: string, env?: Record<string, string|undefined>}} [opts]
 * @returns {{today: () => string, now: () => string}}
 */
export function createClock({ today, env = process.env } = {}) {
  const raw = today ?? env.ACTIONTRACK_TODAY;
  if (raw !== undefined && raw !== '' && !isValidIso(raw)) {
    throw new UsageError(`invalid --today "${raw}" (expected a real date as YYYY-MM-DD)`);
  }
  const pinned = raw || null;
  return {
    today: () => pinned ?? localToday(),
    now: () => (pinned ? `${pinned}T00:00:00.000Z` : new Date().toISOString()),
  };
}

/** The user's local calendar date. */
function localToday() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
