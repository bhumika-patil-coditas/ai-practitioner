// People and name matching. Pure.

/**
 * @typedef {{fullName: string, firstName: string, lastName: string}} PersonName
 */

/** Lower-case, strip accents and apostrophes so "Zoë" == "zoe" and "O'Neil" == "oneil". */
export function fold(s) {
  return String(s ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .replace(/['’‘`]/g, '')
    .toLowerCase()
    .trim();
}

/** @param {string} fullName @returns {PersonName} */
export function makePerson(fullName) {
  const clean = String(fullName).replace(/\([^)]*\)/g, '').replace(/\s+/g, ' ').trim();
  const [firstName, ...rest] = clean.split(' ');
  return { fullName: clean, firstName, lastName: rest.join(' ') };
}

/**
 * Unique people (by folded full name), sorted for determinism.
 * @param {Iterable<string>} names
 * @returns {PersonName[]}
 */
export function buildRoster(names) {
  /** @type {Map<string, PersonName>} */
  const byKey = new Map();
  for (const n of names) {
    if (!n || !String(n).trim()) continue;
    const p = makePerson(n);
    if (!p.firstName) continue;
    const key = fold(p.fullName);
    if (!byKey.has(key)) byKey.set(key, p);
  }
  return [...byKey.values()].sort((a, b) => a.fullName.localeCompare(b.fullName));
}

/**
 * A qualifier narrows people sharing a first name: `{type:'initial', value:'n'}` for "Priya N.",
 * `{type:'last', value:'nair'}` for "Priya Nair".
 * @typedef {{type: 'initial'|'last', value: string}} Qualifier
 */

/**
 * @param {string} first
 * @param {Qualifier|null} qualifier
 * @param {PersonName[]} people
 */
export function candidatesFor(first, qualifier, people) {
  const f = fold(first);
  let out = people.filter((p) => fold(p.firstName) === f);
  if (qualifier) {
    out = out.filter((p) => {
      const last = fold(p.lastName);
      return qualifier.type === 'initial' ? last.startsWith(qualifier.value) : last === qualifier.value;
    });
  }
  return out;
}

/** Turn "Priya", "Priya N.", "Priya Nair" into `{first, qualifier}`. */
export function parseNameQuery(query) {
  const tokens = String(query).replace(/^@/, '').trim().split(/\s+/).filter(Boolean);
  const first = tokens[0] ?? '';
  const rest = tokens.slice(1).join(' ');
  /** @type {Qualifier|null} */
  let qualifier = null;
  if (rest) {
    const initial = /^([A-Za-z])\.?$/.exec(rest);
    qualifier = initial ? { type: 'initial', value: fold(initial[1]) } : { type: 'last', value: fold(rest) };
  }
  return { first, qualifier };
}

/**
 * Match a user-typed name against known people: "Priya Nair", "priya n.", or just "Rahul".
 * @template {PersonName} P
 * @param {string} query
 * @param {P[]} people
 * @returns {P[]}
 */
export function matchPeople(query, people) {
  const exact = people.filter((p) => fold(p.fullName) === fold(query));
  if (exact.length === 1) return exact;
  const { first, qualifier } = parseNameQuery(query);
  return candidatesFor(first, qualifier, people);
}
