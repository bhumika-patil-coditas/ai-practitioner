// Derived status (D7, FR-L2). Stored status is only open|done; overdue is computed against "today". Pure.

/** @typedef {'open'|'done'|'overdue'} DerivedStatus */
export const STATUSES = ['open', 'done', 'overdue'];

/**
 * @param {{status: string, dueDate: string|null}} item
 * @param {string} today YYYY-MM-DD
 * @returns {DerivedStatus}
 */
export function deriveStatus(item, today) {
  if (item.status === 'done') return 'done';
  // ISO dates compare correctly as strings. Due *today* is still open.
  return item.dueDate && item.dueDate < today ? 'overdue' : 'open';
}
