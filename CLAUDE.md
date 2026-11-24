 # CLAUDE.md — actiontrack

Guidance for Claude Code (and humans) working in this repository.

## What this is
`actiontrack` — a zero-dependency Node CLI that ingests markdown meeting notes into SQLite, tracks action items,
and drafts (never sends) per-owner follow-up emails. Built with **Spec-Driven Development**.

## Source of truth: the specs
Read in this order before changing behaviour:
1. `specs/001-actiontrack/analysis.md` — corpus findings and decision register (D1–D12)
2. `specs/001-actiontrack/spec.md` — numbered requirements (`FR-*`, `NFR-*`) and acceptance scenarios
3. `specs/001-actiontrack/plan.md` — architecture, schema, algorithms, test strategy
4. `specs/001-actiontrack/tasks.md` — ordered tasks (tick boxes honestly)

**Workflow for any change:** update `spec.md` first (new/changed `FR-*`) → adjust `plan.md` if design changes → add a failing test → implement →
`npm test`. Do not change behaviour that the spec does not describe without updating the spec in the same change.

## Commands
```
npm test                       # node --test (unit + integration + e2e)
npm run coverage               # with experimental coverage
node bin/actiontrack.js ingest notes
node bin/actiontrack.js list --status overdue --today 2026-10-15
node bin/actiontrack.js done 12
node bin/actiontrack.js followup "Karan Joshi" --sink stdout
```
Requires Node ≥ 22.13 (developed on 24). **No npm dependencies — do not add any** without an explicit decision recorded in `analysis.md`.

## Architecture rules
* Layers point downward: `cli → commands → services → domain` and `services → db`. `domain/` is **pure**: no `fs`, no SQL, no `Date.now()`/`new Date()` without arguments.
* SQL lives only in `src/db/repo.js`. Commands contain no business rules.
* "Now" comes only from `context.clock` (`--today` / `ACTIONTRACK_TODAY`). Tests must pass a fixed date.
* Parsers return `{ok:false, reason}`; they do not throw on bad input. `IngestService` also wraps each file in try/catch.
* Dates are `YYYY-MM-DD` strings handled with UTC arithmetic. Never use local-time `Date` getters.

## Hard safety rules (do not relax)
1. **Never send email.** The only mail operation is `DraftSink.createDraft`. Do not add SMTP, `send`, `messages.send`, or any tool whose name matches `/send/i`.
   The MCP sink refuses send-like tools by design (FR-F5); keep the negative test green.
2. **Never guess an owner.** Same-first-name collisions stay `ambiguous` (D4). Do not "pick the likelier Priya".
3. **Never invent email addresses.** Recipients come only from config; missing ⇒ empty *To* + warning.
4. Ingest must never crash or alter data because of one bad note (FR-I2).
5. Do not run the live Gmail connector against anyone but the user's own mailbox, and only to create drafts.

## Conventions
* ESM, JSDoc types, 2-space indent, single quotes, semicolons, `node:` import prefix.
* File names kebab-case; one concept per module; exports are named, not default.
* Tests mirror source layout under `tests/unit` and `tests/integration`; use `node:test` + `node:assert/strict`; no network, no real Gmail, no touching `~`.
* Error → exit code mapping happens only in `src/cli.js` (`UsageError`=2, others=1, `--strict` skip=3).

## Data & fixtures
* `notes/` is the sample corpus (35 files incl. deliberately malformed: `scratch.md`, `untitled.md`, `2026-10-03-sales-pipeline.md`; the `.txt` is intentionally ignored).
  **Treat it as read-only test data**; golden expectations in `acceptance.test.js` depend on it.
* Runtime state lives in `.actiontrack/` (git-ignored): `actiontrack.db`, `drafts/`.

## Known limitations (see analysis §"Out of scope")
No `assign` command; no fuzzy duplicate detection; no completion inference from prose; deleted source notes keep their items.

## Related
`skills.md` — how an agent drives this CLI and relays follow-up drafts to the Gmail connector.
