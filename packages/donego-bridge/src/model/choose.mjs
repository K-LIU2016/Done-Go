// GPT 自适应选模：纯函数实现 PRD §6.5.1 的复杂度、额度与让路策略。
// 输出可直接作为 trace 片段，quotaSnapshot 是输入额度的不可变快照。

const LADDER = [
  ['gpt-6.1-sol', 'xhigh'],
  ['gpt-6.1-sol', 'high'],
  ['gpt-6-sol', 'high'],
  ['gpt-6-sol', 'medium'],
  ['gpt-6-luna', 'medium'],
  ['gpt-6-luna', 'low'],
];

const clampNumber = (value, min, max, fallback) => Number.isFinite(value)
  ? Math.min(max, Math.max(min, value))
  : fallback;

function snapshot(rateLimits) {
  return {
    weeklyUsedPercent: clampNumber(rateLimits?.weeklyUsedPercent, 0, 100, 0),
    activeForeignThreads: Math.max(0, Math.floor(Number.isFinite(rateLimits?.activeForeignThreads) ? rateLimits.activeForeignThreads : 0)),
    spendControlReached: rateLimits?.spendControlReached === true,
  };
}

function choice(model, effort, reason, quotaSnapshot, flags = {}) {
  const result = {
    model,
    effort,
    reason,
    rateLimit: {
      weeklyUsed: quotaSnapshot.weeklyUsedPercent / 100,
      spendControlReached: quotaSnapshot.spendControlReached,
    },
  };
  // Keep the rich trace-only snapshot and control flags available to the runtime
  // without putting non-contract fields on the CodexChoice wire object.
  for (const [key, value] of Object.entries({ quotaSnapshot, ...flags })) {
    Object.defineProperty(result, key, { value, enumerable: false, writable: false });
  }
  return result;
}

function isComplex(planResult) {
  const plan = planResult && typeof planResult === 'object' ? planResult : {};
  const signals = plan.signals && typeof plan.signals === 'object' ? plan.signals : {};
  const files = Array.isArray(plan.files) ? plan.files : [];
  const sensitive = ['architecture', 'concurrency', 'performance', 'security', 'dataMigration'];
  return plan.crossModule === true
    || files.length > 8
    || sensitive.some(name => signals[name] === true)
    || (Array.isArray(plan.riskFlags) && plan.riskFlags.length >= 2);
}

function isStandard(planResult) {
  const plan = planResult && typeof planResult === 'object' ? planResult : {};
  const files = Array.isArray(plan.files) ? plan.files : [];
  const kinds = Array.isArray(plan.kinds) ? plan.kinds : [];
  const simpleKind = kinds.length > 0 && kinds.every(kind => ['doc', 'script', 'style'].includes(kind));
  const simple = files.length === 1 && Number.isFinite(plan.estimatedDiffLines)
    && plan.estimatedDiffLines < 50 && simpleKind && plan.crossModule !== true;
  return !simple && ((files.length >= 2 && files.length <= 8)
    || plan.needsNewTests === true
    || files.length === 1);
}

function baseTier(planResult, history) {
  if (isComplex(planResult)) {
    return ['gpt-6.1-sol', history?.consecutiveVerificationFailures >= 2 ? 'xhigh' : 'high'];
  }
  if (isStandard(planResult)) {
    return ['gpt-6-sol', history?.failedTestRuns >= 1 ? 'high' : 'medium'];
  }
  return ['gpt-6-luna', 'medium'];
}

function downgrade(tier) {
  const index = LADDER.findIndex(item => item[0] === tier[0] && item[1] === tier[1]);
  return LADDER[Math.min(LADDER.length - 1, Math.max(0, index < 0 ? LADDER.length - 1 : index + 1))];
}

/** §6.5.1: chooseModel(planResult, rateLimits, history). */
export function chooseModel(planResult = {}, rateLimits = {}, history = {}) {
  const quotaSnapshot = snapshot(rateLimits);
  if (quotaSnapshot.spendControlReached) {
    return choice('gpt-6-luna', 'low', 'SPEND_CONTROL_REACHED：暂停全部代码任务', quotaSnapshot, { pause: true });
  }

  const urgent = planResult?.urgent === true;
  if (!urgent && quotaSnapshot.activeForeignThreads > 0) {
    return choice('gpt-6-luna', 'low', '让路：本机存在活跃非 Done&Go Codex thread', quotaSnapshot, { defer: true });
  }

  let tier = baseTier(planResult, history);
  if (quotaSnapshot.weeklyUsedPercent > 90) {
    return choice(
      'gpt-6-luna',
      'low',
      '额度已用 >90%：只允许 luna，需 JC 决定是否继续',
      quotaSnapshot,
      { need: true },
    );
  }
  if (quotaSnapshot.weeklyUsedPercent > 70) {
    tier = downgrade(tier);
  }

  const [model, effort] = tier;
  return choice(
    model,
    effort,
    `${isComplex(planResult) ? '复杂' : isStandard(planResult) ? '标准' : '简单'}任务${quotaSnapshot.weeklyUsedPercent > 70 ? '，额度 >70% 降一级' : ''}`,
    quotaSnapshot,
  );
}

/** 评审必须选择与执行不同模型档位。 */
export function chooseReviewModel(execution) {
  if (!execution || typeof execution !== 'object') {
    throw new TypeError('execution choice must be an object');
  }
  if (String(execution.model || '').includes('sol')) {
    return { model: 'gpt-6-luna', effort: 'high' };
  }
  return { model: 'gpt-6-sol', effort: 'medium' };
}

export { LADDER };
