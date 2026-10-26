// W12 现场感知 · ContextDelta 与建议卡（PRD §6.8.2 L491-493、prototype.html capcard L383-391）：
// 深感知结果 → ContextDelta 固定五字段形状（blockId/seen/change/risk/evidence），evidence 只
// 引用 captureId——快慢双路原地升级同一张卡，不换引用；建议卡 = 一句话建议 + 动作按钮
// （记下来/加待办/调整计划/设提醒/交给 agent 做，PRD L493），空模型输出优雅降级不炸卡片。
// 纯函数、零依赖、无 IO；pipeline.mjs 在 card.upgraded 时调用。
'use strict';

/**
 * 深感知结果 → ContextDelta（PRD §6.8.2 L491：{blockId, seen, change, risk, evidence(imageRef)}）。
 * seen 深感知缺失时回退快卡的一句话（即时卡已示人的描述不凭空消失）；change/risk 深缺省为
 * null（「没有变化填 null」，prompts.mjs 契约）；blockId 未归属（none/ambiguous）为 null。
 * @param {object} args
 * @param {string} args.captureId 捕获 id——evidence 的唯一引用（原地升级不换卡）
 * @param {string|null} args.blockId 归属块；none/ambiguous 时 null
 * @param {{seen?:string|null}} [args.fast] 快感知结果（seen 回退源）
 * @param {{seen?:string|null,change?:string|null,risk?:string|null}} [args.deep] 深感知结果
 * @returns {{blockId:string|null, seen:string|null, change:string|null, risk:string|null,
 *            evidence:{imageRef:string|null}}}
 */
export function buildContextDelta({ captureId, blockId, fast = {}, deep = {} } = {}) {
  return {
    blockId: blockId ?? null,
    seen: deep.seen ?? fast.seen ?? null,
    change: deep.change ?? null,
    risk: deep.risk ?? null,
    evidence: { imageRef: captureId ?? null },
  };
}

/**
 * ContextDelta + 深感知输出 → 建议卡（PRD §6.8.2 L493；prototype capcard L386-388 的
 * suggestion 一句话 + acts 动作按钮区）。actions 单字符串归一为一按钮（vision.mjs 同款
 * 归一规则）；非字符串/空白项丢弃；suggestion 非字符串降级空串——按钮区可为空但卡片在。
 * @param {object} args
 * @param {{blockId?:string|null}} [args.contextDelta] 已构建的 ContextDelta（取 blockId）
 * @param {string|null} [args.suggestion] 一句话建议
 * @param {string[]|string|null} [args.actions] 动作按钮文案（数组或单字符串）
 * @returns {{blockId:string|null, summary:string, actions:Array<{id:string,label:string}>}}
 */
export function buildSuggestionCard({ contextDelta = {}, suggestion, actions } = {}) {
  const raw = Array.isArray(actions)
    ? actions
    : typeof actions === 'string' && actions.trim() ? [actions] : [];
  const labels = raw.filter(a => typeof a === 'string' && a.trim());
  return {
    blockId: (contextDelta && contextDelta.blockId) ?? null,
    summary: typeof suggestion === 'string' ? suggestion : '',
    actions: labels.map((label, i) => ({ id: `act-${i + 1}`, label })),
  };
}
