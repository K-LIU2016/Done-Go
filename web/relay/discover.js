// web/relay/discover.js — AI 接力 v2 场景库（SPEC design/relay-v2/SPEC.md §5.1 / §4⑥）。
//
// 数据文件：web/relay/scenes.zh.json（唯一场景来源）。所有结构一律来自
// web/relay/contracts.js（validateSceneLib / PERSONAS / CATEGORIES）——本模块
// 从不重复定义 usage 字段、上限或枚举。
//
// 职责（L6 场景库线）：
//   - parseSceneLib(text)：JSON 文本 → 契约校验后的库；每个用法额外回填
//     `sayings`（3 条典型说法，L7 匹配线覆盖测试的语料）。contracts 的
//     validateUsage 白名单只保留已知字段，sayings 作为场景库本地附加字段在
//     整库校验通过后从原始 JSON 回填——契约输入不拒绝未知键，因此库本身
//     仍能通过 contracts.validateSceneLib 直接校验（tests/unit/rv2-scenes.test.mjs
//     双重断言了这一点）。缺/坏 sayings 视为坏库（本线交付要求）。
//   - 人群取卡：personaCard / personaScenes / featuredScenes（首页 6 张，
//     SPEC §4① featured=true）、scenesByCategory（发现页按 写/读/整理/计划/
//     翻译/生活 分组，SPEC §4⑥）。卡片 title/hint 先用 personas.<p> 的覆写，
//     否则回退 usage.title / usage.materialHint。
//   - checkCoverage：每个人群 ≥12 个场景、≥6 个 featured（SPEC §5.1）。
//   - usageSayings / usageById / allUsageIds：给 L2 匹配页与 L7 匹配线取数。
//
// Pure module：无 DOM、无 fetch、无存储 IO——`node --test` 与浏览器
// dynamic import() 均可直接使用，风格同 contracts.js / matcher.js。
//
// 兼容两种库形状：parseSceneLib 的返回值 { version, usages }、
// contracts.validateSceneLib 的返回值，或纯 usage 数组（web/relay/home.js 的
// SCENES 形状）——所有取卡函数都接受这三种。

import { PERSONAS, CATEGORIES, validateSceneLib } from './contracts.js';

export var MIN_SCENES_PER_PERSONA = 12; // SPEC §5.1：每个人群 12 个
export var MIN_FEATURED_PER_PERSONA = 6; // SPEC §5.1：其中 6 个 featured
export var SAYINGS_PER_SCENE = 3;        // 每场景 3 条典型说法（本线交付）
export var SAYING_MAX = 200;             // 单条说法字数上限（自定，防长文）

function usagesOf(lib) {
  if (Array.isArray(lib)) return lib;
  if (lib && Array.isArray(lib.usages)) return lib.usages;
  return [];
}

function validSayings(value) {
  if (!Array.isArray(value) || value.length !== SAYINGS_PER_SCENE) return null;
  var out = [];
  for (var i = 0; i < value.length; i += 1) {
    var saying = String(value[i] == null ? '' : value[i]).trim().slice(0, SAYING_MAX);
    if (!saying) return null;
    out.push(saying);
  }
  return out;
}

// JSON 文本 → { status:'ok', lib } | { status:'invalid' }。
// lib.usages = 契约白名单字段 + sayings（见文件头说明）。
export function parseSceneLib(text) {
  var parsed;
  try { parsed = JSON.parse(String(text == null ? '' : text)); } catch (e) { return { status: 'invalid' }; }
  var validated = validateSceneLib(parsed);
  if (!validated) return { status: 'invalid' };
  var rawById = {};
  var rawList = parsed && Array.isArray(parsed.usages) ? parsed.usages : [];
  for (var i = 0; i < rawList.length; i += 1) {
    var raw = rawList[i];
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.id != null) {
      rawById[String(raw.id)] = raw;
    }
  }
  for (var j = 0; j < validated.usages.length; j += 1) {
    var usage = validated.usages[j];
    var sayings = validSayings(rawById[usage.id] && rawById[usage.id].sayings);
    if (!sayings) return { status: 'invalid' };
    usage.sayings = sayings;
  }
  return { status: 'ok', lib: validated };
}

export function usageById(lib, id) {
  var wanted = String(id == null ? '' : id);
  if (!wanted) return null;
  var usages = usagesOf(lib);
  for (var i = 0; i < usages.length; i += 1) {
    if (usages[i] && usages[i].id === wanted) return usages[i];
  }
  return null;
}

export function allUsageIds(lib) {
  return usagesOf(lib)
    .filter(function (usage) { return usage && usage.id != null; })
    .map(function (usage) { return usage.id; });
}

// 一个用法在某人群下的场景卡：personas.<p> 缺失 → null（该人群不展示）。
// title/hint 覆写优先，回退 usage.title / usage.materialHint。
export function personaCard(usage, persona) {
  if (!usage || !usage.personas) return null;
  var entry = usage.personas[String(persona == null ? '' : persona)];
  if (!entry) return null;
  return {
    id: usage.id,
    title: entry.title || usage.title,
    hint: entry.hint || usage.materialHint,
    featured: entry.featured === true,
    category: usage.category,
  };
}

// 该人群全部场景卡，保持库文件顺序（首页与发现页都按此序渲染）。
export function personaScenes(lib, persona) {
  var cards = [];
  usagesOf(lib).forEach(function (usage) {
    var card = personaCard(usage, persona);
    if (card) cards.push(card);
  });
  return cards;
}

// featured 场景卡（SPEC §4①：首页取当前人群 featured=true 的 6 张）。
export function featuredScenes(lib, persona) {
  return personaScenes(lib, persona).filter(function (card) { return card.featured; });
}

// 发现页分组（SPEC §4⑥）：按 contracts.CATEGORIES 顺序输出非空分组。
export function scenesByCategory(lib, persona) {
  var cards = personaScenes(lib, persona);
  var groups = [];
  CATEGORIES.forEach(function (category) {
    var scenes = cards.filter(function (card) { return card.category === category; });
    if (scenes.length) groups.push({ category: category, scenes: scenes });
  });
  return groups;
}

export function sceneCount(lib, persona) {
  return personaScenes(lib, persona).length;
}

export function featuredCount(lib, persona) {
  return featuredScenes(lib, persona).length;
}

// SPEC §5.1 覆盖检查：每个人群 ≥12 场景、≥6 featured。
export function checkCoverage(lib) {
  var personas = {};
  var ok = true;
  PERSONAS.forEach(function (persona) {
    var total = sceneCount(lib, persona);
    var featured = featuredCount(lib, persona);
    var personaOk = total >= MIN_SCENES_PER_PERSONA && featured >= MIN_FEATURED_PER_PERSONA;
    personas[persona] = { total: total, featured: featured, ok: personaOk };
    if (!personaOk) ok = false;
  });
  return { ok: ok, personas: personas };
}

// L7 匹配线覆盖测试语料：某用法的 3 条典型说法（副本）。
// 未回填 sayings 的库形状（如直接 validateSceneLib 的结果）返回 []。
export function usageSayings(lib, id) {
  var usage = usageById(lib, id);
  var sayings = usage && usage.sayings;
  if (!Array.isArray(sayings)) return [];
  return sayings.slice();
}
