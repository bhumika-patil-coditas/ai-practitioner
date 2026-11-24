// Ordered, forward-only schema migrations. The applied version is stored in `PRAGMA user_version` (FR-G4).
import { StorageError } from '../errors.js';

/** @type {{version: number, sql: string}[]} */
export const MIGRATIONS = [
  {
    version: 1,
    sql: `
      CREATE TABLE meetings (
        id            INTEGER PRIMARY KEY,
        path          TEXT NOT NULL UNIQUE,
        filename      TEXT NOT NULL,
        title         TEXT NOT NULL,
        meeting_date  TEXT NOT NULL,
        attendees     TEXT NOT NULL DEFAULT '[]',
        content_hash  TEXT NOT NULL,
        ingested_at   TEXT NOT NULL
      );

      CREATE TABLE people (
        id          INTEGER PRIMARY KEY,
        full_name   TEXT NOT NULL UNIQUE,
        first_name  TEXT NOT NULL,
        last_name   TEXT NOT NULL DEFAULT '',
        email       TEXT
      );
      CREATE INDEX idx_people_first ON people(first_name COLLATE NOCASE);

      CREATE TABLE items (
        id               INTEGER PRIMARY KEY,
        dedupe_key       TEXT NOT NULL UNIQUE,
        owner_kind       TEXT NOT NULL CHECK (owner_kind IN ('person','ambiguous','external','group','none')),
        owner_id         INTEGER REFERENCES people(id),
        owner_label      TEXT,
        owner_candidates TEXT NOT NULL DEFAULT '[]',
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
        task        TEXT NOT NULL,
        raw_text    TEXT NOT NULL,
        due_date    TEXT,
        UNIQUE (meeting_id, line_no, item_id)
      );
      CREATE INDEX idx_occ_item    ON occurrences(item_id);
      CREATE INDEX idx_occ_meeting ON occurrences(meeting_id);

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
      CREATE INDEX idx_drafts_person ON followup_drafts(person_id, itemset_hash);
    `,
  },
];

export const LATEST_VERSION = MIGRATIONS.at(-1).version;

/** @param {import('node:sqlite').DatabaseSync} db */
export function migrate(db) {
  const current = /** @type {{user_version: number}} */ (db.prepare('PRAGMA user_version').get()).user_version;
  if (current > LATEST_VERSION) {
    throw new StorageError(`database schema v${current} is newer than this tool understands (v${LATEST_VERSION}); upgrade actiontrack`);
  }
  for (const m of MIGRATIONS.filter((x) => x.version > current)) {
    db.exec('BEGIN');
    try {
      db.exec(m.sql);
      db.exec(`PRAGMA user_version = ${m.version}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw new StorageError(`migration to v${m.version} failed: ${err.message}`);
    }
  }
}
