// W7 M1 · runtime-ports — 注入端口的形状定义与工厂校验（ports.mjs）
//
// 依据：.s2d/plan.md M1；brief 裁决②④⑤。
// 本文件只做「纯结构定义 + 工厂校验」，不实现任何业务判定：
//   - policyPort.check(ctx, action) → Promise|{ allow: boolean, reason?, need? }
//     （决策归注入的 policy port；W13 用 W4 adapter 接入，W7 不复制 A0–A5）
//   - modelCaller(req) → Promise|{ ok, content?, model?, usage?, error? }
//     （真实模型调用走注入的 OpenAI-compatible transport，绝不联网）
//   - toolCaller(tool, args, ctx) → 结构化工具结果（M6/M7 定义具体形状）
//   - spanSink.record(span) 可选记录器（trace 存储归 W6/W13）
//   - clock.now() → epoch ms（确定性时钟：只允许注入值，禁止真实 wall clock）
//
// fail closed：任一必需端口缺失或形状不对 → 构造期抛结构化错误，
// 绝不静默降级（brief 裁决②）。时钟（红线⑥）全部可注入：预算窗口、
// expiry、checkpoint 时间不得依赖 Date.now()。

import { failClosed } from './errors.mjs';

function isFunction(value) {
  return typeof value === 'function';
}

function isPortObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * policyPort 是必需端口：缺少 / 非对象 / 无 check / check 非函数 → fail closed。
 * 返回原对象（不包装、不代理），保持注入端口的引用透明。
 */
export function validatePolicyPort(port) {
  if (!isPortObject(port)) {
    throw failClosed(
      'CONTRACT_INVALID',
      `policyPort is required and must be an object carrying check(ctx, action) (got ${port === null ? 'null' : typeof port})`,
    );
  }
  if (!isFunction(port.check)) {
    throw failClosed('CONTRACT_INVALID', 'policyPort.check must be a function check(ctx, action) → { allow, reason?, need? }; missing or non-function check');
  }
  return port;
}

/** modelCaller 是必需端口（注入的 OpenAI-compatible transport 适配器）。 */
export function validateModelCaller(caller) {
  if (!isFunction(caller)) {
    throw failClosed(
      'CONTRACT_INVALID',
      `modelCaller must be an injected function modelCaller(req) → { ok, content?, model?, usage?, error? } (got ${caller === null ? 'null' : typeof caller})`,
    );
  }
  return caller;
}

/** toolCaller 是必需端口（注入的工具执行适配器，形状由 M6/M7 定义）。 */
export function validateToolCaller(caller) {
  if (!isFunction(caller)) {
    throw failClosed(
      'CONTRACT_INVALID',
      `toolCaller must be an injected function (got ${caller === null ? 'null' : typeof caller})`,
    );
  }
  return caller;
}

/** spanSink 可选：缺省（undefined/null）直接放行；给了则必须形如 { record(span) }。 */
export function validateSpanSink(sink) {
  if (sink === undefined || sink === null) return sink;
  if (!isPortObject(sink) || !isFunction(sink.record)) {
    throw failClosed('CONTRACT_INVALID', 'spanSink is optional; when provided it must be an object with a record(span) function');
  }
  return sink;
}

/** clock 是必需端口：必须带 now() 函数。真实 wall clock 禁止注入为确定性时钟。 */
export function validateClock(clock) {
  if (!isPortObject(clock) || !isFunction(clock.now)) {
    throw failClosed('CONTRACT_INVALID', 'clock must be injected with a now() function returning epoch ms (deterministic time only; real wall clock is forbidden)');
  }
  return clock;
}

/** decision 形状校验：policyPort.check 的结果必须是 { allow: boolean, reason?, need? }。 */
export function readPolicyDecision(decision) {
  if (!isPortObject(decision) || typeof decision.allow !== 'boolean') {
    throw failClosed('CONTRACT_INVALID', 'policyPort.check must resolve to { allow: boolean, reason?, need? }');
  }
  if (decision.reason !== undefined && typeof decision.reason !== 'string') {
    throw failClosed('CONTRACT_INVALID', 'policy decision reason must be a string when present');
  }
  if (decision.need !== undefined && typeof decision.need !== 'string') {
    throw failClosed('CONTRACT_INVALID', 'policy decision need must be a string when present');
  }
  return decision;
}

/**
 * 调用注入的 policyPort.check 并把「抛错」也变成 fail closed（拒绝执行），
 * 而不是把异常吞掉后放行。只做包装，不做任何决策。
 */
export async function policyCheck(port, ctx, action) {
  let decision;
  try {
    decision = await port.check(ctx, action);
  } catch (cause) {
    const details = typeof cause?.code === 'string' ? { causeCode: cause.code } : {};
    throw failClosed('FORBIDDEN', 'policy port check threw; failing closed without executing the action', details);
  }
  return readPolicyDecision(decision);
}

/**
 * 一次性校验并绑定全部运行时端口。任何一个必需端口缺失 → 构造失败，
 * 不会得到部分可用的运行时（brief 裁决②）。
 */
export function bindRuntimePorts({ policyPort, modelCaller, toolCaller, spanSink, clock } = {}) {
  validatePolicyPort(policyPort);
  validateModelCaller(modelCaller);
  validateToolCaller(toolCaller);
  validateSpanSink(spanSink);
  validateClock(clock);
  return { policyPort, modelCaller, toolCaller, spanSink, clock };
}

// ---------------- 确定性时钟（红线⑥） ----------------

function parseEpochMs(iso, label) {
  if (typeof iso !== 'string' || iso.trim() === '') {
    throw failClosed('CONTRACT_INVALID', `${label} requires an ISO-8601 date-time string (deterministic injected time)`);
  }
  const epochMs = Date.parse(iso);
  if (!Number.isFinite(epochMs)) {
    throw failClosed('CONTRACT_INVALID', `${label} could not parse ISO-8601 date-time for the injected clock`);
  }
  return epochMs;
}

/** 固定时钟：now() 恒等于注入时刻的 epoch ms，多次调用不变。 */
export function createFixedClock(iso) {
  const epochMs = parseEpochMs(iso, 'createFixedClock');
  return { now: () => epochMs };
}

/** 可步进时钟：advance(ms) 只按注入步长移动；支持回拨（负步长）以便测试预算窗口。 */
export function createSteppableClock(iso) {
  let epochMs = parseEpochMs(iso, 'createSteppableClock');
  return {
    now: () => epochMs,
    advance: (ms) => {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) {
        throw failClosed('CONTRACT_INVALID', 'steppable clock advance(ms) requires a finite number of milliseconds');
      }
      epochMs += ms;
      return epochMs;
    },
  };
}
