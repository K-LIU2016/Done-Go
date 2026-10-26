// S2D-W2 · M2 event-clock 单测（TDD 先行：本文件即 event-clock.mjs 的实现契约）
// 依据：BUILD-PLAN §3 W2-1 L106「持久化定时器（表存储），schedule/cancel/list，
//       进程重启后补触发错过的事件（带迟到标记），时区 Asia/Shanghai，单测用可注入时钟」；
//       PRD §10.1 A2 L712；.s2d/plan.md M2 subtasks 1–5。
//
// 被测契约：
//   createEventClock({db, now}) → { schedule(at, event, opts?) → id,
//                                   cancel(id) → {cancelled},
//                                   list({from,to} | {all:true}) → rows,
//                                   tick() → fired[] }
//   · now() 由调用方注入，返回带 +08:00 的 ISO 字符串（生产为 Asia/Shanghai）
//   · 表 event_timers(id, owner_id, dedup_key UNIQUE, run_at TEXT ISO+08:00,
//     event JSON, status scheduled|fired|cancelled, late 0|1, late_ms,
//     created_at, fired_at)——迁移 engine-001-event-clock.sql
//   · tick()：扫描 status=scheduled AND run_at<=now → 触发（这里即返回并落库）；
//     now>run_at 触发 → late=1 且 late_ms=now-run_at；now==run_at 按时 → late=0
//   · schedule 幂等：同 dedup_key 二次调度返回原 id；cancel 后不再触发；
//     已 fired 不重复触发
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeClock, makeDb } from './helpers.mjs';
import { createEventClock } from '../../../../scripts/agentic/engine/event-clock.mjs';

const T0 = '2026-10-26T09:00:00+08:00';

test('schedule persists a scheduled row with +08:00 run_at and idempotent dedup_key', () => {
  const db = makeDb();
  const clock = fakeClock(T0);
  const ec = createEventClock({ db, now: clock.now });
  const id = ec.schedule('2026-10-26T09:30:00+08:00', { type: 'window.start', missionId: 'm_1' }, { dedupKey: 'm_1:start' });
  assert.ok(id, 'schedule 返回 id');
  const row = db.prepare('SELECT * FROM event_timers WHERE id = ?').get(id);
  assert.equal(row.status, 'scheduled');
  assert.equal(row.run_at, '2026-10-26T09:30:00+08:00', 'run_at 必须以 +08:00 原样存储');
  assert.equal(JSON.parse(row.event).type, 'window.start');
  // 同 dedup_key 幂等：返回原 id，不新增行
  const id2 = ec.schedule('2026-10-26T10:30:00+08:00', { type: 'window.start', missionId: 'm_1' }, { dedupKey: 'm_1:start' });
  assert.equal(id2, id, '同 dedup_key 二次调度返回原 id');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM event_timers').get().n, 1);
  db.close();
});

test('tick() before run_at fires nothing; at/after run_at fires with late=0', () => {
  const db = makeDb();
  const clock = fakeClock(T0);
  const ec = createEventClock({ db, now: clock.now });
  const id = ec.schedule('2026-10-26T09:10:00+08:00', { type: 'prep.end' });
  assert.deepEqual(ec.tick(), [], '未到点不触发');
  clock.advance(600); // 09:10:00 整点
  const fired = ec.tick();
  assert.equal(fired.length, 1);
  assert.equal(fired[0].id, id);
  assert.equal(fired[0].late, 0, '准时触发 late=0');
  assert.equal(fired[0].lateMs, 0);
  const row = db.prepare('SELECT status, late, fired_at FROM event_timers WHERE id = ?').get(id);
  assert.equal(row.status, 'fired');
  assert.ok(row.fired_at, '触发后写 fired_at');
  // 已 fired 不重复触发
  clock.advance(60);
  assert.deepEqual(ec.tick(), [], '已 fired 不重复触发');
  db.close();
});

test('restart catch-up: new instance on same db fires missed events with late=1 and late_ms', () => {
  const db = makeDb();
  const clock = fakeClock(T0);
  const ec = createEventClock({ db, now: clock.now });
  const id = ec.schedule('2026-10-26T09:05:00+08:00', { type: 'window.start' });
  clock.advance(900); // 09:15:00，模拟进程“停摆”10分钟后重启
  const restarted = createEventClock({ db, now: clock.now }); // 新实例 = 模拟重启
  const fired = restarted.tick();
  assert.equal(fired.length, 1, '重启后补触发错过的定时器');
  assert.equal(fired[0].id, id);
  assert.equal(fired[0].late, 1, '补触发必须带迟到标记');
  assert.equal(fired[0].lateMs, 10 * 60 * 1000, 'late_ms = now - run_at（毫秒）');
  const row = db.prepare('SELECT status, late, late_ms FROM event_timers WHERE id = ?').get(id);
  assert.equal(row.status, 'fired');
  assert.equal(row.late, 1);
  assert.equal(row.late_ms, 600000);
  db.close();
});

test('long-overdue events still fire (迟到不丢弃)', () => {
  const db = makeDb();
  const clock = fakeClock('2026-10-26T21:00:00+08:00');
  const ec = createEventClock({ db, now: clock.now });
  const id = ec.schedule('2026-10-26T09:00:00+08:00', { type: 'window.end' }); // 已过期 12 小时
  const fired = ec.tick();
  assert.equal(fired.length, 1, '过期已久的事件照常补触发');
  assert.equal(fired[0].late, 1);
  assert.equal(fired[0].lateMs, 12 * 3600 * 1000);
  db.close();
});

test('cancel prevents firing and marks cancelled', () => {
  const db = makeDb();
  const clock = fakeClock(T0);
  const ec = createEventClock({ db, now: clock.now });
  const id = ec.schedule('2026-10-26T09:05:00+08:00', { type: 'window.start' });
  assert.deepEqual(ec.cancel(id), { cancelled: true });
  clock.advance(600);
  assert.deepEqual(ec.tick(), [], '取消后不再触发');
  assert.equal(db.prepare('SELECT status FROM event_timers WHERE id = ?').get(id).status, 'cancelled');
  assert.deepEqual(ec.cancel(id), { cancelled: false }, '重复取消返回 false');
  db.close();
});

test('tick() fires multiple due timers in run_at order', () => {
  const db = makeDb();
  const clock = fakeClock(T0);
  const ec = createEventClock({ db, now: clock.now });
  const late = ec.schedule('2026-10-26T09:01:00+08:00', { type: 'b' });
  const early = ec.schedule('2026-10-26T09:00:30+08:00', { type: 'a' });
  clock.advance(120);
  const fired = ec.tick();
  assert.deepEqual(fired.map((f) => f.id), [early, late], '同批按 run_at 升序触发');
  db.close();
});

test('list({from,to}) filters by run_at range; list({all:true}) returns everything', () => {
  const db = makeDb();
  const clock = fakeClock(T0);
  const ec = createEventClock({ db, now: clock.now });
  const a = ec.schedule('2026-10-26T09:00:00+08:00', { type: 'a' });
  const b = ec.schedule('2026-10-26T09:30:00+08:00', { type: 'b' });
  const c = ec.schedule('2026-10-26T10:00:00+08:00', { type: 'c' });
  ec.cancel(c);
  const range = ec.list({ from: '2026-10-26T09:00:00+08:00', to: '2026-10-26T09:59:59+08:00' });
  assert.equal(range.length, 2, '窗口内恰好 2 条');
  assert.deepEqual(range.map((r) => r.id).sort(), [a, b].sort());
  const all = ec.list({ all: true });
  assert.equal(all.length, 3, 'all 包含已取消的');
  db.close();
});
