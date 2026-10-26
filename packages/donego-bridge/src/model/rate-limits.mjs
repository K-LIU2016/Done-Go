// Codex 额度快照的纯解析器：把 app-server 的响应归一化为桥内选模所需字段。
// 不保留上游对象引用，避免 trace 因上游响应变化而改变。

const numberOr = (value, fallback = 0) => Number.isFinite(value) ? value : fallback;

/**
 * 归一化 account/rateLimits/read 的结果。
 * 兼容测试夹具及 Codex 可能返回的 weekly.usedPercent 嵌套形状。
 */
export function parseRateLimits(input) {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) {
    throw new TypeError('rate limits must be an object');
  }

  const weekly = input.weekly && typeof input.weekly === 'object' ? input.weekly : {};
  const rawPercent = input.weeklyUsedPercent ?? weekly.usedPercent;
  const weeklyUsedPercent = Math.min(100, Math.max(0, numberOr(rawPercent)));
  const rawThreads = input.activeForeignThreads ?? input.activeThreads;
  const activeForeignThreads = Math.max(0, Math.floor(numberOr(rawThreads)));

  return {
    weeklyUsedPercent,
    spendControlReached: input.spendControlReached === true,
    activeForeignThreads,
  };
}
