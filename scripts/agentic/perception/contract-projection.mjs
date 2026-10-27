// W12 感知产物 → W0 冻结契约（FROZEN v1 b9d9bdf）的投影适配器（BUILD-PLAN §2.2 L55
// 收尾一致性测试用）。W0 schema 与 PRD §6.8.2 字面形状存在两处已知分叉（risk 枚举 vs
// 自由文本/空、全字段必填非空 vs 流水线天然的 null——未归属/无变化/快卡阶段）；原第三
// 处「evidence 字符串数组 vs {imageRef}」分叉已随 60fdc73 对齐消除——b9d9bdf 冻结
// schema 的 evidence 即 {imageRef}（与本流内部形状一致，投影直接产出该对象）：
//   1. 本模块不改动冻结契约（contracts/agentic/** 归 W0），只做「能投影则投影」；
//   2. 投影成功条件：blockId/seen/change（+change 非空、evidence.imageRef 非空）齐备，
//      risk null→'none'，自由文本 risk 仅接受可分类关键词，不可分则拒投影（不编造枚举）；
//   3. 投影不满足条件返回 {ok:false, reason}，调用方（事件总线/第 2 批 Block Agent）
//      据此决定暂缓发布——这是 schema 表达力缺口，已列终报「待 CTO 裁决」。
// 动作 kind 映射依据 prompts.mjs 深感知提示词的封闭动词表（记下来/加待办/调整计划/
// 设提醒/交给 agent 做 ↔ remember/todo/adjust/remind/delegate），未命中关键词的标签
// 保守落 remember（只记录、不触发外部动作；回退规则待 CTO 批准，终报有列）。
'use strict';

/** 自由文本 risk → 契约枚举；null/空 → 'none'；可分类关键词 → 对应档；否则 null（不可分）。 */
export function mapRisk(risk) {
  if (risk === null || risk === undefined || String(risk).trim() === '' || /^(none|无)$/i.test(String(risk).trim())) return 'none';
  const text = String(risk).trim();
  if (/高|严重|high|critical/i.test(text)) return 'high';
  if (/中|可能|potential|medium/i.test(text)) return 'medium';
  if (/低|轻微|low|minor/i.test(text)) return 'low';
  return null; // 不可分类：宁可拒投影也不编造枚举档位
}

const ACTION_KINDS = [
  [/待办|todo/i, 'todo'],
  [/调整|改期|顺延|adjust/i, 'adjust'],
  [/提醒|remind/i, 'remind'],
  [/agent|代理|委托|delegate/i, 'delegate'],
  [/记|保存|remember/i, 'remember'],
];
const DEFAULT_ACTION_KIND = 'remember'; // 未命中关键词的标签保守落「只记录」；待 CTO 批准

/** 建议卡动作标签 → 契约 kind（remember/todo/adjust/remind/delegate）。 */
export function mapActionKind(label) {
  const text = String(label ?? '');
  for (const [re, kind] of ACTION_KINDS) if (re.test(text)) return kind;
  return DEFAULT_ACTION_KIND;
}

const nonEmpty = v => (typeof v === 'string' ? v.trim() : null);

/**
 * 感知 ContextDelta（PRD §6.8.2 五字段形状）→ W0 context-delta.schema.json。
 * @returns {{ok:true, value:object}|{ok:false, reason:string}}
 *   拒投影原因：missing-blockId / missing-seen / missing-change（含「无变化填 null」的
 *   正常情形——契约 schema 表达不了「暂无变化」，列待裁决）/ missing-evidence /
 *   unmappable-risk。
 */
export function toContractContextDelta(contextDelta = {}) {
  const blockId = nonEmpty(contextDelta.blockId);
  if (!blockId) return { ok: false, reason: 'missing-blockId' };
  const seen = nonEmpty(contextDelta.seen);
  if (!seen) return { ok: false, reason: 'missing-seen' };
  const change = nonEmpty(contextDelta.change);
  if (!change) return { ok: false, reason: 'missing-change' }; // 「无变化」按提示词契约是 null——schema 表达力缺口
  const imageRef = contextDelta.evidence && nonEmpty(contextDelta.evidence.imageRef);
  if (!imageRef) return { ok: false, reason: 'missing-evidence' };
  const risk = mapRisk(contextDelta.risk);
  if (risk === null) return { ok: false, reason: 'unmappable-risk' };
  return { ok: true, value: { blockId, seen, change, risk, evidence: { imageRef } } };
}

/**
 * 感知建议卡（context-delta.mjs buildSuggestionCard 形状）→ W0 suggestion-card.schema.json。
 * @param {object} args
 * @param {string} args.captureId 卡片唯一 id 来源（evidence 原地升级不换卡 → sc-<captureId>）
 * @param {{blockId:string|null, summary:string, actions:Array<{id,label}>}} args.card
 * @param {'fast'|'deep'} [args.level] fast→instant、deep→upgraded（快慢同卡两态）
 * @returns {{ok:true, value:object}|{ok:false, reason:string}}
 */
export function toContractSuggestionCard({ captureId, card = {}, level = 'deep' } = {}) {
  const id = nonEmpty(captureId) ? `sc-${captureId}` : null;
  if (!id) return { ok: false, reason: 'missing-capture-id' };
  const blockId = nonEmpty(card.blockId);
  if (!blockId) return { ok: false, reason: 'missing-blockId' };
  const text = nonEmpty(card.summary);
  if (!text) return { ok: false, reason: 'missing-text' };
  const actions = Array.isArray(card.actions) ? card.actions : [];
  if (actions.length === 0) return { ok: false, reason: 'missing-actions' };
  return {
    ok: true,
    value: {
      id,
      blockId,
      text,
      actions: actions.map((a, i) => ({
        id: nonEmpty(a && a.id) || `act-${i + 1}`,
        label: String(a.label),
        kind: mapActionKind(a.label),
      })),
      status: level === 'fast' ? 'instant' : 'upgraded',
    },
  };
}
