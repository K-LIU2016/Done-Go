// M3 choose-model 单测（TDD RED 先行）。
// 契约来源：PRD §6.5.1 表格（L428–434）逐行 + 额度/让路（L436–439）、.s2d/plan.md §2 M3。
// 全部纯函数：chooseModel(planResult, rateLimits, history) → {model, effort, reason, quotaSnapshot, ...}。
// 注：表第 1 行「预演规划 luna/low」固定在 M6 adapter.plan 的协议参数上（见 codex-adapter-plan.test.mjs），不归本函数。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chooseModel, chooseReviewModel } from '../../../../packages/donego-bridge/src/model/choose.mjs';
import { parseRateLimits } from '../../../../packages/donego-bridge/src/model/rate-limits.mjs';

const plan = (over = {}) => ({
  files: ['docs/x.md'],
  summary: '改一个文档',
  estimatedDiffLines: 20,
  kinds: ['doc'],
  tests: ['node --test x.test.mjs'],
  crossModule: false,
  riskFlags: [],
  needsNewTests: false,
  signals: { architecture: false, concurrency: false, performance: false, security: false, dataMigration: false },
  urgent: false,
  ...over,
});
const rl = (over = {}) => ({ weeklyUsedPercent: 10, spendControlReached: false, activeForeignThreads: 0, ...over });
const hist = (over = {}) => ({ failedTestRuns: 0, consecutiveVerificationFailures: 0, ...over });

// §6.5.1「执行档整体降一级」的档位阶梯（测试即规格；实现按此导出同名常量亦可）
const LADDER = ['gpt-6.1-sol/xhigh', 'gpt-6.1-sol/high', 'gpt-6-sol/high', 'gpt-6-sol/medium', 'gpt-6-luna/medium', 'gpt-6-luna/low'];
const tierOf = r => `${r.model}/${r.effort}`;

test('简单行：单文件 + diff<50 + 文档/脚本/样式 + 无跨模块 → gpt-6-luna/medium', () => {
  for (const kind of ['doc', 'script', 'style']) {
    const r = chooseModel(plan({ kinds: [kind] }), rl(), hist());
    assert.equal(r.model, 'gpt-6-luna', `kinds=[${kind}]`);
    assert.equal(r.effort, 'medium');
  }
});

test('标准行：2–8 文件或需新增测试 → gpt-6-sol/medium', () => {
  const r1 = chooseModel(plan({ files: ['a.mjs', 'b.mjs'], kinds: ['code'], estimatedDiffLines: 120, needsNewTests: true }), rl(), hist());
  assert.equal(tierOf(r1), 'gpt-6-sol/medium');
  const r2 = chooseModel(plan({ files: ['a.mjs'], kinds: ['code'], needsNewTests: true, estimatedDiffLines: 30 }), rl(), hist());
  assert.equal(tierOf(r2), 'gpt-6-sol/medium', '单文件但需新增测试 → 标准');
});

test('标准行边界：diff 50 行代码单文件不属简单 → 标准档', () => {
  const r = chooseModel(plan({ kinds: ['code'], estimatedDiffLines: 50 }), rl(), hist());
  assert.equal(tierOf(r), 'gpt-6-sol/medium');
});

test('复杂行：跨模块/架构/并发/性能/安全敏感/数据迁移 任一信号 → gpt-6.1-sol/high', () => {
  const cases = [
    { crossModule: true },
    { signals: { architecture: true, concurrency: false, performance: false, security: false, dataMigration: false } },
    { signals: { architecture: false, concurrency: true, performance: false, security: false, dataMigration: false } },
    { signals: { architecture: false, concurrency: false, performance: true, security: false, dataMigration: false } },
    { signals: { architecture: false, concurrency: false, performance: false, security: true, dataMigration: false } },
    { signals: { architecture: false, concurrency: false, performance: false, security: false, dataMigration: true } },
  ];
  for (const over of cases) {
    const r = chooseModel(plan(over), rl(), hist());
    assert.equal(tierOf(r), 'gpt-6.1-sol/high', JSON.stringify(over));
  }
});

test('复杂行：规划阶段风险标记 ≥2 → gpt-6.1-sol/high（1 个风险标记不够）', () => {
  const two = chooseModel(plan({ riskFlags: ['dep-version', 'api-change'] }), rl(), hist());
  assert.equal(tierOf(two), 'gpt-6.1-sol/high');
  const one = chooseModel(plan({ riskFlags: ['dep-version'] }), rl(), hist());
  assert.notEqual(tierOf(one), 'gpt-6.1-sol/high', '单个风险标记不升复杂');
});

test('历史升档：标准档测试失败重试一次 → sol/high；复杂档连续两次验证失败 → 6.1-sol/xhigh', () => {
  const std = chooseModel(plan({ files: ['a.mjs', 'b.mjs'], kinds: ['code'] }), rl(), hist({ failedTestRuns: 1 }));
  assert.equal(tierOf(std), 'gpt-6-sol/high');
  const one = chooseModel(plan({ crossModule: true }), rl(), hist({ consecutiveVerificationFailures: 1 }));
  assert.equal(tierOf(one), 'gpt-6.1-sol/high', '失败 1 次不升 xhigh');
  const two = chooseModel(plan({ crossModule: true }), rl(), hist({ consecutiveVerificationFailures: 2 }));
  assert.equal(tierOf(two), 'gpt-6.1-sol/xhigh');
});

test('额度 >70%：执行档沿 LADDER 降一级', () => {
  const std = chooseModel(plan({ files: ['a.mjs', 'b.mjs'], kinds: ['code'] }), rl({ weeklyUsedPercent: 71 }), hist());
  assert.equal(tierOf(std), 'gpt-6-luna/medium', 'sol/medium → luna/medium');
  const simple = chooseModel(plan({ kinds: ['doc'] }), rl({ weeklyUsedPercent: 75 }), hist());
  assert.equal(tierOf(simple), 'gpt-6-luna/low', 'luna/medium → luna/low');
  const cx = chooseModel(plan({ crossModule: true }), rl({ weeklyUsedPercent: 72 }), hist());
  assert.equal(tierOf(cx), 'gpt-6-sol/high', '6.1-sol/high → sol/high');
  assert.ok(LADDER.indexOf(tierOf(std)) === LADDER.indexOf('gpt-6-sol/medium') + 1, '降级=阶梯下一格');
});

test('额度 >90%：只允许 luna，并产出 Need 决策标记', () => {
  const r = chooseModel(plan({ crossModule: true }), rl({ weeklyUsedPercent: 93 }), hist());
  assert.equal(r.model, 'gpt-6-luna');
  assert.ok(r.need, '>90% 必须带 need 标记（请 JC 决定是否继续）');
  assert.match(r.reason, /90|quota|额度/i);
});

test('spendControlReached：暂停全部代码任务 → {pause:true}', () => {
  const r = chooseModel(plan(), rl({ spendControlReached: true }), hist());
  assert.equal(r.pause, true);
  assert.match(r.reason, /SPEND_CONTROL|暂停/i);
});

test('让路：本机有活跃非 Done&Go Codex thread 且任务非紧急 → {defer:true}；紧急任务不让路', () => {
  const defer = chooseModel(plan({ urgent: false }), rl({ activeForeignThreads: 2 }), hist());
  assert.equal(defer.defer, true);
  assert.match(defer.reason, /让路|yield|defer/i);
  const urgent = chooseModel(plan({ urgent: true }), rl({ activeForeignThreads: 2 }), hist());
  assert.notEqual(urgent.defer, true, '紧急任务不让路');
  assert.ok(urgent.model);
});

test('输出契约：{model, effort, reason, quotaSnapshot}，quotaSnapshot 记录额度快照（写 trace 用，§6.5.1 L439）', () => {
  const r = chooseModel(plan(), rl({ weeklyUsedPercent: 33, activeForeignThreads: 1 }), hist());
  assert.ok(r.model && r.effort && typeof r.reason === 'string' && r.reason.length > 0);
  assert.equal(r.quotaSnapshot.weeklyUsedPercent, 33);
  assert.equal(r.quotaSnapshot.activeForeignThreads, 1);
  assert.equal(r.quotaSnapshot.spendControlReached, false);
});

test('组合：spendControl 优先于一切；>90% 优先于降档与让路之外的历史升档', () => {
  const pause = chooseModel(plan({ crossModule: true }), rl({ weeklyUsedPercent: 95, spendControlReached: true }), hist({ consecutiveVerificationFailures: 2 }));
  assert.equal(pause.pause, true);
});

test('评审行：执行用 sol 系 → 评审 gpt-6-luna/high；执行用 luna → 评审 gpt-6-sol/medium', () => {
  assert.deepEqual(chooseReviewModel({ model: 'gpt-6-sol', effort: 'medium' }), { model: 'gpt-6-luna', effort: 'high' });
  assert.deepEqual(chooseReviewModel({ model: 'gpt-6.1-sol', effort: 'high' }), { model: 'gpt-6-luna', effort: 'high' });
  assert.deepEqual(chooseReviewModel({ model: 'gpt-6-luna', effort: 'low' }), { model: 'gpt-6-sol', effort: 'medium' });
});

test('parseRateLimits：规范化字段、缺省 0/false、百分比夹取 [0,100]、非对象拒绝', () => {
  assert.deepEqual(parseRateLimits({ weeklyUsedPercent: 55 }), { weeklyUsedPercent: 55, spendControlReached: false, activeForeignThreads: 0 });
  assert.deepEqual(parseRateLimits({}), { weeklyUsedPercent: 0, spendControlReached: false, activeForeignThreads: 0 });
  assert.deepEqual(parseRateLimits({ weeklyUsedPercent: 140 }), { weeklyUsedPercent: 100, spendControlReached: false, activeForeignThreads: 0 });
  assert.equal(parseRateLimits({ weekly: { usedPercent: 42 } }).weeklyUsedPercent, 42, '兼容嵌套 codex 形状');
  assert.throws(() => parseRateLimits(null), TypeError);
  assert.throws(() => parseRateLimits('x'), TypeError);
});
