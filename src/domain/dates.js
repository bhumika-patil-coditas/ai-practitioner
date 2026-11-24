// Pure date engine. A "day" is an ISO string `YYYY-MM-DD`; all arithmetic is UTC calendar-day arithmetic,
// so there is no local-timezone or DST drift. Nothing here reads the clock (NFR-3).

const MONTH_NUMBERS = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4, may: 5,
  jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8, sep: 9, sept: 9, september: 9,
  oct: 10, october: 10, nov: 11, november: 11, dec: 12, december: 12,
};

const WEEKDAY_NUMBERS = {
  mon: 1, monday: 1, tue: 2, tues: 2, tuesday: 2, wed: 3, wednesday: 3,
  thu: 4, thur: 4, thurs: 4, thursday: 4, fri: 5, friday: 5, sat: 6, saturday: 6, sun: 7, sunday: 7,
};

export const WEEKDAY_NAMES = ['', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

/** A yearless date more than this many days before the reference rolls to the next year (FR-I16). */
const YEAR_ROLLOVER_DAYS = 180;

// ---------------------------------------------------------------- day arithmetic

/** @param {number} y @param {number} m @param {number} d @returns {string|null} ISO day or null if not a real date */
export function makeIso(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return null;
  if (y < 1000 || y > 9999 || m < 1 || m > 12 || d < 1 || d > 31) return null;
  const t = new Date(Date.UTC(y, m - 1, d));
  if (t.getUTCFullYear() !== y || t.getUTCMonth() !== m - 1 || t.getUTCDate() !== d) return null;
  return t.toISOString().slice(0, 10);
}

/** @param {string} s */
export function isValidIso(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s));
  return m !== null && makeIso(+m[1], +m[2], +m[3]) === s;
}

/** @param {string} iso @returns {number} ms at UTC midnight */
function toMs(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return Date.UTC(y, m - 1, d);
}

/** @param {string} iso @param {number} n */
export function addDays(iso, n) {
  return new Date(toMs(iso) + n * 86_400_000).toISOString().slice(0, 10);
}

/** Whole days from `a` to `b` (positive when b is later). */
export function daysBetween(a, b) {
  return Math.round((toMs(b) - toMs(a)) / 86_400_000);
}

/** ISO weekday: Monday=1 … Sunday=7. */
export function weekday(iso) {
  const dow = new Date(toMs(iso)).getUTCDay(); // 0=Sun
  return dow === 0 ? 7 : dow;
}

export function endOfMonth(year, month) {
  return makeIso(year, month, new Date(Date.UTC(year, month, 0)).getUTCDate());
}

// ---------------------------------------------------------------- grammar

const MONTH = '(?:jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|june?|july?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';
const WEEKDAY = '(?:mon(?:day)?|tue(?:s(?:day)?)?|wed(?:nesday)?|thu(?:r(?:s(?:day)?)?)?|fri(?:day)?|sat(?:urday)?|sun(?:day)?)';
const DAY = '\\d{1,2}(?:st|nd|rd|th)?';
const PREP = '(?:by|before|until|till|due|on|for|from)';
const STRICT_PREP = '(?:by|before|until|till)'; // prepositions that make a bare month a deadline
// Must not be followed by more word characters, a percent sign, or a possessive ("Friday's demo").
const END = "(?![\\w%'’])";

/**
 * Date forms. `bare` forms may appear without a preposition; the rest only count as a deadline when preceded by one.
 * Order is irrelevant: all forms are tried and the match that ends rightmost (then longest) wins.
 */
const FORMS = [
  { kind: 'iso', bare: true, src: '(?<iso>\\d{4}-\\d{2}-\\d{2})' },
  { kind: 'dmy', bare: false, src: `(?:${WEEKDAY},?\\s+)?(?<day>${DAY})\\s+(?:of\\s+)?(?<month>${MONTH})(?:,?\\s+(?<year>\\d{4}))?` },
  { kind: 'mdy', bare: false, src: `(?:${WEEKDAY},?\\s+)?(?<month>${MONTH})\\s+(?<day>${DAY})(?:,?\\s+(?<year>\\d{4}))?` },
  { kind: 'weekday', bare: false, src: `(?<next>next\\s+)?(?<wd>${WEEKDAY})` },
  { kind: 'relday', bare: true, src: '(?<rel>tomorrow|today|tonight)' },
  { kind: 'eod', bare: true, src: '(?:eod|end of (?:the )?day|cob)(?:\\s+(?<eodrel>tomorrow|today))?' },
  { kind: 'eom', bare: false, src: 'end of (?:the )?month' },
  { kind: 'eow', bare: false, src: 'end of (?:the )?(?<eowwhich>next |this )?week' },
  { kind: 'nextweek', bare: false, src: 'next week' },
  { kind: 'mid', bare: false, src: `mid[- ]?(?<month>${MONTH})` },
  { kind: 'monthonly', bare: false, strictPrep: true, src: `(?<month>${MONTH})` },
];

const COMPILED = FORMS.map((f) => ({
  ...f,
  re: new RegExp(
    `(?<![\\w])(?<prep>${f.strictPrep ? STRICT_PREP : PREP}\\s+)?${f.src}${END}`,
    'gi',
  ),
}));

// ---------------------------------------------------------------- resolution helpers

function inferYearFor(month, day, refIso) {
  const refYear = Number(refIso.slice(0, 4));
  const candidate = makeIso(refYear, month, day);
  if (candidate && daysBetween(candidate, refIso) > YEAR_ROLLOVER_DAYS) return refYear + 1;
  return refYear;
}

function fridayOfThisWeek(refIso) {
  const f = addDays(refIso, 5 - weekday(refIso));
  return daysBetween(refIso, f) < 0 ? addDays(f, 7) : f;
}

function fridayOfNextWeek(refIso) {
  return addDays(refIso, 8 - weekday(refIso) + 4);
}

/** @returns {{iso: string|null, invalid?: boolean}} */
function resolve(kind, g, refIso) {
  switch (kind) {
    case 'iso': {
      const [y, m, d] = g.iso.split('-').map(Number);
      const iso = makeIso(y, m, d);
      return iso ? { iso } : { iso: null, invalid: true };
    }
    case 'dmy':
    case 'mdy': {
      const month = MONTH_NUMBERS[g.month.toLowerCase()];
      const day = parseInt(g.day, 10);
      const year = g.year ? Number(g.year) : inferYearFor(month, day, refIso);
      const iso = makeIso(year, month, day);
      return iso ? { iso } : { iso: null, invalid: true };
    }
    case 'weekday': {
      const target = WEEKDAY_NUMBERS[g.wd.toLowerCase()];
      const w = weekday(refIso);
      if (g.next) return { iso: addDays(refIso, 8 - w + (target - 1)) };
      return { iso: addDays(refIso, ((target - w + 7) % 7) || 7) }; // strictly after the meeting day (FR-I15)
    }
    case 'relday':
      return { iso: addDays(refIso, g.rel.toLowerCase() === 'tomorrow' ? 1 : 0) };
    case 'eod':
      return { iso: addDays(refIso, (g.eodrel || '').toLowerCase() === 'tomorrow' ? 1 : 0) };
    case 'eom': {
      const [y, m] = refIso.split('-').map(Number);
      return { iso: endOfMonth(y, m) };
    }
    case 'eow':
      return { iso: (g.eowwhich || '').toLowerCase().trim() === 'next' ? fridayOfNextWeek(refIso) : fridayOfThisWeek(refIso) };
    case 'nextweek':
      return { iso: fridayOfNextWeek(refIso) };
    case 'mid': {
      const month = MONTH_NUMBERS[g.month.toLowerCase()];
      return { iso: makeIso(inferYearFor(month, 15, refIso), month, 15) };
    }
    case 'monthonly': {
      const month = MONTH_NUMBERS[g.month.toLowerCase()];
      const refYear = Number(refIso.slice(0, 4));
      let year = refYear;
      if (daysBetween(endOfMonth(year, month), refIso) > YEAR_ROLLOVER_DAYS) year += 1;
      return { iso: endOfMonth(year, month) };
    }
    /* c8 ignore next 2 */
    default:
      return { iso: null };
  }
}

// ---------------------------------------------------------------- public API

/**
 * Parse an absolute date used in note headers. Year is required.
 * Accepts `2026-09-01`, `9 September 2026`, `Monday, 14 September 2026`, `September 9, 2026`.
 * @param {string} input
 * @returns {{iso: string, weekdayPrefix: number|null} | {error: 'unparseable'|'invalid'}}
 */
export function parseAbsoluteDate(input) {
  const s = String(input ?? '').trim().replace(/\s+/g, ' ');
  if (!s) return { error: 'unparseable' };
  const wdm = new RegExp(`^(?<wd>${WEEKDAY}),?\\s+`, 'i').exec(s);
  const rest = wdm ? s.slice(wdm[0].length) : s;
  const weekdayPrefix = wdm ? WEEKDAY_NUMBERS[wdm.groups.wd.toLowerCase()] : null;

  let y; let m; let d;
  let mm = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(rest);
  if (mm) { y = +mm[1]; m = +mm[2]; d = +mm[3]; }
  else if ((mm = new RegExp(`^(${DAY})\\s+(?:of\\s+)?(${MONTH}),?\\s+(\\d{4})$`, 'i').exec(rest))) {
    d = parseInt(mm[1], 10); m = MONTH_NUMBERS[mm[2].toLowerCase()]; y = +mm[3];
  } else if ((mm = new RegExp(`^(${MONTH})\\s+(${DAY}),?\\s+(\\d{4})$`, 'i').exec(rest))) {
    m = MONTH_NUMBERS[mm[1].toLowerCase()]; d = parseInt(mm[2], 10); y = +mm[3];
  } else {
    return { error: 'unparseable' };
  }
  const iso = makeIso(y, m, d);
  return iso ? { iso, weekdayPrefix } : { error: 'invalid' };
}

/**
 * Find the due date phrase in a task string, resolve it against `refIso` (the meeting date) and return
 * the task with the phrase removed. Non-dates ("by 10%", "for the last 6 months", "for November") are left alone.
 * @param {string} text
 * @param {string} refIso meeting date
 * @returns {{task: string, due: string|null, phrase: string|null, invalid: boolean}}
 */
export function extractDue(text, refIso) {
  let best = null;
  for (const form of COMPILED) {
    form.re.lastIndex = 0;
    for (const m of text.matchAll(form.re)) {
      const hasPrep = Boolean(m.groups.prep);
      // "next Monday" is unmistakably a date even without "by"/"on"; a bare "Monday" is not (could be "the Monday report").
      const explicitNext = form.kind === 'weekday' && Boolean(m.groups.next);
      if (!hasPrep && !form.bare && !explicitNext) continue;
      const start = m.index;
      const end = m.index + m[0].length;
      if (!best || end > best.end || (end === best.end && start < best.start)) {
        best = { form, start, end, groups: m.groups, text: m[0] };
      }
    }
  }
  if (!best) return { task: tidy(text), due: null, phrase: null, invalid: false };

  const { iso, invalid } = resolve(best.form.kind, best.groups, refIso);
  let before = text.slice(0, best.start);
  // "…survey, results due 15 October": drop the noun that only made sense with "due".
  if (/^due\b/i.test(best.groups.prep || '')) before = before.replace(/(?:[,;:—–-]\s*)?\b(?:results|proposal|report)\s*$/i, '');
  const removed = before + text.slice(best.end);
  return { task: tidy(removed), due: iso, phrase: best.text.trim(), invalid: Boolean(invalid) };
}

/** Collapse whitespace and drop dangling connectors left behind after removing a date phrase. */
function tidy(s) {
  return s
    .replace(/\s+/g, ' ')
    .replace(/\s+([,;.])/g, '$1')
    .replace(/(?:[,;:—–-]\s*)?(?:results\s+)?\b(?:due|by|before|until|till|on|for|from)\s*$/i, '')
    .replace(/[\s,;:.—–-]+$/, '')
    .trim();
}

/**
 * Resolve a user-typed date for CLI flags: an ISO date or any due phrase ("friday", "end of month", "next tuesday")
 * relative to `todayIso`. Returns null when it is not a date.
 * @param {string} input @param {string} todayIso
 */
export function parseDueArg(input, todayIso) {
  const s = String(input).trim();
  if (isValidIso(s)) return s;
  const abs = parseAbsoluteDate(s);
  if ('iso' in abs) return abs.iso;
  const r = extractDue(`x by ${s}`, todayIso);
  return r.due && r.task === 'x' ? r.due : null;
}
