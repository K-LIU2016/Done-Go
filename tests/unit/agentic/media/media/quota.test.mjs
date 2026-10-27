// W11 media-gen · 每日配额计数器先行单测（RED 契约）。
// 依据：DAG 组1(3)：可配置上限（产品默认 30 张/天 vs 本流冒烟 ≤20，两个数字分开）；
// 原子落盘、跨进程安全、超额抛类型化错误。PRD §5.2（默认生图 ≤30 张/天、场景片 ≤3 段/天）。
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { test } from 'node:test';

import { createDailyQuota, DEFAULT_IMAGE_QUOTA, DEFAULT_VIDEO_QUOTA } from '../../../../../scripts/agentic/media/quota.mjs';

const tmp = () => mkdtempSync(join(tmpdir(), 'w11-quota-'));
const day = () => new Date('2026-10-26T10:00:00+08:00');

test('product defaults are separate from the smoke budget: 30 images/day, 3 videos/day', () => {
  assert.equal(DEFAULT_IMAGE_QUOTA, 30, 'PRD §5.2 产品默认生图 30 张/天（冒烟 ≤20 是另一个数字，见 smoke.mjs）');
  assert.equal(DEFAULT_VIDEO_QUOTA, 3, 'PRD §5.2 场景片默认 3 段/天');
});

test('spend increments the daily counter and persists across instances', () => {
  const d = tmp();
  const file = join(d, 'quota.json');
  const a = createDailyQuota({ file, now: day });
  assert.equal(a.used(), 0);
  a.spend();
  a.spend();
  assert.equal(a.used(), 2);
  // 新实例 = 另一进程：必须看到已落盘的计数（跨进程安全）
  const b = createDailyQuota({ file, now: day });
  assert.equal(b.used(), 2);
  assert.equal(b.remaining(), 28);
  rmSync(d, { recursive: true, force: true });
});

test('exceeding the limit throws a typed QUOTA_EXCEEDED and does not overspend', () => {
  const d = tmp();
  const q = createDailyQuota({ file: join(d, 'quota.json'), limit: 2, now: day });
  q.spend();
  q.spend();
  assert.equal(q.check().ok, false);
  assert.equal(q.check().remaining, 0);
  assert.throws(() => q.spend(), err => err.code === 'QUOTA_EXCEEDED' && /2/.test(err.message));
  assert.equal(q.used(), 2, '超额后计数不得继续增长');
  rmSync(d, { recursive: true, force: true });
});

test('the counter rolls over at midnight (Asia/Shanghai day key)', () => {
  const d = tmp();
  const q = createDailyQuota({
    file: join(d, 'quota.json'), limit: 2,
    now: () => new Date('2026-10-26T23:59:00+08:00'),
  });
  q.spend(2);
  assert.equal(q.used(), 2);
  const next = createDailyQuota({
    file: join(d, 'quota.json'), limit: 2,
    now: () => new Date('2026-10-27T00:01:00+08:00'),
  });
  assert.equal(next.used(), 0, '次日计数归零');
  assert.equal(next.check().ok, true);
  // 昨天的计数仍可按日查询
  assert.equal(next.used('2026-10-26'), 2);
  rmSync(d, { recursive: true, force: true });
});

test('a missing or corrupt state file starts the day at zero (resilient default)', () => {
  const d = tmp();
  const missing = createDailyQuota({ file: join(d, 'none.json'), now: day });
  assert.equal(missing.used(), 0);

  const corruptFile = join(d, 'corrupt.json');
  writeFileSync(corruptFile, '{half-written', 'utf8');
  const corrupt = createDailyQuota({ file: corruptFile, now: day });
  assert.equal(corrupt.used(), 0);
  corrupt.spend();
  assert.equal(corrupt.used(), 1, '损坏后可继续记账');
  rmSync(d, { recursive: true, force: true });
});

test('spend(n) counts n uses at once and rejects a whole batch that would overflow', () => {
  const d = tmp();
  const q = createDailyQuota({ file: join(d, 'quota.json'), limit: 5, now: day });
  q.spend(3);
  assert.equal(q.used(), 3);
  assert.throws(() => q.spend(3), err => err.code === 'QUOTA_EXCEEDED');
  assert.equal(q.used(), 3);
  q.spend(2);
  assert.equal(q.used(), 5);
  rmSync(d, { recursive: true, force: true });
});
