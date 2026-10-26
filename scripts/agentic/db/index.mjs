import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

/**
 * Open the dedicated Agentic SQLite database.
 *
 * Persistent Agentic tables are expected to carry the server-derived
 * `owner_id` column; this module deliberately does not infer ownership from
 * request data or add a hidden default owner.
 */
function plainRow(row) {
  if (row === null || typeof row !== 'object' || Array.isArray(row)) return row;
  return Object.fromEntries(Object.entries(row));
}

function wrapStatement(statement) {
  return new Proxy(statement, {
    get(target, property, receiver) {
      if (property === 'get') {
        return (...args) => plainRow(target.get(...args));
      }
      if (property === 'all') {
        return (...args) => target.all(...args).map(plainRow);
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

function wrapDatabase(db) {
  return new Proxy(db, {
    get(target, property, receiver) {
      if (property === 'prepare') {
        return (...args) => wrapStatement(target.prepare(...args));
      }
      const value = Reflect.get(target, property, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}

export function openAgenticDb(file = ':memory:') {
  const target = file || ':memory:';
  if (target !== ':memory:') {
    const absolute = resolve(target);
    mkdirSync(dirname(absolute), { recursive: true });
    const db = new DatabaseSync(absolute);
    db.exec('PRAGMA foreign_keys = ON;');
    db.exec('PRAGMA journal_mode = WAL;');
    return wrapDatabase(db);
  }

  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON;');
  return wrapDatabase(db);
}

/**
 * Apply pending SQL migrations in lexical filename order.
 *
 * Each migration is its own transaction so a failed migration cannot leave
 * partial schema changes or an entry in the ledger. Migration names are the
 * filenames, making the ledger stable and reruns idempotent.
 */
export function migrate(db, dir) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS _migrations (
      name TEXT PRIMARY KEY,
      applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )
  `);

  const names = readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.sql'))
    .map(entry => entry.name)
    .sort();
  const applied = [];
  const hasApplied = db.prepare('SELECT 1 AS found FROM _migrations WHERE name = ?');
  const record = db.prepare('INSERT INTO _migrations (name) VALUES (?)');

  for (const name of names) {
    if (hasApplied.get(name)) continue;
    const sql = readFileSync(resolve(dir, name), 'utf8');
    db.exec('BEGIN');
    try {
      if (sql.trim()) db.exec(sql);
      record.run(name);
      db.exec('COMMIT');
      applied.push(name);
    } catch (error) {
      try {
        db.exec('ROLLBACK');
      } catch {
        // Preserve the migration error if rollback itself is unavailable.
      }
      throw error;
    }
  }
  return applied;
}
