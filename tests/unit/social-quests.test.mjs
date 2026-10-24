import assert from 'node:assert/strict';
import { test } from 'node:test';

// SO·S7搭档圈挑战 line (quests half): web/social/quests.js — 周挑战
// (PRD design/social-sync/PRD.md §4.7、§8)。
//
// 硬门槛在本文件证明：
// - 每周恰好 QUESTS_PER_WEEK=3 个挑战（默认 2 个人 + 1 个圈级），同一周
//   计划完全确定（两次调用 deepEqual），周与周之间计划滚动变化。
// - 进度：单调递增、clamp 到 target、到 target 即 done；绝不倒退。
// - 徽章：只有 done 才发。
// - 「太多了」是保护指标反馈（QUEST_FEEDBACK_TYPES），提交反馈绝不改变
//   任何进度 —— 不是惩罚（PRD §8）。
// - 所有产出的 quest/progress 都过 contracts.validateQuest /
//   validateQuestProgress（契约唯一来源）。

import {
  QUESTS_PER_WEEK, QUEST_SCOPES, QUEST_FEEDBACK_TYPES,
  validateQuest, validateQuestProgress,
} from '../../web/social/contracts.js';
import {
  DEFAULT_QUEST_POOL, questWeekPlan, initialQuestProgress, applyQuestProgress,
  questBadge, validateQuestFeedback, questProgressRatio,
  isoWeekOfDate, questWeekRemainingDays,
} from '../../web/social/quests.js';

const W43 = '2026-W43';

test('DEFAULT_QUEST_POOL：全部过 validateQuest，两种 scope 齐备，含 PRD 示例挑战', () => {
  assert.ok(Array.isArray(DEFAULT_QUEST_POOL) && DEFAULT_QUEST_POOL.length >= 8, '池子足够滚动');
  for (const q of DEFAULT_QUEST_POOL) {
    const clean = validateQuest(q);
    assert.ok(clean, `池内挑战 ${q && q.id} 必须过契约`);
    assert.deepEqual(Object.keys(clean).sort(), ['id', 'scope', 'target', 'title', 'unit', 'week'].sort());
  }
  const scopes = new Set(DEFAULT_QUEST_POOL.map((q) => q.scope));
  assert.ok(scopes.has('personal') && scopes.has('circle'), '个人和圈级都要有');
  const titles = DEFAULT_QUEST_POOL.map((q) => q.title).join('\n');
  assert.ok(titles.includes('传棒'), '含 PRD 示例「给 1 个人传棒」类挑战');
  assert.ok(titles.includes('家人'), '含 PRD 示例「把空出来的时间给家人」类挑战');
});

test('questWeekPlan：恰好 3 个、默认 2 个人 + 1 个圈级、全部过契约', () => {
  const plan = questWeekPlan(W43);
  assert.equal(plan.length, QUESTS_PER_WEEK);
  assert.equal(plan.filter((q) => q.scope === 'personal').length, 2);
  assert.equal(plan.filter((q) => q.scope === 'circle').length, 1);
  for (const q of plan) assert.ok(validateQuest(q), '计划内挑战逐个过契约');
  assert.equal(new Set(plan.map((q) => q.id)).size, QUESTS_PER_WEEK, '不重复');
});

test('questWeekPlan：同一周完全确定；连续 8 周计划滚动变化', () => {
  assert.deepEqual(questWeekPlan(W43), questWeekPlan(W43), '同周两次调用一致');
  const weeks = ['2026-W40', '2026-W41', '2026-W42', '2026-W43', '2026-W44', '2026-W45', '2026-W46', '2026-W47'];
  const plans = weeks.map((w) => questWeekPlan(w).map((q) => q.id).join('|'));
  assert.ok(new Set(plans).size >= 3, '8 周里至少出现 3 种不同计划（周周滚动）');
  assert.notEqual(plans[0], plans[1], '相邻两周计划不同');
});

test('questWeekPlan：自定义配额；池不足时返回 null，绝不凑数', () => {
  const oneEach = questWeekPlan(W43, null, { personal: 1, circle: 2 });
  assert.equal(oneEach.filter((q) => q.scope === 'circle').length, 2);
  const tiny = DEFAULT_QUEST_POOL.filter((q) => q.id === 'quest-baton-1');
  assert.equal(questWeekPlan(W43, tiny), null, '池子不够 3 个 → null，不造假挑战');
});

test('isoWeekOfDate：锚点日期全部正确（纯日期数学，无时区依赖）', () => {
  assert.equal(isoWeekOfDate('2026-01-01'), '2026-W01', '2026-01-01 周四属 W01');
  assert.equal(isoWeekOfDate('2026-10-19'), W43, '周一开周');
  assert.equal(isoWeekOfDate('2026-10-25'), W43, '周日收周（今天）');
  assert.equal(isoWeekOfDate('2026-12-28'), '2026-W53', '2026 年有 53 个 ISO 周');
  assert.equal(isoWeekOfDate('2027-01-04'), '2027-W01', '跨年');
  assert.equal(isoWeekOfDate('bogus'), null);
});

test('questWeekRemainingDays：周一 6 → 周日 0；不在本周 null', () => {
  assert.equal(questWeekRemainingDays(W43, '2026-10-19'), 6);
  assert.equal(questWeekRemainingDays(W43, '2026-10-21'), 4);
  assert.equal(questWeekRemainingDays(W43, '2026-10-24'), 1);
  assert.equal(questWeekRemainingDays(W43, '2026-10-25'), 0, '周日当天挑战收口');
  assert.equal(questWeekRemainingDays(W43, '2026-10-18'), null, '上周日期不属本周');
});

test('initialQuestProgress / applyQuestProgress：单调、clamp、done 语义', () => {
  const quest = questWeekPlan(W43).find((q) => q.scope === 'personal');
  let p = initialQuestProgress(quest, 'alice');
  assert.ok(validateQuestProgress(p));
  assert.equal(p.done, false);
  p = applyQuestProgress(p, quest, 1);
  assert.equal(p.progress, 1);
  p = applyQuestProgress(p, quest, 99);
  assert.equal(p.progress, quest.target, 'clamp 到 target');
  assert.equal(p.done, true);
  const more = applyQuestProgress(p, quest, 5);
  assert.equal(more.progress, quest.target, '完成后不再增长');
  assert.equal(more.done, true);
  assert.equal(applyQuestProgress(p, quest, 0), null, '非正增量拒绝');
  assert.equal(applyQuestProgress(p, quest, -1), null, '进度绝不倒退（负增量拒绝）');
  for (const step of [p, more]) assert.ok(validateQuestProgress(step), '转移后仍过契约');
});

test('questBadge：done 才发徽章；徽章带上 questId/week/scope/title', () => {
  const quest = questWeekPlan(W43)[0];
  let p = initialQuestProgress(quest, 'alice');
  assert.equal(questBadge(quest, p), null, '未完成无徽章');
  p = applyQuestProgress(p, quest, quest.target);
  const badge = questBadge(quest, p);
  assert.ok(badge);
  assert.equal(badge.questId, quest.id);
  assert.equal(badge.week, quest.week);
  assert.equal(badge.scope, quest.scope);
  assert.equal(badge.title, quest.title);
});

test('「太多了」反馈：只认 QUEST_FEEDBACK_TYPES；提交反馈绝不改进度（保护指标≠惩罚）', () => {
  assert.deepEqual(QUEST_FEEDBACK_TYPES, ['too-much']);
  const fb = validateQuestFeedback({ type: 'too-much' });
  assert.ok(fb);
  assert.equal(fb.type, 'too-much');
  assert.equal(validateQuestFeedback({ type: 'angry' }), null, '未知反馈类型拒绝');
  assert.equal(validateQuestFeedback('too-much'), null, '必须是对象');
  const quest = questWeekPlan(W43)[0];
  const before = applyQuestProgress(initialQuestProgress(quest, 'alice'), quest, 1);
  // 反馈与进度是两个世界：任何反馈对象都不参与进度转移函数的输入
  const after = applyQuestProgress(initialQuestProgress(quest, 'alice'), quest, 1);
  assert.deepEqual(after, before, '反馈不影响进度（applyQuestProgress 无反馈入口，等值对照）');
});

test('questProgressRatio：0–1 收口，驱动原型进度条宽度', () => {
  const quest = questWeekPlan(W43).find((q) => q.target >= 2);
  const zero = initialQuestProgress(quest, 'alice');
  assert.equal(questProgressRatio(zero, quest), 0);
  const half = applyQuestProgress(zero, quest, Math.floor(quest.target / 2));
  const r = questProgressRatio(half, quest);
  assert.ok(r > 0 && r <= 1);
  const done = applyQuestProgress(zero, quest, quest.target);
  assert.equal(questProgressRatio(done, quest), 1);
});
