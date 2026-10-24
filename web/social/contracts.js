// web/social/contracts.js — 同频（社交游戏化）数据契约（PRD design/social-sync/PRD.md §3）。
//
// This module is the single source of truth for every 同频 data shape.
// Later social lines (social-store / social-service / social-features /
// social-lab / web UI) import these names — they never redefine keys, caps
// or enums locally.
//
// Pure module: no DOM, no fetch, no storage IO — directly importable by
// `node --test` and by the browser via dynamic import(), like web/relay/contracts.js.
//
// Hard rules pinned here (红线 D2/D5/D6):
// - D2 上传白名单：weekly features payload 只允许 §3.1 的 9 个字段，未知字段
//   一律【拒绝】（不是静默剥离）；事项标题、材料、AI 结果、具体时间、地点
//   不在白名单内，永远过不了校验（见 FORBIDDEN_UPLOAD_FIELDS 的 unit 证明）。
// - D5 圈内排名只按传棒与毕业（CIRCLE_RANK_METRICS），排名视图不接受任何
//   工时/分钟字段；"空出来的时间"汇总只允许占比。
// - D6 传棒用法卡只含 {usageId, scenarioTitle, promptTemplate}，传递链视图
//   最多 5 跳（BATON_CHAIN_MAX_HOPS）。
//
// 刻意不放在本文件的（属于其它线，禁止在此重复定义）：
// - 流派判定与相似度计算的纯函数及可配置阈值（D3）→ social-features.mjs；
//   本文件只锁定 6 个流派的 id/label/颜色与证据条数上限。
// - SQLite 表结构与落盘（PRD §7）→ social-store.mjs。

export var SOCIAL_CONTRACTS_VERSION = 1;

// ---------------------------------------------------------------------------
// 公共常量 — 优先级枚举沿用全站约定（web/assistant-core.js:201：1 最高、5 不急）。
// ---------------------------------------------------------------------------
export var PRIORITY_MIN = 1;
export var PRIORITY_MAX = 5;
export var PRIORITIES = [1, 2, 3, 4, 5];

export function isPriority(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= PRIORITY_MIN && value <= PRIORITY_MAX;
}

// ---------------------------------------------------------------------------
// 共享校验原语。
// ---------------------------------------------------------------------------
var USAGE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;      // 与 web/relay/contracts.js 同规
var WEEK_RE = /^[0-9]{4}-W(0[1-9]|[1-4][0-9]|5[0-3])$/; // ISO 周，如 2026-W43
var AVATAR_COLOR_RE = /^#[0-9A-Fa-f]{6}$/;
var INVITE_CODE_RE = /^[A-Z0-9]{6,12}$/;
var SUM_EPSILON = 1e-6;

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function nonNegInt(value, max) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value <= max;
}

function text(value, max) {
  var out = typeof value === 'string' ? value.trim() : '';
  return out && out.length <= max ? out : null;
}

// 键集合必须与 allowed 完全一致：未知字段与缺失字段都记为错误（path 定位）。
function checkExactKeys(value, allowed, base, errors) {
  var keys = Object.keys(value);
  for (var i = 0; i < keys.length; i += 1) {
    if (allowed.indexOf(keys[i]) < 0) errors.push({ path: base + '.' + keys[i], message: '未知字段：白名单外一律拒绝' });
  }
  for (var j = 0; j < allowed.length; j += 1) {
    if (!(allowed[j] in value)) errors.push({ path: base + '.' + allowed[j], message: '缺少必填字段' });
  }
}

// 占比表：键固定、值为 0–1 的有限数字、总和为 1（±1e-6）。
function ratioMap(value, keys, base, errors) {
  checkExactKeys(value, keys, base, errors);
  var out = {};
  var sum = 0;
  var numeric = 0;
  for (var i = 0; i < keys.length; i += 1) {
    var key = keys[i];
    if (!(key in value)) continue;
    var raw = value[key];
    if (typeof raw !== 'number' || !Number.isFinite(raw) || raw < 0 || raw > 1) {
      errors.push({ path: base + '.' + key, message: '占比必须是 0–1 之间的数字' });
      continue;
    }
    out[key] = raw;
    sum += raw;
    numeric += 1;
  }
  if (numeric === keys.length && Math.abs(sum - 1) > SUM_EPSILON) {
    errors.push({ path: base, message: '占比之和必须为 1' });
  }
  return out;
}

export function isUsageId(value) {
  return typeof value === 'string' && USAGE_ID_RE.test(value);
}

export function isIsoWeek(value) {
  return typeof value === 'string' && WEEK_RE.test(value);
}

// ---------------------------------------------------------------------------
// 每周 AI 原生画像 — 上传白名单（PRD §3.1，红线 D2）。
// 客户端在本地计算，只上传聚合值；validateFeaturesUpload 拒绝白名单外的
// 任何字段（顶层与嵌套都查），sanitizeFeaturesUpload 在拒绝时返回 null，
// 绝不静默剥离 —— 剥离会掩盖客户端泄漏 bug，D2 要求的是拒绝。
// ---------------------------------------------------------------------------
export var FEATURES_UPLOAD_FIELDS = [
  'week', 'kindMix', 'rhythm', 'usages', 'relays', 'graduations',
  'rating', 'freedTo', 'freedMinutesConfirmed',
];
export var KIND_MIX_KEYS = ['necessary', 'create', 'connect', 'explore', 'restore', 'stillness'];
export var RHYTHM_KEYS = ['dawn', 'morning', 'afternoon', 'evening', 'night'];
export var FREED_TO_KEYS = ['family', 'exercise', 'study', 'rest', 'hobby', 'other'];
export var RATINGS = ['much', 'little', 'none']; // 与 relay v2 三档自评同枚举

export var FEATURES_USAGES_MAX = 200;   // 一周用过的用法 id 上限（对齐 relay MAX_RECORDS 量级）
export var WEEKLY_COUNT_MAX = 10000;    // relays/graduations/rating 次数上限
export var FREED_MINUTES_MAX = 10080;   // 一周总分钟数（7×24×60），物理上限

// D2 对照清单：这些字段名在任何上传里出现都必须被拒绝（unit 逐个证明）。
// 清单不必穷尽 —— 拒绝逻辑是白名单制，未知字段本来就全部拒绝。
export var FORBIDDEN_UPLOAD_FIELDS = [
  'title', 'itemTitle', 'note', 'notes', 'material', 'materials', 'content',
  'aiResult', 'result', 'event', 'events', 'time', 'times', 'startTime',
  'endTime', 'start', 'end', 'at', 'date', 'location', 'place', 'schedule',
];

export function validateFeaturesUpload(payload) {
  var errors = [];
  if (!isPlainObject(payload)) {
    return { ok: false, errors: [{ path: 'payload', message: '必须是对象' }] };
  }
  checkExactKeys(payload, FEATURES_UPLOAD_FIELDS, 'payload', errors);

  if (!isIsoWeek(payload.week)) errors.push({ path: 'payload.week', message: 'week 必须是 YYYY-Www（ISO 周）' });

  var kindMix = isPlainObject(payload.kindMix) ? ratioMap(payload.kindMix, KIND_MIX_KEYS, 'payload.kindMix', errors) : missingMap('payload.kindMix', errors);
  var rhythm = isPlainObject(payload.rhythm) ? ratioMap(payload.rhythm, RHYTHM_KEYS, 'payload.rhythm', errors) : missingMap('payload.rhythm', errors);
  var freedTo = isPlainObject(payload.freedTo) ? ratioMap(payload.freedTo, FREED_TO_KEYS, 'payload.freedTo', errors) : missingMap('payload.freedTo', errors);

  var usages = [];
  if (!Array.isArray(payload.usages)) {
    errors.push({ path: 'payload.usages', message: 'usages 必须是数组（只有用法 id）' });
  } else if (payload.usages.length > FEATURES_USAGES_MAX) {
    errors.push({ path: 'payload.usages', message: '用法 id 数量超上限 ' + FEATURES_USAGES_MAX });
  } else {
    var seen = {};
    for (var i = 0; i < payload.usages.length; i += 1) {
      var id = payload.usages[i];
      if (!isUsageId(id)) {
        errors.push({ path: 'payload.usages.' + i, message: '用法 id 不合法' });
      } else if (seen[id]) {
        errors.push({ path: 'payload.usages.' + i, message: '用法 id 重复' });
      } else {
        seen[id] = true;
        usages.push(id);
      }
    }
  }

  if (!nonNegInt(payload.relays, WEEKLY_COUNT_MAX)) errors.push({ path: 'payload.relays', message: 'relays 必须是 0–' + WEEKLY_COUNT_MAX + ' 的整数' });
  if (!nonNegInt(payload.graduations, WEEKLY_COUNT_MAX)) errors.push({ path: 'payload.graduations', message: 'graduations 必须是 0–' + WEEKLY_COUNT_MAX + ' 的整数' });

  var rating = null;
  if (!isPlainObject(payload.rating)) {
    errors.push({ path: 'payload.rating', message: 'rating 必须是对象' });
  } else {
    checkExactKeys(payload.rating, RATINGS, 'payload.rating', errors);
    rating = {};
    for (var r = 0; r < RATINGS.length; r += 1) {
      var key = RATINGS[r];
      if (!(key in payload.rating)) continue;
      if (!nonNegInt(payload.rating[key], WEEKLY_COUNT_MAX)) {
        errors.push({ path: 'payload.rating.' + key, message: '自评次数必须是 0–' + WEEKLY_COUNT_MAX + ' 的整数' });
      } else {
        rating[key] = payload.rating[key];
      }
    }
  }

  if (!nonNegInt(payload.freedMinutesConfirmed, FREED_MINUTES_MAX)) {
    errors.push({ path: 'payload.freedMinutesConfirmed', message: 'freedMinutesConfirmed 必须是 0–' + FREED_MINUTES_MAX + ' 的整数（只算本人确认过的）' });
  }

  if (errors.length) return { ok: false, errors: errors };
  return {
    ok: true,
    value: {
      week: payload.week,
      kindMix: kindMix,
      rhythm: rhythm,
      usages: usages,
      relays: payload.relays,
      graduations: payload.graduations,
      rating: rating,
      freedTo: freedTo,
      freedMinutesConfirmed: payload.freedMinutesConfirmed,
    },
  };
}

function missingMap(path, errors) {
  errors.push({ path: path, message: '必须是占比对象' });
  return {};
}

// relay 风格的 null-返回包装：拒绝即 null，供 store/service 线直接使用。
export function sanitizeFeaturesUpload(payload) {
  var result = validateFeaturesUpload(payload);
  return result.ok ? result.value : null;
}

// ---------------------------------------------------------------------------
// 时间流派（PRD §3.2，6 种）。id/label/颜色/motto 在此定死；判定纯函数与
// 可配置阈值（D3）在 social-features.mjs —— 判定输出必须通过
// validateStyleCard，证据最多 STYLE_EVIDENCE_MAX 条（流派卡三条）。
// ---------------------------------------------------------------------------
export var STYLES = [
  { id: 'morning-sorter', label: '晨光整理派', motto: '天刚亮就理清，一天都轻快。', color: '#E8B04B' },
  { id: 'night-creator', label: '深夜创作派', motto: '灯熄了，你的想法才刚开始。', color: '#4C7A93' },
  { id: 'relay-ace', label: '接力达人派', motto: '自己学会，也让人学会。', color: '#E95432' },
  { id: 'slow-liver', label: '生活慢行派', motto: '省下来的时间，慢慢过。', color: '#3E7B5B' },
  { id: 'academic-climber', label: '学术攀登派', motto: '一篇一篇往上爬。', color: '#615CED' },
  { id: 'parallel-runner', label: '多线并行派', motto: '几条线一起走，乱中有数。', color: '#C7701F' },
];
export var STYLE_IDS = STYLES.map(function (s) { return s.id; });
export var STYLE_EVIDENCE_MAX = 3;    // D3: 流派卡三条证据
export var STYLE_EVIDENCE_TEXT_MAX = 80;

export function validateStyleCard(card) {
  if (!isPlainObject(card)) return null;
  var keys = Object.keys(card);
  if (keys.length !== 3 || ['style', 'week', 'evidence'].some(function (k) { return keys.indexOf(k) < 0; })) return null;
  if (STYLE_IDS.indexOf(card.style) < 0) return null;
  if (!isIsoWeek(card.week)) return null;
  if (!Array.isArray(card.evidence) || card.evidence.length < 1 || card.evidence.length > STYLE_EVIDENCE_MAX) return null;
  var evidence = [];
  for (var i = 0; i < card.evidence.length; i += 1) {
    var line = text(card.evidence[i], STYLE_EVIDENCE_TEXT_MAX);
    if (!line) return null;
    evidence.push(line);
  }
  return { style: card.style, week: card.week, evidence: evidence };
}

// ---------------------------------------------------------------------------
// 同频匹配（PRD §3.3）。相似度计算（加权余弦 + usages Jaccard）是
// social-features.mjs 的纯函数；本文件只锁定权重、输出形状和「略多一点」
// 的硬边界：对方 graduations ≥ 你，且 ≤ 你的 2 倍 + 2。
// ---------------------------------------------------------------------------
export var MATCH_WEIGHTS = { kindMix: 0.3, rhythm: 0.2, usages: 0.3, freedTo: 0.2 };
export var MATCHES_PER_WEEK = 3;
export var MATCH_REASON_MAX = 2;          // 同频理由最多 2 条，必须粗粒度
export var MATCH_REASON_TEXT_MAX = 60;
export var MATCH_RECENT_USAGES_MAX = 2;   // TA 最近学会的 2 个用法
export var ALIAS_MAX = 24;                // 化名 = 形容词 + 自然物（服务端生成）

export function validateAlias(value) {
  return text(value, ALIAS_MAX);
}

export function isAvatarColor(value) {
  return typeof value === 'string' && AVATAR_COLOR_RE.test(value);
}

export function isSlightlyAhead(myGraduations, theirGraduations) {
  if (!nonNegInt(myGraduations, WEEKLY_COUNT_MAX) || !nonNegInt(theirGraduations, WEEKLY_COUNT_MAX)) return false;
  return theirGraduations >= myGraduations && theirGraduations <= myGraduations * 2 + 2;
}

var MATCH_FIELDS = ['alias', 'avatarColor', 'style', 'similarity', 'theirGraduations', 'reasons', 'recentUsages'];

// context 可选：{ myGraduations } 提供时同时校验「略多一点」边界。
export function validateMatch(rec, context) {
  if (!isPlainObject(rec)) return null;
  var keys = Object.keys(rec);
  if (keys.length !== MATCH_FIELDS.length || MATCH_FIELDS.some(function (k) { return keys.indexOf(k) < 0; })) return null;
  var alias = validateAlias(rec.alias);
  if (!alias) return null;
  if (!isAvatarColor(rec.avatarColor)) return null;
  if (STYLE_IDS.indexOf(rec.style) < 0) return null;
  if (typeof rec.similarity !== 'number' || !Number.isFinite(rec.similarity) || rec.similarity < 0 || rec.similarity > 1) return null;
  if (!nonNegInt(rec.theirGraduations, WEEKLY_COUNT_MAX)) return null;
  if (!Array.isArray(rec.reasons) || rec.reasons.length < 1 || rec.reasons.length > MATCH_REASON_MAX) return null;
  var reasons = [];
  for (var i = 0; i < rec.reasons.length; i += 1) {
    var reason = text(rec.reasons[i], MATCH_REASON_TEXT_MAX);
    if (!reason) return null;
    reasons.push(reason);
  }
  if (!Array.isArray(rec.recentUsages) || rec.recentUsages.length > MATCH_RECENT_USAGES_MAX) return null;
  var recentUsages = [];
  for (var j = 0; j < rec.recentUsages.length; j += 1) {
    if (!isUsageId(rec.recentUsages[j])) return null;
    recentUsages.push(rec.recentUsages[j]);
  }
  if (isPlainObject(context) && nonNegInt(context.myGraduations, WEEKLY_COUNT_MAX)) {
    if (!isSlightlyAhead(context.myGraduations, rec.theirGraduations)) return null;
  }
  return {
    alias: alias,
    avatarColor: rec.avatarColor,
    style: rec.style,
    similarity: rec.similarity,
    theirGraduations: rec.theirGraduations,
    reasons: reasons,
    recentUsages: recentUsages,
  };
}

// ---------------------------------------------------------------------------
// 加油 kudos（PRD §4.3）。只能对【本人确认分享后】的事件加油 —— 该约束由
// 服务层执行；契约锁定三种可分享事件与 kudos 自身的形状。
// ---------------------------------------------------------------------------
export var KUDOS_EVENT_KINDS = ['usage-learned', 'self-kept', 'time-given'];
export var KUDOS_EVENT_LABELS = {
  'usage-learned': '学会了一个用法',
  'self-kept': '自己做到了',
  'time-given': '把空出来的时间给了人',
};
export var ACCOUNT_ID_MAX = 64;

function accountId(value) {
  return text(value, ACCOUNT_ID_MAX);
}

export function validateKudos(payload) {
  if (!isPlainObject(payload)) return null;
  var keys = Object.keys(payload);
  var fields = ['from', 'to', 'eventKind', 'sharedEventId'];
  if (keys.length !== fields.length || fields.some(function (k) { return keys.indexOf(k) < 0; })) return null;
  var from = accountId(payload.from);
  var to = accountId(payload.to);
  var sharedEventId = accountId(payload.sharedEventId);
  if (!from || !to || KUDOS_EVENT_KINDS.indexOf(payload.eventKind) < 0 || !sharedEventId) return null;
  return { from: from, to: to, eventKind: payload.eventKind, sharedEventId: sharedEventId };
}

// ---------------------------------------------------------------------------
// 传棒 baton（PRD §4.4，红线 D6）。用法卡只含 {usageId, scenarioTitle,
// promptTemplate} —— 场景标题是用法库的场景名，不是任何人的事项标题；
// 材料、个人备注、发送者信息都不在卡上，出现即拒绝。
// ---------------------------------------------------------------------------
export var BATON_CARD_FIELDS = ['usageId', 'scenarioTitle', 'promptTemplate'];
export var SCENARIO_TITLE_MAX = 40;      // 对齐 relay v2 usage title 上限
export var PROMPT_TEMPLATE_MAX = 2000;   // 对齐 relay v2 externalPrompt 上限

export function validateBatonCard(card) {
  if (!isPlainObject(card)) return null;
  var keys = Object.keys(card);
  if (keys.length !== BATON_CARD_FIELDS.length || BATON_CARD_FIELDS.some(function (k) { return keys.indexOf(k) < 0; })) return null;
  if (!isUsageId(card.usageId)) return null;
  var scenarioTitle = text(card.scenarioTitle, SCENARIO_TITLE_MAX);
  if (!scenarioTitle) return null;
  if (typeof card.promptTemplate !== 'string' || !card.promptTemplate.trim() || card.promptTemplate.length > PROMPT_TEMPLATE_MAX) return null;
  return { usageId: card.usageId, scenarioTitle: scenarioTitle, promptTemplate: card.promptTemplate };
}

// D6 事件枚举：发出 / 打开 / 完成接力 / 毕业。
export var BATON_EVENTS = ['sent', 'opened', 'relay-completed', 'graduated'];
export var BATON_EVENT_LABELS = { sent: '发出', opened: '打开', 'relay-completed': '完成接力', graduated: '毕业' };

export function validateBatonEvent(event) {
  if (!isPlainObject(event)) return null;
  var fields = ['id', 'batonId', 'kind', 'at', 'byAccount'];
  var keys = Object.keys(event);
  if (keys.length !== fields.length || fields.some(function (k) { return keys.indexOf(k) < 0; })) return null;
  var id = accountId(event.id);
  var batonId = accountId(event.batonId);
  var byAccount = accountId(event.byAccount);
  if (!id || !batonId || !byAccount) return null;
  if (BATON_EVENTS.indexOf(event.kind) < 0) return null;
  if (typeof event.at !== 'string' || !event.at || Number.isNaN(Date.parse(event.at))) return null;
  return { id: id, batonId: batonId, kind: event.kind, at: event.at, byAccount: byAccount };
}

// 传给搭档 / 圈 / 生成链接（PRD §4.4）。link 无直接接收者，targetId 为 null。
export var BATON_TARGET_KINDS = ['pair', 'circle', 'link'];

export function validateBatonShare(share) {
  if (!isPlainObject(share)) return null;
  var fields = ['id', 'usageId', 'fromAccount', 'targetKind', 'targetId', 'card'];
  var keys = Object.keys(share);
  if (keys.length !== fields.length || fields.some(function (k) { return keys.indexOf(k) < 0; })) return null;
  var id = accountId(share.id);
  var fromAccount = accountId(share.fromAccount);
  if (!id || !fromAccount || !isUsageId(share.usageId)) return null;
  if (BATON_TARGET_KINDS.indexOf(share.targetKind) < 0) return null;
  var targetId = share.targetKind === 'link' ? null : accountId(share.targetId);
  if (share.targetKind !== 'link' && !targetId) return null;
  if (share.targetKind === 'link' && share.targetId != null && !accountId(share.targetId)) return null;
  var card = validateBatonCard(share.card);
  if (!card) return null;
  return { id: id, usageId: share.usageId, fromAccount: fromAccount, targetKind: share.targetKind, targetId: targetId, card: card };
}

// D6: 传递链最多展示 5 跳（"这个用法经过了 N 个人"）。存储可长，视图封顶。
export var BATON_CHAIN_MAX_HOPS = 5;

export function clipBatonChain(chain) {
  if (!Array.isArray(chain)) return [];
  var hops = chain.filter(function (hop) { return typeof hop === 'string' && hop.trim(); });
  return hops.slice(-BATON_CHAIN_MAX_HOPS);
}

// ---------------------------------------------------------------------------
// 接力搭档 pair（PRD §4.5）。两人每天各 ≥1 次接力共享火苗；断了只提醒不
// 惩罚（无惩罚字段）；每周 1 次冻结；每人最多 5 位搭档（服务层计数）。
// ---------------------------------------------------------------------------
export var MAX_PAIRS = 5;
export var PAIR_DAILY_RELAYS = 1;
export var PAIR_FREEZES_PER_WEEK = 1;

export function validatePair(pair) {
  if (!isPlainObject(pair)) return null;
  var fields = ['id', 'a', 'b', 'startedWeek', 'flame', 'freezesUsed'];
  var keys = Object.keys(pair);
  if (keys.length !== fields.length || fields.some(function (k) { return keys.indexOf(k) < 0; })) return null;
  var id = accountId(pair.id);
  var a = accountId(pair.a);
  var b = accountId(pair.b);
  if (!id || !a || !b || a === b) return null;
  if (!isIsoWeek(pair.startedWeek)) return null;
  if (!nonNegInt(pair.flame, WEEKLY_COUNT_MAX * 100)) return null;
  if (!nonNegInt(pair.freezesUsed, PAIR_FREEZES_PER_WEEK)) return null;
  return { id: id, a: a, b: b, startedWeek: pair.startedWeek, flame: pair.flame, freezesUsed: pair.freezesUsed };
}

// ---------------------------------------------------------------------------
// 同频圈 circle（PRD §4.6，红线 D5）。规模 3–50 人，邀请码加入；圈内排名
// 只按传棒与毕业，只显示前 3 名和「你」；"空出来的时间"汇总只允许占比。
// 未满 18 岁只允许进邀请码圈、不进公开同频池（服务层执行，阈值在此定死）。
// ---------------------------------------------------------------------------
export var CIRCLE_MIN_MEMBERS = 3;
export var CIRCLE_MAX_MEMBERS = 50;
export var CIRCLE_NAME_MAX = 30;
export var CIRCLE_RANK_METRICS = ['batons', 'graduations']; // D5: 不比工时
export var CIRCLE_RANK_SHOWN = 3;                           // 前 3 名 + 你
export var MIN_AGE_PUBLIC_POOL = 18;

export function validateCircle(circle) {
  if (!isPlainObject(circle)) return null;
  var fields = ['id', 'name', 'inviteCode'];
  var keys = Object.keys(circle);
  if (keys.length !== fields.length || fields.some(function (k) { return keys.indexOf(k) < 0; })) return null;
  var id = accountId(circle.id);
  var name = text(circle.name, CIRCLE_NAME_MAX);
  if (!id || !name) return null;
  if (typeof circle.inviteCode !== 'string' || !INVITE_CODE_RE.test(circle.inviteCode)) return null;
  return { id: id, name: name, inviteCode: circle.inviteCode };
}

function rankEntry(value) {
  if (!isPlainObject(value)) return null;
  var fields = ['rank', 'alias', 'avatarColor', 'batons', 'graduations'];
  var keys = Object.keys(value);
  if (keys.length !== fields.length || fields.some(function (k) { return keys.indexOf(k) < 0; })) return null;
  var alias = validateAlias(value.alias);
  if (!alias) return null;
  if (typeof value.rank !== 'number' || !Number.isInteger(value.rank) || value.rank < 1) return null;
  if (!isAvatarColor(value.avatarColor)) return null;
  if (!nonNegInt(value.batons, WEEKLY_COUNT_MAX) || !nonNegInt(value.graduations, WEEKLY_COUNT_MAX)) return null;
  return { rank: value.rank, alias: alias, avatarColor: value.avatarColor, batons: value.batons, graduations: value.graduations };
}

// 排名视图：top ≤ CIRCLE_RANK_SHOWN 条 + 可选的「你」。任何工时/分钟/小时
// 字段都是白名单外字段，直接拒绝（D5）。
export function validateCircleRankView(view) {
  if (!isPlainObject(view)) return null;
  var keys = Object.keys(view);
  var fields = ['top', 'you'];
  if (keys.length !== fields.length || fields.some(function (k) { return keys.indexOf(k) < 0; })) return null;
  if (!Array.isArray(view.top) || view.top.length < 1 || view.top.length > CIRCLE_RANK_SHOWN) return null;
  var top = [];
  for (var i = 0; i < view.top.length; i += 1) {
    var entry = rankEntry(view.top[i]);
    if (!entry) return null;
    top.push(entry);
  }
  var you = null;
  if (view.you != null) {
    you = rankEntry(view.you);
    if (!you) return null;
  }
  return { top: top, you: you };
}

// 圈内"空出来的时间"汇总：只允许 FREED_TO_KEYS 的占比，总和为 1。
export function validateFreedToSummary(summary) {
  if (!isPlainObject(summary)) return null;
  var errors = [];
  var out = ratioMap(summary, FREED_TO_KEYS, 'freedToSummary', errors);
  return errors.length ? null : out;
}

// ---------------------------------------------------------------------------
// 周挑战 quest（PRD §4.7）。每周 3 个，个人或圈级；"太多了"是保护指标
// 反馈通道（PRD §8），不是惩罚。
// ---------------------------------------------------------------------------
export var QUESTS_PER_WEEK = 3;
export var QUEST_SCOPES = ['personal', 'circle'];
export var QUEST_FEEDBACK_TYPES = ['too-much'];
export var QUEST_TITLE_MAX = 60;
export var QUEST_UNIT_MAX = 12;
export var QUEST_TARGET_MAX = 999;

export function validateQuest(quest) {
  if (!isPlainObject(quest)) return null;
  var fields = ['id', 'week', 'scope', 'title', 'target', 'unit'];
  var keys = Object.keys(quest);
  if (keys.length !== fields.length || fields.some(function (k) { return keys.indexOf(k) < 0; })) return null;
  var id = accountId(quest.id);
  var title = text(quest.title, QUEST_TITLE_MAX);
  var unit = text(quest.unit, QUEST_UNIT_MAX);
  if (!id || !title || !unit) return null;
  if (!isIsoWeek(quest.week)) return null;
  if (QUEST_SCOPES.indexOf(quest.scope) < 0) return null;
  if (typeof quest.target !== 'number' || !Number.isInteger(quest.target) || quest.target < 1 || quest.target > QUEST_TARGET_MAX) return null;
  return { id: id, week: quest.week, scope: quest.scope, title: title, target: quest.target, unit: unit };
}

export function validateQuestProgress(progress) {
  if (!isPlainObject(progress)) return null;
  var fields = ['questId', 'scope', 'owner', 'progress', 'done'];
  var keys = Object.keys(progress);
  if (keys.length !== fields.length || fields.some(function (k) { return keys.indexOf(k) < 0; })) return null;
  var questId = accountId(progress.questId);
  var owner = accountId(progress.owner);
  if (!questId || !owner || QUEST_SCOPES.indexOf(progress.scope) < 0) return null;
  if (!nonNegInt(progress.progress, QUEST_TARGET_MAX)) return null;
  if (typeof progress.done !== 'boolean') return null;
  return { questId: questId, scope: progress.scope, owner: owner, progress: progress.progress, done: progress.done };
}
