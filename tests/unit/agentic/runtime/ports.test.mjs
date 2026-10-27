// W7 M1 · runtime-ports 单测（测试先行 · RED 基线）
//
// 本文件钉住 `scripts/agentic/runtime/ports.mjs` 与 `scripts/agentic/runtime/errors.mjs`
// 的 API 契约（plan.md M1）。实现节点必须让本文件全绿，不得改测试换绿。
//
// 契约要点（brief 裁决②：fail closed，不静默降级）：
//   errors.mjs
//     - FAIL_CLOSED_CODES ⊆ api-error.schema.json error.code 枚举
//     - failClosed(code, message, details?) → Error（.code/.details），非法 code 直接抛
//     - toApiError(err) → { error: { code, message } }，必须通过 api-error.schema.json 校验；
//       非 failClosed 错误 → INTERNAL_ERROR；message 永不包含 key/Authorization 正文（脱敏）
//   ports.mjs（纯形状校验工厂，不实现业务）
//     - validatePolicyPort(port)：非对象 / 缺 check / check 非函数 → 抛 fail closed 错误
//     - validateModelCaller(fn) / validateToolCaller(fn)：非函数 → 抛
//     - validateSpanSink(sink)：undefined/null 可选通过；给了但形状不对 → 抛
//     - createFixedClock(iso) / createSteppableClock(iso)：clock.now() 返回 epoch ms，
//       deterministic，绝不读真实 wall clock
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadSchema, validate } from '../../../../scripts/agentic/contracts.mjs';
import { failClosed, toApiError, FAIL_CLOSED_CODES } from '../../../../scripts/agentic/runtime/errors.mjs';
import {
  validatePolicyPort,
  validateModelCaller,
  validateToolCaller,
  validateSpanSink,
  createFixedClock,
  createSteppableClock,
} from '../../../../scripts/agentic/runtime/ports.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../');
const contractDir = join(root, 'contracts/agentic');
const apiErrorSchema = loadSchema('api-error.schema.json', contractDir);
const API_ERROR_CODES = apiErrorSchema.properties.error.properties.code.enum;

test('M1 · FAIL_CLOSED_CODES 全部落在冻结 api-error 枚举内', () => {
  assert.deepEqual(
    FAIL_CLOSED_CODES.sort(),
    ['BUDGET_EXCEEDED', 'CONFLICT', 'CONTRACT_INVALID', 'FORBIDDEN', 'NEED_HUMAN', 'UPSTREAM_UNAVAILABLE'].sort(),
  );
  for (const code of FAIL_CLOSED_CODES) {
    assert.ok(API_ERROR_CODES.includes(code), `${code} must be in frozen api-error enum`);
  }
});

test('M1 · failClosed 产生结构化错误且可被 toApiError 包成合法信封', () => {
  const err = failClosed('FORBIDDEN', 'actor not bound to any grant', { actor: 'x' });
  assert.ok(err instanceof Error);
  assert.equal(err.code, 'FORBIDDEN');
  assert.equal(err.details.actor, 'x');
  const envelope = toApiError(err);
  const result = validate(envelope, apiErrorSchema, { schemaDir: contractDir });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  assert.equal(envelope.error.code, 'FORBIDDEN');
});

test('M1 · failClosed 非法 code fail closed（不降级成 INTERNAL_ERROR 之外的新码）', () => {
  assert.throws(() => failClosed('TOTALLY_NEW_CODE', 'x'), /code/i);
});

test('M1 · toApiError 对未知错误统一 INTERNAL_ERROR，message 脱敏不携带凭据正文', () => {
  const envelope = toApiError(new Error('boom at Authorization: Bearer sk-secret-123'));
  const result = validate(envelope, apiErrorSchema, { schemaDir: contractDir });
  assert.equal(result.valid, true);
  assert.equal(envelope.error.code, 'INTERNAL_ERROR');
  // 红线：不读写打印任何 key/Authorization —— 错误 message 不得回显凭据
  assert.ok(!/sk-secret-123/.test(envelope.error.message), 'credential material must not leak into error message');
});

// ---------------- ports 校验：负面路径先行 ----------------

test('M1 负面 · policyPort 缺失（undefined/null/空对象）→ fail closed', () => {
  for (const bad of [undefined, null, {}, 'policyPort', 42]) {
    assert.throws(() => validatePolicyPort(bad), err => err instanceof Error, `validatePolicyPort(${JSON.stringify(bad)}) must throw`);
  }
});

test('M1 负面 · policyPort 有属性但无 check / check 非函数 → fail closed', () => {
  assert.throws(() => validatePolicyPort({ decide() {} }), /check/i);
  assert.throws(() => validatePolicyPort({ check: 'not-a-fn' }), /check/i);
});

test('M1 正例 · policyPort={check} 通过并原样返回', () => {
  const port = { check: async () => ({ allow: true }) };
  assert.equal(validatePolicyPort(port), port);
});

test('M1 负面 · modelCaller / toolCaller 非函数 → fail closed', () => {
  for (const bad of [undefined, null, {}, 'x']) {
    assert.throws(() => validateModelCaller(bad), `validateModelCaller(${JSON.stringify(bad)}) must throw`);
    assert.throws(() => validateToolCaller(bad), `validateToolCaller(${JSON.stringify(bad)}) must throw`);
  }
});

test('M1 正例 · modelCaller / toolCaller 函数通过', () => {
  const fn = async () => ({ ok: true });
  assert.equal(validateModelCaller(fn), fn);
  assert.equal(validateToolCaller(fn), fn);
});

test('M1 · spanSink 可选：缺省通过；给了但形状不对 fail closed', () => {
  assert.equal(validateSpanSink(undefined), undefined);
  assert.equal(validateSpanSink(null), null);
  const sink = { record: () => {} };
  assert.equal(validateSpanSink(sink), sink);
  assert.throws(() => validateSpanSink({ emit: 'not-a-fn' }), /record/i);
  assert.throws(() => validateSpanSink('sink'), /record/i);
});

// ---------------- 确定性时钟（红线⑥） ----------------

test('M1 · createFixedClock：now() 恒等于注入时刻（epoch ms），多次调用不变', () => {
  const clock = createFixedClock('2026-10-27T08:00:00Z');
  const expected = Date.parse('2026-10-27T08:00:00Z');
  assert.equal(clock.now(), expected);
  assert.equal(clock.now(), expected);
});

test('M1 · createSteppableClock：advance 只按注入步长移动，不受真实 wall clock 影响', () => {
  const clock = createSteppableClock('2026-10-27T08:00:00Z');
  const t0 = clock.now();
  clock.advance(60_000);
  assert.equal(clock.now(), t0 + 60_000);
  clock.advance(-30_000);
  assert.equal(clock.now(), t0 + 30_000);
  // 真实时间流逝不应影响注入时钟
  assert.equal(clock.now(), t0 + 30_000);
});

// ---------------- 实现期补充的负面路径（plan M1 清单：check 抛错 / clock 缺失） ----------------
// 只新增验证，不放宽上方任何断言。
import {
  validateClock,
  readPolicyDecision,
  policyCheck,
  bindRuntimePorts,
} from '../../../../scripts/agentic/runtime/ports.mjs';
import { sanitizeMessage } from '../../../../scripts/agentic/runtime/errors.mjs';

test('M1 负面 · clock 缺失 / 无 now / now 非函数 → fail closed', () => {
  for (const bad of [undefined, null, {}, { now: 'not-a-fn' }, 'clock', 42]) {
    assert.throws(() => validateClock(bad), err => err.code === 'CONTRACT_INVALID', `validateClock(${JSON.stringify(bad) ?? bad}) must fail closed`);
  }
});

test('M1 正例 · clock={now} 通过并原样返回', () => {
  const clock = createFixedClock('2026-10-27T00:00:00Z');
  assert.equal(validateClock(clock), clock);
});

test('M1 负面 · bindRuntimePorts 任一必需端口缺失 → 构造失败，不产出部分运行时', () => {
  const policyPort = { check: async () => ({ allow: true }) };
  const modelCaller = async () => ({ ok: true });
  const toolCaller = async () => ({ ok: true });
  const clock = createFixedClock('2026-10-27T00:00:00Z');
  const full = { policyPort, modelCaller, toolCaller, clock };
  assert.deepEqual(bindRuntimePorts({ ...full }), { ...full, spanSink: undefined });
  for (const key of ['policyPort', 'modelCaller', 'toolCaller', 'clock']) {
    const broken = { ...full };
    delete broken[key];
    assert.throws(() => bindRuntimePorts(broken), err => err.code === 'CONTRACT_INVALID', `missing ${key} must fail closed`);
  }
  assert.throws(() => bindRuntimePorts(), err => err.code === 'CONTRACT_INVALID');
});

test('M1 负面 · policyPort.check 抛错 → fail closed（FORBIDDEN），不放行不吞错', async () => {
  const port = { check: async () => { throw new Error('policy backend exploded'); } };
  await assert.rejects(
    () => policyCheck(port, { actor: 'a' }, { autonomy: 'A2' }),
    err => err.code === 'FORBIDDEN' && !/exploded/.test(err.message),
  );
});

test('M1 负面 · check 结果形状不对（非对象 / allow 非布尔 / reason 非字符串）→ CONTRACT_INVALID', async () => {
  const okPort = { check: async decision => decision };
  for (const bad of [undefined, null, 'allow', 1, {}, { allow: 'yes' }, { allow: 1 }]) {
    await assert.rejects(
      () => policyCheck(okPort, bad, {}),
      err => err.code === 'CONTRACT_INVALID',
      `decision ${JSON.stringify(bad) ?? bad} must fail closed`,
    );
  }
  assert.throws(
    () => readPolicyDecision({ allow: true, reason: 7 }),
    err => err.code === 'CONTRACT_INVALID',
  );
  assert.throws(
    () => readPolicyDecision({ allow: true, need: {} }),
    err => err.code === 'CONTRACT_INVALID',
  );
});

test('M1 正例 · policyCheck 透传合法 decision（同步/异步 check、带 reason/need）', async () => {
  const asyncPort = { check: async () => ({ allow: false, reason: 'grant missing', need: 'human-confirm' }) };
  assert.deepEqual(await policyCheck(asyncPort, {}, {}), { allow: false, reason: 'grant missing', need: 'human-confirm' });
  const syncPort = { check: () => ({ allow: true }) };
  assert.deepEqual(await policyCheck(syncPort, {}, {}), { allow: true });
});

test('M1 负面 · 时钟注入值非法（非字符串 / 解析失败）→ fail closed', () => {
  for (const bad of [undefined, null, 42, '', 'not-a-date', '2026-13-40T99:00:00Z']) {
    assert.throws(() => createFixedClock(bad), err => err.code === 'CONTRACT_INVALID', `createFixedClock(${JSON.stringify(bad) ?? bad}) must fail closed`);
    assert.throws(() => createSteppableClock(bad), err => err.code === 'CONTRACT_INVALID');
  }
  const clock = createSteppableClock('2026-10-27T00:00:00Z');
  for (const bad of [undefined, '60', NaN, Infinity]) {
    assert.throws(() => clock.advance(bad), err => err.code === 'CONTRACT_INVALID', `advance(${bad}) must fail closed`);
  }
});

test('M1 · sanitizeMessage 脱敏 Authorization/Bearer/sk-/cookie/api-key，非字符串回退', () => {
  assert.ok(!/Bearer\s+abc123/.test(sanitizeMessage('Authorization: Bearer abc123 was echoed')));
  assert.ok(!/sk-live999/.test(sanitizeMessage('upstream rejected sk-live999 for tenant t')));
  assert.ok(!/yum=secret/.test(sanitizeMessage('cookie: yum=secret; path=/')));
  assert.ok(!/hunter2/.test(sanitizeMessage('api_key=hunter2 rejected')));
  assert.ok(!/tok123/.test(sanitizeMessage('token: tok123 expired')));
  assert.equal(sanitizeMessage('Bearer abc123'), 'bearer [REDACTED]');
  assert.equal(sanitizeMessage(42), 'fail-closed error');
  assert.equal(sanitizeMessage('   '), 'fail-closed error');
});
