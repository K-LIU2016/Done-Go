// S2D-W13 · M16 projection 接缝（brief §4.4「projection」、plan.md §G2 M16、R-7 围栏）。
//
// 只读投影层：把各流的持久化/查询结果投影成消费方视图，绝不反向扩写任何流的表。
//   - W6 Preview 持久化与 Timeline projection 分离：投影复用 W6 纯函数
//     projectTimeline（scripts/agentic/preview/timeline.mjs，单一事实源，不在
//     集成层分叉），集成路径拿 Timeline VM 只能经 projectPreviewTimeline；
//   - W11 播放字段经 projectPlayback(vm) 从 VM 派生，Preview schema 永不生长
//     player/autoplay/playback 键（W6 timeline.mjs 头注的同一铁律）；
//   - W9 Artifact/Acceptance/Need 与 W10 trace/matrix 只经显式查询结果接入：
//     projectAcceptedBenefit 的入参是调用方显式查出的 acceptance+verdict 行
//     （形状对齐 W9 delivery/benefit.mjs + verifier/db-gate.mjs 的门禁语义），
//     投影本身不开 db、不写对方表；
//   - 模型来源门禁（红线 7 / brief §4.6）：resolved_model=NULL → UNKNOWN；
//     mock/fixture/cache-replay/unknown 来源、冲突或 stale 证据最多 PROVISIONAL，
//     绝不升级成 VERIFIED（W10 vocabulary VERIFIABLE_MODEL_SOURCES 为唯一可验证集）。
//
// 纯函数契约：无 IO、无时钟、无 db、无外部调用；输出为深拷贝，改输出不影响输入。

import { projectTimeline } from '../preview/timeline.mjs';
import { acceptedBenefit } from '../delivery/benefit.mjs';
import { EVIDENCE_STATUS } from '../observability/provenance.mjs';
import { VERIFIABLE_MODEL_SOURCES } from '../observability/vocabulary.mjs';

// ---------------- W6 → W11：Preview 持久化 ↔ Timeline projection 分离 ----------------

/**
 * 把一份已过 preview.schema.json 门（scripts/agentic/preview/validate.mjs）的
 * W6 Preview 投影成 W11 Timeline 视图模型。前置条件与 W6 projectTimeline 相同
 * （校验归 W6 门禁，投影保持 validation-free 的纯读变换，坏输入不在此吞错）。
 *
 * 分离铁律：本函数是集成路径获取 Timeline VM 的唯一入口；VM 里的一切播放便利
 * 字段只经 projectPlayback 向下消费，绝不回写 Preview 持久化。
 *
 * @param {object} preview schema-valid 的 Preview 值
 * @param {object|null} [source] 可选 store 元数据（previewId/revision/…）原样携带
 * @returns {object} W6 timeline VM（shots 1:1、旁白按句可原样拼回、未知组件降级并列 fallbacks）
 */
export function projectPreviewTimeline(preview, source = null) {
  return projectTimeline(preview, source);
}

/**
 * W11 播放字段消费点：从 Timeline VM 派生播放视图（时长/音轨），纯读、不落库。
 * Preview 持久化上永不出现 player/autoplay/timelineVm/playback 键；VM 缺字段时
 * 诚实降级（null / 空轨），不编造。
 *
 * @param {object} vm projectPreviewTimeline 的输出
 * @returns {{durationSec: number|null, tracks: Array}} 播放视图
 */
export function projectPlayback(vm) {
  const view = vm && typeof vm === 'object' ? vm : {};
  return {
    durationSec: typeof view.durationSec === 'number' ? view.durationSec : null,
    tracks: structuredClone(Array.isArray(view.tracks) ? view.tracks : []),
  };
}

// ---------------- W9：已验收收益投影（显式查询入参，不写对方表） ----------------

/**
 * 把 W9 显式查询出的 acceptance+verdict 行折算成 W9 verdictGate 摘要形状
 * （{blocking, unknownCount, highFailCount}）。语义逐条锚定
 * scripts/agentic/verifier/db-gate.mjs:5-47：
 *   - overall !== 'VERIFIED'（UNKNOWN/FAILED）一律 blocking（没有免费 VERIFIED）；
 *   - 任一 UNKNOWN check 阻断；HIGH+FAIL 阻断；仅 MEDIUM/LOW FAIL 不在此收紧；
 *   - 无任何核验结果（verdict 缺失）fail-closed → blocking（用户验收 ≠ agent 自报成功）。
 */
function verdictSummaryFromChecks(verdict) {
  if (verdict === null || typeof verdict !== 'object') return null;
  const checks = Array.isArray(verdict.checks) ? verdict.checks : [];
  const unknownCount = checks.filter((check) => check && check.status === 'UNKNOWN').length;
  const highFailCount = checks
    .filter((check) => check && check.status === 'FAIL' && check.severity === 'HIGH')
    .length;
  const overallBlocking = verdict.overall !== 'VERIFIED';
  return { blocking: overallBlocking || unknownCount > 0 || highFailCount > 0, unknownCount, highFailCount };
}

/**
 * 已验收收益投影（brief §5.5：revision_requested、UNKNOWN/HIGH 未决、跨 owner
 * acceptance 不计入收益，合法 accepted 才进投影）。
 *
 * 入参是调用方显式查询的结果行（本函数不开 db、不写 W9/W10 任何表）：
 *   { owner, acceptance:{actor, decision, artifactVersion}, verdict:{overall, checks[]} }
 *
 * 围栏顺序：owner 不匹配 / actor 不是 `user:<ownerId>`（跨 owner、agent 自验）
 * 的行在进入 W9 收益门禁前就被丢弃并记录原因；随后由 W9 acceptedBenefit
 * （scripts/agentic/delivery/benefit.mjs）做最终裁决——decision==='accepted'
 * 且 verdict 摘要 blocking===false 才计入。所有排除均带 reason，绝不静默丢行。
 *
 * @param {Array<object>} entries 显式查询结果
 * @param {string} ownerId 收益归属 owner
 * @returns {{count: number, included: Array<{artifactVersion}>, excluded: Array<{artifactVersion, reason}>}}
 */
export function projectAcceptedBenefit(entries, ownerId) {
  const included = [];
  const excluded = [];
  const rows = Array.isArray(entries) ? entries : [];
  const owner = typeof ownerId === 'string' && ownerId.length > 0 ? ownerId : null;

  for (const entry of rows) {
    const record = entry !== null && typeof entry === 'object' ? entry : {};
    const acceptance = record.acceptance !== null && typeof record.acceptance === 'object'
      ? record.acceptance
      : {};
    const artifactVersion = acceptance.artifactVersion ?? null;
    const drop = (reason, detail) => excluded.push({ artifactVersion, reason, ...detail });

    // 围栏 1：owner 归属——跨 owner 的 acceptance 不投影进本 owner 的收益。
    if (owner === null || record.owner !== owner) {
      drop('OWNER_MISMATCH');
      continue;
    }
    // 围栏 2：只有该 owner 自己的用户验收算收益；agent 验收/跨 owner 用户不算。
    if (acceptance.actor !== `user:${owner}`) {
      drop('ACTOR_NOT_USER_OWNER');
      continue;
    }
    // 围栏 3：非 accepted 决策（rejected/revision_requested/…）不是收益。
    if (acceptance.decision !== 'accepted') {
      drop(`DECISION_NOT_ACCEPTED:${acceptance.decision ?? 'none'}`);
      continue;
    }
    // 围栏 4：W9 门禁——无核验结果或 UNKNOWN/HIGH 未决 fail-closed。
    const summary = verdictSummaryFromChecks(record.verdict);
    if (acceptedBenefit(acceptance, summary) === null) {
      if (summary === null) {
        drop('VERDICT_MISSING');
      } else {
        drop('VERDICT_BLOCKING', { unknownCount: summary.unknownCount, highFailCount: summary.highFailCount });
      }
      continue;
    }
    included.push({ artifactVersion });
  }

  return { count: included.length, included, excluded };
}

// ---------------- W10：模型来源投影（只降级，不升级） ----------------

/**
 * 单 actor 模型来源投影（红线 7 / brief §4.6、W10 provenance/cache 语义）。
 *
 * 裁决阶梯逐条锚定 W10：
 *   - resolved_model 缺失/空白 → UNKNOWN，绝不从邻位/请求/缓存回填
 *     （vocabulary.mjs normalizeActor MODEL_MISSING 规则）；
 *   - 无任何证据 → UNKNOWN（provenance.mjs evidenceStatusFor：total===0）；
 *   - 来源不可验证（mock/fixture/cache-replay/unknown——非 W10
 *     VERIFIABLE_MODEL_SOURCES={gateway,local}）、证据冲突（同一 actor 两个模型，
 *     provenance.mjs actorRoster CONFLICT 规则）或 stale（cache.mjs：stale 永不算
 *     证据）→ 最多 PROVISIONAL；
 *   - 唯有可验证来源 + 一致证据才 VERIFIED。投影只能降级，不能升级。
 *
 * @param {{actor?: string, resolvedModel?: string|null, modelSource?: string,
 *          evidence?: object|Array, stale?: boolean}} input
 * @returns {{actor, resolvedModel, modelSource, status: 'VERIFIED'|'PROVISIONAL'|'UNKNOWN',
 *            evidence, reasons: string[]}} evidence 原样深拷贝回带
 */
export function projectModelProvenance(input = {}) {
  const record = input !== null && typeof input === 'object' ? input : {};
  const actor = record.actor ?? null;
  const modelSource = record.modelSource ?? 'unknown';
  const evidence = record.evidence === undefined || record.evidence === null
    ? []
    : structuredClone(record.evidence);
  const base = { actor, modelSource, evidence };

  // W10 MODEL_MISSING：无 resolved_model 即 UNKNOWN，任何来源/证据都救不回来。
  if (typeof record.resolvedModel !== 'string' || record.resolvedModel.trim().length === 0) {
    return { ...base, resolvedModel: null, status: EVIDENCE_STATUS.UNKNOWN, reasons: ['MODEL_MISSING'] };
  }
  const resolvedModel = record.resolvedModel;

  const reasons = [];
  if (!VERIFIABLE_MODEL_SOURCES.includes(modelSource)) {
    reasons.push(`MODEL_SOURCE_UNVERIFIABLE:${modelSource}`);
  }
  const evidenceList = Array.isArray(evidence) ? evidence : [evidence];
  if (evidenceList.length === 0) {
    reasons.push('EVIDENCE_MISSING');
  } else {
    // W10 actorRoster：同一 actor 声明两个不同模型 = 冲突；证据模型与
    // resolved_model 不一致同样冲突（证据不得反过来改写声明）。
    const declared = evidenceList
      .map((item) => (item !== null && typeof item === 'object' ? item.model : undefined))
      .filter((model) => model !== undefined && model !== null);
    if (new Set(declared).size > 1 || declared.some((model) => model !== resolvedModel)) {
      reasons.push('EVIDENCE_CONFLICT');
    }
  }
  if (record.stale === true) {
    reasons.push('EVIDENCE_STALE');
  }

  // W10 evidenceStatusFor 先例：无证据 → UNKNOWN；全部可验证且一致 → VERIFIED；
  // 其间一切（不可验证来源/冲突/stale）→ PROVISIONAL。
  const status = reasons.includes('EVIDENCE_MISSING')
    ? EVIDENCE_STATUS.UNKNOWN
    : (reasons.length === 0 ? EVIDENCE_STATUS.VERIFIED : EVIDENCE_STATUS.PROVISIONAL);
  return { ...base, resolvedModel, status, reasons };
}
