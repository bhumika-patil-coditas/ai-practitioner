// Task normalisation and identity (D6, FR-I20). Pure.
// Deliberately NOT fuzzy: two tasks are the same commitment only if they are equal after this normalisation.

const ARTICLES = new Set(['the', 'a', 'an']);

/** @param {string} task */
export function normalizeTask(task) {
  return String(task)
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/['’‘`]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter((w) => w && !ARTICLES.has(w))
    .join(' ');
}

/** @param {string} ownerKey @param {string} task */
export function dedupeKey(ownerKey, task) {
  return `${ownerKey}|${normalizeTask(task)}`;
}

/** Capitalise the first letter for display; leaves the rest untouched ("SSO", "CRM"). */
export function sentenceCase(s) {
  const t = String(s).trim();
  return t ? t[0].toUpperCase() + t.slice(1) : t;
}
