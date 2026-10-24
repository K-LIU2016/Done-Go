// web/relay/contracts.js — AI 接力 v2 数据契约（SPEC design/relay-v2/SPEC.md §5）。
//
// This module is the single source of truth for every relay v2 data shape.
// Later relay lines (storage, scenes, server relay/route modes, metrics, UI)
// import these names — they never redefine keys, caps or enums locally.
//
// Pure module: no DOM, no fetch, no storage IO — directly importable by
// `node --test` and by the browser via dynamic import(), like web/ai-parse.js.

// ---------------------------------------------------------------------------
// Storage keys — D9: 账号作用域约定
//
// relay v2 records live under exactly one key: 'tango-donego.relay.v2'.
// D9 convention: after login, every read/write MUST go through
// root.TangoAccountStorage (web/app-auth.js scope()), which rewrites this key
// to 'tango-donego.user.<id>.tango-donego.relay.v2'; guests (D5: 访客走完全
// 流程) fall back to root.localStorage with the bare key, exactly like the v1
// precedent in web/ai-relay.js (options.storage || root.TangoAccountStorage ||
// root.localStorage).
//
// INTEGRATION POINT (owned by the integration line, not this file): the
// scope() key regex in web/app-auth.js:84 currently covers
// 'tango-donego.(web.v1|assistant(-privacy).v1|llm.v1|agreements.v1)(\.|$)'
// and MUST be extended with 'relay\.v2' — that prefix also covers the
// '.quarantine' suffix below, so quarantined payloads stay in the same
// account scope.
// ---------------------------------------------------------------------------
export var RELAY_STORE_KEY = 'tango-donego.relay.v2';
export var RELAY_STORE_VERSION = 2;

// Legacy v1 store (web/ai-relay.js): read once, migrated, never written back.
export var LEGACY_V1_STORE_KEY = 'tango-donego.ai-relay.v1';

// SPEC §5.4: 未知版本时不覆盖，放进隔离区并提示用户. The quarantine copy is
// written under <key>.quarantine before any fresh store replaces the payload.
export var RELAY_QUARANTINE_SUFFIX = '.quarantine';
export function quarantineKey(key) {
  return String(key == null ? '' : key) + RELAY_QUARANTINE_SUFFIX;
}

// ---------------------------------------------------------------------------
// Field caps and enums.
// ---------------------------------------------------------------------------
export var MAX_RECORDS = 200;              // SPEC §5.4: 最多 200 条
export var RATINGS = ['much', 'little', 'none']; // SPEC §1.5 三档自评 / §5.4 rating
// SPEC §4⑧ failure causes: 未配置/超时/限流/上游失败/格式错误 → metric + record type.
export var FAIL_TYPES = ['unconfigured', 'timeout', 'ratelimit', 'upstream', 'format'];
// SPEC §4①: 人群切换 学生/老师/上班族/长辈.
export var PERSONAS = ['student', 'teacher', 'worker', 'elder'];
// SPEC §4⑥: 发现页分类 写/读/整理/计划/翻译/生活.
export var CATEGORIES = ['写', '读', '整理', '计划', '翻译', '生活'];

export var EVENT_MAX = 600;                // v1 input cap (web/ai-relay.js), kept for 事件原话
export var MATERIAL_MAX = 8000;            // SPEC §4②: 材料最多 8000 字
export var RESULT_MAX = 12000;             // v1 normalizeResult cap, kept for 用户编辑后的纯文本
export var PROMPT_MAX = 10000;             // relay prompt = usage template + 8000 material + 不可信标签 margin
export var SECTIONS_MAX = 5;               // SPEC §5.3: sections 1–5 组
export var SECTION_ITEMS_MAX = 10;         // SPEC §5.3: 每组 ≤10 条
export var SECTION_ITEM_MAX = 300;         // SPEC §5.3: 每条 ≤300 字
export var BATON_MATERIAL_PREVIEW_MAX = 200; // SPEC §4④: 接力棒提示词带材料前 200 字

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var USAGE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
// External app ids come from web/relay/external-apps.js (§5.2, another line);
// without that list at hand this defensive shape still rejects junk slots.
var APP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;

function cleanStrings(list, cap) {
  if (!Array.isArray(list)) return [];
  var out = [];
  for (var i = 0; i < list.length; i += 1) {
    var value = String(list[i] == null ? '' : list[i]).trim().slice(0, cap);
    if (value) out.push(value);
  }
  return out;
}

function randomUuid() {
  var cryptoApi = typeof globalThis !== 'undefined' && globalThis.crypto;
  if (cryptoApi && typeof cryptoApi.randomUUID === 'function') {
    try { return cryptoApi.randomUUID(); } catch (e) { /* fall through */ }
  }
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (ch) {
    var r = (Math.random() * 16) | 0;
    return (ch === 'x' ? r : (r & 0x3) | 0x8).toString(16);
  });
}

// ---------------------------------------------------------------------------
// Records — SPEC §5.4 local store payload
//   { "v": 2, "records": [ { id, at, event, usageId, result, rating,
//     graduated, graduatedApp, failed } ] }
// usageId is null ONLY for records migrated from ai-relay.v1: the v1 record
// carried a display label (`type`), and SPEC defines no scene-id mapping for
// it. Consumers must treat null as "无用法" and skip the scene lookup.
// `failed` carries the §4⑧ FAIL_TYPES id (null = relay succeeded / not run).
// ---------------------------------------------------------------------------

function sanitizeRecordShape(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  var id = String(value.id == null ? '' : value.id);
  if (!UUID_RE.test(id)) return null;
  var at = String(value.at == null ? '' : value.at);
  if (!at || Number.isNaN(Date.parse(at))) return null;
  var event = String(value.event == null ? '' : value.event).trim().slice(0, EVENT_MAX);
  if (!event) return null;
  var usageId = value.usageId == null ? null : String(value.usageId);
  if (usageId !== null && !USAGE_ID_RE.test(usageId)) return null;
  var rating = value.rating == null ? null : value.rating;
  if (rating !== null && !RATINGS.includes(rating)) return null;
  var graduatedApp = value.graduatedApp == null ? null : String(value.graduatedApp);
  if (graduatedApp !== null && !APP_ID_RE.test(graduatedApp)) return null;
  var failed = value.failed == null ? null : value.failed;
  if (failed !== null && !FAIL_TYPES.includes(failed)) return null;
  return {
    id: id,
    at: at,
    event: event,
    usageId: usageId,
    result: String(value.result == null ? '' : value.result).slice(0, RESULT_MAX),
    rating: rating,
    graduated: value.graduated === true,
    graduatedApp: graduatedApp,
    failed: failed,
  };
}

export function sanitizeRecord(value) {
  return sanitizeRecordShape(value);
}

export function createRecord(fields, options) {
  options = options || {};
  var f = fields || {};
  var event = String(f.event == null ? '' : f.event).trim().slice(0, EVENT_MAX);
  if (!event) return null;
  var usageId = String(f.usageId == null ? '' : f.usageId);
  if (!USAGE_ID_RE.test(usageId)) return null;
  var rating = f.rating == null ? null : f.rating;
  if (rating !== null && !RATINGS.includes(rating)) return null;
  var graduatedApp = f.graduatedApp == null ? null : String(f.graduatedApp);
  if (graduatedApp !== null && !APP_ID_RE.test(graduatedApp)) return null;
  var failed = f.failed == null ? null : f.failed;
  if (failed !== null && !FAIL_TYPES.includes(failed)) return null;
  var now = options.now == null ? Date.now() : options.now;
  // The factory output must round-trip through the strict sanitizer.
  return sanitizeRecordShape({
    id: options.uuid || randomUuid(),
    at: new Date(now).toISOString(),
    event: event,
    usageId: usageId,
    result: String(f.result == null ? '' : f.result).slice(0, RESULT_MAX),
    rating: rating,
    graduated: f.graduated === true,
    graduatedApp: graduatedApp,
    failed: failed,
  });
}

function freshStore() {
  return { v: RELAY_STORE_VERSION, records: [] };
}

// Parse the raw text stored under RELAY_STORE_KEY.
//   'empty'   → nothing stored yet, caller may start from a fresh store.
//   'ok'      → sanitized store (invalid records dropped, capped at 200).
//   'unknown' → unreadable JSON or a version we do not know: the caller MUST
//               NOT overwrite it — quarantine it and prompt the user (SPEC §5.4).
//               No `store` field is returned on purpose.
export function sanitizeStoreText(text) {
  if (text == null || String(text).trim() === '') return { status: 'empty', store: freshStore() };
  var parsed;
  try { parsed = JSON.parse(String(text)); } catch (e) { return { status: 'unknown' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'unknown' };
  if (parsed.v !== RELAY_STORE_VERSION) return { status: 'unknown' };
  var rawRecords = Array.isArray(parsed.records) ? parsed.records : [];
  var records = [];
  for (var i = 0; i < rawRecords.length && records.length < MAX_RECORDS; i += 1) {
    var record = sanitizeRecordShape(rawRecords[i]);
    if (record) records.push(record);
  }
  return { status: 'ok', store: { v: RELAY_STORE_VERSION, records: records } };
}

// One-shot migration from the ai-relay.v1 payload (web/ai-relay.js:109 shape):
// { v:1, records:[{ id, event, type, result, learned, estimatedSavedMinutes,
//                   savedAt }] }.
// SPEC §5.4: estimatedSavedMinutes 丢弃, rating 设为 null. The v1 `type` and
// `learned` have no v2 slot (v2 usage metadata lives in the scene library) and
// are dropped by the whitelist; usageId becomes null (see above). The v1 key
// itself is only ever read.
export function migrateLegacyText(text, options) {
  options = options || {};
  if (text == null || String(text).trim() === '') return { status: 'empty' };
  var parsed;
  try { parsed = JSON.parse(String(text)); } catch (e) { return { status: 'empty' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'empty' };
  if (parsed.v !== 1 || !Array.isArray(parsed.records) || !parsed.records.length) return { status: 'empty' };
  var now = options.now == null ? Date.now() : options.now;
  var records = [];
  parsed.records.forEach(function (raw, index) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return;
    var event = String(raw.event == null ? '' : raw.event).trim().slice(0, EVENT_MAX);
    if (!event) return;
    var stamp = Date.parse(String(raw.savedAt == null ? '' : raw.savedAt));
    var at = Number.isNaN(stamp) ? new Date(now).toISOString() : new Date(stamp).toISOString();
    var uuid = (options.uuids && options.uuids[index]) || randomUuid();
    var record = sanitizeRecordShape({
      id: uuid,
      at: at,
      event: event,
      usageId: null,
      result: String(raw.result == null ? '' : raw.result).slice(0, RESULT_MAX),
      rating: null,
      graduated: false,
      graduatedApp: null,
      failed: null,
    });
    if (record && records.length < MAX_RECORDS) records.push(record);
  });
  if (!records.length) return { status: 'empty' };
  return { status: 'ok', store: { v: RELAY_STORE_VERSION, records: records } };
}

// ---------------------------------------------------------------------------
// Scene library — SPEC §5.1 web/relay/scenes.zh.json usage schema.
// ---------------------------------------------------------------------------

function sanitizePersonas(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  var out = {};
  PERSONAS.forEach(function (name) {
    var persona = value[name];
    if (!persona || typeof persona !== 'object' || Array.isArray(persona)) return;
    var entry = { featured: persona.featured === true };
    var title = String(persona.title == null ? '' : persona.title).trim().slice(0, 40);
    if (title) entry.title = title;
    var hint = String(persona.hint == null ? '' : persona.hint).trim().slice(0, 80);
    if (hint) entry.hint = hint;
    out[name] = entry;
  });
  return Object.keys(out).length ? out : null;
}

export function validateUsage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  var id = String(value.id == null ? '' : value.id);
  if (!USAGE_ID_RE.test(id)) return null;
  var title = String(value.title == null ? '' : value.title).trim().slice(0, 40);
  if (!title) return null;
  if (!CATEGORIES.includes(value.category)) return null;
  var does = cleanStrings(value.does, 60);
  if (!does.length) return null;
  var materialLabel = String(value.materialLabel == null ? '' : value.materialLabel).trim().slice(0, 40);
  if (!materialLabel) return null;
  var materialHint = String(value.materialHint == null ? '' : value.materialHint).trim().slice(0, 200);
  if (!materialHint) return null;
  var learned = String(value.learned == null ? '' : value.learned).trim().slice(0, 200);
  if (!learned) return null;
  var externalPrompt = String(value.externalPrompt == null ? '' : value.externalPrompt);
  // The baton template must carry the {{material}} slot (SPEC §4④); length is
  // rejected, not truncated — truncation could cut the slot off the tail.
  if (!externalPrompt || externalPrompt.length > 2000 || externalPrompt.indexOf('{{material}}') === -1) return null;
  var keywords = cleanStrings(value.keywords, 40);
  if (!keywords.length) return null;
  var personas = sanitizePersonas(value.personas);
  if (!personas) return null;
  return {
    id: id,
    title: title,
    category: value.category,
    does: does,
    materialLabel: materialLabel,
    materialHint: materialHint,
    learned: learned,
    externalPrompt: externalPrompt,
    keywords: keywords,
    personas: personas,
  };
}

export function validateSceneLib(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.version !== 1) return null;
  if (!Array.isArray(payload.usages) || !payload.usages.length) return null;
  var seen = {};
  var usages = [];
  for (var i = 0; i < payload.usages.length; i += 1) {
    var usage = validateUsage(payload.usages[i]);
    if (!usage || seen[usage.id]) return null;
    seen[usage.id] = true;
    usages.push(usage);
  }
  return { version: 1, usages: usages };
}

// ---------------------------------------------------------------------------
// Material gates — SPEC §4② (≤8000, 为空置灰) and §4④ (baton preview 200 字).
// ---------------------------------------------------------------------------
export function checkMaterial(text) {
  var value = String(text == null ? '' : text);
  if (!value.trim()) return { ok: false, reason: 'empty', value: value };
  if (value.length > MATERIAL_MAX) return { ok: false, reason: 'too_long', value: value };
  return { ok: true, reason: null, value: value };
}

export function batonMaterialPreview(text) {
  return String(text == null ? '' : text).slice(0, BATON_MATERIAL_PREVIEW_MAX);
}

// ---------------------------------------------------------------------------
// Relay request/response — SPEC §5.3.
//   request:  { mode:'relay', stream:true, prompt }
//   response: { sections:[{title, items[]}], learned, followups[] }
// The final streamed frame goes through sanitizeRelayResult() in full. The
// whitelisted output shape means estimatedSavedMinutes can never survive
// (SPEC §1.5 / D3: relay 输出契约里删除 estimatedSavedMinutes).
// followups are advisory chips — §4④ fixes the three chip labels — so a
// missing list degrades to [] instead of failing the whole draft.
// ---------------------------------------------------------------------------

export var RELAY_MODE = 'relay';

export function validateRelayRequest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.mode !== RELAY_MODE) return null;
  var prompt = payload.prompt == null ? '' : String(payload.prompt);
  if (!prompt.trim() || prompt.length > PROMPT_MAX) return null;
  var stream = payload.stream == null ? false : payload.stream;
  if (typeof stream !== 'boolean') return null;
  return { mode: RELAY_MODE, stream: stream, prompt: prompt };
}

// First balanced {...} with string awareness, mirroring web/ai-parse.js
// extractJSON: streamed relay frames arrive as prose-wrapped text.
function extractJSON(text) {
  var s = String(text == null ? '' : text);
  var start = -1;
  var depth = 0;
  var inString = false;
  var escaped = false;
  for (var i = 0; i < s.length; i += 1) {
    var ch = s[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === '{') {
      if (depth === 0) start = i;
      depth += 1;
    } else if (ch === '}') {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        try { return JSON.parse(s.slice(start, i + 1)); } catch (e) { return null; }
      }
    }
  }
  return null;
}

export function sanitizeRelayResult(raw) {
  var value = raw;
  if (typeof value === 'string') value = extractJSON(value);
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!Array.isArray(value.sections)) return null;
  var sections = [];
  for (var i = 0; i < value.sections.length && sections.length < SECTIONS_MAX; i += 1) {
    var group = value.sections[i];
    if (!group || typeof group !== 'object' || Array.isArray(group)) continue;
    var title = String(group.title == null ? '' : group.title).trim().slice(0, 80);
    if (!title) continue;
    var items = [];
    var rawItems = Array.isArray(group.items) ? group.items : [];
    for (var j = 0; j < rawItems.length && items.length < SECTION_ITEMS_MAX; j += 1) {
      var item = String(rawItems[j] == null ? '' : rawItems[j]).trim().slice(0, SECTION_ITEM_MAX);
      if (item) items.push(item);
    }
    if (items.length) sections.push({ title: title, items: items });
  }
  if (!sections.length) return null;
  var learned = String(value.learned == null ? '' : value.learned).trim().slice(0, 200);
  if (!learned) return null;
  var followups = Array.isArray(value.followups) ? cleanStrings(value.followups, 40).slice(0, 3) : [];
  return { sections: sections, learned: learned, followups: followups };
}

// ---------------------------------------------------------------------------
// Route request/response — SPEC §5.3 mode:'route' (light 档).
//   request:  { mode:'route', event } — the 事件原话 from the start input.
//   response: { usageId, confidence, alternatives:[usageId, usageId] }
// usageId and every alternative must exist in the scene library id set
// (只能从场景库的 id 中选); confidence is a 0–1 number, never coerced.
// ---------------------------------------------------------------------------

export var ROUTE_MODE = 'route';

export function validateRouteRequest(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  if (payload.mode !== ROUTE_MODE) return null;
  var event = payload.event == null ? '' : String(payload.event).trim();
  if (!event || event.length > EVENT_MAX) return null;
  return { mode: ROUTE_MODE, event: event };
}

function toKnownSet(ids) {
  if (!Array.isArray(ids) || !ids.length) return null;
  var set = {};
  ids.forEach(function (id) {
    var key = String(id == null ? '' : id);
    if (USAGE_ID_RE.test(key)) set[key] = true;
  });
  return Object.keys(set).length ? set : null;
}

export function sanitizeRouteResult(raw, knownUsageIds) {
  var known = toKnownSet(knownUsageIds);
  if (!known) return null;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  var usageId = raw.usageId == null ? '' : String(raw.usageId);
  if (!known[usageId]) return null;
  var confidence = raw.confidence;
  if (typeof confidence !== 'number' || !Number.isFinite(confidence) || confidence < 0 || confidence > 1) return null;
  var alternatives = [];
  var rawAlts = Array.isArray(raw.alternatives) ? raw.alternatives : [];
  for (var i = 0; i < rawAlts.length && alternatives.length < 2; i += 1) {
    var alt = rawAlts[i] == null ? '' : String(rawAlts[i]);
    if (known[alt] && alt !== usageId && !alternatives.includes(alt)) alternatives.push(alt);
  }
  return { usageId: usageId, confidence: confidence, alternatives: alternatives };
}

// ---------------------------------------------------------------------------
// Funnel metrics — SPEC §5.5 POST /api/metrics. D10: 只计数，不带任何内容.
// The wire body is exactly { event: '<name>' } — no user id, no IP, no text.
// Base events take no parameter slot; parametrized events carry one enum slot
// (fail type / rating / app id). App ids come from web/relay/external-apps.js
// at call time via options.apps; without the list, APP_ID_RE is the defensive
// gate so free text can never enter a counter name.
// ---------------------------------------------------------------------------
export var METRIC_BASE_EVENTS = [
  'start_submit', 'scene_click', 'match_shown', 'match_switch',
  'relay_send', 'relay_ok', 'stop', 'signup_nudge_click',
];
export var METRIC_PARAM_EVENTS = {
  'relay_fail': FAIL_TYPES,
  'rate': RATINGS,
  'baton_copy': null,   // enum supplied per call via options.apps
  'graduated': null,
};

function validMetricParam(name, arg, options) {
  if (arg == null) return null;
  var value = String(arg);
  var allowed = METRIC_PARAM_EVENTS[name];
  if (allowed) return allowed.includes(value) ? value : null;
  var apps = options && Array.isArray(options.apps) ? options.apps.map(String) : null;
  if (apps) return apps.includes(value) ? value : null;
  return APP_ID_RE.test(value) ? value : null;
}

export function metricEvent(name, arg, options) {
  var key = String(name == null ? '' : name);
  if (METRIC_BASE_EVENTS.includes(key)) return arg == null ? key : null;
  if (Object.prototype.hasOwnProperty.call(METRIC_PARAM_EVENTS, key)) {
    var param = validMetricParam(key, arg, options);
    return param == null ? null : key + ':' + param;
  }
  return null;
}

export function metricPayload(name, arg, options) {
  var event = metricEvent(name, arg, options);
  return event == null ? null : { event: event };
}

// Server-side D10 guard: accept a body only when it is a plain object whose
// single key is 'event' holding a valid event string. Anything else — extra
// keys, nested objects, free text — is rejected, not logged.
export function sanitizeMetricBody(body, options) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return null;
  var keys = Object.keys(body);
  if (keys.length !== 1 || keys[0] !== 'event') return null;
  var value = String(body.event == null ? '' : body.event);
  var split = value.indexOf(':');
  var name = split === -1 ? value : value.slice(0, split);
  var arg = split === -1 ? null : value.slice(split + 1);
  var event = metricEvent(name, arg, options);
  return event === value ? { event: event } : null;
}
