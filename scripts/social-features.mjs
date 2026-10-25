// scripts/social-features.mjs — 同频（社交游戏化）流派与相似度纯函数（S2 线）。
//
// 依据：design/social-sync/PRD.md §3.2（六种时间流派）、§3.3（同频匹配）；
// 形状契约一律 import web/social/contracts.js（commit 1b5c2b2），本文件绝不
// 重定义流派 id/权重/边界 —— 只实现判定与计算的纯函数 + 可配置阈值（D3）。
//
// 纯模块：无 DOM、无 fetch、无存储 IO，node --test 与浏览器 dynamic import
// 均可直接使用。不含任何个人内容 —— 证据与理由只用占比、计数和用法库的
// 公共场景归类（D2：事项标题/材料/时间永不出现）。
//
// 判定口径（PRD §3.2 表是"示意，做成可配置阈值"，以下为本线落实的默认值
// 与解释，全部可通过 resolveStyleConfig 覆盖）：
// - 晨光整理派：dawn+morning ≥ 0.50 且「整理」类用法 ≥ 2 个。
// - 深夜创作派：evening+night ≥ 0.45 且 kindMix.create ≥ 0.30。
// - 接力达人派：relays ≥ 8 且 graduations ≥ 2（PRD 原文数值）。
// - 生活慢行派：freedTo 的 family+rest+exercise 合计 ≥ 0.60。
// - 学术攀登派：「读」类用法（论文/文献/阅读，用法库 category）占用法总数
//   ≥ 0.50 且「读」类用法 ≥ 2 个。
// - 多线并行派：kindMix 归一化熵（以 log2(6) 为满）≥ 0.85 且本周用法数
//   ≥ 5（§3.1 画像没有事项计数字段，「事项多」以本周用法种类数代理）。
// 多个流派同时强命中时按 contracts.STYLE_IDS（= PRD §3.2 表序）取第一个；
// 全都不命中时取主指标最接近的流派并在证据首行诚实标注"特征还不明显"，
// 保证每周都能出卡（validateStyleCard 要求 style ∈ 6 种、证据 1–3 条）。
//
// 用法归类快照派生自 web/relay/scenes.zh.json（version 1，50 个用法）；
// tests/unit/social-features.test.mjs 用 fs 读库做漂移校验，库更新时必须
// 同步本快照，或经 opts.usageCategories 注入新映射。

import {
  STYLES, STYLE_IDS, KIND_MIX_KEYS, RHYTHM_KEYS, FREED_TO_KEYS,
  MATCH_WEIGHTS, MATCHES_PER_WEEK, MATCH_RECENT_USAGES_MAX,
  isUsageId, validateStyleCard, validateMatch,
} from '../web/social/contracts.js';
import { CATEGORIES } from '../web/relay/contracts.js';

// ---------------------------------------------------------------------------
// 用法归类快照（读库漂移校验锁同步；未知 id 一律算未归类，绝不猜）。
// ---------------------------------------------------------------------------
export const USAGE_CATEGORIES = Object.freeze({
  // 读
  'paper-read': '读', 'survey-read': '读', 'code-debug': '读', 'doc-read': '读',
  'contract-check': '读', 'long-doc': '读', 'tool-learn': '读', 'bill-question': '读',
  'policy-read': '读', 'appliance-manual': '读',
  // 写
  'advisor-mail': '写', 'resume-edit': '写', 'presentation-prep': '写', 'lab-report': '写',
  'comments-30': '写', 'parent-notice': '写', 'class-speech': '写', 'quiz-10': '写',
  'peer-review': '写', 'parent-meeting': '写', 'email-work': '写', 'weekly-report': '写',
  'excel-formula': '写', 'reply-difficult': '写', 'report-page': '写', 'reunion-message': '写',
  'old-photo': '写', 'memoir-write': '写',
  // 整理
  'meeting-notes': '整理', 'notes-condense': '整理', 'wrong-questions': '整理',
  'refs-format': '整理', 'grade-analysis': '整理', 'data-summary': '整理',
  // 翻译
  'abstract-en': '翻译', 'doc-translate': '翻译',
  // 计划
  'homework-plan': '计划', 'lesson-plan': '计划', 'tutor-plan': '计划',
  'student-talk': '计划', 'quiz-review': '计划', 'trip-plan': '计划',
  'meeting-prep': '计划', 'interview-prep': '计划', 'med-schedule': '计划',
  'exercise-plan': '计划',
  // 生活
  'ask-doctor': '生活', 'phone-usage': '生活', 'scam-check': '生活', 'recipe-plan': '生活',
});

export function usageCategoryCounts(usages, usageCategories = USAGE_CATEGORIES) {
  const counts = {};
  for (const category of CATEGORIES) counts[category] = 0;
  counts.__total__ = Array.isArray(usages) ? usages.length : 0;
  if (Array.isArray(usages)) {
    for (const id of usages) {
      const category = usageCategories ? usageCategories[id] : undefined;
      if (category != null && category in counts) counts[category] += 1;
    }
  }
  return counts;
}

// ---------------------------------------------------------------------------
// 画像形状检查（轻量结构校验：调用方应先过 contracts.validateFeaturesUpload；
// 这里只保证纯函数不吞 NaN —— 坏输入抛 TypeError，绝不静默给出假数字）。
// ---------------------------------------------------------------------------
function finiteNumber(value, path) {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('画像字段必须是有限数字：' + path);
  }
  return value;
}

function requireRatioMap(features, key, keys) {
  const map = features[key];
  if (!map || typeof map !== 'object' || Array.isArray(map)) {
    throw new TypeError('画像缺少占比对象：' + key);
  }
  for (const k of keys) finiteNumber(map[k], key + '.' + k);
  return map;
}

function requireFeatures(features) {
  if (!features || typeof features !== 'object' || Array.isArray(features)) {
    throw new TypeError('画像必须是对象');
  }
  requireRatioMap(features, 'kindMix', KIND_MIX_KEYS);
  requireRatioMap(features, 'rhythm', RHYTHM_KEYS);
  requireRatioMap(features, 'freedTo', FREED_TO_KEYS);
  if (!Array.isArray(features.usages) || features.usages.some((id) => typeof id !== 'string')) {
    throw new TypeError('画像 usages 必须是字符串数组');
  }
  finiteNumber(features.relays, 'relays');
  finiteNumber(features.graduations, 'graduations');
  finiteNumber(features.freedMinutesConfirmed, 'freedMinutesConfirmed');
  return features;
}

// ---------------------------------------------------------------------------
// 可配置阈值（D3）。share 类 ∈ (0,1]；count 类为 ≥0 整数；未知键一律拒绝。
// ---------------------------------------------------------------------------
export const STYLE_THRESHOLD_DEFAULTS = Object.freeze({
  morningSorter: Object.freeze({ minDayShare: 0.5, minOrganizeUsages: 2 }),
  nightCreator: Object.freeze({ minLateShare: 0.45, minCreateShare: 0.3 }),
  relayAce: Object.freeze({ minRelays: 8, minGraduations: 2 }),
  slowLiver: Object.freeze({ minLifeShare: 0.6 }),
  academicClimber: Object.freeze({ minReadShare: 0.5, minReadUsages: 2 }),
  parallelRunner: Object.freeze({ minEntropy: 0.85, minUsages: 5 }),
});

const THRESHOLD_KINDS = {
  minDayShare: 'ratio', minLateShare: 'ratio', minCreateShare: 'ratio',
  minLifeShare: 'ratio', minReadShare: 'ratio', minEntropy: 'ratio',
  minOrganizeUsages: 'count', minReadUsages: 'count', minRelays: 'count',
  minGraduations: 'count', minUsages: 'count',
};

function checkThreshold(styleKey, key, value) {
  const kind = THRESHOLD_KINDS[key];
  if (!kind) throw new TypeError('未知阈值字段：' + styleKey + '.' + key);
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    throw new TypeError('阈值必须是数字：' + styleKey + '.' + key);
  }
  if (kind === 'ratio' && (value <= 0 || value > 1)) {
    throw new TypeError('占比阈值必须在 (0,1]：' + styleKey + '.' + key);
  }
  if (kind === 'count' && (!Number.isInteger(value) || value < 0)) {
    throw new TypeError('计数阈值必须是 ≥0 整数：' + styleKey + '.' + key);
  }
  return value;
}

function validatedStyleConfig(source) {
  const out = {};
  for (const styleKey of Object.keys(STYLE_THRESHOLD_DEFAULTS)) {
    const merged = {};
    const defaults = STYLE_THRESHOLD_DEFAULTS[styleKey];
    for (const key of Object.keys(defaults)) merged[key] = checkThreshold(styleKey, key, defaults[key]);
    const override = source[styleKey];
    if (override != null) {
      if (typeof override !== 'object' || Array.isArray(override)) {
        throw new TypeError('流派配置必须是对象：' + styleKey);
      }
      for (const key of Object.keys(override)) {
        if (!(key in defaults)) throw new TypeError('未知阈值字段：' + styleKey + '.' + key);
        merged[key] = checkThreshold(styleKey, key, override[key]);
      }
    }
    out[styleKey] = Object.freeze(merged);
  }
  for (const key of Object.keys(source)) {
    if (!(key in STYLE_THRESHOLD_DEFAULTS)) throw new TypeError('未知流派配置：' + key);
  }
  return Object.freeze(out);
}

const DEFAULT_STYLE_CONFIG = validatedStyleConfig(STYLE_THRESHOLD_DEFAULTS);

export function resolveStyleConfig(partial) {
  if (partial == null) return DEFAULT_STYLE_CONFIG;
  if (typeof partial !== 'object' || Array.isArray(partial)) {
    throw new TypeError('流派阈值配置必须是对象');
  }
  return validatedStyleConfig(partial);
}

// ---------------------------------------------------------------------------
// 熵（归一化到 log2(6)，均匀分布 = 1）。
// ---------------------------------------------------------------------------
export function normalizedKindEntropy(kindMix) {
  let entropy = 0;
  for (const key of KIND_MIX_KEYS) {
    const p = finiteNumber(kindMix && kindMix[key], 'kindMix.' + key);
    if (p > 0) entropy -= p * Math.log2(p);
  }
  return entropy / Math.log2(KIND_MIX_KEYS.length);
}

// ---------------------------------------------------------------------------
// 流派判定：{ style, strong, evidence }，证据恰好三条、只有占比/计数。
// ---------------------------------------------------------------------------
function pct(share) {
  return Math.round(share * 100) + '%';
}

const SLOW_BUCKETS = [['family', '家人'], ['exercise', '运动'], ['rest', '休息']];

function styleEvidence(styleId, f, ctx) {
  const total = f.usages.length;
  switch (styleId) {
    case 'morning-sorter':
      return [
        `早晨+上午开始的事占了${pct(ctx.dayShare)}`,
        `整理类用法用了${ctx.organizeCount}个`,
        `本周共用了${total}种AI用法`,
      ];
    case 'night-creator':
      return [
        `晚上+夜里开始的事占了${pct(ctx.lateShare)}`,
        `创作类的事占了${pct(f.kindMix.create)}`,
        `本周AI接力${f.relays}次、毕业${f.graduations}次`,
      ];
    case 'relay-ace':
      return [
        `本周接力${f.relays}次`,
        `毕业${f.graduations}次`,
        `本周共用了${total}种AI用法`,
      ];
    case 'slow-liver': {
      let top = SLOW_BUCKETS[0];
      for (const bucket of SLOW_BUCKETS) {
        if (f.freedTo[bucket[0]] > f.freedTo[top[0]]) top = bucket;
      }
      const hours = Math.round((f.freedMinutesConfirmed / 60) * 10) / 10;
      return [
        `空出来的时间${pct(ctx.lifeShare)}给了家人、休息或运动`,
        `其中给${top[1]}最多，占${pct(f.freedTo[top[0]])}`,
        `本人确认的空出时间${hours}小时`,
      ];
    }
    case 'academic-climber':
      return [
        `读论文、文献类用法占了${pct(ctx.readShare)}`,
        `这周用了${ctx.readCount}个读类用法`,
        `本周共用了${total}种AI用法`,
      ];
    case 'parallel-runner': {
      let minShare = 1;
      for (const key of KIND_MIX_KEYS) minShare = Math.min(minShare, f.kindMix[key]);
      return [
        `六类事项分布很平均（均匀度${ctx.entropy.toFixed(2)}）`,
        `本周用了${total}种不同的AI用法`,
        `最少的一类也占了${pct(minShare)}`,
      ];
    }
    default:
      throw new TypeError('未知流派：' + styleId);
  }
}

export function determineStyle(features, config, usageCategories = USAGE_CATEGORIES) {
  const cfg = resolveStyleConfig(config);
  const f = requireFeatures(features);
  const counts = usageCategoryCounts(f.usages, usageCategories);
  const total = f.usages.length;
  const dayShare = f.rhythm.dawn + f.rhythm.morning;
  const lateShare = f.rhythm.evening + f.rhythm.night;
  const lifeShare = f.freedTo.family + f.freedTo.exercise + f.freedTo.rest;
  const readCount = counts['读'] || 0;
  const readShare = total > 0 ? readCount / total : 0;
  const organizeCount = counts['整理'] || 0;
  const entropy = normalizedKindEntropy(f.kindMix);

  const rules = {
    'morning-sorter': {
      strong: dayShare >= cfg.morningSorter.minDayShare && organizeCount >= cfg.morningSorter.minOrganizeUsages,
      metric: dayShare,
    },
    'night-creator': {
      strong: lateShare >= cfg.nightCreator.minLateShare && f.kindMix.create >= cfg.nightCreator.minCreateShare,
      metric: lateShare,
    },
    'relay-ace': {
      strong: f.relays >= cfg.relayAce.minRelays && f.graduations >= cfg.relayAce.minGraduations,
      metric: Math.min(f.relays / Math.max(cfg.relayAce.minRelays, 1), 1) * 0.5
        + Math.min(f.graduations / Math.max(cfg.relayAce.minGraduations, 1), 1) * 0.5,
    },
    'slow-liver': {
      strong: lifeShare >= cfg.slowLiver.minLifeShare,
      metric: lifeShare,
    },
    'academic-climber': {
      strong: readShare >= cfg.academicClimber.minReadShare && readCount >= cfg.academicClimber.minReadUsages,
      metric: readShare,
    },
    'parallel-runner': {
      strong: entropy >= cfg.parallelRunner.minEntropy && total >= cfg.parallelRunner.minUsages,
      metric: entropy,
    },
  };

  let style = null;
  let strong = false;
  for (const id of STYLE_IDS) {
    if (rules[id].strong) { style = id; strong = true; break; }
  }
  if (!strong) {
    let best = -1;
    for (const id of STYLE_IDS) {
      if (rules[id].metric > best) { best = rules[id].metric; style = id; }
    }
  }
  const facts = styleEvidence(style, f, { dayShare, lateShare, lifeShare, readShare, readCount, organizeCount, entropy });
  const evidence = strong ? facts : ['本周流派特征还不明显，最接近这一派', facts[0], facts[1]];
  return { style, strong, evidence };
}

// 周流派卡（contracts.validateStyleCard 的完整输出；坏输入返回 null）。
export function buildStyleCard(features, config, usageCategories) {
  if (!features || typeof features !== 'object' || Array.isArray(features)) return null;
  try {
    const result = determineStyle(features, config, usageCategories);
    return validateStyleCard({ style: result.style, week: features.week, evidence: result.evidence });
  } catch (err) {
    if (err instanceof TypeError) return null;
    throw err;
  }
}

// ---------------------------------------------------------------------------
// 相似度：加权余弦（kindMix/rhythm/freedTo）+ usages Jaccard，权重来自
// contracts.MATCH_WEIGHTS（可覆盖但必须仍是四键、≥0、和为 1）。
// ---------------------------------------------------------------------------
export function cosine(a, b) {
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }
  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function dotCos(aVec, aNorm, bVec, bNorm) {
  if (aNorm === 0 || bNorm === 0) return 0;
  let dot = 0;
  for (let i = 0; i < aVec.length; i += 1) dot += aVec[i] * bVec[i];
  return dot / (aNorm * bNorm);
}

export function jaccard(a, b) {
  const setA = a instanceof Set ? a : new Set(a);
  const setB = b instanceof Set ? b : new Set(b);
  if (setA.size === 0 || setB.size === 0) return 0; // 双空无信号，定义为 0
  let intersection = 0;
  const [small, large] = setA.size <= setB.size ? [setA, setB] : [setB, setA];
  for (const item of small) if (large.has(item)) intersection += 1;
  const union = setA.size + setB.size - intersection;
  return union > 0 ? intersection / union : 0;
}

function resolveWeights(weights) {
  if (weights == null) return MATCH_WEIGHTS;
  if (typeof weights !== 'object' || Array.isArray(weights)) throw new TypeError('相似度权重必须是对象');
  const out = {};
  let sum = 0;
  for (const key of Object.keys(weights)) {
    if (!(key in MATCH_WEIGHTS)) throw new TypeError('未知权重字段：' + key);
  }
  for (const key of Object.keys(MATCH_WEIGHTS)) {
    const value = weights[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new TypeError('相似度权重必须是 ≥0 的数字：' + key);
    }
    out[key] = value;
    sum += value;
  }
  if (Math.abs(sum - 1) > 1e-9) throw new TypeError('相似度权重之和必须为 1');
  return Object.freeze(out);
}

function normOf(vec) {
  let norm = 0;
  for (const value of vec) norm += value * value;
  return Math.sqrt(norm);
}

// 预编译画像：匹配 1 万候选时每份只算一次范数/集合（性能门槛 <300ms）。
export function compileProfile(features) {
  const f = requireFeatures(features);
  const kindVec = KIND_MIX_KEYS.map((k) => f.kindMix[k]);
  const rhythmVec = RHYTHM_KEYS.map((k) => f.rhythm[k]);
  const freedVec = FREED_TO_KEYS.map((k) => f.freedTo[k]);
  return {
    kindVec, kindNorm: normOf(kindVec),
    rhythmVec, rhythmNorm: normOf(rhythmVec),
    freedVec, freedNorm: normOf(freedVec),
    usages: f.usages,
    usageSet: new Set(f.usages),
    relays: f.relays,
    graduations: f.graduations,
    week: f.week,
  };
}

export function similarityCompiled(me, other, weights) {
  const w = resolveWeights(weights);
  const score = w.kindMix * dotCos(me.kindVec, me.kindNorm, other.kindVec, other.kindNorm)
    + w.rhythm * dotCos(me.rhythmVec, me.rhythmNorm, other.rhythmVec, other.rhythmNorm)
    + w.usages * jaccard(me.usageSet, other.usageSet)
    + w.freedTo * dotCos(me.freedVec, me.freedNorm, other.freedVec, other.freedNorm);
  return Math.min(1, Math.max(0, score));
}

export function similarity(me, other, weights) {
  const w = resolveWeights(weights);
  return similarityCompiled(compileProfile(me), compileProfile(other), w);
}

// ---------------------------------------------------------------------------
// 「略多一点」过滤（PRD §3.3）。默认 factor 2 / offset 2 与
// contracts.isSlightlyAhead 的硬边界完全一致（unit 有等价网格证明）；
// 自定义值仅供 lab 调参 —— 生产路径必须走默认，否则 validateMatch 的
// context 校验（硬边界）会拒绝该记录。
// ---------------------------------------------------------------------------
export const AHEAD_DEFAULTS = Object.freeze({ factor: 2, offset: 2 });

export function resolveAheadConfig(partial) {
  if (partial == null) return AHEAD_DEFAULTS;
  if (typeof partial !== 'object' || Array.isArray(partial)) throw new TypeError('略多一点配置必须是对象');
  const out = { ...AHEAD_DEFAULTS };
  for (const key of Object.keys(partial)) {
    if (!(key in AHEAD_DEFAULTS)) throw new TypeError('未知略多一点配置字段：' + key);
    const value = partial[key];
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
      throw new TypeError('略多一点配置必须是 ≥0 的数字：' + key);
    }
    out[key] = value;
  }
  return Object.freeze(out);
}

export function isAhead(myGraduations, theirGraduations, cfg) {
  const c = resolveAheadConfig(cfg);
  if (!Number.isInteger(myGraduations) || myGraduations < 0) return false;
  if (!Number.isInteger(theirGraduations) || theirGraduations < 0) return false;
  return theirGraduations >= myGraduations && theirGraduations <= myGraduations * c.factor + c.offset;
}

// ---------------------------------------------------------------------------
// 同频理由（PRD §3.3：最多 2 条、必须粗粒度、来自真实特征）。
// 按信号强度取前 2，同族去重；永远 ≥1 条。
// ---------------------------------------------------------------------------
const SLOT_LABELS = { night: '夜里', evening: '晚上', afternoon: '下午', morning: '上午', dawn: '清晨' };
const FREED_LABELS = { family: '家人', exercise: '运动', study: '学新东西', rest: '休息', hobby: '爱好' };

function intersectionCount(a, b) {
  const setB = new Set(b);
  let count = 0;
  for (const item of a) if (setB.has(item)) count += 1;
  return count;
}

export function matchReasons(me, other, context) {
  const meF = requireFeatures(me);
  const otherF = requireFeatures(other);
  const myStyle = context && context.myStyle ? context.myStyle : determineStyle(meF);
  const otherStyle = context && context.otherStyle ? context.otherStyle : determineStyle(otherF);

  const candidates = [];

  // ① 夜里/晚上 + 创作的组合（PRD 例："你们都在晚上 10 点后做创作类的事"）。
  const nightCombo = meF.rhythm.night >= 0.25 && otherF.rhythm.night >= 0.25
    && meF.kindMix.create >= 0.25 && otherF.kindMix.create >= 0.25;
  const eveningCombo = meF.rhythm.evening >= 0.25 && otherF.rhythm.evening >= 0.25
    && meF.kindMix.create >= 0.25 && otherF.kindMix.create >= 0.25;
  const lateCreate = nightCombo || eveningCombo;
  if (nightCombo) candidates.push({ family: 'late-create', strength: 0.95, text: '你们都在夜里做创作类的事' });
  else if (eveningCombo) candidates.push({ family: 'late-create', strength: 0.9, text: '你们都在晚上做创作类的事' });

  // ② 空出来的时间同去向（PRD 例："你们都把空出来的时间给了运动"）。
  let bestFreed = null;
  for (const key of Object.keys(FREED_LABELS)) {
    if (meF.freedTo[key] >= 0.3 && otherF.freedTo[key] >= 0.3) {
      const value = Math.min(meF.freedTo[key], otherF.freedTo[key]);
      if (!bestFreed || value > bestFreed.value) bestFreed = { key, value };
    }
  }
  if (bestFreed) {
    candidates.push({ family: 'freed', strength: 0.85, text: `你们都把空出来的时间给了${FREED_LABELS[bestFreed.key]}` });
  }

  // ③ 共同的高占比时段（与 ① 同提夜里/晚上时跳过，避免重复表述）。
  let bestSlot = null;
  for (const key of Object.keys(SLOT_LABELS)) {
    if (meF.rhythm[key] >= 0.3 && otherF.rhythm[key] >= 0.3) {
      const value = Math.min(meF.rhythm[key], otherF.rhythm[key]);
      if (!bestSlot || value > bestSlot.value) bestSlot = { key, value };
    }
  }
  if (bestSlot && !(lateCreate && (bestSlot.key === 'night' || bestSlot.key === 'evening'))) {
    candidates.push({ family: 'rhythm', strength: 0.8, text: `你们都常在${SLOT_LABELS[bestSlot.key]}做事` });
  }

  // ④ 同流派（双方都是强判定才算，回退流派不算"同门"）。
  if (myStyle.strong && otherStyle.strong && myStyle.style === otherStyle.style) {
    const style = STYLES.find((s) => s.id === myStyle.style);
    candidates.push({ family: 'style', strength: 0.75, text: `你们都是「${style.label}」` });
  }

  // ⑤ 用法重合（Jaccard 高→"很像"；否则 ≥2 个共同→报数量）。
  const shared = intersectionCount(meF.usages, otherF.usages);
  const union = meF.usages.length + otherF.usages.length - shared;
  const jaccardScore = union > 0 ? shared / union : 0;
  if (jaccardScore >= 0.25) candidates.push({ family: 'usage', strength: 0.6, text: '你们常用的AI用法很像' });
  else if (shared >= 2) candidates.push({ family: 'usage', strength: 0.55, text: `你们有${shared}个都在用的AI用法` });

  // ⑥ 创作类/探索类占比都高（① 已提创作时不重复）。
  if (!lateCreate) {
    if (meF.kindMix.create >= 0.3 && otherF.kindMix.create >= 0.3) {
      candidates.push({ family: 'kind', strength: 0.55, text: '你们都用AI做创作的事' });
    } else if (meF.kindMix.explore >= 0.3 && otherF.kindMix.explore >= 0.3) {
      candidates.push({ family: 'kind', strength: 0.5, text: '你们都爱用AI探索新东西' });
    }
  }

  // ⑦ 兜底（永真、粗粒度）。
  candidates.push({
    family: 'base',
    strength: 0.2,
    text: meF.usages.length > 0 && otherF.usages.length > 0 ? '你们这周都在用AI做事' : '你们的AI用法都还在起步',
  });

  candidates.sort((a, b) => b.strength - a.strength);
  const seenFamilies = new Set();
  const reasons = [];
  for (const candidate of candidates) {
    if (seenFamilies.has(candidate.family)) continue;
    seenFamilies.add(candidate.family);
    reasons.push(candidate.text);
    if (reasons.length >= 2) break;
  }
  return reasons;
}

// ---------------------------------------------------------------------------
// 匹配器：略多一点过滤 → 相似度排序 → 前 N 条（默认 contracts.
// MATCHES_PER_WEEK）。输出逐条过 contracts.validateMatch（默认略多一点
// 配置时带 myGraduations context 硬边界校验）；形状不符直接抛错，绝不
// 静默丢人（数据不准会引发信任危机，PRD §1）。
// 候选自带 recentUsages（服务层从"学会事件"取最近 2 个用法 id）；缺省
// 回退用周用法列表前 2 个占位 —— §3.1 的 usages 无时间序，语义由服务层负责。
// ---------------------------------------------------------------------------
function pickRecentUsages(candidate) {
  if (Array.isArray(candidate.recentUsages)) {
    const ids = candidate.recentUsages.filter(isUsageId).slice(0, MATCH_RECENT_USAGES_MAX);
    if (ids.length) return ids;
  }
  return Array.isArray(candidate.features.usages)
    ? candidate.features.usages.slice(0, MATCH_RECENT_USAGES_MAX)
    : [];
}

export function findMatches(myProfile, candidates, opts = {}) {
  if (!Array.isArray(candidates)) throw new TypeError('candidates 必须是数组');
  const cfg = resolveStyleConfig(opts.config);
  const weights = resolveWeights(opts.weights);
  const ahead = resolveAheadConfig(opts.ahead);
  const minSimilarity = opts.minSimilarity == null ? 0 : opts.minSimilarity;
  if (typeof minSimilarity !== 'number' || !Number.isFinite(minSimilarity) || minSimilarity < 0 || minSimilarity > 1) {
    throw new TypeError('minSimilarity 必须是 0–1 的数字');
  }
  const limit = opts.limit == null ? MATCHES_PER_WEEK : opts.limit;
  if (!Number.isInteger(limit) || limit < 1) throw new TypeError('limit 必须是正整数');

  const me = compileProfile(myProfile);
  const myGrads = myProfile.graduations;
  const myStyle = determineStyle(myProfile, cfg, opts.usageCategories);

  const pool = [];
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') throw new TypeError('候选必须是对象');
    if (opts.myAccount && candidate.account === opts.myAccount) continue; // 不推自己
    const theirGrads = candidate.features ? candidate.features.graduations : undefined;
    if (!isAhead(myGrads, theirGrads, ahead)) continue; // 只推「略多一点」的人
    const compiled = compileProfile(candidate.features);
    const score = similarityCompiled(me, compiled, weights);
    if (score < minSimilarity) continue;
    pool.push({ candidate, score });
  }
  pool.sort((a, b) => b.score - a.score
    || (a.candidate.alias < b.candidate.alias ? -1 : a.candidate.alias > b.candidate.alias ? 1 : 0));

  // 默认略多一点配置 == 契约硬边界，才带 context 校验；lab 自定义放宽时不带。
  const useContractContext = ahead.factor === 2 && ahead.offset === 2;
  const matches = [];
  for (const entry of pool.slice(0, limit)) {
    const features = entry.candidate.features;
    const otherStyle = determineStyle(features, cfg, opts.usageCategories);
    const record = {
      alias: entry.candidate.alias,
      avatarColor: entry.candidate.avatarColor,
      style: otherStyle.style,
      similarity: Math.round(entry.score * 10000) / 10000,
      theirGraduations: features.graduations,
      reasons: matchReasons(myProfile, features, { myStyle, otherStyle }),
      recentUsages: pickRecentUsages(entry.candidate),
    };
    const validated = validateMatch(record, useContractContext ? { myGraduations: myGrads } : undefined);
    if (!validated) {
      throw new Error('SOCIAL_MATCH_SHAPE: 匹配卡片未通过契约校验 ' + JSON.stringify(record));
    }
    // account 供服务层回查身份，非枚举字段不污染契约形状（validateMatch 逐键校验）。
    if (entry.candidate.account != null) {
      Object.defineProperty(validated, 'account', { value: entry.candidate.account, enumerable: false });
    }
    matches.push(validated);
  }
  return matches;
}
