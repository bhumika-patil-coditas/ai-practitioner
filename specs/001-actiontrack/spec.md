# Phase 2 — Specification: `actiontrack`

Status: **approved for planning** · Inputs: `analysis.md` (decisions **D1–D12**, gaps **G1–G7**)
Keywords MUST / SHOULD / MAY are used in the RFC 2119 sense. Every `FR-*` has at least one test (traceability
table in `plan.md` §9).

## 1. Purpose
Turn a folder of markdown meeting notes into a tracked, de-duplicated list of action items in a local SQL
database, and draft (never send) one follow-up email per owner.

## 2. Global CLI contract

```
actiontrack [global options] <command> [args]

Commands: ingest <folder> | list | done <id...> | followup <owner> | followup --all
Global:   --db <path>        database file          (default ./.actiontrack/actiontrack.db, env ACTIONTRACK_DB)
          --today <date>     override "today"        (YYYY-MM-DD, env ACTIONTRACK_TODAY; default: system date)
          --config <path>    config file             (default ./actiontrack.config.json if present, env ACTIONTRACK_CONFIG)
          --json             machine-readable output (all commands)
          --help, --version
```

* **FR-G1** Exit codes: `0` success · `1` runtime failure (e.g. unknown id, DB error) · `2` usage error
  (unknown flag/command, bad date, ambiguous `--owner`) · `3` `ingest --strict` finished with skipped notes.
* **FR-G2** Errors go to stderr as one human-readable line (`error: …`); stack traces only with `ACTIONTRACK_DEBUG=1`.
* **FR-G3** `--today` / the clock is the **only** source of "now". No command reads the system clock elsewhere.
* **FR-G4** The tool MUST create the DB directory and schema on first use and migrate older schemas forward.
* **FR-G5** Plain-text output has no ANSI colour when stdout is not a TTY or `NO_COLOR` is set.

## 3. `ingest <folder>`

Scans `<folder>` recursively (skipping dot-directories) for files whose extension is `.md` (case-insensitive).

### 3.1 Note validity
* **FR-I1** A note is valid iff it is UTF-8 text (BOM and CRLF tolerated; NUL bytes or invalid sequences ⇒ `not-text`)
  **and** has a date that resolves to a real calendar day.
* **FR-I2** Invalid notes are **skipped and reported** with a reason code: `not-text`, `empty`, `missing-date`,
  `invalid-date`, `read-error`, `internal-error`. One bad file MUST NOT stop or crash the run, and MUST NOT
  change any stored data.
* **FR-I3** Missing title ⇒ warning `missing-title` (filename used). Missing attendees ⇒ warning `missing-attendees`.
* **FR-I4** Header sources: `# Meeting: <t>` / `# <t>` + `Date:` / `Attendees:` lines in the first block, **or** `---` front matter
  with `title`, `date`, `attendees` (inline list `[a, b]` or block list). Date formats: `YYYY-MM-DD`,
  `D Month YYYY`, `Month D, YYYY`, optional leading weekday. A leading weekday that disagrees with the date ⇒ warning.
* **FR-I5** An invalid-date note whose filename starts with a valid ISO date reports that date as a *hint*; it is still skipped.

### 3.2 Extracting action items
* **FR-I6** Recognised forms, anywhere in the body: checkbox lines `[-*+] [ ]`/`[x]`/`[X]` **or numbered `1. [ ]` / `2) [x]`** at any indent
  (tabs included; optional space after `]`); lines starting `ACTION:` (case-insensitive); table rows under a header containing
  `Owner`, `Action` and (optionally) `Due` columns.
* **FR-I7** Never items: lines in fenced code blocks (``` or ~~~), inside HTML comments (single- or multi-line),
  or in blockquotes (`>`), headings, prose.
* **FR-I8** `[ ]` ⇒ open occurrence; `[x]`/`[X]` ⇒ done occurrence. `ACTION:` and table rows are open.
* **FR-I9** Each item records its occurrence: source file, line number, raw text, meeting date.

### 3.3 Owner (D4)
* **FR-I10** Names are Unicode letters (`José`, `Zoë`, `Søren`); matching folds accents, so `Jose` finds `José García`. A markdown wrapper around the owner
  (`**Sam** to …`, `__Sam__`, `*Sam*`, `` `Sam` ``, `**Sam:** …`, or a fully bold line) is stripped — only at the start of the text.
  Owner grammar at the start of the item text: `<names> to|will|: <task>`, where `<names>` is one or
  more of `@?First [Initial.|Last]` joined by `&`, `and`, or `,`; optional trailing `(with <helper>)`.
* **FR-I11** Candidates for a first name = meeting attendees with that first name; if none, all known people
  (every attendee seen in any ingested note, plus config `people`). A qualifier (`N.` or `Nair`) filters candidates
  by last name. Exactly one candidate ⇒ `person`; several ⇒ `ambiguous` (candidate list stored); none ⇒ `external`
  (name kept verbatim).
* **FR-I12** Group words (`everyone, everybody, all, team, we`) ⇒ `group`. Placeholders (`tbd, tba, someone, anyone,
  somebody, nobody, unassigned`) and text with no recognisable owner ⇒ `none`. These items are still stored.
* **FR-I13** `A & B to …` creates **one item per owner**. `(with X)` helpers are appended to the task text and do not own the item.
* **FR-I14** Owner resolution MUST NOT depend on file ordering: all notes are parsed first, the roster is built, then owners are resolved.

### 3.4 Due dates (D5)
* **FR-I15** Reference date = the note's meeting date. Recognised forms (after an optional preposition
  `by|before|until|till|due|on|for|from`; `tomorrow|today|EOD` may also stand alone):

  | Phrase | Resolves to |
  |---|---|
  | ISO date, `D Mon[th] [YYYY]`, `Mon[th] D[st/nd/rd/th] [YYYY]`, with optional weekday prefix | that calendar date (weekday prefix ignored) |
  | `<weekday>` / abbreviation (`Mon`, `Wed`, `Thursday`) | first such weekday **strictly after** the meeting date |
  | `next <weekday>` (a preposition is optional: `next Monday` alone is a deadline) | that weekday in the following Mon–Sun week |
  | `tomorrow` / `today` / `EOD` / `EOD tomorrow` | meeting date +1 / +0 / +0 / +1 |
  | `end of (the) month` | last day of the meeting's month |
  | `end of (next) week`, `next week` | Friday of this/next week |
  | `mid-<month>` | the 15th of that month (meeting year rule below) |
  | `by <month>` | last day of that month |

* **FR-I16** A yearless date takes the meeting's year; if that lands more than 180 days **before** the meeting, use the next year.
* **FR-I17** Non-dates MUST stay in the task text and yield no date: `by 10%`, `for the last 6 months`, `for November`, `before cutover`.
* **FR-I18** The recognised due phrase (and the dangling `by`, `—`, `,`) is removed from the stored task. The raw line is kept on the occurrence.
* **FR-I19** Invalid calendar dates (`2026-02-30`) yield no date and a warning `invalid-due`.

### 3.5 De-duplication & merge (D6, D8)
* **FR-I20** Item identity = `(owner key, normalised task)`. Owner key = person id | `ambiguous:<first>:<sorted candidate ids>` |
  `external:<lower name>` | `group:<word>` | `none`. Normalisation per D6.
* **FR-I21** A matching occurrence attaches to the existing item rather than creating a new one — across notes **and** within one note.
* **FR-I22** Merged state: `status` = state of the latest occurrence by (meeting date, filename, line); `due_date` = due of the
  latest occurrence **that has one**; `first_seen`/`last_seen` meetings tracked. Notes-driven `done` sets `completed_at` = that meeting's date.
* **FR-I23** Items with the same task but different owners (including `Priya N.` vs `Priya S.`) MUST remain separate.
* **FR-I24** A manual `done` (FR-D1) is never reopened by ingest.

### 3.6 Idempotency & reporting
* **FR-I25** Notes are processed in (meeting date, filename) order. **Every valid note is re-processed on every run** (notes are small; this keeps
  owner resolution independent of how ingests were batched, because the roster may have grown since a note was last seen). The per-file content hash
  is stored and only decides the *reported* file status (`new` / `changed` / `unchanged`). A re-processed note replaces its occurrences; items are
  recomputed from occurrences, so re-running on an unchanged folder changes nothing and keeps all ids. Notes that disappear from the folder, or that
  become malformed, keep their previously stored items.
* **FR-I26** Ingest is transactional **per run**: either all valid notes are applied or the DB is unchanged on a storage error.
* **FR-I27** An ingest that finds no `.md` files succeeds but says so (a mistyped folder must not look like success). The summary lists: files scanned/ingested/unchanged/skipped (each skipped file with its reason), items
  created/updated/unchanged, and warnings grouped by code — notably `ambiguous-owner`, `no-owner`, `no-due-date`. `--json` emits the same data.
  `--strict` ⇒ exit `3` if anything was skipped.

## 4. `list`

* **FR-L1** Columns: `ID  STATUS  OWNER  DUE  TASK  SOURCE`. Sorted overdue → open → done; then due date (no-date last); then id.
* **FR-L2** Derived status: `done` if done; else `overdue` if `due_date < today`; else `open`. Due *today* is `open`. Items with no date are never overdue.
* **FR-L3** `--status open|done|overdue` filters on the derived status (mutually exclusive, G5). Other values ⇒ exit 2.
* **FR-L4** `--owner <name>`: full name (case-insensitive), first name, or `First I.` initial form. Quotes are optional: `--owner Priya Nair` is read as `"Priya Nair"` (same for `followup Priya Nair`). If it matches **more than one** person ⇒
  exit 2 listing the candidates. If it matches no one ⇒ empty result plus a hint listing known owners.
* **FR-L5** `--due-before <date>` keeps items with `due_date` strictly before the date (items without a date are excluded).
  Accepts ISO or any FR-I15 phrase resolved against *today*.
* **FR-L6** `--unassigned` shows items whose owner is not a resolved person (`ambiguous`, `group`, `none`, `external`).
* **FR-L7** Owner column renders `Priya (ambiguous)`, `(everyone)`, `—` as appropriate; filters combine with AND. `--json` returns objects incl. `occurrences`.

## 5. `done <id...>`

* **FR-D1** Sets `status=done`, `completed_at`=today, `completed_by=manual`. Sticky (FR-I24).
* **FR-D2** Already done ⇒ success with "already done" note (idempotent). Unknown id ⇒ exit 1, other ids in the call are still processed.
* **FR-D3** Non-integer id ⇒ exit 2.

## 6. `followup <owner> | --all`

* **FR-F1** For one owner (same resolution as FR-L4; ambiguous name ⇒ exit 2 — **never** pick one; a name nobody matches ⇒ exit 1 listing known people), gather: **overdue**, **open**
  (dated, then undated), and **to confirm** (ambiguous items listing the person as a candidate). Done items are excluded.
  A draft is created only if the person has at least one overdue/open/undated item (an ambiguous item alone does not trigger an email, it only rides along);
  otherwise no draft and the message says so.
* **FR-F2** `--all` creates one draft per person with at least one overdue/open item. Then prints an **unrouted report**: open items owned
  by groups/placeholders/ambiguous/external, so nothing is silently dropped (D11).
* **FR-F3** Draft content (plain text, no Markdown — Gmail `body` is plain text): subject
  `Action items: <n> open, <m> overdue (as of <date>)`; greeting by first name; sections *Overdue* (with days overdue),
  *Open*, *No due date*, *Please confirm*; each line has `[#id]`, task (sentence-cased), due, and source meeting (title + date).
  Overdue first, then by due date.
* **FR-F4** Recipient from config `people["<Full Name>"].email`. If absent the draft is still produced with empty recipients and a
  `missing-recipient` warning. Emails are never invented.
* **FR-F5** **The tool never sends mail.** The only mail capability in the code base is `DraftSink.createDraft`. The MCP sink MUST refuse to
  invoke any tool whose name matches `/send/i`, and MUST only call the single configured draft tool (default `create_draft`).
* **FR-F6** Sinks (`--sink`, config `followup.sink`): `file` (default) writes `<draftsDir>/<run>/<slug>.json|.txt` payloads and records the draft as
  `staged`; `stdout` prints a preview and records nothing; `mcp` spawns the configured MCP stdio server, performs
  `initialize` → `tools/list` (verifies the draft tool exists and is not a send tool) → `tools/call`, and records `drafted` with the returned id.
  `--dry-run` forces `stdout`.
* **FR-F7** Duplicate guard: if a `staged`/`drafted` draft for the same owner and the same item set (ids + due dates) exists, skip with a note;
  `--force` overrides.
* **FR-F9** In text output, missing recipients are reported **once** for all drafts ("No email address configured for: …"), not once per draft. JSON keeps per-draft warnings.
* **FR-F8** A sink failure for one owner is reported and does not stop the others (non-zero exit `1` at the end).

## 7. Data model (logical)

`meetings` · `people` · `items` · `occurrences` · `followup_drafts` — see `plan.md` §4 for DDL. Constraints required by this spec:
`items.dedupe_key` UNIQUE; `items.status ∈ {open, done}`; `occurrences` cascade-delete with their meeting; foreign keys ON;
schema version tracked with `PRAGMA user_version`.

## 8. Non-functional requirements
* **NFR-1** Zero runtime dependencies; Node ≥ 22.13.
* **NFR-2** Ingesting the 35-file sample takes < 2 s on a laptop; no command loads whole DB tables unnecessarily.
* **NFR-3** Pure parsing logic has no I/O and no clock access (unit-testable); I/O lives at the edges.
* **NFR-4** No secrets in repo; the MCP sink config contains only command/args, never tokens.
* **NFR-5** Windows, macOS, Linux: path handling via `node:path`; CRLF tolerant; no shell-specific code.

## 9. Acceptance scenarios (end-to-end, against `notes/`)

| # | Given | When | Then |
|---|---|---|---|
| A1 | the sample folder | `ingest notes` | exit 0; **31** notes ingested; **3** skipped (`scratch.md`=not-text, `untitled.md`=missing-date, `2026-10-03-sales-pipeline.md`=invalid-date); `.txt` never read |
| A2 | after A1 | inspect | exactly **115** action lines extracted (113 checkboxes + 1 `ACTION:` + 1 table row); the quoted refund line, the fenced example and the commented-out token purchase are absent |
| A3 | after A1 | `list --owner "Priya Nair"` | includes the revised-quote item as **done**, with 3 occurrences |
| A4 | after A1 | `list --owner Priya` | exit 2, names *Priya Nair* and *Priya Shah* |
| A5 | after A1 | `list --unassigned` | contains `Everyone…`, `TBD…`, `Someone…`, `Team…`, and the ambiguous `Priya`/`Rahul` items |
| A6 | after A1, `--today 2026-10-15` | `list --status overdue --owner "Rahul Verma"` | only open items with `due < 2026-10-15` |
| A7 | after A1 | `ingest notes` again | 0 created, 0 updated; ids unchanged |
| A8 | after A1 | `done 1` then re-ingest | item 1 still done |
| A9 | after A1 | `followup "Karan Joshi" --sink file` | one staged draft; subject counts match `list`; nothing sent |
| A10 | `followup --all` | | one draft per routable person + an unrouted report |
