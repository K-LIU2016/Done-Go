// web/relay/matcher.js — AI 接力 v2 用法匹配（SPEC design/relay-v2/SPEC.md §4② / §5.3, D7）。
//
// 关键词打分 + 人群加权 → top1 + 2 备选 + 置信度；置信度 < 0.6（D7）时升级
// mode:'route'（light 档，服务端实现）重新判定。请求/响应结构一律来自
// web/relay/contracts.js（validateRouteRequest / sanitizeRouteResult /
// validateSceneLib）——用法 id 只能出自场景库（SPEC §5.3「只能从场景库的 id
// 中选」），本模块从不自定义数据结构。
//
// Pure module: no DOM, no fetch, no storage IO。route 网络调用通过
// options.route(request) 注入（可同步可异步），因此 matchEvent 可直接被
// `node --test` 和浏览器 dynamic import() 使用，风格同 contracts.js。
//
// 匹配面 = 场景库每条用法的 keywords（SPEC §5.1 的字段即为此设计）。
// 打分规则：
//   - 命中的关键词按自身长度计权（越长越具体）：w = 1 + 0.35×(len-1)，上限 2.4；
//   - 同一用法的多个命中按权重降序以 0.6^i 衰减求和（重复证据递减，不线性叠加）；
//   - 人群加权：用法覆盖当前人群 ×1.25，且 featured ×1.1（复乘 ≈1.375）；
//     未知 persona 一律忽略；未给 persona 时中性。
// 置信度 = 优势度 × 饱和度：
//   - dominance d = top/(top+second)（无第二名证据时为 1）；
//   - saturation e = top/(top+0.8)：单个二字关键词命中 ≈ 0.63（过 0.6 线），
//     单个一字命中 ≈ 0.56（不过线 → 升级 route），证据越多越接近 1。
// 结果永远给出 top1 + 2 备选（不足时更短）：置信度 < 0.6 时 needsRoute=true
// 由调用方升级 route；< 0.5 时（SPEC §4②）UI 改问「你想让 AI 帮哪一种？」，
// CHOOSER_CONFIDENCE_THRESHOLD 供 UI 线引用，不在本模块内判断。

import {
  PERSONAS, EVENT_MAX, ROUTE_MODE,
  validateSceneLib, validateRouteRequest, sanitizeRouteResult,
} from './contracts.js';

export var ROUTE_CONFIDENCE_THRESHOLD = 0.6;   // D7：低于此值升级 mode:'route'
export var CHOOSER_CONFIDENCE_THRESHOLD = 0.5; // SPEC §4②：UI 三选一的阈值（UI 线使用）

var DECAY = 0.6;            // 第 i 个命中权重 × 0.6^i
var SATURATION_K = 0.8;     // 饱和常数：单命中 w=1.35 → 0.628 ≥ 0.6
var PERSONA_BOOST = 1.25;   // 用法覆盖当前人群
var FEATURED_BOOST = 1.1;   // 且在该人群 featured（复乘 ≈ 1.375）
var MAX_KEYWORD_WEIGHT = 2.4;
var ROUND = 1e9;

function round9(value) {
  return Math.round(value * ROUND) / ROUND;
}

function isValidPersona(persona) {
  return !!persona && PERSONAS.indexOf(persona) !== -1;
}

export function normalizeEventText(text) {
  var value = String(text == null ? '' : text);
  try { value = value.normalize('NFKC'); } catch { /* engines without full Unicode normalization */ }
  return value.toLowerCase().replace(/\s+/g, ' ').trim();
}

export function keywordWeight(keyword) {
  var n = Array.from(String(keyword == null ? '' : keyword)).length;
  if (n <= 1) return 1;
  var weight = 1 + 0.35 * (n - 1);
  return weight > MAX_KEYWORD_WEIGHT ? MAX_KEYWORD_WEIGHT : round9(weight);
}

function personaFactor(usage, persona) {
  if (!isValidPersona(persona)) return 1;
  var entry = usage.personas && usage.personas[persona];
  if (!entry) return 1;
  return entry.featured === true ? PERSONA_BOOST * FEATURED_BOOST : PERSONA_BOOST;
}

// Tie-break helper for equal scores: featured > applicable > others, then
// stable library order — gives the low-confidence chooser sensible defaults
// even when no keyword matched at all.
function personaRank(usage, persona) {
  if (!isValidPersona(persona)) return 0;
  var entry = usage.personas && usage.personas[persona];
  if (!entry) return 0;
  return entry.featured === true ? 2 : 1;
}

function matchedKeywords(eventText, usage) {
  var normalized = normalizeEventText(eventText);
  if (!normalized) return [];
  var seen = {};
  var hits = [];
  (usage.keywords || []).forEach(function (keyword) {
    var key = normalizeEventText(keyword);
    if (!key || seen[key] || normalized.indexOf(key) === -1) return;
    seen[key] = true;
    hits.push({ keyword: keyword, weight: keywordWeight(key) });
  });
  hits.sort(function (a, b) { return b.weight - a.weight; });
  return hits;
}

export function scoreUsage(eventText, usage, options) {
  var hits = matchedKeywords(eventText, usage);
  var score = 0;
  for (var i = 0; i < hits.length; i += 1) score += hits[i].weight * Math.pow(DECAY, i);
  score = round9(score);
  var factor = personaFactor(usage, options && options.persona);
  return { score: score, hits: hits.map(function (hit) { return hit.keyword; }), weighted: round9(score * factor) };
}

export function rankUsages(eventText, usages, options) {
  var persona = options && options.persona;
  var rows = (usages || []).map(function (usage, index) {
    var scored = scoreUsage(eventText, usage, options);
    return { usage: usage, index: index, score: scored.score, weighted: scored.weighted, hits: scored.hits };
  });
  rows.sort(function (a, b) {
    if (b.weighted !== a.weighted) return b.weighted - a.weighted;
    var byPersona = personaRank(b.usage, persona) - personaRank(a.usage, persona);
    if (byPersona) return byPersona;
    return a.index - b.index;
  });
  return rows.map(function (row) {
    return { usage: row.usage, score: row.score, weighted: row.weighted, hits: row.hits };
  });
}

function confidenceOf(topWeighted, secondWeighted) {
  if (!(topWeighted > 0)) return 0;
  var dominance = secondWeighted > 0 ? topWeighted / (topWeighted + secondWeighted) : 1;
  var saturation = topWeighted / (topWeighted + SATURATION_K);
  return Math.round(dominance * saturation * 1000) / 1000;
}

export function needsRoute(match) {
  if (!match || typeof match.confidence !== 'number') return true;
  return match.confidence < ROUTE_CONFIDENCE_THRESHOLD;
}

function libIds(lib) {
  return lib.usages.map(function (usage) { return usage.id; });
}

// Contract-shaped local match: { usageId, confidence, alternatives:[id,id] }
// (plus the D7 flag needsRoute). The three core fields are produced only
// through contracts.sanitizeRouteResult against the library id set, so an id
// outside the scene library can never survive.
export function matchLocal(eventText, scenePayload, options) {
  var lib = validateSceneLib(scenePayload);
  if (!lib) return null;
  var normalized = normalizeEventText(eventText);
  if (!normalized) return null;
  var ranked = rankUsages(normalized.slice(0, EVENT_MAX), lib.usages, options);
  if (!ranked.length) return null;
  var sanitized = sanitizeRouteResult({
    usageId: ranked[0].usage.id,
    confidence: confidenceOf(ranked[0].weighted, ranked[1] ? ranked[1].weighted : 0),
    alternatives: ranked.slice(1, 3).map(function (row) { return row.usage.id; }),
  }, libIds(lib));
  if (!sanitized) return null; // defensive: unreachable for a validated library
  var match = {
    usageId: sanitized.usageId,
    confidence: sanitized.confidence,
    alternatives: sanitized.alternatives,
  };
  match.needsRoute = needsRoute(match);
  return match;
}

// D7 wire body: exactly contracts.validateRouteRequest({mode:'route', event}).
// Only the event text travels — the server (scripts/ai-assistant.mjs route
// mode, light 档) owns the scene library and must answer with library ids.
export function buildRouteRequest(eventText) {
  return validateRouteRequest({ mode: ROUTE_MODE, event: String(eventText == null ? '' : eventText) });
}

// Route answer gate: ids outside the scene library are rejected wholesale
// (D7/SPEC §5.3), unknown alternatives dropped, shape capped to the contract.
export function matchFromRoute(rawRouteResult, scenePayload) {
  var lib = validateSceneLib(scenePayload);
  if (!lib) return null;
  var sanitized = sanitizeRouteResult(rawRouteResult, libIds(lib));
  if (!sanitized) return null;
  var match = {
    usageId: sanitized.usageId,
    confidence: sanitized.confidence,
    alternatives: sanitized.alternatives,
  };
  match.needsRoute = needsRoute(match);
  return match;
}

function withVia(match, via, extra) {
  return Object.assign({ via: via }, match, extra);
}

// Orchestrator honouring D7: run the local keyword match; only when
// confidence < ROUTE_CONFIDENCE_THRESHOLD call options.route(request) and
// adopt its (sanitized) answer. A route that fails, throws or returns junk
// falls back to the local match with routeFailed/routeError set — the flow
// never breaks because the escalation path is down.
export async function matchEvent(eventText, scenePayload, options) {
  options = options || {};
  var local = matchLocal(eventText, scenePayload, options);
  if (!local) return null;
  if (!needsRoute(local)) return withVia(local, 'local', { routeCalled: false });
  if (typeof options.route !== 'function') return withVia(local, 'local', { routeCalled: false });
  var request = buildRouteRequest(eventText);
  if (!request) return withVia(local, 'local', { routeCalled: false });
  var raw;
  try {
    raw = await options.route(request);
  } catch (error) {
    return withVia(local, 'local', {
      routeCalled: true, routeFailed: true,
      routeError: String((error && error.message) || error),
    });
  }
  var routed = matchFromRoute(raw, scenePayload);
  if (routed) return withVia(routed, 'route', { routeCalled: true });
  return withVia(local, 'local', {
    routeCalled: true, routeFailed: true,
    routeError: raw == null
      ? 'route returned no result'
      : 'route result rejected by contracts.sanitizeRouteResult',
  });
}
