// S2D-W13 · migration 排序/幂等门禁测试（合入链 M01–M12 每步必跑的固定检查，
// 此处固化为可重复单测）。
//
// 依据：plan.md G1 门禁包「migrations 目录排序快照、同 db 双跑 migrate() 幂等
// （applied=[]）」、0.2 节迁移盘点（17 文件、字典序、W6 preview-001/002 裸
// CREATE 靠 _migrations 台账保幂等、双台账围栏——组合根只走 W0 migrate 单台账）。
//
// 当前状态（W0 基线 60fdc73）：scripts/agentic/db/migrations/ 目录尚不存在
// （plan.md 0.2 实测）→ 本文件 RED（ENOENT）；M01 合入 W2 后目录出现，随合入
// 链逐步转 GREEN。W0 的 migrate() 实现已在 scripts/agentic/db/index.mjs 冻结。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { migrate, openAgenticDb } from '../../../../scripts/agentic/db/index.mjs';

const migrationsDir = fileURLToPath(new URL('../../../../scripts/agentic/db/migrations/', import.meta.url));

function sqlFiles() {
  return readdirSync(migrationsDir, { withFileTypes: true })
    .filter(entry => entry.isFile() && entry.name.endsWith('.sql'))
    .map(entry => entry.name)
    .sort();
}

test('the merged migrations directory exists and holds only non-empty .sql files', () => {
  const names = sqlFiles();
  assert.ok(names.length >= 1, 'after the merge chain the directory must contain flow migrations');
  for (const name of names) {
    const path = join(migrationsDir, name);
    assert.equal(statSync(path).size > 0, true, `${name} must not be empty`);
    assert.equal(name.endsWith('.sql'), true);
  }
});

test('migrate() applies every pending file in lexical order on a fresh db', () => {
  const db = openAgenticDb(':memory:');
  const applied = migrate(db, migrationsDir);
  assert.deepEqual(applied, sqlFiles(), 'applied order must equal lexical filename order');
  const ledger = db.prepare('SELECT name FROM _migrations ORDER BY rowid').all().map(row => row.name);
  assert.deepEqual(ledger, sqlFiles(), 'ledger row order must follow apply order');
});

test('migrate() is idempotent: a second run on the same db applies nothing', () => {
  const db = openAgenticDb(':memory:');
  const first = migrate(db, migrationsDir);
  assert.ok(first.length >= 1);
  const second = migrate(db, migrationsDir);
  assert.deepEqual(second, [], 'second run must apply zero migrations');
  const ledger = db.prepare('SELECT name FROM _migrations').all().map(row => row.name).sort();
  assert.deepEqual(ledger, sqlFiles());
});

test('the ledger contains exactly the migration files — no strays, no gaps', () => {
  const db = openAgenticDb(':memory:');
  migrate(db, migrationsDir);
  const ledger = db.prepare('SELECT name FROM _migrations').all().map(row => row.name).sort();
  assert.deepEqual(ledger, sqlFiles());
});

test('no two migrations declare the same table or index name (add/add collision guard)', () => {
  const seen = new Map();
  const ddl = /\bCREATE\s+(?:TEMP(?:RARY)?\s+)?(?:TABLE|UNIQUE\s+INDEX|INDEX)\s+(?:IF\s+NOT\s+EXISTS\s+)?["'`]?([A-Za-z_][A-Za-z0-9_]*)["'`]?/gi;
  for (const name of sqlFiles()) {
    const sql = readFileSync(join(migrationsDir, name), 'utf8');
    for (const match of sql.matchAll(ddl)) {
      const objectName = match[1].toLowerCase();
      if (objectName.startsWith('sqlite_')) continue;
      const earlier = seen.get(objectName);
      assert.equal(earlier, undefined, `${name} re-declares ${objectName} already declared by ${earlier ?? '?'}`);
      seen.set(objectName, name);
    }
  }
});

test('every migration lands in the single W0 _migrations ledger, not a per-flow second ledger', () => {
  const db = openAgenticDb(':memory:');
  migrate(db, migrationsDir);
  const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map(row => row.name);
  const flowLedgers = tables.filter(name => /^_/.test(name) && name !== '_migrations');
  assert.deepEqual(flowLedgers, [], 'composition root must use the single W0 migrate() ledger only');
});
