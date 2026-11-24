# Phase 4 — Task breakdown

Rule: each task lists its **requirements**, **deliverable**, and **done-when**. Tests are written with (or before) the code they cover.
`[P]` = can be done in parallel with its siblings. Check a box only when its done-when is true and `npm test` is green.

## M0 — Foundations
- [x] **T00** Scaffold: `package.json` (bin, scripts, engines, no deps), `.gitignore`, `.editorconfig`, `bin/actiontrack.js` shim, `tests/helpers.js`. *Done when:* `node bin/actiontrack.js --help` runs. · NFR-1
- [x] **T01** `errors.js`, `clock.js`, `context.js`, `cli.js` skeleton + dispatcher + help/version + exit-code mapping. · FR-G1, G2, G3

## M1 — Pure domain (no I/O)  — all `[P]` after T00
- [x] **T02** `dates.js`: ISO/day arithmetic, `parseAbsoluteDate`, `extractDue`, phrase resolution + **`dates.test.js`** (every phrase in analysis §2.5, negatives `by 10%`, `for November`, `before cutover`, invalid `2026-02-30`, year rollover, "strictly after" rule, weekday-mismatch). · FR-I4, I15–I19
- [x] **T03** `frontmatter.js` + test (inline list, block list, quoted values, no front matter). · FR-I4
- [x] **T04** `markdown-scan.js` + test (fences incl. `~~~` and nested lengths, single/multi-line HTML comments, blockquotes, unclosed fence). · FR-I7
- [x] **T05** `action-lines.js` + test (all 3 bullet markers, `x`/`X`, indent, no-space-after-`]`, `ACTION:`, table incl. empty Due/`—`, not-a-table pipes). · FR-I6, I8
- [x] **T06** `owner.js` + `roster.js` + test (first name, `Priya N.`, `@anita:`, `A & B`, `(with X)`, group/placeholder words, no-owner, `will`/`:` delimiters, ambiguous/external, accent folding, roster fallback). · FR-I10–I14
- [x] **T07** `normalize.js` + test (articles, punctuation, apostrophes, corpus duplicate pairs equal; near-misses unequal). · FR-I20, I23
- [x] **T08** `status.js` + test (due today ≠ overdue; no date never overdue). · FR-L2
- [x] **T09** `note-parser.js` + **`note-parser.test.js`** (header formats, CRLF/BOM, binary, empty, missing/invalid date, hint, missing title/attendees warnings, weekday mismatch warning, trap fixtures). Depends T02–T05. · FR-I1–I9

## M2 — Storage
- [x] **T10** `db/migrations.js`, `db/open.js` (pragmas, `user_version`, directory creation). · FR-G4, §4
- [x] **T11** `db/repo.js` — people upsert, meetings, occurrences, item upsert, `recomputeItems`, queries (`listItems` with SQL filters, `findPeople`, `getItems`), `markDone`, drafts table methods + **`repo.test.js`** (constraints, recompute rules: slipped deadline replaces, undated re-mention keeps, later `[x]` closes, manual-done sticky, orphan deletion). Depends T10. · FR-I22, I24, D1, §7

## M3 — Ingest
- [x] **T12** `services/ingest-service.js`: folder scan, two-pass roster, resolve, persist, hash skip, per-file try/catch, report object. Depends T09, T11. · FR-I2, I14, I21, I25–I27
- [x] **T13** `commands/ingest.js` + `format/report.js` (text + `--json`, `--strict`). Depends T12.
- [x] **T14** *(deviation: generated mini folders via `tests/helpers.js` instead of a static `mini-notes/` directory)* **`ingest.integration.test.js`** (idempotency, changed file replaces occurrences, same-name people, bad file doesn't poison run, within-note dedupe, joint owners).

## M4 — Read/update commands
- [x] **T15** `format/table.js`; `commands/list.js` (filters, owner resolution/ambiguity error, `--due-before` phrases, `--unassigned`, `--json`) + tests in **`unit/repo.test.js`** and **`integration/commands.test.js`**. Depends T11. · FR-L1–L7
- [x] **T16** `commands/done.js` + tests in **`integration/commands.test.js`**. · FR-D1–D3

## M5 — Follow-up
- [x] **T17** `email/compose.js` + **`compose.test.js`** (golden text; sections; overdue day counts; sentence case; missing recipient warning; plain text only). · FR-F3, F4
- [x] **T18** `email/sinks/{stdout,file,index}.js`; `email/mcp-client.js` + `sinks/mcp.js`; `tests/fixtures/fake-mcp-server.mjs`; **`sinks.test.js`** incl. the negative "send tool is refused and `tools/call` never issued" case, timeout, spawn failure. · FR-F5, F6
- [x] **T19** `services/followup-service.js` + `commands/followup.js`: owner resolution, selection (+ambiguous "confirm" items), duplicate guard, `--force`, `--all`, unrouted report, per-owner failure isolation + tests in **`integration/commands.test.js`**. Depends T11, T17, T18. · FR-F1, F2, F7, F8
- [x] **T20** `config.js` loader/validator + `actiontrack.config.example.json` + test. · §5

## M6 — Verification against the real corpus
- [x] **T21** `tests/integration/acceptance.test.js` — scenarios A1–A10 on `notes/`, plus per-person golden expectations (the Priya/Rahul cases, the revised-quote chain, refund item has **no** due date, no hardware-token item). · spec §9
- [x] **T22** `cli.e2e.test.js` — spawn the real binary: exit codes 0/1/2/3, `--json` parses, stderr format, `--today`, no ANSI when piped. · FR-G1–G5
- [x] **T23** Run full suite + coverage; fix defects found (each with a regression test first); manual smoke of all four commands on `notes/`.

## M7 — Docs & hand-off
- [x] **T24** `README.md` (install, usage, design notes, limitations), `CLAUDE.md`, `skills.md` finalised against the built behaviour.
- [ ] **T25** ⛔ BLOCKED — Live Gmail check through the connector: create **one** draft (no recipient) from `file`-sink output; confirm via `get_draft`; **no send tool is used**. *Status:* the payload was staged (`followup "Karan Joshi" --json`) and `create_draft` was called twice; the claude.ai Gmail connector answered "needs to be connected in claude.ai" both times (non-interactive session cannot run OAuth). **No draft was created.** Re-authorise the connector, then relay per `skills.md` Skill 4. The CLI-side contract is covered by tests (T18/T19).
- [x] **T27** Manual audit against the brief + messy-notes probe; fix what it finds, each with a regression test: numbered checklists, emphasis-wrapped owners, Unicode names, bare `next <weekday>`, empty-folder hint, plural grammar, collapsed no-recipient warning. Re-verified end-to-end in PowerShell.
- [x] **T26** Final consistency pass: spec ↔ code ↔ tests (update traceability in `plan.md` §9 if file names changed); tick all boxes honestly.

---
## Status (end of implementation)
* **M0–M6, M7 except T25: done.** 308 tests pass; line coverage 99.4 %, branch 93 % (`npm run coverage`).
* **T25 blocked on external authorisation**, not on code.
* Deviations from the plan (each recorded in the spec/plan/analysis): every valid note is re-processed per run (FR-I25 / D10); `occurrences.task` column added;
  unknown `followup` owner exits 1; `--strict` and `--unassigned` flags added; test files consolidated (see plan §7, §9).
