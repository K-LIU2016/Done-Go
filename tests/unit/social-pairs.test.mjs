import assert from 'node:assert/strict';
import { test } from 'node:test';

// SO·S7搭档圈挑战 line (pairs half): web/social/pairs.js — 接力搭档状态机
// (PRD design/social-sync/PRD.md §4.5)。
//
// 硬门槛在本文件证明：
// - 火苗：双方当天各 ≥1 次接力（PAIR_DAILY_RELAYS）→ 火苗 +1；共享计数。
// - 冻结：每周 1 次（PAIR_FREEZES_PER_WEEK）——PRD 未写死冻结的确切效果，
//   pairs.js 采用并锁定：冻结保住当天火苗（+1，视为火苗未熄），消耗当周
//   冻结额度；无冻结可用时当天停涨【不清零、不扣减】。
// - 不惩罚（PRD §4.5「一方断了只提醒，不惩罚」）：任意活动序列火苗单调
//   不减，且提醒文案不含任何惩罚字眼。
// - 上限：每人最多 MAX_PAIRS=5 位不同搭档；重复搭档、自己与自己一律拒绝。
// - 一切转移后的 pair 输出都必须能过 contracts.validatePair（契约唯一来源）。

import {
  MAX_PAIRS, PAIR_DAILY_RELAYS, PAIR_FREEZES_PER_WEEK, validatePair,
} from '../../web/social/contracts.js';
import {
  createPairRuntime, toPairWire, recordPairDay, rollPairWeek,
  pairDayStatus, pairReminder, canAddPair, distinctPartners,
  compareIsoWeeks, PAIR_REMINDER_TEXT,
} from '../../web/social/pairs.js';

const W42 = '2026-W42';
const W43 = '2026-W43';
const W44 = '2026-W44';

function day(a, b) { return { aRelays: a, bRelays: b }; }

test('createPairRuntime: 初始火苗 0、冻结 0，投影过 validatePair；自配对拒绝', () => {
  const rt = createPairRuntime({ a: 'alice', b: 'bob', week: W43 });
  assert.ok(rt, 'runtime 应创建成功');
  assert.equal(rt.flame, 0);
  assert.equal(rt.freezesUsed, 0);
  const wire = toPairWire(rt);
  const clean = validatePair(wire);
  assert.ok(clean, '投影必须过 contracts.validatePair');
  assert.equal(clean.a, 'alice');
  assert.equal(clean.b, 'bob');
  assert.equal(createPairRuntime({ a: 'alice', b: 'alice', week: W43 }), null, 'a === b 拒绝');
});

test('火苗：双方各接力 ≥PAIR_DAILY_RELAYS 当天 +1；显式不用冻结时单边不加', () => {
  let rt = createPairRuntime({ a: 'alice', b: 'bob', week: W43 });
  rt = recordPairDay(rt, W43, day(2, 1));
  assert.equal(rt.flame, 1, '双方 ≥1 → +1');
  rt = recordPairDay(rt, W43, day(0, 1), { useFreeze: false });
  assert.equal(rt.flame, 1, '单边不接力且不冻结 → 火苗停涨');
});

test('冻结：当周第一次 miss 自动消耗冻结保火苗(+1)；同周第二次 miss 停涨', () => {
  let rt = createPairRuntime({ a: 'alice', b: 'bob', week: W43 });
  rt = recordPairDay(rt, W43, day(0, 1));
  assert.equal(rt.flame, 1, '第一次 miss：消耗每周 1 次冻结，火苗保住 +1');
  assert.equal(rt.freezesUsed, 1);
  rt = recordPairDay(rt, W43, day(1, 0));
  assert.equal(rt.flame, 1, '同周第二次 miss：冻结已用完，停涨');
  assert.equal(rt.freezesUsed, PAIR_FREEZES_PER_WEEK, '冻结用量封顶 1');
  const wire = toPairWire(rt);
  assert.ok(validatePair(wire), '冻结后仍过 validatePair');
});

test('冻结可显式保留：useFreeze:false 时 miss 不消耗冻结、火苗不变', () => {
  let rt = createPairRuntime({ a: 'alice', b: 'bob', week: W43 });
  rt = recordPairDay(rt, W43, day(0, 0), { useFreeze: false });
  assert.equal(rt.flame, 0);
  assert.equal(rt.freezesUsed, 0, '未消耗冻结');
});

test('周滚动：新 ISO 周冻结额度恢复；rollPairWeek 幂等且不倒退', () => {
  let rt = createPairRuntime({ a: 'alice', b: 'bob', week: W42 });
  rt = recordPairDay(rt, W42, day(0, 0));
  assert.equal(rt.freezesUsed, 1);
  const rolled = rollPairWeek(rt, W43);
  assert.notEqual(rolled, rt, '进入新周产生新状态');
  assert.equal(rolled.freezesUsed, 0, '进入新周冻结恢复');
  assert.equal(rolled.flame, 1, '火苗跨周保留');
  assert.equal(rollPairWeek(rolled, W43), rolled, '同周重复 roll 是 no-op');
  assert.equal(rollPairWeek(rolled, W42), rolled, '回滚到更早的周是 no-op');
  assert.equal(rollPairWeek(rolled, W44).freezesUsed, 0);
});

test('recordPairDay 跨周直接记账也会先重置冻结额度', () => {
  let rt = createPairRuntime({ a: 'alice', b: 'bob', week: W42 });
  rt = recordPairDay(rt, W42, day(0, 0)); // 用掉 W42 冻结
  rt = recordPairDay(rt, W43, day(0, 0)); // W43 新额度 → 冻结保火苗
  assert.equal(rt.freezesUsed, 1, 'W43 的冻结被消耗');
  assert.equal(rt.flame, 2, '两次冻结各 +1');
});

test('不惩罚：任意序列火苗单调不减（性质测试）', () => {
  let rt = createPairRuntime({ a: 'alice', b: 'bob', week: W43 });
  const seq = [day(1, 1), day(0, 1), day(0, 0), day(1, 0), day(3, 2), day(0, 0), day(0, 0), day(1, 1)];
  let prev = rt.flame;
  for (const d of seq) {
    rt = recordPairDay(rt, rt.currentWeek, d);
    assert.ok(rt.flame >= prev, `火苗不得下降（${prev} → ${rt.flame}）`);
    assert.ok(validatePair(toPairWire(rt)), '每个转移后都过 validatePair');
    prev = rt.flame;
  }
});

test('pairDayStatus：both / 单边（cold+提醒）/ 双缺 三态', () => {
  const rt = createPairRuntime({ a: 'alice', b: 'bob', week: W43 });
  assert.equal(pairDayStatus(rt, day(1, 1)).kind, 'both');
  const oneSide = pairDayStatus(rt, day(1, 0));
  assert.equal(oneSide.kind, 'missed');
  assert.equal(oneSide.cold, true, '单边未接力火苗呈冷色');
  assert.deepEqual(oneSide.pendingRelay, ['bob'], '提醒指向未接力的一方');
  const none = pairDayStatus(rt, day(0, 0));
  assert.equal(none.kind, 'missed');
  assert.deepEqual(none.pendingRelay.sort(), ['alice', 'bob']);
});

test('提醒：只在对方未接力时给 viewer 提醒对象，文案无惩罚字眼', () => {
  const rt = createPairRuntime({ a: 'alice', b: 'bob', week: W43 });
  const r = pairReminder(rt, day(1, 0), 'alice');
  assert.ok(r, 'alice 已接力、bob 未接力 → 有提醒');
  assert.equal(r.to, 'bob');
  assert.equal(pairReminder(rt, day(1, 0), 'bob'), null, '自己没接力就不提醒对方');
  assert.equal(pairReminder(rt, day(1, 1), 'alice'), null, '都接力了不提醒');
  assert.equal(pairReminder(rt, day(0, 0), 'alice'), null, '双方都没接力：不产生「指责对方」的提醒');
  for (const bad of ['断', '失败', '惩罚', '扣']) {
    assert.ok(!PAIR_REMINDER_TEXT.includes(bad), `提醒文案不得含「${bad}」`);
  }
});

test('上限 5 位：第 6 位不同搭档拒绝；重复搭档拒绝；自配对拒绝', () => {
  const mk = (id) => ({ id: id, a: 'alice', b: id, startedWeek: W43, flame: 1, freezesUsed: 0 });
  const five = ['bob', 'carol', 'dave', 'erin', 'frank'].map(mk);
  assert.equal(distinctPartners(five, 'alice'), MAX_PAIRS);
  const sixth = canAddPair(five, 'alice', 'grace');
  assert.equal(sixth.ok, false);
  assert.match(sixth.reason, /5/);
  assert.equal(canAddPair(five, 'alice', 'bob').ok, false, '已有搭档不可重复结成');
  assert.equal(canAddPair(five, 'alice', 'alice').ok, false, '不能和自己结为搭档');
  assert.equal(canAddPair(five.slice(0, 4), 'alice', 'grace').ok, true, '第 5 位仍可加入');
  // 只统计与 self 相关的 pair：别人的搭档不算在 alice 头上
  const others = ['x1', 'x2', 'x3', 'x4', 'x5'].map((id) => ({ id: id, a: 'zed', b: id, startedWeek: W43, flame: 0, freezesUsed: 0 }));
  assert.equal(distinctPartners(others, 'alice'), 0);
});

test('compareIsoWeeks：周序正确（含跨年）', () => {
  assert.equal(compareIsoWeeks('2025-W52', '2026-W01'), -1);
  assert.equal(compareIsoWeeks(W43, W43), 0);
  assert.equal(compareIsoWeeks(W43, W42), 1);
  assert.equal(compareIsoWeeks(W43, W44), -1);
});
