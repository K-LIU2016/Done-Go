// W7 M4 · model-router-core 单测（测试先行 · RED 基线）
//
// 钉住 `scripts/agentic/model-router/router.mjs` 的选择规则（plan.md M4）。
// 纯选择函数：不做真实调用、不读 key、不读真实时钟。
//
// API 契约：
//   selectModel(taskClass, dataClass, { actor, budget, localAvailable, now, rateLimit? })
//     → { status: 'selected'|'unknown', model?, provider?, locality: 'local'|'cloud',
//         provenance: { rule, inputsHash, decidedAt }, reason, codexChoice? }
//
// 规则表（本文件即规格）：
//   dataClass='secret'        → 直接拒：抛 FORBIDDEN（永不进任何模型）
//   dataClass='sensitive'     → 仅本地：localAvailable→selected(local)；否则 status='unknown'（绝不降级上云）
//   taskClass='code'          → Codex 路径（cloud, provider='codex'），产出 codexChoice
//                               须通过冻结 codex-choice.schema.json：
//                                 rateLimit.weeklyUsed>=0.9 或 spendControlReached → gpt-6-luna/low
//                                 budget.tokens < 8000                            → gpt-6-luna/low
//                                 其余                                            → gpt-6.1-sol/high
//   taskClass='reason'        → gpt-6-sol（cloud, provider='codex'）
//   taskClass='summarize'     → localAvailable→local('local-small')；否则 gpt-6-luna（cloud）
//   其余 taskClass            → status='unknown'（不猜默认模型）
//   dataClass 越界            → CONTRACT_INVALID
//   taskClass 空/空串          → CONTRACT_INVALID
//   budget.calls===0          → BUDGET_EXCEEDED（无调用额度即无选择）
//   now 未注入                → 抛错（红线⑥：provenance.decidedAt 不允许读真实 wall clock）
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSchema, validate } from '../../../../scripts/agentic/contracts.mjs';
import { selectModel } from '../../../../scripts/agentic/model-router/router.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../');
const contractDir = join(root, 'contracts/agentic');
const codexChoiceSchema = loadSchema('codex-choice.schema.json', contractDir);

const NOW = '2026-10-27T08:30:00Z';
const OPTS = { actor: 'planner@w7', budget: { calls: 5, tokens: 50_000 }, localAvailable: true, now: NOW };
const NO_LOCAL = { ...OPTS, localAvailable: false };

// ---------------- 数据分级边界（负面先行） ----------------

test('M4 负面 · dataClass=secret → 直接 FORBIDDEN，永不进模型', () => {
  for (const taskClass of ['code', 'reason', 'summarize']) {
    assert.throws(
      () => selectModel(taskClass, 'secret', OPTS),
      err => err.code === 'FORBIDDEN',
      `${taskClass}+secret must be rejected outright`,
    );
  }
});

test('M4 负面 · dataClass=sensitive 且无本地模型 → status=unknown（绝不降级上云）', () => {
  const decision = selectModel('reason', 'sensitive', NO_LOCAL);
  assert.equal(decision.status, 'unknown');
  assert.equal(decision.model, undefined);
  assert.equal(decision.locality, undefined, 'unknown decisions must not claim a locality');
  assert.ok(decision.reason.length > 0);
});

test('M4 正例 · dataClass=sensitive 且本地可用 → 仅 local', () => {
  const decision = selectModel('reason', 'sensitive', OPTS);
  assert.equal(decision.status, 'selected');
  assert.equal(decision.locality, 'local');
  assert.equal(decision.provider, 'local');
});

test('M4 负面 · dataClass 越界（不在 public/personal/sensitive/secret）→ CONTRACT_INVALID', () => {
  assert.throws(() => selectModel('reason', 'topsecret', OPTS), err => err.code === 'CONTRACT_INVALID');
  assert.throws(() => selectModel('reason', undefined, OPTS), err => err.code === 'CONTRACT_INVALID');
  assert.throws(() => selectModel('reason', '', OPTS), err => err.code === 'CONTRACT_INVALID');
});

test('M4 负面 · taskClass 空/空串/未知 → 拒绝或不猜默认', () => {
  assert.throws(() => selectModel('', 'public', OPTS), err => err.code === 'CONTRACT_INVALID');
  assert.throws(() => selectModel(null, 'public', OPTS), err => err.code === 'CONTRACT_INVALID');
  const unknown = selectModel('telepathy', 'public', OPTS);
  assert.equal(unknown.status, 'unknown');
  assert.equal(unknown.model, undefined, 'no rule hit must not guess a default model');
});

test('M4 负面 · budget.calls=0 → BUDGET_EXCEEDED（没有额度就没有选择）', () => {
  assert.throws(
    () => selectModel('reason', 'public', { ...OPTS, budget: { calls: 0, tokens: 1000 } }),
    err => err.code === 'BUDGET_EXCEEDED',
  );
});

test('M4 负面 · now 未注入 → 抛错（decidedAt 不得来自真实 wall clock）', () => {
  const { now, ...withoutNow } = OPTS;
  assert.throws(() => selectModel('reason', 'public', withoutNow), /now|clock/i);
});

// ---------------- 规则正例 ----------------

test('M4 正例 · reason+public → gpt-6-sol cloud', () => {
  const decision = selectModel('reason', 'public', OPTS);
  assert.equal(decision.status, 'selected');
  assert.equal(decision.model, 'gpt-6-sol');
  assert.equal(decision.locality, 'cloud');
});

test('M4 正例 · summarize：本地可用走 local，不可用回落 cloud gpt-6-luna', () => {
  assert.equal(selectModel('summarize', 'public', OPTS).locality, 'local');
  const cloud = selectModel('summarize', 'public', NO_LOCAL);
  assert.equal(cloud.locality, 'cloud');
  assert.equal(cloud.model, 'gpt-6-luna');
});

// ---------------- Codex 路径（PRD §6.5 / 冻结 codex-choice.schema.json） ----------------

test('M4 正例 · code+public 常规档 → gpt-6.1-sol/high，codexChoice 过冻结 schema', () => {
  const decision = selectModel('code', 'public', OPTS);
  assert.equal(decision.status, 'selected');
  assert.equal(decision.model, 'gpt-6.1-sol');
  assert.equal(decision.provider, 'codex');
  const check = validate(decision.codexChoice, codexChoiceSchema, { schemaDir: contractDir });
  assert.equal(check.valid, true, JSON.stringify(check.errors));
  assert.equal(decision.codexChoice.model, 'gpt-6.1-sol');
  assert.equal(decision.codexChoice.effort, 'high');
});

test('M4 正例 · code 轻任务（tokens<8000）→ gpt-6-luna/low 降档', () => {
  const decision = selectModel('code', 'public', { ...OPTS, budget: { calls: 5, tokens: 4_000 } });
  assert.equal(decision.model, 'gpt-6-luna');
  assert.equal(decision.codexChoice.effort, 'low');
  const check = validate(decision.codexChoice, codexChoiceSchema, { schemaDir: contractDir });
  assert.equal(check.valid, true);
});

test('M4 正例 · code 限流压力（weeklyUsed>=0.9 / spendControlReached）→ gpt-6-luna/low', () => {
  const pressured = selectModel('code', 'public', { ...OPTS, rateLimit: { weeklyUsed: 0.95 } });
  assert.equal(pressured.model, 'gpt-6-luna');
  assert.equal(pressured.codexChoice.effort, 'low');
  const spendHit = selectModel('code', 'public', { ...OPTS, rateLimit: { weeklyUsed: 0.2, spendControlReached: true } });
  assert.equal(spendHit.model, 'gpt-6-luna');
  assert.equal(spendHit.codexChoice.effort, 'low');
});

// ---------------- provenance（可审计来源，确定性） ----------------

test('M4 · provenance：rule 命名、inputsHash 稳定且区分输入、decidedAt=注入 now', () => {
  const a = selectModel('reason', 'public', OPTS);
  const b = selectModel('reason', 'public', OPTS);
  assert.ok(a.provenance.rule.length > 0);
  assert.equal(a.provenance.inputsHash, b.provenance.inputsHash, 'same inputs → same hash');
  assert.match(a.provenance.inputsHash, /^[a-f0-9]{64}$/, 'inputsHash is sha-256 hex');
  assert.equal(a.provenance.decidedAt, NOW, 'decidedAt comes from injected now');
  const different = selectModel('summarize', 'public', OPTS);
  assert.notEqual(a.provenance.inputsHash, different.provenance.inputsHash, 'different inputs → different hash');
  const otherTime = selectModel('reason', 'public', { ...OPTS, now: '2026-10-27T09:00:00Z' });
  assert.equal(otherTime.provenance.decidedAt, '2026-10-27T09:00:00Z');
});

// ---------------- 补充钉子：防御分支与规则优先级（只增不删） ----------------

test('M4 负面 · budget.tokens=0 或 budget 缺失/非法 → BUDGET_EXCEEDED / CONTRACT_INVALID', () => {
  assert.throws(
    () => selectModel('reason', 'public', { ...OPTS, budget: { calls: 5, tokens: 0 } }),
    err => err.code === 'BUDGET_EXCEEDED',
  );
  assert.throws(
    () => selectModel('reason', 'public', { ...OPTS, budget: undefined }),
    err => err.code === 'CONTRACT_INVALID',
  );
  assert.throws(
    () => selectModel('reason', 'public', { ...OPTS, budget: { calls: -1, tokens: 10 } }),
    err => err.code === 'CONTRACT_INVALID',
  );
  assert.throws(
    () => selectModel('reason', 'public', { ...OPTS, budget: { calls: 'many', tokens: 10 } }),
    err => err.code === 'CONTRACT_INVALID',
  );
});

test('M4 负面 · rateLimit 注入但非法（越界 weeklyUsed / 非布尔 spendControlReached / 非对象）→ CONTRACT_INVALID', () => {
  for (const rateLimit of [{ weeklyUsed: 1.5 }, { weeklyUsed: -0.1 }, { weeklyUsed: 'high' }, {}, 'busy']) {
    assert.throws(
      () => selectModel('reason', 'public', { ...OPTS, rateLimit }),
      err => err.code === 'CONTRACT_INVALID',
      `rateLimit=${JSON.stringify(rateLimit)} must be rejected`,
    );
  }
  assert.throws(
    () => selectModel('reason', 'public', { ...OPTS, rateLimit: { weeklyUsed: 0.2, spendControlReached: 'yes' } }),
    err => err.code === 'CONTRACT_INVALID',
  );
});

test('M4 负面 · 注入缺失：opts 整体 / actor / localAvailable / now 不可解析 → CONTRACT_INVALID（fail closed）', () => {
  assert.throws(() => selectModel('reason', 'public', undefined), err => err.code === 'CONTRACT_INVALID');
  assert.throws(() => selectModel('reason', 'public', null), err => err.code === 'CONTRACT_INVALID');
  const { actor, ...noActor } = OPTS;
  assert.throws(() => selectModel('reason', 'public', noActor), err => err.code === 'CONTRACT_INVALID');
  const { localAvailable, ...noLocalFlag } = OPTS;
  assert.throws(() => selectModel('reason', 'public', noLocalFlag), err => err.code === 'CONTRACT_INVALID');
  assert.throws(
    () => selectModel('reason', 'public', { ...OPTS, now: 'not-a-timestamp' }),
    err => err.code === 'CONTRACT_INVALID' && /now|clock/i.test(err.message),
  );
});

test('M4 正例 · dataClass=sensitive 优先于 taskClass=code：仍只走本地，不产 codexChoice', () => {
  const decision = selectModel('code', 'sensitive', OPTS);
  assert.equal(decision.status, 'selected');
  assert.equal(decision.locality, 'local');
  assert.equal(decision.provider, 'local');
  assert.equal(decision.codexChoice, undefined, 'sensitive data must not take the cloud codex path');
});

test('M4 · unknown 决策也带完整 provenance（rule=no-rule-match，inputsHash 稳定、不含 decidedAt）', () => {
  const a = selectModel('telepathy', 'public', OPTS);
  const b = selectModel('telepathy', 'public', { ...OPTS, now: '2026-10-27T23:59:59Z' });
  assert.equal(a.provenance.rule, 'no-rule-match');
  assert.equal(a.provenance.inputsHash, b.provenance.inputsHash, 'decidedAt must not affect inputsHash');
  assert.equal(b.provenance.decidedAt, '2026-10-27T23:59:59Z');
  const noLocal = selectModel('reason', 'sensitive', NO_LOCAL);
  assert.equal(noLocal.provenance.rule, 'sensitive-local-only');
  assert.ok(noLocal.provenance.inputsHash.length === 64);
});

test('M4 正例 · code 未注入 rateLimit → codexChoice.rateLimit.weeklyUsed=0 且过冻结 schema（如实记录无压力信号）', () => {
  const decision = selectModel('code', 'public', OPTS);
  const check = validate(decision.codexChoice, codexChoiceSchema, { schemaDir: contractDir });
  assert.equal(check.valid, true, JSON.stringify(check.errors));
  assert.equal(decision.codexChoice.rateLimit.weeklyUsed, 0);
  assert.equal(decision.codexChoice.rateLimit.spendControlReached, undefined);
});
