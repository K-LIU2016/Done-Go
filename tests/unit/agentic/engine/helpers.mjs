// S2D-W2 引擎 · 测试共享夹具（非测试文件，不被收集）
// 依据：BUILD-PLAN §3 W2（L103–110）、.s2d/plan.md M1 subtask 4。
// 时间约定：所有 now() 均返回带 +08:00 的 ISO 字符串（PRD §4 L162「时间对象带 IANA 时区」，
// 中国无夏令时，固定偏移即可——模式同 scripts/voice-pipeline/gateway.mjs shanghaiNow()，
// 自写 10 行，不跨目录 import 语音管线，plan.md §0 风格基准）。
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openEngineDb, applyEngineMigrations } from '../../../../scripts/agentic/engine/db.mjs';

export const WORKTREE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', '..', '..');
export const MIGRATIONS_DIR = join(WORKTREE_ROOT, 'scripts', 'agentic', 'db', 'migrations');

/** 固定 +08:00 的 ISO（无 DST，Asia/Shanghai 合法近似）。 */
export function shanghaiIso(epochMs) {
  return new Date(epochMs + 8 * 3600_000).toISOString().slice(0, 19) + '+08:00';
}

/** 可注入时钟：now() 返回 +08:00 ISO；advance(nSec) 前进并返回新时刻。 */
export function fakeClock(startIso = '2026-10-26T09:00:00+08:00', stepSec = 60) {
  let currentMs = Date.parse(startIso);
  return {
    now: () => shanghaiIso(currentMs),
    advance: (nSec = stepSec) => { currentMs += nSec * 1000; return shanghaiIso(currentMs); },
    set: (iso) => { currentMs = Date.parse(iso); return shanghaiIso(currentMs); },
    epochMs: () => currentMs,
  };
}

/** 零等待 sleeper：记录退避序列（plan.md M3 subtask 5「注入 sleep，测试零等待」）。 */
export function fakeSleeper() {
  const delays = [];
  return { delays, sleep: async (ms) => { delays.push(ms); } };
}

/** 内存库 + 全量 engine 迁移（plan.md §0：W0 迁移运行器未到位前自举，L48）。 */
export function makeDb() {
  const db = openEngineDb({ memory: true });
  applyEngineMigrations(db, MIGRATIONS_DIR);
  return db;
}

/** 临时目录（崩溃恢复等需要文件库的场景）。 */
export function tempDir(prefix = 's2d-engine-') {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** 一次性 SQL 迁移夹具目录（db-hash.test.mjs 用来测迁移运行器本身）。 */
export function makeSqlFixtureDir(files) {
  const dir = mkdtempSync(join(tmpdir(), 's2d-engine-sql-'));
  for (const [name, sql] of Object.entries(files)) {
    writeFileSync(join(dir, name), sql);
  }
  return dir;
}

export { mkdirSync };
