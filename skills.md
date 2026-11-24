# skills.md — what an agent can do with actiontrack

Capabilities for Claude Code (or any agent) working with this repo. Each skill lists **when to use it**, **exact steps**, and **guardrails**.
Read `CLAUDE.md` first; the safety rules there apply to every skill below.

---

## Skill 1 — Ingest meeting notes
**Use when:** the user points at a folder of `.md` meeting notes, or says notes were added/changed.

```bash
node bin/actiontrack.js ingest <folder> [--json] [--strict]
```
1. Run it; it is safe to repeat (idempotent, ids are stable).
2. Read the report and **surface three things to the user**, never bury them:
   * **Skipped notes** (reason codes `not-text`, `empty`, `missing-date`, `invalid-date`) — offer to help fix the file (e.g. an invalid date with a filename hint).
   * **Ambiguous owners** ("Priya could be Priya Nair or Priya Shah") — these need a human decision; do **not** pick one.
   * **No individual owner** (Everyone / Team / TBD / Someone).
3. `--strict` makes exit code `3` mean "some notes were skipped" (useful in scripts).

## Skill 2 — Answer "what's open / overdue / due soon?"
**Use when:** the user asks about status, workload, or deadlines.

```bash
node bin/actiontrack.js list --status overdue --json
node bin/actiontrack.js list --owner "Rahul Verma" --status open
node bin/actiontrack.js list --due-before friday
node bin/actiontrack.js list --unassigned
```
* `--status` values are mutually exclusive: `open` (not done, not past due, includes undated), `overdue`, `done`.
* Pass `--today YYYY-MM-DD` when the question is about a specific date; otherwise the system date is used.
* `--owner Priya` / `--owner Rahul` **fails with exit 2** because two people share the name — ask the user which one, or use `"Priya Nair"` / `"Priya N."`.
* Prefer `--json` when you will reason over results; use the table when showing the user.

## Skill 3 — Mark work done
```bash
node bin/actiontrack.js done 12 15 21
```
Only after the **user** says the item is done (never infer completion from prose). Manual completions are sticky — re-ingesting notes will not reopen them.

## Skill 4 — Draft follow-up emails (drafts only — NEVER send)
**Use when:** the user wants reminders sent to owners. Interpret this as "create drafts for review".

### 4a. Stage payloads with the CLI
```bash
node bin/actiontrack.js followup "Karan Joshi" --json        # one owner
node bin/actiontrack.js followup --all --json                 # everyone + "unrouted" report
node bin/actiontrack.js followup "Karan Joshi" --dry-run      # preview text only
```
Default sink `file` writes `<draftsDir>/<run>/<owner>.json` containing `{ "to": [...], "subject": "...", "body": "..." }` and returns its path in
`drafts[].location`. Re-running the same item set is skipped (`skipped-duplicate`); use `--force` only if the user asks.

### 4b. Relay each staged payload to the Gmail connector — `create_draft` only
For every draft with `status: "staged"`:

1. Read the payload file at `location` (do not retype or "improve" the text).
2. Call the connector's **`create_draft`** tool (in Claude Code: `mcp__claude_ai_Gmail__create_draft`) with exactly:

   | argument | value |
   |---|---|
   | `to` | the payload's `to` array — **may be empty** (no address is configured); never invent one |
   | `subject` | payload `subject` |
   | `body` | payload `body` (plain text — do **not** convert to Markdown) |

3. Report the returned draft `viewUrl`/`id` to the user. Tell them about any `missing-recipient` warning so they add the address before sending.
4. Offer the **unrouted report** (items with no single owner) so a human can assign them.

### Guardrails (non-negotiable)
* **Allowed Gmail tools: `create_draft` only** (plus read-only `get_draft` / `list_drafts` to verify what you created).
  **Never** call any tool whose name contains "send", and never send a draft — the user reviews and sends from Gmail.
* Create drafts only in the **user's own** mailbox, only for what they asked, and **ask before creating many** (`--all` can be ~10 drafts).
* Do not add recipients that are not in the config. Do not CC/BCC anyone.
* If the Gmail connector says it needs to be connected, stop and tell the user to authorise it in their claude.ai connector settings — do not work around it.
* The CLI itself also has an `mcp` sink (`--sink mcp`) for a standalone Gmail MCP server configured in `actiontrack.config.json`; it refuses any send-like
  tool by construction. That path does **not** use the claude.ai connector.

## Skill 5 — Work on the codebase the SDD way
**Use when:** changing behaviour.
1. Find the requirement in `specs/001-actiontrack/spec.md` (`FR-*`). If it does not exist, **write it first**.
2. Update `plan.md` if the design changes; add/adjust tasks in `tasks.md`.
3. Write the failing test, then the code. Run `npm test` (expect all green) and `npm run coverage` for gaps.
4. Never touch `notes/` (golden fixtures). Never commit `.actiontrack/`.

## Quick reference
| Need | Command |
|---|---|
| Everything overdue as of a date | `list --status overdue --today <date>` |
| Who owns the unowned? | `list --unassigned` |
| Preview an email | `followup <owner> --dry-run` |
| Machine-readable anything | add `--json` |
| Exit codes | `0` ok · `1` runtime/not found/sink failure · `2` usage (incl. ambiguous owner) · `3` `--strict` skipped notes |
