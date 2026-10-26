// S2D-W2 引擎基础：SQLite 句柄与本流迁移自举器。
// 依据：BUILD-PLAN §2.1（迁移按文件名排序、W0 到位前各流自举）。
import { readdirSync, readFileSync, mkdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export function openEngineDb({ file, memory = false } = {}) {
  const target = memory || !file ? ':memory:' : resolve(file);
  if (target !== ':memory:') mkdirSync(dirname(target), { recursive: true });
  const db = new DatabaseSync(target);
  db.exec('PRAGMA foreign_keys = ON');
  if (target !== ':memory:') {
    try { db.exec('PRAGMA journal_mode = WAL'); } catch { /* 某些 SQLite 构建不支持 WAL，保持可用 */ }
  }
  return db;
}

export function applyEngineMigrations(db, dir) {
  db.exec('CREATE TABLE IF NOT EXISTS _engine_migrations (name TEXT PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP)');
  const names = readdirSync(dir, { withFileTypes: true })
    .filter(entry => entry.isFile() && /^engine-.*\.sql$/.test(entry.name))
    .map(entry => entry.name).sort();
  const applied = [];
  const has = db.prepare('SELECT 1 AS found FROM _engine_migrations WHERE name = ?');
  const mark = db.prepare('INSERT INTO _engine_migrations(name) VALUES (?)');
  for (const name of names) {
    if (has.get(name)) continue;
    const sql = readFileSync(resolve(dir, name), 'utf8');
    db.exec('BEGIN');
    try {
      if (sql.trim()) db.exec(sql);
      mark.run(name);
      db.exec('COMMIT');
      applied.push(name);
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch { /* preserve original migration failure */ }
      throw error;
    }
  }
  return applied;
}
