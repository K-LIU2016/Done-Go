// W7 M4 · model-router-core — 纯模型选择函数（router.mjs）
//
// 依据：.s2d/plan.md M4；brief 裁决④（model-router 只返回结构化选择 + provenance，
// 不做真实调用、不读不打印 key）；红线⑥（provenance.decidedAt 只用注入 now，
// 绝不读真实 wall clock）。
//
// 跨组约束：G2 不 import G1（runtime/**）的任何文件（plan「无跨组源文件依赖」），
// 本模块自带最小 fail-closed 错误工厂；冻结契约校验器 `../contracts.mjs`（W0
// 骨架，全流共享）是唯一外部源依赖。
//
// 规则表（tests/unit/agentic/model-router/router.test.mjs 即规格）：
//   dataClass=secret        → 直接抛 FORBIDDEN（secret 永不进任何模型）
//   dataClass=sensitive     → 仅本地：localAvailable → selected(local)；
//                             否则 status='unknown'（绝不降级上云）
//   taskClass=code          → Codex 自适应路径（cloud, provider='codex'）：
//                             rateLimit.weeklyUsed>=0.9 或 spendControlReached
//                             或 budget.tokens<8000 → gpt-6-luna/low；
//                             否则 gpt-6.1-sol/high。产出 codexChoice 必须
//                             通过冻结 codex-choice.schema.json（构造后自检）。
//   taskClass=reason        → gpt-6-sol（cloud, provider='codex'）
//   taskClass=summarize     → localAvailable → local('local-small')；
//                             否则 gpt-6-luna（cloud）
//   其余 taskClass          → status='unknown'（不猜默认模型）
//   输入非法/缺注入          → CONTRACT_INVALID / BUDGET_EXCEEDED（fail closed）

import { createHash } from 'node:crypto';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValid, canonicalJson, loadSchema } from '../contracts.mjs';

// ---------------- 自带最小 fail-closed 错误工厂（对齐冻结 api-error 枚举） ----------------

/** 本模块用到的错误码（冻结 api-error.schema.json 枚举的子集）。 */
const ROUTER_ERROR_CODES = new Set(['FORBIDDEN', 'BUDGET_EXCEEDED', 'CONTRACT_INVALID']);

/**
 * 构造结构化 fail-closed 错误。未知码是编程错误，立即抛 TypeError，
 * 绝不编造枚举外的码。message 只描述选择输入的类别/数值，不含凭据正文
 * （本模块根本接触不到 key：真实调用归注入 transport，M5/W13 接线）。
 */
function fail(code, message) {
  if (!ROUTER_ERROR_CODES.has(code)) {
    throw new TypeError(`invalid router error code ${String(code)}`);
  }
  const error = new Error(message);
  error.code = code;
  return error;
}

// ---------------- 冻结 schema（只读，懒加载缓存） ----------------

const DEFAULT_SCHEMA_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '../../../contracts/agentic');

let codexChoiceSchemaCache;

/** 懒加载冻结 codex-choice.schema.json（每进程一次；FROZEN v1 只读）。 */
function codexChoiceSchema() {
  if (codexChoiceSchemaCache === undefined) {
    codexChoiceSchemaCache = loadSchema('codex-choice.schema.json', DEFAULT_SCHEMA_DIR);
  }
  return codexChoiceSchemaCache;
}

// ---------------- 常量与规则参数 ----------------

/** 数据分级（冻结契约体系 public/personal/sensitive/secret 的交集语义）。 */
const DATA_CLASSES = ['public', 'personal', 'sensitive', 'secret'];

/** Codex 自适应降档阈值（PRD §6.5.1：限流压力 / 轻任务降 luna-low）。 */
const RATE_LIMIT_WEEKLY_PRESSURE = 0.9;
const LIGHT_TASK_TOKENS = 8000;

const CODEX_LOCAL = 'local-small';
const RULE_SENSITIVE = 'sensitive-local-only';
const RULE_CODEX_ADAPTIVE = 'code-codex-adaptive';
const RULE_REASON = 'reason-sol';
const RULE_SUMMARIZE = 'summarize-local-first';
const RULE_NO_MATCH = 'no-rule-match';

// ---------------- 输入校验（负面路径优先，全部 fail closed） ----------------

function requireNonEmptyString(value, label, code = 'CONTRACT_INVALID') {
  if (typeof value !== 'string' || value.length === 0) {
    throw fail(code, `${label} must be a non-empty string (got ${value === null ? 'null' : typeof value})`);
  }
  return value;
}

function validateBudget(budget) {
  if (budget === null || typeof budget !== 'object' || Array.isArray(budget)) {
    throw fail('CONTRACT_INVALID', 'opts.budget is required as { calls, tokens } for an auditable selection');
  }
  for (const key of ['calls', 'tokens']) {
    const value = budget[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw fail('CONTRACT_INVALID', `opts.budget.${key} must be a finite number >= 0 (got ${typeof value})`);
    }
  }
  if (budget.calls === 0 || budget.tokens === 0) {
    throw fail('BUDGET_EXCEEDED', `budget exhausted (calls=${budget.calls}, tokens=${budget.tokens}); no budget → no model selection`);
  }
  return budget;
}

function validateRateLimit(rateLimit) {
  if (rateLimit === undefined || rateLimit === null) return undefined;
  if (typeof rateLimit !== 'object' || Array.isArray(rateLimit)) {
    throw fail('CONTRACT_INVALID', 'opts.rateLimit, when provided, must be { weeklyUsed: 0..1, spendControlReached?: boolean }');
  }
  const { weeklyUsed, spendControlReached } = rateLimit;
  if (typeof weeklyUsed !== 'number' || !Number.isFinite(weeklyUsed) || weeklyUsed < 0 || weeklyUsed > 1) {
    throw fail('CONTRACT_INVALID', 'opts.rateLimit.weeklyUsed must be a number in [0, 1]');
  }
  if (spendControlReached !== undefined && typeof spendControlReached !== 'boolean') {
    throw fail('CONTRACT_INVALID', 'opts.rateLimit.spendControlReached must be a boolean when present');
  }
  return { weeklyUsed, spendControlReached };
}

function validateInjectedNow(now) {
  if (typeof now !== 'string' || now.length === 0 || !Number.isFinite(Date.parse(now))) {
    // 红线⑥：decidedAt 不允许来自真实 wall clock，只接受注入的确定性时刻。
    throw fail('CONTRACT_INVALID', 'opts.now is required: inject an ISO-8601 date-time for provenance.decidedAt (real wall clock is forbidden)');
  }
  return now;
}

/** 决策输入哈希：对选择真正起作用的输入做 canonical JSON 后取 sha-256。不含 decidedAt。 */
function hashInputs({ taskClass, dataClass, actor, budget, localAvailable, rateLimit }) {
  const inputs = { taskClass, dataClass, actor, budget, localAvailable };
  if (rateLimit !== undefined) inputs.rateLimit = rateLimit;
  return createHash('sha256').update(canonicalJson(inputs)).digest('hex');
}

function provenance(rule, inputsHash, decidedAt) {
  return { rule, inputsHash, decidedAt };
}

// ---------------- Codex 自适应路径（code taskClass） ----------------

/**
 * 构造并通过冻结 codex-choice.schema.json 自检的 CodexChoice。
 * 未注入 rateLimit 时按 schema 要求补 weeklyUsed=0（无压力信号），
 * 并在 reason 里如实说明，便于审计。
 */
function buildCodexChoice({ tier, rateLimit, cause }) {
  const choice = {
    model: tier.model,
    effort: tier.effort,
    reason: cause,
    rateLimit: rateLimit === undefined
      ? { weeklyUsed: 0 }
      : { weeklyUsed: rateLimit.weeklyUsed, ...(rateLimit.spendControlReached === undefined ? {} : { spendControlReached: rateLimit.spendControlReached }) },
  };
  return assertValid(choice, codexChoiceSchema(), { schemaDir: DEFAULT_SCHEMA_DIR });
}

function codexTier({ budget, rateLimit }) {
  const pressured = rateLimit !== undefined
    && (rateLimit.weeklyUsed >= RATE_LIMIT_WEEKLY_PRESSURE || rateLimit.spendControlReached === true);
  if (pressured) {
    const cause = rateLimit.spendControlReached === true
      ? 'rate-limit spend control reached: downgrade to gpt-6-luna/low'
      : `rate-limit pressure (weeklyUsed=${rateLimit.weeklyUsed}>=${RATE_LIMIT_WEEKLY_PRESSURE}): downgrade to gpt-6-luna/low`;
    return { model: 'gpt-6-luna', effort: 'low', cause };
  }
  if (budget.tokens < LIGHT_TASK_TOKENS) {
    return { model: 'gpt-6-luna', effort: 'low', cause: `light task (budget.tokens=${budget.tokens}<${LIGHT_TASK_TOKENS}): downgrade to gpt-6-luna/low` };
  }
  return { model: 'gpt-6.1-sol', effort: 'high', cause: `standard code task (budget.tokens=${budget.tokens}): gpt-6.1-sol/high` };
}

// ---------------- 纯选择函数 ----------------

/**
 * 选择模型（纯函数：不做真实调用、不读 key、不读真实时钟、不落盘）。
 *
 * @param {string} taskClass 任务类别（code|reason|summarize|…；未知 → unknown，不猜默认）
 * @param {string} dataClass 数据分级（public|personal|sensitive|secret）
 * @param {object} opts
 *   - actor           必填：显式绑定的 actor 标识（brief ⑦：所有 actor 显式绑定模型）
 *   - budget          必填：{ calls, tokens }，任一为 0 → BUDGET_EXCEEDED
 *   - localAvailable  必填 boolean：本地模型是否可用
 *   - now             必填：ISO-8601 确定性时刻 → provenance.decidedAt
 *   - rateLimit       可选：{ weeklyUsed: 0..1, spendControlReached?: boolean }
 * @returns {{status:'selected'|'unknown', model?, provider?, locality?,
 *            provenance:{rule, inputsHash, decidedAt}, reason, codexChoice?}}
 * @throws FORBIDDEN（secret 永不进模型）/ BUDGET_EXCEEDED（额度为 0）/ CONTRACT_INVALID（输入非法或缺注入）
 */
export function selectModel(taskClass, dataClass, opts) {
  requireNonEmptyString(taskClass, 'taskClass');
  if (typeof dataClass !== 'string' || !DATA_CLASSES.includes(dataClass)) {
    throw fail('CONTRACT_INVALID', `dataClass must be one of ${DATA_CLASSES.join('|')} (got ${dataClass === null ? 'null' : JSON.stringify(dataClass)})`);
  }
  if (dataClass === 'secret') {
    // secret 永不进任何模型：直接拒，不是 unknown，也不产出任何决策。
    throw fail('FORBIDDEN', `dataClass=secret must never be sent to any model (taskClass=${taskClass})`);
  }
  if (opts === null || typeof opts !== 'object' || Array.isArray(opts)) {
    throw fail('CONTRACT_INVALID', 'opts is required: { actor, budget, localAvailable, now, rateLimit? }');
  }
  requireNonEmptyString(opts.actor, 'opts.actor');
  validateBudget(opts.budget);
  if (typeof opts.localAvailable !== 'boolean') {
    throw fail('CONTRACT_INVALID', 'opts.localAvailable must be an explicit boolean (local availability must not be guessed)');
  }
  const decidedAt = validateInjectedNow(opts.now);
  const rateLimit = validateRateLimit(opts.rateLimit);

  const inputsHash = hashInputs({ taskClass, dataClass, actor: opts.actor, budget: opts.budget, localAvailable: opts.localAvailable, rateLimit });

  // 分级闸门：sensitive 仅本地，本地不可用绝不降级上云。
  if (dataClass === 'sensitive') {
    if (!opts.localAvailable) {
      return {
        status: 'unknown',
        provenance: provenance(RULE_SENSITIVE, inputsHash, decidedAt),
        reason: 'dataClass=sensitive allows local models only and none is available; refusing to degrade to cloud',
      };
    }
    return {
      status: 'selected',
      model: CODEX_LOCAL,
      provider: 'local',
      locality: 'local',
      provenance: provenance(RULE_SENSITIVE, inputsHash, decidedAt),
      reason: 'dataClass=sensitive routed to the local model; cloud is not allowed for this data class',
    };
  }

  switch (taskClass) {
    case 'code': {
      const tier = codexTier({ budget: opts.budget, rateLimit });
      const codexChoice = buildCodexChoice({ tier, rateLimit, cause: tier.cause });
      return {
        status: 'selected',
        model: tier.model,
        provider: 'codex',
        locality: 'cloud',
        provenance: provenance(RULE_CODEX_ADAPTIVE, inputsHash, decidedAt),
        reason: tier.cause,
        codexChoice,
      };
    }
    case 'reason':
      return {
        status: 'selected',
        model: 'gpt-6-sol',
        provider: 'codex',
        locality: 'cloud',
        provenance: provenance(RULE_REASON, inputsHash, decidedAt),
        reason: 'reasoning task routed to gpt-6-sol (cloud)',
      };
    case 'summarize':
      if (opts.localAvailable) {
        return {
          status: 'selected',
          model: CODEX_LOCAL,
          provider: 'local',
          locality: 'local',
          provenance: provenance(RULE_SUMMARIZE, inputsHash, decidedAt),
          reason: 'summarization routed to the local model first (local available)',
        };
      }
      return {
        status: 'selected',
        model: 'gpt-6-luna',
        provider: 'codex',
        locality: 'cloud',
        provenance: provenance(RULE_SUMMARIZE, inputsHash, decidedAt),
        reason: 'no local model available; summarization falls back to gpt-6-luna (cloud, non-sensitive data)',
      };
    default:
      // 无规则命中：不猜默认模型，交由调用方按 UNKNOWN 处理（不得视为完成）。
      return {
        status: 'unknown',
        provenance: provenance(RULE_NO_MATCH, inputsHash, decidedAt),
        reason: `no routing rule for taskClass=${taskClass}; refusing to guess a default model`,
      };
  }
}
