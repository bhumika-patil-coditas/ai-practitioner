# Phase 3 — Implementation plan

Inputs: `spec.md` (FR-*/NFR-*), `analysis.md` (D1–D12). Output feeds `tasks.md`.

## 1. Technology (D1)

| Concern | Choice | Why |
|---|---|---|
| Language | JavaScript (ESM) + JSDoc types, `// @ts-check`-friendly | Node 24 present, Python absent; no build step, no transpiler |
| Runtime | Node ≥ 22.13 (`engines`) | `node:sqlite` unflagged |
| DB | `node:sqlite` `DatabaseSync`, WAL off for single-user simplicity, `foreign_keys=ON` | real SQL, zero install |
| CLI parsing | `node:util` `parseArgs` + small dispatcher | no dependency |
| Tests | `node:test` + `node:assert/strict`; coverage via `--experimental-test-coverage` | zero dependency |
| Package | `package.json` with `bin`, `scripts.test`, no `dependencies` | NFR-1 |

## 2. Architecture

Layered, dependencies point **downward** only:

```
bin/actiontrack.js ─► src/cli.js ─► commands/* ─► services/* ─► domain/* (pure)
                                         │             │
                                         │             └──► db/repo.js ─► node:sqlite
                                         └──► email/* (compose pure; sinks = edge I/O)
```

* **domain/** — pure functions, no `fs`, no `Date.now()`, no SQL. Fully unit-tested (NFR-3).
* **db/** — the only place SQL lives (`Repository`). Services receive it by injection.
* **services/** — orchestration (`IngestService`, `FollowupService`) with injected `repo`, `clock`, `fs`-ish folder reader, `sink`.
* **commands/** — thin: parse flags → call service → format output → return an exit code. No business rules.
* **email/** — `compose.js` is pure (items → `{to, subject, body}`); `sinks/*` are the I/O edge.
* A single `Context` object (`{repo, clock, config, io}`) is built in `cli.js` and passed down — makes every command testable with an in-memory DB and a fixed clock.

### 2.1 Directory layout

```
bin/actiontrack.js            shim (silences SQLite experimental warning, calls main)
src/
  cli.js  context.js  config.js  clock.js  errors.js
  commands/   ingest.js  list.js  done.js  followup.js
  services/   ingest-service.js  followup-service.js
  domain/     dates.js  frontmatter.js  markdown-scan.js  note-parser.js
              action-lines.js  owner.js  roster.js  normalize.js  status.js
  db/         open.js  migrations.js  repo.js
  email/      compose.js  mcp-client.js  sinks/{index,stdout,file,mcp}.js
  format/     table.js  report.js
tests/
  unit/  integration/  fixtures/{mini-notes/, fake-mcp-server.mjs}  helpers.js
notes/                        the 35-file sample corpus
specs/001-actiontrack/        analysis · spec · plan · tasks
CLAUDE.md  skills.md  README.md  actiontrack.config.example.json  .gitignore
```

## 3. Core algorithms

### 3.1 Note parsing pipeline (`domain/note-parser.js`, pure)
`parseNote(buffer, {filename}) → {ok:true, note} | {ok:false, reason, detail}`

1. **Decode**: reject if buffer contains `0x00` or fails `new TextDecoder('utf-8',{fatal:true})`; strip BOM; normalise `\r\n`→`\n`. Empty/whitespace ⇒ `empty`.
2. **Header**: if text starts with `---\n` parse front matter (`frontmatter.js`); else scan the first 40 non-skipped lines for `# Meeting: …`/`# …`, `Date:`, `Attendees:`. Parse date (`dates.parseAbsoluteDate`); missing ⇒ `missing-date`, unparseable/impossible ⇒ `invalid-date` (+ filename hint).
3. **Mask**: `markdown-scan.js` walks lines once with a tiny state machine (in-fence with fence-char/length matching, in-HTML-comment, blockquote prefix) and yields `{lineNo, text, skipped}`.
4. **Extract**: `action-lines.js` over non-skipped lines → `{lineNo, kind: checkbox|action|table, checked, text, rawLine}`. Table rows are recognised after a header row naming Owner/Action(/Due) and its `|---|` separator; the row becomes synthetic text `"<owner> to <action> by <due>"` so the same downstream grammar applies.
5. **Interpret each line** (still pure, needs only the meeting date): `owner.parseOwnerClause` → owner tokens + helpers + task text; `dates.extractDue(task, meetingDate)` → `{task, due, phrase}`.
   Result is an `ParsedOccurrence[]` with *unresolved* owner tokens (resolution needs the roster).

### 3.2 Owner resolution (`domain/owner.js`, `domain/roster.js`)
Two-pass ingest (FR-I14): pass 1 parses every note and builds `roster` = attendees of all valid notes ∪ config people. Pass 2 resolves
each owner token with `resolveOwner(token, meetingAttendees, roster)`:
```
cands = attendees.filter(firstName == token.first)           // attendees first
if cands.empty: cands = roster.filter(firstName == token.first)
if token.qualifier: cands = cands.filter(lastName matches qualifier)   // 'N.' => startsWith, 'Nair' => equals
unique(cands) → person | cands.length>1 → ambiguous(candidates) | else → external(name)
```
Name matching is case-insensitive, accent-insensitive (NFKD strip). `@anita` ⇒ `anita`. Group/placeholder words are checked **before** name matching.

### 3.3 Date engine (`domain/dates.js`, pure, UTC day arithmetic)
* Represent a day as an ISO string; helpers `addDays`, `weekday(iso)` (Mon=1…Sun=7), `endOfMonth`, `isValidIso`. Computation uses `Date.UTC` and `getUTC*` only.
* `parseAbsoluteDate(str, {defaultYear})` for headers and absolute due forms.
* `extractDue(text, refIso)` — finds the **rightmost** match of `PREP? DATE_EXPR`, where bare forms (no preposition) are allowed only for ISO,
  `tomorrow|today|EOD`; verifies the match is not followed by `%`, `'s`, or a letter; resolves per spec table; returns the text with the phrase and dangling
  `by/—/,` removed. Month-only phrases (`for November`) intentionally do not match; `by November` does (end of month).
* `resolvePhrase()` is a pure switch over a tagged match, so each rule is unit-tested in isolation (table-driven tests, including every phrase in the corpus).

### 3.4 Normalisation and identity (`domain/normalize.js`)
`normalizeTask(t)`: NFKD, lower-case, `’→'`, drop everything except `[a-z0-9 ]`/apostrophes→removed, drop tokens `the|a|an`, collapse whitespace.
`dedupeKey(ownerKey, task)` = `ownerKey + '|' + normalizeTask(task)`.

### 3.5 Merge / persistence (`services/ingest-service.js` + `db/repo.js`)
Per run, inside one transaction (FR-I26):
1. For **every** valid note in (date, filename) order (see FR-I25 — the hash only drives the reported status): upsert meeting row; delete its old occurrences; for each occurrence upsert the item by `dedupe_key`, insert occurrence.
2. After all notes: **recompute** every touched item from its occurrences — `status` from the latest occurrence, `due_date` from the latest occurrence with a due date, `first/last_seen`, `completed_at` (unless `completed_by='manual'`, which pins `status='done'`). Items left with zero occurrences are deleted unless manually done.
   Recompute-from-occurrences (instead of incremental updates) makes the result independent of ingest order and trivially idempotent.
3. Created/updated/unchanged counts come from comparing item snapshots before/after recompute.

### 3.6 Derived status (`domain/status.js`)
`derive(item, today) = done | (due && due < today ? 'overdue' : 'open')`. SQL filters push the same predicate down (`due_date < :today`) so `list` never loads the whole table to filter.

### 3.7 Follow-up (`services/followup-service.js`, `email/compose.js`)
1. Resolve owner(s) via `repo.findPeople(query)`; >1 ⇒ `UsageError` with candidates.
2. Select: overdue, open-dated, open-undated for `owner_id`; plus `owner_kind='ambiguous'` items whose `owner_candidates` contain the person.
3. `compose({person, email, items, today}) → {to:[…], subject, body, warnings}` (pure; fixed formatting, golden-file tested).
4. `itemsetHash = sha1(sorted "id:due" list)`; skip if `followup_drafts` has a `staged|drafted` row with the same owner + hash unless `--force`.
5. `sink.createDraft(payload)`; record result; continue on per-owner failure.
6. `--all`: also compute the **unrouted report** (D11).

### 3.8 Sinks and the "never send" guarantee (FR-F5)
```js
/** @typedef {{to:string[], subject:string, body:string}} DraftPayload */
/** interface DraftSink { name:string; createDraft(p:DraftPayload, meta):Promise<{status:'staged'|'drafted'|'previewed', id?:string, location?:string}> } */
```
* `stdout` — prints; `file` — writes `.json` (payload) + `.txt` (human preview) under `<draftsDir>/<timestamp>/`; `mcp` — see below.
* **MCP client** (`email/mcp-client.js`): spawn `command args` (no shell), newline-delimited JSON-RPC 2.0 over stdio. Sequence:
  `initialize` → `notifications/initialized` → `tools/list` → assert configured tool exists **and** `!/send/i.test(name)` → `tools/call{name, arguments:{to,subject,body}}` → close.
  Per-request timeout (default 20 s), child killed on timeout/exit. The guard runs *before* any `tools/call`, and again inside the client's single `callTool` entry point so no code path can call a send-like tool.
* The sink registry is closed (`stdout|file|mcp`); there is no code path that composes SMTP/`messages.send`.
* **Agent relay**: the claude.ai Gmail connector is not an MCP stdio server we can spawn. In Claude Code, the `file` sink output (`--json` for the list of payload paths) is relayed to the connector's `create_draft` tool — procedure in `skills.md`. The connector exposes no send tool among those the workflow uses.

## 4. Database schema (migration 1)

```sql
PRAGMA foreign_keys = ON;

CREATE TABLE meetings (
  id            INTEGER PRIMARY KEY,
  path          TEXT NOT NULL UNIQUE,          -- absolute path
  filename      TEXT NOT NULL,
  title         TEXT NOT NULL,
  meeting_date  TEXT NOT NULL,                 -- YYYY-MM-DD
  attendees     TEXT NOT NULL DEFAULT '[]',    -- JSON array of full names
  content_hash  TEXT NOT NULL,
  ingested_at   TEXT NOT NULL
);

CREATE TABLE people (
  id          INTEGER PRIMARY KEY,
  full_name   TEXT NOT NULL UNIQUE,
  first_name  TEXT NOT NULL,
  last_name   TEXT NOT NULL DEFAULT '',
  email       TEXT                              -- from config, nullable
);
CREATE INDEX idx_people_first ON people(first_name COLLATE NOCASE);

CREATE TABLE items (
  id               INTEGER PRIMARY KEY,
  dedupe_key       TEXT NOT NULL UNIQUE,
  owner_kind       TEXT NOT NULL CHECK (owner_kind IN ('person','ambiguous','external','group','none')),
  owner_id         INTEGER REFERENCES people(id),          -- only for 'person'
  owner_label      TEXT,                                    -- raw/verbatim name or group word
  owner_candidates TEXT NOT NULL DEFAULT '[]',              -- JSON array of people ids (ambiguous)
  task             TEXT NOT NULL,
  status           TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','done')),
  due_date         TEXT,
  completed_at     TEXT,
  completed_by     TEXT CHECK (completed_by IN ('notes','manual')),
  first_meeting_id INTEGER REFERENCES meetings(id) ON DELETE SET NULL,
  last_meeting_id  INTEGER REFERENCES meetings(id) ON DELETE SET NULL,
  created_at       TEXT NOT NULL,
  updated_at       TEXT NOT NULL,
  CHECK ((owner_kind = 'person') = (owner_id IS NOT NULL))
);
CREATE INDEX idx_items_owner  ON items(owner_id);
CREATE INDEX idx_items_status ON items(status, due_date);

CREATE TABLE occurrences (
  id          INTEGER PRIMARY KEY,
  item_id     INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
  meeting_id  INTEGER NOT NULL REFERENCES meetings(id) ON DELETE CASCADE,
  line_no     INTEGER NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('checkbox','action','table')),
  checked     INTEGER NOT NULL CHECK (checked IN (0,1)),
  task        TEXT NOT NULL,                   -- cleaned task text as worded in this meeting (the item shows the latest wording)
  raw_text    TEXT NOT NULL,
  due_date    TEXT,
  UNIQUE (meeting_id, line_no, item_id)
);
CREATE INDEX idx_occ_item ON occurrences(item_id);

CREATE TABLE followup_drafts (
  id           INTEGER PRIMARY KEY,
  person_id    INTEGER NOT NULL REFERENCES people(id),
  itemset_hash TEXT NOT NULL,
  sink         TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('staged','drafted')),
  external_id  TEXT,
  subject      TEXT NOT NULL,
  created_at   TEXT NOT NULL
);
```
Schema version: `PRAGMA user_version = 1`; `migrations.js` is an ordered array applied in a transaction until `user_version` reaches the latest.

## 5. Configuration (`actiontrack.config.json`, optional)
```json
{
  "people": { "Priya Nair": { "email": "priya.nair@example.com" } },
  "followup": {
    "sink": "file",
    "draftsDir": ".actiontrack/drafts",
    "signoff": "Thanks,",
    "mcp": { "command": "node", "args": ["path/to/gmail-mcp-server.js"], "tool": "create_draft", "timeoutMs": 20000 }
  }
}
```
Validated on load (unknown sink, non-string email, malformed JSON ⇒ `UsageError` naming the key). `people` keys also seed the roster.

## 6. Error handling policy
* `errors.js`: `UsageError(2)`, `NotFoundError(1)`, `StorageError(1)`, `SinkError(1)`. `cli.js` is the only place that maps errors → exit codes/messages.
* Parsing returns **values**, not exceptions (`{ok:false, reason}`); `IngestService` additionally wraps each file in `try/catch` ⇒ `internal-error` skip, so a parser bug on one file cannot abort the run.
* Storage errors roll the ingest transaction back (FR-I26).

## 7. Test strategy

| Layer | Approach | Files |
|---|---|---|
| Unit (pure domain) | table-driven; one case per spec row; every corpus phrase | `unit/dates`, `unit/markdown-parsing` (front matter + scan + action lines), `unit/owner-normalize` (owner, roster, normalize, status) |
| Parser | inline notes: each trap (quote/fence/comment), each header format, CRLF/BOM, binary; plus the real malformed samples | `unit/note-parser.test.js` |
| Repository | in-memory DB: constraints, recompute rules, manual-done stickiness, migrations, filters | `unit/repo.test.js` |
| Compose / sinks / config / clock | text assertions; file + stdout + MCP sinks against `fixtures/fake-mcp-server.mjs`; **negative**: send-only server ⇒ refused and `tools/call` never issued | `unit/compose-sinks-config.test.js` |
| Service/integration | generated mini folders: dedupe chains, same-name people, no-owner/no-date, malformed files, idempotency, change handling, atomic rollback | `integration/ingest.integration.test.js` |
| Commands (in-process) | `list`/`done`/`followup` incl. duplicate guard, `--all`, MCP sink end-to-end | `integration/commands.test.js` |
| Golden / acceptance | the real `notes/` corpus asserting spec scenarios A1–A10 and per-person expectations | `integration/acceptance.test.js` |
| CLI end-to-end | spawn `bin/actiontrack.js`: exit codes, `--json`, stderr contract, no ANSI/warnings when piped, corrupt DB | `integration/cli.e2e.test.js` |

Principles: tests use a fixed clock (`--today`); no test touches the user's real DB or Gmail; failing-first for each bug found during corpus runs
(add a regression test before fixing).

## 8. Risks & mitigations
| Risk | Mitigation |
|---|---|
| Date grammar false positives (`by 10%`) | negative-lookahead rules + explicit negative tests (FR-I17) |
| Wrong-person email via first-name collisions | `ambiguous` never resolves; `--owner Priya` errors; confirm-section in both candidates' emails |
| Dedupe over/under-merging | exact-after-normalisation only; corpus near-miss tests (§2.6 of analysis) |
| `node:sqlite` API is still "release candidate" | confined to `db/`; shim silences warning; `engines` pinned |
| MCP server dialects differ | handshake is minimal/standard; tool name + argument names configurable; fake-server test documents the contract |
| Re-ingest reopening manual `done` | recompute pins manual completions; dedicated test |

## 9. Traceability (FR → tests)

| Requirements | Test file(s) |
|---|---|
| FR-G1..G5, NFR-5 | `integration/cli.e2e.test.js`, `unit/compose-sinks-config.test.js` (clock) |
| FR-I1..I5 | `unit/note-parser.test.js`, `unit/markdown-parsing.test.js` (front matter), acceptance A1 |
| FR-I6..I9 | `unit/markdown-parsing.test.js`, `unit/note-parser.test.js`, acceptance A2 |
| FR-I10..I14 | `unit/owner-normalize.test.js`, `integration/ingest.integration.test.js`, acceptance A3–A5 |
| FR-I15..I19 | `unit/dates.test.js`, acceptance A2 |
| FR-I20..I24 | `unit/owner-normalize.test.js`, `unit/repo.test.js`, `integration/ingest.integration.test.js`, acceptance A3 |
| FR-I25..I27 | `integration/ingest.integration.test.js`, acceptance A7 |
| FR-L1..L7 | `unit/repo.test.js` (filters), `integration/commands.test.js`, acceptance A3–A6 |
| FR-D1..D3 | `integration/commands.test.js`, acceptance A8 |
| FR-F1..F8 | `unit/compose-sinks-config.test.js`, `integration/commands.test.js`, acceptance A9–A10 |
