// web/social/features-client.js — 同频 S1·特征提取（PRD design/social-sync/PRD.md §3.1）。
//
// 客户端在本地把四类数据聚合成「每周 AI 原生画像」，只输出聚合值：
//   1. 事项（index.html 的 S.entries，形状 {id,date,title,start,end,prio,kind,
//      done,state,kept,use,note,intent,from,…}）→ kindMix + rhythm
//   2. 接力（web/relay/store.js 的 v2 记录，形状见 web/relay/contracts.js）
//      → usages + relays + graduations
//   3. 自评（接力记录上的 rating 三档）→ rating 计数
//   4. 省时去向（「空出来的时间」= 完成事项提前腾出、被预留的静驻条目，
//      即 from 指向事项 id 的 stillness 条目）→ freedTo + freedMinutesConfirmed
//
// ============================ D2 隐私红线 ============================
// 本模块【逐字段构造】输出，输入里的标题（title）、材料/事件原话（event）、
// AI 结果（result）、备注/意图（note/intent）从头到尾没有任何代码路径能到达
// 返回值；具体时间同样只在本地参与计算（rhythm 分带、周内过滤、kept 分钟
// 求和），输出里只有周号（YYYY-Www）与计数。上传构造 featuresUploadPayload
// 再过一遍 web/social/contracts.js 的白名单校验（validateFeaturesUpload），
// 白名单外字段一律返回 null —— 拒绝而非剥离（契约红线，剥离会掩盖泄漏 bug）。
// unit（tests/unit/social-features-client.test.mjs）用诱饵字符串 + 深度遍历
// 双向证明：输出字符串只可能是周号或用法 id；禁止字段名零出现。
//
// ============================ 聚合口径 ============================
// · week：ISO 周（周一起步）；所有数据按「本地日期落在该周 7 天内」过滤。
// · kindMix：时长加权（分钟）。任务条目按 start–end 时长计入 kind；
//   静驻条目只计本人确认的 kept 分钟（沿用 index.html mix() 与
//   personalUseSummary 的既有口径），use 不在六类枚举内记 stillness。
// · rhythm：条目【开始时刻】的条数占比。分带（分钟）：
//   night [0,300)∪[1320,1440]、dawn [300,480)、morning [480,720)、
//   afternoon [720,1080)、evening [1080,1320)。
//   PRD §3.3「晚上 10 点后」→ 22:00 起记 night。
// · usages：本周成功接力（failed == null）记录里出现过的用法 id，去重保序，
//   封顶 FEATURES_USAGES_MAX；v1 迁移记录 usageId 为 null，不计。
// · relays / graduations / rating：只数本周成功记录；毕业与自评不来自失败记录。
// · freedTo / freedMinutesConfirmed：只认「空出来的时间」——from 关联的静驻
//   条目。state kept/partial 记确认分钟 kept（进 freedTo 与
//   freedMinutesConfirmed）；state reserved 记计划时长（只进 freedTo）；
//   taken（被占用）不记。归桶 freedToBucket：标题关键词优先（本地判定，
//   标题绝不上传），其次按本地 use 枚举兜底，再兜底 other。
// · 分母为 0 的占比（kindMix/rhythm/freedTo 任一）不造假：返回
//   ok:false + missing 清单，由上层引导用户补数据；绝不输出编造的均匀占比。
//
// 纯模块：无 DOM、无 fetch、无存储 IO —— node --test 直接 import，
// 浏览器侧由同频 UI 线（第二期接入）dynamic import。形状/上限/枚举一律
// import 自 ./contracts.js，本文件不重定义。

import {
  KIND_MIX_KEYS, RHYTHM_KEYS, FREED_TO_KEYS, RATINGS,
  FEATURES_USAGES_MAX, WEEKLY_COUNT_MAX, FREED_MINUTES_MAX,
  isIsoWeek, isUsageId, validateFeaturesUpload,
} from './contracts.js';

export var FEATURES_CLIENT_VERSION = 1;

var DAY_MS = 86400000;
var YMD_RE = /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/;
var HM_RE = /^([01][0-9]|2[0-3]):[0-5][0-9]$/;

function pad2(value) { return value < 10 ? '0' + value : String(value); }

function parseYmd(value) {
  if (typeof value !== 'string' || !YMD_RE.test(value)) return null;
  var y = Number(value.slice(0, 4)), m = Number(value.slice(5, 7)), d = Number(value.slice(8, 10));
  var ms = Date.UTC(y, m - 1, d);
  var back = new Date(ms);
  // 真实日期校验（2026-02-30 之类拒绝）：UTC 往返一致才有效。
  if (back.getUTCFullYear() !== y || back.getUTCMonth() !== m - 1 || back.getUTCDate() !== d) return null;
  return { y: y, m: m, d: d, ms: ms };
}

function fmtYmd(ms) {
  var d = new Date(ms);
  return d.getUTCFullYear() + '-' + pad2(d.getUTCMonth() + 1) + '-' + pad2(d.getUTCDate());
}

// ISO 星期一..日 = 1..7（getUTCDay 是周日..周六 = 0..6）。
function isoWeekday(ms) { return ((new Date(ms).getUTCDay() + 6) % 7) + 1; }

// ---------------------------------------------------------------------------
// ISO 周数学 —— 全部走 UTC 毫秒运算，不碰本地时区，任何机器结果一致。
// ---------------------------------------------------------------------------
export function isoWeekOfDate(dateStr) {
  var ymd = parseYmd(dateStr);
  if (!ymd) return null;
  var monday = ymd.ms - (isoWeekday(ymd.ms) - 1) * DAY_MS;
  var thursday = monday + 3 * DAY_MS; // 该 ISO 周的周四决定归属年份
  var year = new Date(thursday).getUTCFullYear();
  var week = Math.floor((thursday - Date.UTC(year, 0, 1)) / DAY_MS / 7) + 1;
  return year + '-W' + pad2(week);
}

export function weekDates(week) {
  if (!isIsoWeek(week)) return null;
  var year = Number(week.slice(0, 4));
  var n = Number(week.slice(6));
  var jan1 = Date.UTC(year, 0, 1);
  var firstThursday = jan1 + ((4 - isoWeekday(jan1) + 7) % 7) * DAY_MS;
  var monday = firstThursday - 3 * DAY_MS + (n - 1) * 7 * DAY_MS;
  // 不存在的周（52 周年份里的 W53）往返不一致 → null。
  if (isoWeekOfDate(fmtYmd(monday)) !== week) return null;
  var out = [];
  for (var i = 0; i < 7; i += 1) out.push(fmtYmd(monday + i * DAY_MS));
  return out;
}

// ---------------------------------------------------------------------------
// rhythm 分带。night 跨午夜环绕；'24:00' 收在 night。
// ---------------------------------------------------------------------------
export var RHYTHM_BANDS = { dawn: 300, morning: 480, afternoon: 720, evening: 1080, night: 1320 };

export function rhythmBandOf(startHm) {
  var m = minuteOf(startHm);
  if (m == null) return null;
  if (m < RHYTHM_BANDS.dawn) return 'night';
  if (m < RHYTHM_BANDS.morning) return 'dawn';
  if (m < RHYTHM_BANDS.afternoon) return 'morning';
  if (m < RHYTHM_BANDS.evening) return 'afternoon';
  if (m < RHYTHM_BANDS.night) return 'evening';
  return 'night';
}

function minuteOf(hm) {
  if (typeof hm !== 'string') return null;
  if (hm === '24:00') return 1440;
  if (!HM_RE.test(hm)) return null;
  return Number(hm.slice(0, 2)) * 60 + Number(hm.slice(3));
}

// ---------------------------------------------------------------------------
// freedTo 归桶：标题关键词（有序，首个命中生效）→ 本地 use 枚举兜底 → other。
// 关键词在本地跑，标题永远不离开设备。顺序刻意：family 最先（「陪家人散步」
// 归家人），exercise 在 rest 前（「晨跑」归运动而非恢复）。
// ---------------------------------------------------------------------------
export var FREED_TO_KEYWORDS = [
  ['family', /陪|家人|父母|爸|妈|孩子|带娃|女儿|儿子|老婆|老公|伴侣|爱人|对象|朋友|聊天|聚|吃饭|电话|视频|约会|见面|亲戚|长辈|回家/],
  ['exercise', /跑步|晨跑|夜跑|运动|健身|游泳|瑜伽|球|骑车|骑行|爬山|徒步|散步|走一走|拉伸|跳绳|跳舞|马拉松/],
  ['study', /读|看书|阅读|学|课程|文献|论文|纪录片|播客|复习|背单词|网课/],
  ['rest', /睡|午休|小憩|休息|发呆|冥想|泡澡|洗澡|按摩|打盹|静驻|躺|放空|什么都不/],
  ['hobby', /画|创作|音乐|听歌|歌|游戏|玩|电影|看剧|追剧|摄影|手工|园艺|下棋|钓鱼|乐器|弹|唱|拼图|桌游|漫画|小说|写日记|写点东西/],
];

var FREED_TO_USE_FALLBACK = {
  connect: 'family', restore: 'rest', explore: 'study',
  create: 'hobby', necessary: 'other', stillness: 'rest',
};

export function freedToBucket(title, use) {
  if (typeof title === 'string' && title.trim()) {
    for (var i = 0; i < FREED_TO_KEYWORDS.length; i += 1) {
      if (FREED_TO_KEYWORDS[i][1].test(title)) return FREED_TO_KEYWORDS[i][0];
    }
  }
  return FREED_TO_USE_FALLBACK[use] || 'other';
}

// ---------------------------------------------------------------------------
// 核心聚合。
// ---------------------------------------------------------------------------
function zeroMap(keys) {
  var out = {};
  for (var i = 0; i < keys.length; i += 1) out[keys[i]] = 0;
  return out;
}

function sumMap(map) {
  var sum = 0;
  var keys = Object.keys(map);
  for (var i = 0; i < keys.length; i += 1) sum += map[keys[i]];
  return sum;
}

// 计数 → 占比：残差（浮点尾数）归最大桶，保证总和恰为 1（合同容差 1e-6）。
function toRatios(counts) {
  var keys = Object.keys(counts);
  var total = sumMap(counts);
  var out = {};
  var maxKey = keys[0];
  for (var i = 0; i < keys.length; i += 1) {
    out[keys[i]] = counts[keys[i]] / total;
    if (counts[keys[i]] > counts[maxKey]) maxKey = keys[i];
  }
  var sum = 0;
  for (var j = 0; j < keys.length; j += 1) sum += out[keys[j]];
  out[maxKey] += 1 - sum;
  return out;
}

// 接力记录的 at（ISO 时间戳）→ 本地日期串。与浏览器侧一致的本地口径。
function localDateOfIso(iso) {
  if (typeof iso !== 'string' || !iso) return null;
  var d = new Date(iso);
  if (Number.isNaN(d.getTime())) return null;
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function localToday() {
  var d = new Date();
  return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate());
}

function confirmedKept(entry, duration) {
  return (entry.state === 'kept' || entry.state === 'partial')
    && Number.isInteger(entry.kept) && entry.kept >= 0
    && (duration <= 0 || entry.kept <= duration);
}

// input: { entries: […S.entries 形状], records: […relay v2 记录] }
// options: { week?: 'YYYY-Www'（显式周）, today?: 'YYYY-MM-DD'（推当周） }
// 返回 { ok: true, features, source: { week, entries, records } }
// 或    { ok: false, reason: 'bad-week'|'insufficient-data'|'contract',
//         week?, missing?: ['kindMix'|'rhythm'|'freedTo'] }
export function computeWeeklyFeatures(input, options) {
  var cfg = options || {};
  var week = null;
  if (cfg.week != null) week = isIsoWeek(cfg.week) ? cfg.week : null;
  else if (cfg.today != null) week = isoWeekOfDate(cfg.today);
  else week = isoWeekOfDate(localToday());
  if (!week) return { ok: false, reason: 'bad-week', week: typeof cfg.week === 'string' ? cfg.week : null };

  var dates = weekDates(week);
  var inWeek = {};
  for (var w = 0; w < dates.length; w += 1) inWeek[dates[w]] = true;

  var kindWeight = zeroMap(KIND_MIX_KEYS);
  var rhythmCount = zeroMap(RHYTHM_KEYS);
  var freedWeight = zeroMap(FREED_TO_KEYS);
  var freedConfirmed = 0;
  var seenEntryIds = {};
  var entriesUsed = 0;

  var entries = input && Array.isArray(input.entries) ? input.entries : [];
  for (var i = 0; i < entries.length; i += 1) {
    var e = entries[i];
    if (!e || typeof e !== 'object' || typeof e.id !== 'string' || seenEntryIds[e.id]) continue;
    if (typeof e.date !== 'string' || !inWeek[e.date]) continue;
    if (KIND_MIX_KEYS.indexOf(e.kind) < 0) continue;
    seenEntryIds[e.id] = true;
    entriesUsed += 1;

    var start = minuteOf(e.start);
    var end = minuteOf(e.end);
    var duration = start != null && end != null && end > start ? end - start : 0;

    // kindMix：任务按时长；静驻只计确认 kept 分钟（mix() 口径）。
    if (e.kind === 'stillness') {
      if (confirmedKept(e, duration)) {
        kindWeight[KIND_MIX_KEYS.indexOf(e.use) >= 0 ? e.use : 'stillness'] += e.kept;
      }
    } else if (duration > 0) {
      kindWeight[e.kind] += duration;
    }

    // rhythm：有开始时刻才有归属；''（无开始时间）不计。
    if (start != null) rhythmCount[rhythmBandOf(e.start)] += 1;

    // freedTo：只认「空出来的时间」（from 关联的静驻预留）。
    if (e.kind === 'stillness' && typeof e.from === 'string' && e.from) {
      if (confirmedKept(e, duration) && e.kept > 0) {
        freedWeight[freedToBucket(e.title, e.use)] += e.kept;
        freedConfirmed += e.kept;
      } else if (e.state === 'reserved' && duration > 0) {
        freedWeight[freedToBucket(e.title, e.use)] += duration;
      }
      // taken（被占用）与非法 kept：不进 freedTo，也不进确认分钟。
    }
  }

  var rating = zeroMap(RATINGS);
  var relays = 0;
  var graduations = 0;
  var usageSeen = {};
  var usages = [];
  var recordsInWeek = 0;

  var records = input && Array.isArray(input.records) ? input.records : [];
  for (var r = 0; r < records.length; r += 1) {
    var rec = records[r];
    if (!rec || typeof rec !== 'object') continue;
    var date = localDateOfIso(rec.at);
    if (!date || !inWeek[date]) continue;
    recordsInWeek += 1;
    if (rec.failed != null) continue; // 失败接力：不算 relays/usages/毕业/自评
    relays += 1;
    if (rec.graduated === true) graduations += 1;
    if (RATINGS.indexOf(rec.rating) >= 0) rating[rec.rating] += 1;
    if (typeof rec.usageId === 'string' && isUsageId(rec.usageId)
      && !usageSeen[rec.usageId] && usages.length < FEATURES_USAGES_MAX) {
      usageSeen[rec.usageId] = true;
      usages.push(rec.usageId);
    }
  }

  var missing = [];
  if (!sumMap(kindWeight)) missing.push('kindMix');
  if (!sumMap(rhythmCount)) missing.push('rhythm');
  if (!sumMap(freedWeight)) missing.push('freedTo');
  if (missing.length) return { ok: false, reason: 'insufficient-data', week: week, missing: missing };

  var features = {
    week: week,
    kindMix: toRatios(kindWeight),
    rhythm: toRatios(rhythmCount),
    usages: usages,
    relays: Math.min(relays, WEEKLY_COUNT_MAX),
    graduations: Math.min(graduations, WEEKLY_COUNT_MAX),
    rating: {
      much: Math.min(rating.much, WEEKLY_COUNT_MAX),
      little: Math.min(rating.little, WEEKLY_COUNT_MAX),
      none: Math.min(rating.none, WEEKLY_COUNT_MAX),
    },
    freedTo: toRatios(freedWeight),
    freedMinutesConfirmed: Math.min(freedConfirmed, FREED_MINUTES_MAX),
  };
  // 自校验：组装结果必须过合同白名单，否则拒绝输出（不修裁、不降级）。
  if (!validateFeaturesUpload(features).ok) return { ok: false, reason: 'contract', week: week };
  return { ok: true, features: features, source: { week: week, entries: entriesUsed, records: recordsInWeek } };
}

// ---------------------------------------------------------------------------
// 上传构造 —— 请求体唯一入口。
// 接受 computeWeeklyFeatures 的结果对象或裸 features 对象；ok:false 一律 null。
// 白名单外字段 = 客户端 bug = 拒绝上传（null），绝不静默剥离后继续。
// ---------------------------------------------------------------------------
export function featuresUploadPayload(computed) {
  if (!computed || typeof computed !== 'object' || Array.isArray(computed)) return null;
  var candidate = computed.ok === true ? computed.features : computed;
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) return null;
  var result = validateFeaturesUpload(candidate);
  return result.ok ? result.value : null;
}

export function featuresUploadBody(computed) {
  var payload = featuresUploadPayload(computed);
  return payload == null ? null : JSON.stringify(payload);
}
