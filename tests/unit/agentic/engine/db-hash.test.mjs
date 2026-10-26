// S2D-W2 · M1 engine-foundation 单测（TDD 先行：本文件即 db.mjs / hash.mjs 的实现契约）
// 依据：BUILD-PLAN §3 W2-1 前置（L103）、§2.3 L60（先测后码、覆盖率 ≥80%）；
//       .s2d/plan.md M1 subtasks 1–3；hash 语义对齐 BUILD-PLAN W0-4 L91
//       「字段顺序不同 hash 相同、任一字段变化 hash 变化」与 PRD §8.1 L597
//       「规范化 JSON 的 SHA-256」。
//
// 被测契约：
//   scripts/agentic/engine/hash.mjs
//     canonicalJson(obj) → 稳定字符串（key 递归字典序，数组保序）
//     sha256Hex(str) → 64 位小写 hex
//     contractHash(contract) / stepInputHash(input) → canonicalJson+sha256Hex
//   scripts/agentic/engine/db.mjs
//     openEngineDb({memory:true}) 或 openEngineDb({file}) → node:sqlite
//       DatabaseSync 兼容句柄（exec/prepare/close），foreign_keys 强制开启
//     applyEngineMigrations(db, dir) → 按**文件名排序**执行 dir 下 engine-*.sql，
//       可重复调用（幂等 SQL + 已执行记账），返回本轮应用的文件名数组
import assert from 'node:assert/strict';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { test } from 'node:test';
import { createHash } from 'node:crypto';
import { MIGRATIONS_DIR, makeSqlFixtureDir, tempDir } from './helpers.mjs';
import { canonicalJson, sha256Hex, contractHash, stepInputHash } from '../../../../scripts/agentic/engine/hash.mjs';
import { openEngineDb, applyEngineMigrations } from '../../../../scripts/agentic/engine/db.mjs';

test('canonicalJson sorts keys recursively and ignores key order', () => {
  const a = { b: 1, a: { d: 2, c: [3, { z: 4, y: 5 }] } };
  const b = { a: { c: [3, { y: 5, z: 4 }], d: 2 }, b: 1 };
  assert.equal(canonicalJson(a), canonicalJson(b));
  assert.equal(canonicalJson(a), '{"a":{"c":[3,{"y":5,"z":4}],"d":2},"b":1}');
});

test('canonicalJson preserves array order (order is semantic)', () => {
  assert.notEqual(canonicalJson({ list: [1, 2] }), canonicalJson({ list: [2, 1] }));
});

test('sha256Hex produces the known SHA-256 digest', () => {
  assert.equal(sha256Hex('abc'), createHash('sha256').update('abc').digest('hex'));
  assert.match(sha256Hex('x'), /^[0-9a-f]{64}$/);
});

test('contractHash: same fields different order → same hash; any change → different hash', () => {
  const base = () => ({
    id: 'c_1', missionId: 'm_1', version: 1,
    goal: '整理课程设计', autonomy: 'A2',
    will: ['检索公开资料'], wont: ['不付款'],
    budget: { modelCalls: 40, tokens: 1000, costCap: null, localSlots: 1 },
    window: { prepStart: '2026-10-26T08:00:00+08:00', start: '2026-10-26T09:00:00+08:00', end: '2026-10-26T12:00:00+08:00', overrun: 'deliver_best' },
  });
  const first = contractHash(base());
  const reordered = base();
  reordered.budget = { tokens: 1000, modelCalls: 40, localSlots: 1, costCap: null };
  assert.equal(first, contractHash(reordered), '字段顺序不同 hash 必须相同（BUILD-PLAN W0-4 语义）');
  const mutated = base(); mutated.goal = '整理课程设计 v2';
  assert.notEqual(first, contractHash(mutated), '任一字段值变化 hash 必须变化');
  const removed = base(); delete removed.wont;
  assert.notEqual(first, contractHash(removed), '删除字段 hash 必须变化');
  assert.match(first, /^[0-9a-f]{64}$/);
});

test('stepInputHash shares the same canonical semantics', () => {
  assert.equal(stepInputHash({ a: 1, b: [2, 3] }), stepInputHash({ b: [2, 3], a: 1 }));
  assert.notEqual(stepInputHash({ a: 1 }), stepInputHash({ a: 2 }));
});

test('openEngineDb({memory:true}) yields a DatabaseSync-compatible handle with foreign_keys ON', () => {
  const db = openEngineDb({ memory: true });
  assert.equal(typeof db.exec, 'function');
  assert.equal(typeof db.prepare, 'function');
  db.exec('CREATE TABLE probe(k TEXT)');
  db.prepare('INSERT INTO probe(k) VALUES (?)').run('v');
  assert.equal(db.prepare('SELECT k FROM probe').get().k, 'v');
  assert.equal(db.prepare('PRAGMA foreign_keys').get().foreign_keys, 1, '外键必须强制开启');
  db.close();
});

test('openEngineDb({file}) creates a persistent database file', () => {
  const dir = tempDir();
  const file = join(dir, 'engine.sqlite');
  const db = openEngineDb({ file });
  db.exec('CREATE TABLE keep(v TEXT)');
  db.prepare('INSERT INTO keep(v) VALUES (?)').run('persisted');
  db.close();
  assert.equal(existsSync(file), true, '文件库必须落盘');
  const reopened = openEngineDb({ file });
  assert.equal(reopened.prepare('SELECT v FROM keep').get().v, 'persisted');
  reopened.close();
  rmSync(dir, { recursive: true, force: true });
});

test('applyEngineMigrations executes engine-*.sql in filename order and is repeatable', () => {
  const dir = makeSqlFixtureDir({
    // 故意以非字母序提供：002 依赖 001 的表，若未按文件名排序必然失败
    'engine-902-dep.sql': 'INSERT OR IGNORE INTO base(k) VALUES (\'applied-after-901\');',
    'engine-901-base.sql': 'CREATE TABLE IF NOT EXISTS base(k TEXT);',
    'ignored.txt': 'not sql',
  });
  const db = openEngineDb({ memory: true });
  const applied = applyEngineMigrations(db, dir);
  assert.deepEqual(applied, ['engine-901-base.sql', 'engine-902-dep.sql'], '只收 engine-*.sql 且按文件名排序');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM base').get().n, 1);
  const again = applyEngineMigrations(db, dir);
  assert.deepEqual(again, [], '重复调用不重放已执行迁移');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM base').get().n, 1, '幂等：不产生重复行');
  db.close();
});

test('applyEngineMigrations is idempotent against the shipped engine migrations', () => {
  // 依赖真实迁移目录（engine-001..004）；M2–M5 各自断言自己的表，这里只验证可重复应用
  const db = openEngineDb({ memory: true });
  applyEngineMigrations(db, MIGRATIONS_DIR);
  applyEngineMigrations(db, MIGRATIONS_DIR);
  db.close();
});
