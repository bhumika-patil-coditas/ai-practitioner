// Opens (and creates) the SQLite database. The only module that imports `node:sqlite`.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { StorageError } from '../errors.js';
import { migrate } from './migrations.js';
import { Repository } from './repo.js';

/**
 * @param {string} dbPath file path, or ':memory:'
 * @returns {Repository}
 */
export function openRepository(dbPath) {
  try {
    if (dbPath !== ':memory:') fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
    const db = new DatabaseSync(dbPath);
    db.exec('PRAGMA foreign_keys = ON');
    db.exec('PRAGMA busy_timeout = 3000');
    migrate(db);
    return new Repository(db);
  } catch (err) {
    if (err instanceof StorageError) throw err;
    throw new StorageError(`cannot open database "${dbPath}": ${err.message}`);
  }
}
