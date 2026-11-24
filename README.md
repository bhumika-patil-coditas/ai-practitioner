# actiontrack

Turn a folder of markdown meeting notes into a tracked, de-duplicated list of action items — and draft (never send) follow-up emails.

* Zero npm dependencies · Node ≥ 22.13 · SQLite via `node:sqlite` · tests via `node:test`
* Built with Spec-Driven Development: [`specs/001-actiontrack/`](specs/001-actiontrack) (analysis → spec → plan → tasks)
* For Claude Code / agents: [`CLAUDE.md`](CLAUDE.md) and [`skills.md`](skills.md)

## Quick start

```bash
node bin/actiontrack.js ingest notes                     # parse the sample corpus
node bin/actiontrack.js list --status overdue            # what is late?
node bin/actiontrack.js list --owner "Rahul Verma"
node bin/actiontrack.js done 12                          # mark item #12 done
node bin/actiontrack.js followup "Karan Joshi" --dry-run # preview a follow-up email
node bin/actiontrack.js followup --all                   # stage one draft per owner
npm test                                                 # 313 tests
```
State lives in `./.actiontrack/actiontrack.db` (override with `--db` / `ACTIONTRACK_DB`). Add `--today 2026-10-15` to pin "today" (the sample notes are dated Sep–Oct 2026).
Optional config: copy `actiontrack.config.example.json` → `actiontrack.config.json` (owner emails, follow-up sink).

## Commands

| Command | What it does |
|---|---|
| `ingest <folder> [--strict]` | Recursively parses every `.md` note. Reports skipped notes (with reasons) and items that need attention. Idempotent. `--strict` → exit 3 if any note was skipped. |
| `list [--owner N] [--status open\|done\|overdue] [--due-before D] [--unassigned] [--json]` | Shows items. `overdue` is computed at read time (open and due strictly before today). `open`/`overdue`/`done` are mutually exclusive. |
| `done <id...>` | Marks items done. Sticky: re-ingesting never reopens them. |
| `followup <owner> \| --all [--sink file\|stdout\|mcp] [--dry-run] [--force]` | One plain-text email per owner covering overdue + open items. **Creates drafts only.** |

Exit codes: `0` ok · `1` runtime failure / not found · `2` usage error (incl. ambiguous `--owner`) · `3` `ingest --strict` skipped notes.

## How the edge cases are handled

| Edge case | Behaviour |
|---|---|
| **Duplicates across meetings** | Identity = (owner, normalised task). One item with N occurrences; status = latest mention; a new date replaces the deadline, an undated re-mention keeps it; later `[x]` closes it. Near-misses ("first" vs "updated" wireframes) stay separate — no fuzzy matching. |
| **No owner** | `Everyone/Team/TBD/Someone` or no recognisable owner → stored, shown under `list --unassigned`, listed in `followup --all` as "not emailed". |
| **No due date** | Stored with no date, never overdue, flagged at ingest, listed under "No due date" in emails. |
| **Same first name** (Priya Nair/Shah, Rahul Mehta/Verma) | Resolved via attendees, then initial (`Priya N.`) or last name. If still ambiguous it is **never guessed**: item is `ambiguous`, `--owner Priya` exits 2 naming both people, and both candidates get it under "PLEASE CONFIRM". |
| **Malformed notes** | Binary / empty / no date / impossible date → skipped and reported with a reason (and a filename hint); nothing is stored from them; the run continues. |
| **Traps in the notes** | Blockquoted "wishes", fenced code, HTML comments and non-`.md` files are never mined. `ACTION:` lines, tables and `*`/`+` bullets *are*. |
| **Relative dates** | Resolved against each meeting's date: `by Friday` = first Friday strictly after; `next Tuesday` = in the following week; `EOD`, `tomorrow`, `end of month`, `mid-October`, `Wed 16 Sep`, … `by 10%` and `for November` are not deadlines. |

## Architecture

```
bin → cli → commands → services → domain (pure)      db/repo.js is the only SQL      email/sinks = the only mail edge
```
See [`specs/001-actiontrack/plan.md`](specs/001-actiontrack/plan.md) for schema, algorithms and the test strategy.

## Gmail drafts — and the guarantee that nothing is sent

The only mail operation in the code base is `DraftSink.createDraft`. There is no SMTP and no send call. Three sinks:

* `file` (default) — stages `{to, subject, body}` JSON per owner for review/relay.
* `stdout` — preview only.
* `mcp` — the CLI acts as an MCP *client* for a Gmail MCP stdio server you configure; it refuses any tool whose name matches `/send/i` (tested, including a server that only offers `send_email`).

**The claude.ai Gmail connector is reached by Claude Code, not by the CLI process.** The documented flow (`skills.md`, Skill 4) is: `followup --json` stages
payloads → the agent calls the connector's `create_draft` with `{to, subject, body}` for each → you review and send from Gmail yourself.

> **Status of the live connector check:** during the build, the claude.ai Gmail connector reported "needs to be connected" when the first draft was relayed
> (two attempts), so **no live draft has been created yet**. Re-authorise the connector in your claude.ai settings and ask the agent to relay a draft.
> The CLI side — staging, the `mcp` sink protocol, and the never-send guard — is fully tested against a fake MCP server.

## Known limitations
* No `assign` command to hand-resolve ambiguous owners (they are surfaced, not fixed).
* No fuzzy duplicate detection; completion is never inferred from discussion prose (e.g. "customer quotes arrived" does not close "collect 5 customer quotes").
* Notes deleted from the folder keep their items. Date headers must be ISO, `D Month YYYY` or `Month D, YYYY` (optional weekday).
* On Windows the `mcp` sink spawns without a shell, so `command` must be a real executable (e.g. `node`), not a `.cmd` shim.
