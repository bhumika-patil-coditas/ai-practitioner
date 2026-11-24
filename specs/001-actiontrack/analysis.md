# Phase 1 — Requirements & corpus analysis

> SDD step 1 of 4: **analysis → spec → plan → tasks**. Nothing in `src/` exists until steps 2–4 are written.
> This document records what was read, what is ambiguous, and which decisions were made (and why). The
> specification (`spec.md`) turns these decisions into testable requirements.

## 1. What was asked

`actiontrack` is a CLI that turns a folder of markdown meeting notes into a tracked list of action items
and drafts follow-up emails.

| Command | Brief |
|---|---|
| `ingest <folder>` | Parse every `.md` note → store items (owner, task, due date resolved to a real date, source file, status). |
| `list` | Show items. Filters `--owner`, `--status open\|done\|overdue`, `--due-before <date>`. Overdue is derived. |
| `done <id>` | Mark an item done. |
| `followup <owner>` | One email per owner covering open + overdue items; create a **Gmail draft** via the Gmail MCP connector. **Never send.** |

Required edge cases: duplicates across meetings · no owner / no date · two people with the same first name ·
malformed notes (skip + report, never crash). Deliverables also include `CLAUDE.md`, `skills.md`, tests,
a clean structure and real database storage.

### Gaps in the brief (the pasted text is truncated in places) and the assumption taken

| # | Gap | Assumption |
|---|---|---|
| G1 | "Overdue …" sentence is cut off. | Overdue = not done **and** due date strictly before *today*. Computed at read time, never stored. |
| G2 | `followup <owner…` is cut off ("per owner covering their open and overdue items"). | `followup <owner>` for one person, `followup --all` for everyone routable. |
| G3 | No e-mail addresses exist anywhere in the notes. | Owner → email comes from an optional config file. Missing address ⇒ draft is still created with an empty *To* and flagged. Addresses are never guessed. |
| G4 | "Today" for overdue. The sample notes are Sep–Oct 2026. | Clock is injectable (`--today`, `ACTIONTRACK_TODAY`) so output is reproducible and testable. |
| G5 | Is `open` inclusive of overdue? | **No.** `open`, `overdue`, `done` are mutually exclusive display statuses (the brief lists them as three filter values, and says follow-up covers "open *and* overdue"). |
| G6 | A Node/Python choice is not specified. | Python is not installed here; Node 24 is. See D1. |
| G7 | How can a standalone CLI use a *claude.ai* connector? | It cannot call it directly. See D9 — three sinks, and an agent relay documented in `skills.md`. |

## 2. Corpus census (`notes/`)

35 files · 34 `.md` · 1 `.txt` (`2026-09-19-offsite-draft.txt` — not a note, not scanned).
118 raw checkbox lines in the `.md` files (13 checked). 9 distinct people.

### 2.1 Format variants found

| Variant | Where | Handling |
|---|---|---|
| `# Meeting: <title>` + `Date:` + `Attendees:` header lines | most files | primary format |
| YAML-ish front matter (`title/date/attendees: [a, b]`) | 09-16, 09-30 standups | mini front-matter parser |
| Date as `2026-09-01`, `9 September 2026`, `Monday, 14 September 2026` | various | multi-format date parser |
| Bullet markers `-`, `*`, `+`; checked as `[x]` **and** `[X]` | offsite, finance sync | all accepted |
| Indented (nested) checkbox | offsite (`Karan to validate targets…`) | accepted at any indent |
| `ACTION: Karan to circulate…` (no checkbox) | offsite | accepted |
| Markdown table `Owner \| Action \| Due` | offsite | accepted (row → item) |
| Em-dash separated due phrase (`— by Friday`) | 09-08, 10-02 | stripped from task |
| No attendees line at all | 09-23 standup | accepted with a warning (see D2) |

### 2.2 Traps (content that *looks* like an action item but must not be one)

| File | Trap | Rule |
|---|---|---|
| `2026-09-21-incident-review.md` | `> - [ ] Karan to refund … by Friday` is a **quoted wish**; the real, un-dated item is below | blockquote lines are never items |
| `2026-10-09-security-review.md` | fenced code block with `- [ ] Owner to remediate …` | fenced code is skipped |
| `2026-10-09-security-review.md` | `<!-- - [ ] Sam to buy hardware tokens … -->` | HTML comments are skipped |
| `2026-09-19-offsite-draft.txt` | `- [ ] Book the venue` in a non-note | only `.md` files are read |
| `2026-09-30-q4-offsite.md` | prose "both Priyas … nodded", "unclear which Rahul" | prose is never mined for items |

### 2.3 Malformed files (must be skipped **and reported**, never crash)

| File | Why | Reason code |
|---|---|---|
| `scratch.md` | binary (UTF-16 BOM, PNG magic, NULs, invalid UTF-8) | `not-text` |
| `untitled.md` | no header, no date, no attendees — only loose checkboxes | `missing-date` |
| `2026-10-03-sales-pipeline.md` | `Date: sometime last week` — unparseable | `invalid-date` (hint: filename suggests 2026-10-03) |

A note *without* a resolvable date is rejected rather than guessed: relative deadlines ("by Friday") are
meaningless without it, and silently trusting a filename would fabricate deadlines.

### 2.4 Owner patterns found

| Pattern | Example | Outcome |
|---|---|---|
| First name | `Priya to send…` | resolve against attendees |
| Name + initial | `Priya N.`, `Priya S.` | disambiguates via last-name initial |
| @handle | `@anita: audit …` | resolves like a first name |
| Joint | `Anita & Rahul to agree…` | one item **per** owner |
| With helper | `Lena (with Priya) to collect…` | owner = Lena; helper kept in the task text |
| Group word | `Everyone to review…`, `Team to decide…` | `group` — unroutable, reported |
| Placeholder | `TBD to write…`, `Someone to update…` | `none` — unroutable, reported |
| Same first name, both attendees present | 09-17, 09-29, 09-30 offsite, 10-07, 10-08 | `ambiguous` — **never guessed** |
| No attendees line | 09-23: `Rahul to rebase…` | falls back to global roster; two Rahuls ⇒ ambiguous; `Sam` unique ⇒ resolved |

People: Priya **Nair** / Priya **Shah**, Rahul **Mehta** / Rahul **Verma**, plus Anita Desai, Sam Okafor,
Karan Joshi, Meera Iyer, Lena Fischer.

### 2.5 Due-date phrases found (all resolved relative to the meeting date)

ISO (`2026-09-08`) · `10 Sep` · `Oct 3rd` · `15 October` · `Wed 16 Sep` · `Saturday 10 Oct` · `from 9 Oct` ·
`by Friday/Thu/Wed/Mon` · `by next Tuesday` · `by tomorrow` · `tomorrow` (bare) · `by EOD` · `by EOD tomorrow` ·
`end of month` · `end of next week` · `by mid-October`.
Not deadlines (must **not** become dates): `by 10%`, `for the last 6 months`, `for November`
(*schedule the QBR for November* — the review is in November, the action has no stated deadline),
`before cutover` (event-relative, no date).

### 2.6 Duplicates found (same commitment restated across meetings)

Example chain: `Priya to send the revised quote to Acme` appears 09-01 (open, by Fri), 09-08 as
`Priya N. … revised quote … — by Friday` (re-promised, different wording), 09-15 `[x]` (done).
Other chains: staging environment, cloud budget, wireframes, pagination bug, beta deploy ×3, welcome-email
copy ×3, SSO estimate, schema review, invoice export, freeze invoice edits, notify customers, CTO call, one-pager…
Near-misses that must **stay distinct**: `first wireframes` vs `updated wireframes`;
`collect 5 customer quotes` vs `publish the customer quotes`; `fix the pagination bug` vs `fix the top three critical bugs`;
same task text for **different** people (`Priya N.` vs `Priya S.`).

Derived truths we rely on:
* A re-mention with a **new** date replaces the old deadline (the deadline slipped).
* A re-mention **without** a date does not erase an earlier deadline (the commitment still stands).
* A later `[x]` closes the item; items first seen as `[x]` are ingested already done.

## 3. Decision register

| ID | Decision | Rationale |
|---|---|---|
| D1 | **Node ≥ 22.13, ES modules + JSDoc, zero npm dependencies.** `node:sqlite` for storage, `node:test` for tests, `util.parseArgs` for flags. | Python unavailable; Node 24 present. Built-ins give a real SQL database with no install step or native build, and nothing to supply-chain. |
| D2 | A note is **valid** iff it decodes as UTF-8 text and has a resolvable `Date`. Title and attendees are optional (warning). | Date is load-bearing; the rest is recoverable. Dropping 09-23's real items would reproduce the "items get lost" problem. |
| D3 | Item syntaxes: checkbox (`-`/`*`/`+`, any indent, `x`/`X`), `ACTION:` line, `Owner\|Action\|Due` table rows. Skipped regions: fenced code, HTML comments, blockquotes. Parsed anywhere in the note, not only under "Action items". | The offsite note scatters items across sections and notations. |
| D4 | Owner resolution: attendees first → global roster fallback → exactly one candidate resolves, more than one is `ambiguous`, zero is `external`. Qualifiers (`N.`, `Nair`) narrow candidates. **Never guess.** | A wrong guess emails the wrong person. An ambiguous item is surfaced to *both* candidates as "please confirm". |
| D5 | Date rules: `by <weekday>` = first such weekday **strictly after** the meeting date; `next <weekday>` = that weekday in the **following Mon–Sun week**; `end of (next) week` = that week's Friday; `mid-<month>` = the 15th; `EOD` = meeting day; yearless dates take the meeting's year, rolling forward if > 180 days in the past. | Deterministic, documented, testable. All arithmetic in UTC calendar days — no timezone drift. |
| D6 | Identity of an item = `(owner identity, normalised task)`. Normalisation: lower-case, strip punctuation and articles, collapse spaces, remove the due phrase. No fuzzy matching. | Fuzzy merging risks collapsing distinct commitments; exact-after-normalisation catches every real chain in the corpus. |
| D7 | Stored status is `open`/`done` only. `overdue` is derived from `due_date` and the clock. | Stored overdue goes stale. |
| D8 | Status from notes = state of the latest mention (by meeting date). A **manual** `done` is sticky across re-ingest. | Re-ingesting must never silently reopen work someone closed in the CLI. |
| D9 | Follow-up goes through a **`DraftSink`** with one method, `createDraft`. Sinks: `stdout` (preview), `file` (default; stages payloads for relay), `mcp` (CLI is an MCP stdio *client* for a configured Gmail MCP server). A hard guard refuses any tool whose name contains "send". The claude.ai connector is reached by Claude Code itself — `skills.md` documents that relay. | A CLI process cannot call a claude.ai connector. The abstraction makes "never sends" structural, not a promise. |
| D10 | Re-ingest is idempotent: every valid note is re-processed each run (so owner resolution never depends on ingest batching); items are upserted by dedupe key and **recomputed from occurrences**; item IDs are stable; the content hash only drives the reported new/changed/unchanged status. *(Revised during implementation: the original "skip unchanged files" idea could resolve an attendee-less note differently depending on when the roster grew.)* | Folders get re-ingested constantly. |
| D11 | Group/placeholder/ambiguous/external items are **not emailed directly** but are listed in an "unrouted" report (and ambiguous ones appear as "confirm" in candidates' emails). | An item everyone owns is owned by no one; broadcasting it is noise. |
| D12 | Ids are integers. `done` accepts several. Fresh ingest of the same corpus yields the same ids (deterministic sort by date, then filename). | Easy to type, stable enough. |

### Added after the manual audit (see `tasks.md` → T27)
Probing with deliberately messy notes found four gaps the sample corpus does not exercise: numbered checklists were dropped, `**bold**` owners lost their owner,
`José`-style names never parsed (ASCII-only pattern), and `next Monday` needed a preposition. All four are fixed with regression tests (FR-I6, I10, I15).

### Explicitly out of scope (documented, not forgotten)
* An `assign` command to hand-resolve ambiguous owners (would need re-ingest-safe overrides).
* Fuzzy/semantic duplicate detection; inferring completion from discussion prose.
* Sending email, ever. Reading the user's inbox.
* Removing items whose source file was later deleted (the DB is the record).
