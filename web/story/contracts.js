// web/story/contracts.js — 时光故事书数据契约（SPEC design/story-recap/SPEC.md §2–§6）。
//
// This module is the single source of truth for every story-recap data shape:
// the chapter store, stats input/output, the page library, wishes, and the
// shared seed/segment conventions behind the data-composed soundtrack
// (SPEC §4; the playable demo at the top of design/story-recap/prototype.html
// is the reference implementation its constants pin). Later story lines
// (stats, definitions, narrative, soundtrack, player, pages/*, poster, shelf,
// scheduler, lab) import these names — they never redefine keys, caps, enums
// or mappings locally, exactly like the relay v2 precedent in
// web/relay/contracts.js.
//
// Pure module: no DOM, no Web Audio, no fetch, no storage IO — directly
// importable by `node --test` and by the browser via dynamic import().
//
// Pinned contract decisions (all flagged in the ST line report):
// - SPEC §6 keeps type ∈ week|month|year; the data-insufficient 短章 (SPEC §2:
//   本期事项少于 5 件) is a *variant* ('short'), not a fourth type, so the
//   stored schema stays exactly the SPEC §6 one.
// - 短章 3 页 = cover → numbers → poster. SPEC §2 fixes the count (3) and the
//   copy tone but not the pages; this trio is the contract default. 待 CTO
//   裁决 if a different trio is wanted.
// - 年书页数不锁定: SPEC §2 says 18 页, but 月章 10 页型 + 6 年度专属 = 16.
//   Year/full validation pins cover-first, poster-last and the presence of
//   all six year types — NOT the total count. 待 CTO 裁决 the gap.
// - `no` (章号, SPEC §3 page ⓪ "第 10 章") is stored on the chapter so the
//   MAX_CHAPTERS pruning can never renumber history. SPEC §6's field list has
//   no slot for it; this is the minimal addition that keeps 章号 stable.
// - songSeed is DERIVED from the chapter id (FNV-1a 32-bit) at generation,
//   then stored verbatim: regenerating a chapter reproduces the same song
//   (SPEC §4 种子固定，同一章每次播放都是同一首).
// - Ledger entries and relay records are sanitized by their OWN contracts
//   (web/index.html shapes; web/relay/contracts.js sanitizeRecord). This
//   module never redefines those shapes — it imports/whitelists them.

import { sanitizeRecord as sanitizeRelayRecord } from '../relay/contracts.js';

// ---------------------------------------------------------------------------
// Storage keys and caps — SPEC §6.
//   章节存储 tango-donego.story.v1（纳入账号作用域，与 relay v2 的 D9 约定一致:
//   登录后经 TangoAccountStorage 作用域改写，访客用裸 key）。心愿也存这里
//   (SPEC §6 数据源表)，不另开 key。
// ---------------------------------------------------------------------------
export var STORY_STORE_KEY = 'tango-donego.story.v1';
export var STORY_STORE_VERSION = 1;
export var MAX_CHAPTERS = 120; // SPEC §6: 最多 120 章

// SPEC §2: 数据不足（本期事项少于 5 件）→ 3 页短章。
export var SHORT_CHAPTER_MIN_EVENTS = 5;

// ---------------------------------------------------------------------------
// Chapter taxonomy and time kinds.
// ---------------------------------------------------------------------------
export var CHAPTER_TYPES = ['week', 'month', 'year']; // SPEC §6 store schema
export var CHAPTER_VARIANTS = ['full', 'short'];      // 短章是变体，不是第四种 type

// 6 个时间类别 — web/index.html KIND_ORDER（时间之树/回顾的 canonical 顺序），
// prototype ② 六色光谱与 §4 音色映射共用同一组 id。
export var KINDS = ['necessary', 'create', 'connect', 'explore', 'restore', 'stillness'];

// SPEC §4 主旋律音色按 dominantKind — prototype KIND_TIMBRE 原样锁定
// (connect 的「柔和 saw 加低通」、restore/stillness 的「加长混响」由
// soundtrack.js 在此基础音色上叠加，契约只锁基础波形)。
export var KIND_TIMBRE = {
  create: 'triangle',
  necessary: 'sine',
  connect: 'sawtooth',
  explore: 'square',
  restore: 'sine',
  stillness: 'sine',
};

// ---------------------------------------------------------------------------
// Page library — SPEC §3 月章 10 页（按原型顺序）+ SPEC §2 周/短/年篇幅。
// ---------------------------------------------------------------------------
export var PAGE_TYPES = [
  'cover',       // ⓪ 封面
  'numbers',     // ① 开篇数字
  'timeColors',  // ② 时间的颜色
  'specialDay',  // ③ 最特别的一天
  'lessons',     // ④ 学会的用法
  'savedTime',   // ⑤ 省下的时间去了哪
  'rhythm',      // ⑥ 节律与流派
  'panels',      // ⑦ 四格与关键词
  'wish',        // ⑧ 写给下一章
  'poster',      // ⑨ 海报
];
export var WEEK_PAGE_ORDER = ['cover', 'numbers', 'timeColors', 'lessons', 'poster'];
export var SHORT_PAGE_ORDER = ['cover', 'numbers', 'poster']; // 契约决定（见文件头）
export var YEAR_PAGE_TYPES = [
  'yearSpectrum',  // 12 个月的时间光谱长卷
  'yearFirstLast', // 年度第一次和最后一次
  'yearStreak',    // 年度最长连续接力
  'yearGenres',    // 年度流派变化史
  'yearKeywords',  // 年度十大关键词
  'yearWall',      // 12 张月度四格拼成的年度墙
];

export function pageOrderFor(type, variant) {
  var v = variant == null ? 'full' : variant;
  if (CHAPTER_VARIANTS.indexOf(v) < 0) return null;
  if (v === 'short') return SHORT_PAGE_ORDER.slice();
  if (type === 'week') return WEEK_PAGE_ORDER.slice();
  if (type === 'month') return PAGE_TYPES.slice();
  // year/full 的完整页序未锁定（SPEC §2 18 页 vs 10+6=16 的差距，待 CTO 裁决）；
  // year 章节的 pages 必须由生成方显式给出并通过 validatePages。
  return null;
}

// ---------------------------------------------------------------------------
// Wish — SPEC §3 page ⑧ / §1 连载感.
//   可量化心愿（早睡/运动/学习/陪伴）下一章用数据回应；other 只做温柔复述。
// ---------------------------------------------------------------------------
export var WISH_CATEGORIES = ['sleep', 'exercise', 'learning', 'company', 'other'];
export var WISH_TEXT_MAX = 60;  // 一句就好；超长截断（用户输入，不拒收）
export var CAPTION_MAX = 60;    // captions 值上限（AI 润色 ≤24 字 + 用户编辑余量）

export function isQuantifiableWish(category) {
  return WISH_CATEGORIES.indexOf(category) >= 0 && category !== 'other';
}

// ---------------------------------------------------------------------------
// Seed & segment conventions — SPEC §4 公共约定（十线共用，soundtrack 不得自定）。
// ---------------------------------------------------------------------------
export var SONG = {
  BPM_BASE: 64,            // SPEC §4: 速度 = 64 + busyness × 40 bpm
  BPM_SPAN: 40,
  MOOD_MAJOR_THRESHOLD: 0.5, // SPEC §4: mood ≥ 0.5 用大调，否则小调
  INTRO_BARS: 4,           // SPEC §4: 前奏 4 小节 pad
  VOLUME_MAX: 0.25,        // SPEC §4: 音量上限 0.25
  ROOT_MIDI: 57,           // prototype: A3
  OUTRO_PAGE: 'poster',    // SPEC §4: 结尾在海报页回到主和弦并淡出
};
export var MODES = ['major', 'minor'];

// FNV-1a 32-bit over the chapter id — deterministic across platforms, so the
// same chapter always maps to the same seed even after regenerate/prune.
export function songSeedFromId(id) {
  var s = String(id == null ? '' : id);
  var h = 0x811c9dc5;
  for (var i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

// A stored seed must be an integer in [0, 2^32-1]. Never coerced.
export function normalizeSongSeed(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (Math.floor(value) !== value) return null;
  if (value < 0 || value > 4294967295) return null;
  return value;
}

// mulberry32 — THE canonical PRNG for every stochastic decision inside the
// soundtrack (pitch/density draws). soundtrack.js must draw notes from
// createRng(chapterSeed) and never from Math.random, so 同一种子重复生成的
// 音符序列完全一致 (SPEC §8 验收). Accepts a uint32 seed or any string
// (hashed via songSeedFromId); anything else returns null.
export function createRng(seed) {
  var a;
  if (typeof seed === 'number') {
    a = normalizeSongSeed(seed);
    if (a == null) return null;
  } else if (typeof seed === 'string') {
    a = songSeedFromId(seed);
  } else {
    return null;
  }
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    var t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// SPEC §4 映射 — 纯函数，D3 unit 在无 Web Audio 的 node 里直接证明。
export function tempoBpm(busyness) {
  if (typeof busyness !== 'number' || !Number.isFinite(busyness)) return null;
  if (busyness < 0 || busyness > 1) return null;
  return SONG.BPM_BASE + busyness * SONG.BPM_SPAN;
}

export function modeFor(mood) {
  if (typeof mood !== 'number' || !Number.isFinite(mood)) return null;
  if (mood < 0 || mood > 1) return null;
  return mood >= SONG.MOOD_MAJOR_THRESHOLD ? 'major' : 'minor';
}

export function timbreFor(kind) {
  var wave = KIND_TIMBRE[String(kind == null ? '' : kind)];
  return wave || 'sine'; // 防御性兜底，绝不抛错
}

// prototype scale/prog 原样锁定（major: I–vi–IV–V / minor: i–III–v–iv）。
var MAJOR_SCALE = [0, 2, 4, 7, 9, 12, 14, 16];
var MINOR_SCALE = [0, 2, 3, 7, 8, 12, 14, 15];
var MAJOR_DEGREES = [0, 5, 3, 4];
var MINOR_DEGREES = [0, 3, 5, 4];

export function scaleFor(mode) {
  if (mode === 'major') return MAJOR_SCALE.slice();
  if (mode === 'minor') return MINOR_SCALE.slice();
  return null;
}

export function chordDegreesFor(mode) {
  if (mode === 'major') return MAJOR_DEGREES.slice();
  if (mode === 'minor') return MINOR_DEGREES.slice();
  return null;
}

// 结构分段：前奏 4 小节 pad 之外，主体随页面推进 — 翻到第几页就进入第几段
// (SPEC §4)。段号 = 页号（0 基）；最后一段（海报页）回到主和弦并淡出；
// 换页时音乐连续不重启由 player/soundtrack 按此约定协作。
export function pageSegmentIndex(pageIndex) {
  if (typeof pageIndex !== 'number' || !Number.isFinite(pageIndex)) return null;
  if (Math.floor(pageIndex) !== pageIndex || pageIndex < 0) return null;
  return pageIndex;
}

export function isOutroSegment(pageIndex, pageCount) {
  var index = pageSegmentIndex(pageIndex);
  if (index == null) return false;
  if (typeof pageCount !== 'number' || !Number.isFinite(pageCount)) return false;
  if (pageCount !== Math.floor(pageCount) || pageCount < 1) return false;
  return index === pageCount - 1;
}

// ---------------------------------------------------------------------------
// Note events — soundtrack ⇄ poster 波形契约 (SPEC §4: 海报上的「时间之歌」
// 波形 = 这首曲子主旋律的音高序列). soundtrack emits, poster consumes; the
// shared shape lives here so neither side invents its own.
// ---------------------------------------------------------------------------
export var NOTE_VOICES = ['pad', 'lead', 'chime'];

export function validateNoteSequence(value) {
  if (!Array.isArray(value) || value.length > 4096) return null;
  var out = [];
  for (var i = 0; i < value.length; i += 1) {
    var n = value[i];
    if (!n || typeof n !== 'object' || Array.isArray(n)) return null;
    if (typeof n.midi !== 'number' || !Number.isFinite(n.midi) || Math.floor(n.midi) !== n.midi) return null;
    if (n.midi < 0 || n.midi > 127) return null;
    if (typeof n.at !== 'number' || !Number.isFinite(n.at) || n.at < 0 || n.at > 1e6) return null;
    if (typeof n.dur !== 'number' || !Number.isFinite(n.dur) || n.dur <= 0 || n.dur > 1e6) return null;
    if (NOTE_VOICES.indexOf(n.voice) < 0) return null;
    out.push({ midi: n.midi, at: n.at, dur: n.dur, voice: n.voice });
  }
  return out;
}

// 主旋律音高序列：lead + chime（毕业钟琴算旋律事件），pad 伴奏排除，按时间排序。
export function melodyPitches(notes) {
  var seq = validateNoteSequence(notes);
  if (!seq) return null;
  var melody = [];
  for (var i = 0; i < seq.length; i += 1) if (seq[i].voice !== 'pad') melody.push(seq[i]);
  melody.sort(function (a, b) { return a.at - b.at || a.midi - b.midi; });
  var out = [];
  for (var j = 0; j < melody.length; j += 1) out.push(melody[j].midi);
  return out;
}

// ---------------------------------------------------------------------------
// Small shared helpers.
// ---------------------------------------------------------------------------
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
var USAGE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;   // 同 web/relay/contracts.js
var APP_ID_RE = /^[a-z0-9][a-z0-9_-]{0,31}$/;    // 同 web/relay/contracts.js
var GENRE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
var YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
// 同 web/index.html isHM：HH:MM（零填充），另允许 24:00。
var HM_RE = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/;
var CAPTION_KEY_RE = /^[-_.a-zA-Z0-9]{1,40}$/;
var METRIC_KEY_RE = /^[a-zA-Z][a-zA-Z0-9.]{0,39}$/;

function isNum(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value) && value >= min && value <= max;
}

function isInt(value, min, max) {
  return isNum(value, min, max) && Math.floor(value) === value;
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
// Period — {from, to} 本地日期 YYYY-MM-DD，from ≤ to（零填充字符串序即日期序）。
// ---------------------------------------------------------------------------
export function validatePeriod(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  var from = String(value.from == null ? '' : value.from);
  var to = String(value.to == null ? '' : value.to);
  if (!YMD_RE.test(from) || !YMD_RE.test(to)) return null;
  if (Number.isNaN(Date.parse(from)) || Number.isNaN(Date.parse(to))) return null;
  if (from > to) return null;
  return { from: from, to: to };
}

// ---------------------------------------------------------------------------
// Ledger entries — stats 的原始输入之一（SPEC §6: 旧账本 tango-donego.web.v1
// 的 entries 及语音/首页新增）。字段白名单对齐 web/index.html：
//   { id, date, start, end, title, kind, done, ai:{used}, completion,
//     state, kept, use }
// stillness 条目承载省时预留/确认（state: reserved|kept|partial|taken，
// kept=本人确认的分钟数，use=去向 kind — web/index.html
// personalUseSummary 的口径）。state 作不透明字符串透传（账本契约归账本）。
// ---------------------------------------------------------------------------
var ENTRY_TITLE_MAX = 200;
var MAX_INPUT_ENTRIES = 20000;
var MAX_INPUT_RELAYS = 5000;
var MAX_INPUT_USAGES = 200;

export function sanitizeLedgerEntry(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  var date = String(value.date == null ? '' : value.date);
  if (!YMD_RE.test(date) || Number.isNaN(Date.parse(date))) return null;
  var start = String(value.start == null ? '' : value.start);
  var end = String(value.end == null ? '' : value.end);
  if (!HM_RE.test(start) || !HM_RE.test(end)) return null;
  var kind = String(value.kind == null ? '' : value.kind);
  if (KINDS.indexOf(kind) < 0) return null;
  var title = String(value.title == null ? '' : value.title).trim().slice(0, ENTRY_TITLE_MAX);
  if (!title) return null;
  var id = String(value.id == null ? '' : value.id).slice(0, 64);
  var entry = {
    id: id,
    date: date,
    start: start,
    end: end,
    title: title,
    kind: kind,
    done: value.done === true,
  };
  if (value.ai && typeof value.ai === 'object' && !Array.isArray(value.ai) && value.ai.used === true) {
    entry.ai = { used: true };
  }
  if (value.state != null) {
    var state = String(value.state).trim().slice(0, 16);
    if (state) entry.state = state;
  }
  if (value.kept != null) {
    if (!isInt(value.kept, 0, 1440)) return null;
    entry.kept = value.kept;
  }
  if (value.use != null) {
    if (KINDS.indexOf(value.use) < 0) return null;
    entry.use = value.use;
  }
  if (value.completion && typeof value.completion === 'object' && !Array.isArray(value.completion)) {
    var c = value.completion;
    var completion = {};
    var hasAny = false;
    if (isInt(c.before, 0, 1440)) { completion.before = c.before; hasAny = true; }
    if (c.actual == null) { completion.actual = null; hasAny = true; }
    else if (isInt(c.actual, 0, 1440)) { completion.actual = c.actual; hasAny = true; }
    if (typeof c.usedAI === 'boolean') { completion.usedAI = c.usedAI; hasAny = true; }
    if (hasAny) entry.completion = completion; // 无效 completion 静默丢弃，stats 回退计划时长
  }
  return entry;
}

// ---------------------------------------------------------------------------
// StatsInput — stats.js 的输入 (SPEC §6: 统计计算输入原始数据和期间)。
//   { period, entries[], relays[], usages[{id,title}], prevChapter }
// entries/relays 含期间外的历史数据（busyness 分位需要个人历史）；stats.js
// 自行按 period 过滤。relays 只经 web/relay/contracts.js sanitizeRecord 清洗，
// 本模块不重定义 relay 形状。prevChapter 无效时按 null 处理（上下文数据，
// 不值得让整次生成失败）。
// ---------------------------------------------------------------------------
export function validateStatsInput(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  var period = validatePeriod(value.period);
  if (!period) return null;
  var rawEntries = Array.isArray(value.entries) ? value.entries : [];
  var entries = [];
  for (var i = 0; i < rawEntries.length && entries.length < MAX_INPUT_ENTRIES; i += 1) {
    var entry = sanitizeLedgerEntry(rawEntries[i]);
    if (entry) entries.push(entry);
  }
  var rawRelays = Array.isArray(value.relays) ? value.relays : [];
  var relays = [];
  for (var j = 0; j < rawRelays.length && relays.length < MAX_INPUT_RELAYS; j += 1) {
    var record = sanitizeRelayRecord(rawRelays[j]);
    if (record) relays.push(record);
  }
  var rawUsages = Array.isArray(value.usages) ? value.usages : [];
  var usages = [];
  for (var k = 0; k < rawUsages.length && usages.length < MAX_INPUT_USAGES; k += 1) {
    var u = rawUsages[k];
    if (!u || typeof u !== 'object' || Array.isArray(u)) continue;
    var uid = String(u.id == null ? '' : u.id);
    var uTitle = String(u.title == null ? '' : u.title).trim().slice(0, 40);
    if (USAGE_ID_RE.test(uid) && uTitle) usages.push({ id: uid, title: uTitle });
  }
  var prevChapter = null;
  if (value.prevChapter != null) prevChapter = validateChapter(value.prevChapter);
  return {
    period: period,
    entries: entries,
    relays: relays,
    usages: usages,
    prevChapter: prevChapter,
  };
}

// ---------------------------------------------------------------------------
// Stats — stats.js 的输出，SPEC §3 页面库的数据列 + §4 作曲输入。
// 只存统计和文案，不复制原始事项（SPEC §6）。所有数值字段严格校验、绝不
// 强转；未知键被白名单丢弃。可为 null 的块对应零数据/第一章等边界
// (SPEC §8: 跨月、跨年、零数据、只有 1 件事都要有 unit)。
// ---------------------------------------------------------------------------
function sanitizeTotals(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!isInt(value.events, 0, 1e7)) return null;
  if (!isInt(value.aiRelays, 0, 1e7)) return null;
  var prevEvents = value.prevEvents == null ? null : value.prevEvents;
  if (prevEvents !== null && !isInt(prevEvents, 0, 1e7)) return null;
  var delta = value.delta == null ? null : value.delta;
  if (delta !== null && !isInt(delta, -1e7, 1e7)) return null;
  return { events: value.events, aiRelays: value.aiRelays, prevEvents: prevEvents, delta: delta };
}

function sanitizeKindMinutes(value) {
  var rows = Array.isArray(value) ? value : null;
  if (!rows || rows.length !== KINDS.length) return null; // SPEC §3 ②: 6 个类别，缺 0 也占位
  var out = [];
  var seen = {};
  for (var i = 0; i < rows.length; i += 1) {
    var row = rows[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    var kind = String(row.kind == null ? '' : row.kind);
    if (KINDS.indexOf(kind) < 0 || seen[kind]) return null;
    seen[kind] = true;
    if (!isInt(row.minutes, 0, 1e7)) return null;
    if (!isNum(row.share, 0, 1)) return null;
    out.push({ kind: kind, minutes: row.minutes, share: row.share });
  }
  return out;
}

function sanitizeTopDay(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  var date = String(value.date == null ? '' : value.date);
  if (!YMD_RE.test(date) || Number.isNaN(Date.parse(date))) return null;
  if (!isInt(value.events, 1, 1e6)) return null;
  var rawTimeline = Array.isArray(value.timeline) ? value.timeline : null;
  if (!rawTimeline || !rawTimeline.length || rawTimeline.length > 24) return null;
  var timeline = [];
  for (var i = 0; i < rawTimeline.length; i += 1) {
    var item = rawTimeline[i];
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    var time = String(item.time == null ? '' : item.time);
    if (!HM_RE.test(time)) return null;
    var title = String(item.title == null ? '' : item.title).trim().slice(0, ENTRY_TITLE_MAX);
    if (!title) return null;
    timeline.push({ time: time, title: title, ai: item.ai === true });
  }
  var warmIndex = value.warmIndex == null ? null : value.warmIndex;
  if (warmIndex !== null && !isInt(warmIndex, 0, timeline.length - 1)) return null;
  return { date: date, events: value.events, timeline: timeline, warmIndex: warmIndex };
}

function sanitizeLessons(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  var rawLearned = Array.isArray(value.learned) ? value.learned : [];
  if (rawLearned.length > 12) return null;
  var learned = [];
  for (var i = 0; i < rawLearned.length; i += 1) {
    var row = rawLearned[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    var usageId = String(row.usageId == null ? '' : row.usageId);
    if (!USAGE_ID_RE.test(usageId)) return null;
    var title = String(row.title == null ? '' : row.title).trim().slice(0, 60);
    if (!title) return null;
    if (!isInt(row.count, 1, 1e6)) return null;
    learned.push({ usageId: usageId, title: title, count: row.count });
  }
  var rawFirst = value.firstGraduation;
  var firstGraduation = null;
  if (rawFirst != null) {
    if (!rawFirst || typeof rawFirst !== 'object' || Array.isArray(rawFirst)) return null;
    var gDate = String(rawFirst.date == null ? '' : rawFirst.date);
    if (!YMD_RE.test(gDate) || Number.isNaN(Date.parse(gDate))) return null;
    var gTime = String(rawFirst.time == null ? '' : rawFirst.time);
    if (!HM_RE.test(gTime)) return null;
    var app = String(rawFirst.app == null ? '' : rawFirst.app);
    if (!APP_ID_RE.test(app)) return null;
    firstGraduation = { date: gDate, time: gTime, app: app };
  }
  return { learned: learned, firstGraduation: firstGraduation };
}

function sanitizeSavedTime(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!isInt(value.confirmedMinutes, 0, 1e6)) return null; // 只统计本人确认过的（红线）
  var raw = Array.isArray(value.allocations) ? value.allocations : [];
  if (raw.length > KINDS.length) return null;
  var allocations = [];
  for (var i = 0; i < raw.length; i += 1) {
    var row = raw[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    var use = String(row.use == null ? '' : row.use);
    if (KINDS.indexOf(use) < 0) return null; // 去向按账本 use kind 存原始真值
    if (!isInt(row.minutes, 0, 1e6)) return null;
    allocations.push({ use: use, minutes: row.minutes });
  }
  return { confirmedMinutes: value.confirmedMinutes, allocations: allocations };
}

function sanitizeRhythm(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  var rawHourly = Array.isArray(value.hourly) ? value.hourly : null;
  if (!rawHourly || rawHourly.length !== 24) return null; // SPEC §3 ⑥: 24 小时热力
  var hourly = [];
  for (var i = 0; i < 24; i += 1) {
    if (!isInt(rawHourly[i], 0, 1e6)) return null;
    hourly.push(rawHourly[i]);
  }
  var goldenHour = value.goldenHour == null ? null : value.goldenHour;
  if (goldenHour !== null && !isInt(goldenHour, 0, 23)) return null;
  var rawGenre = value.genre;
  var genre = null;
  if (rawGenre != null) {
    if (!rawGenre || typeof rawGenre !== 'object' || Array.isArray(rawGenre)) return null;
    var id = String(rawGenre.id == null ? '' : rawGenre.id);
    if (!GENRE_ID_RE.test(id)) return null;
    var title = String(rawGenre.title == null ? '' : rawGenre.title).trim().slice(0, 24);
    if (!title) return null;
    var tagline = String(rawGenre.tagline == null ? '' : rawGenre.tagline).trim().slice(0, 40);
    genre = { id: id, title: title, tagline: tagline }; // 流派规则与同频共用（SPEC §3 ⑥）
  }
  return { hourly: hourly, goldenHour: goldenHour, genre: genre };
}

function sanitizePanels(value) {
  var raw = Array.isArray(value) ? value : null;
  if (!raw || !raw.length || raw.length > 12) return null;
  var out = [];
  for (var i = 0; i < raw.length; i += 1) {
    var row = raw[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    var label = String(row.label == null ? '' : row.label).trim();
    if (!label || label.length > 12) return null; // 计算产物超限即拒绝，不截断
    var caption = String(row.caption == null ? '' : row.caption).trim();
    if (!caption || caption.length > 24) return null; // SPEC §5: 每条 ≤ 24 字，模板兜底必在
    out.push({ label: label, caption: caption });
  }
  return out;
}

function sanitizeKeywords(value) {
  var raw = Array.isArray(value) ? value : [];
  if (raw.length > 10) return null; // SPEC: Top 6 / 年度十大
  var out = [];
  for (var i = 0; i < raw.length; i += 1) {
    var row = raw[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    var word = String(row.word == null ? '' : row.word).trim();
    if (!word || word.length > 16) return null; // 分词超限即拒绝：截断会改变词义
    if (!isNum(row.weight, 0, 1e6) || row.weight <= 0) return null;
    out.push({ word: word, weight: row.weight });
  }
  return out;
}

function sanitizeWishEcho(value) {
  if (value == null) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  var text = String(value.text == null ? '' : value.text).trim().slice(0, WISH_TEXT_MAX);
  if (!text) return null;
  var reply = String(value.reply == null ? '' : value.reply).trim().slice(0, 120);
  if (!reply) return null;
  if (typeof value.matched !== 'boolean') return null;
  var rawFacts = Array.isArray(value.facts) ? value.facts : [];
  if (rawFacts.length > 4) return null;
  var facts = [];
  for (var i = 0; i < rawFacts.length; i += 1) {
    var fact = rawFacts[i];
    if (!fact || typeof fact !== 'object' || Array.isArray(fact)) return null;
    var label = String(fact.label == null ? '' : fact.label).trim().slice(0, 12);
    var factValue = String(fact.value == null ? '' : fact.value).trim().slice(0, 24);
    if (!label || !factValue) return null;
    facts.push({ label: label, value: factValue });
  }
  return { text: text, reply: reply, matched: value.matched, facts: facts };
}

function sanitizeSongStats(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!isNum(value.busyness, 0, 1)) return null;  // SPEC §4: 0–1 分位
  if (!isNum(value.mood, 0, 1)) return null;      // SPEC §4: 0–1 占比
  var dominantKind = String(value.dominantKind == null ? '' : value.dominantKind);
  if (KINDS.indexOf(dominantKind) < 0) return null;
  var rawWeekly = Array.isArray(value.weeklyCounts) ? value.weeklyCounts : null;
  if (!rawWeekly || !rawWeekly.length || rawWeekly.length > 53) return null; // 年章最多 53 周
  var weeklyCounts = [];
  for (var i = 0; i < rawWeekly.length; i += 1) {
    if (!isInt(rawWeekly[i], 0, 1e5)) return null;
    weeklyCounts.push(rawWeekly[i]);
  }
  var rawGrad = Array.isArray(value.graduations) ? value.graduations : null;
  if (!rawGrad || rawGrad.length !== weeklyCounts.length) return null; // 与每周对齐: 第 i 周毕业次数
  var graduations = [];
  for (var j = 0; j < rawGrad.length; j += 1) {
    if (!isInt(rawGrad[j], 0, 1e4)) return null;
    graduations.push(rawGrad[j]);
  }
  return {
    busyness: value.busyness,
    mood: value.mood,
    dominantKind: dominantKind,
    weeklyCounts: weeklyCounts,
    graduations: graduations,
  };
}

export function validateStats(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  var totals = sanitizeTotals(value.totals);
  if (!totals) return null;
  var kindMinutes = sanitizeKindMinutes(value.kindMinutes);
  if (!kindMinutes) return null;
  var topDay = sanitizeTopDay(value.topDay);
  if (topDay === null && value.topDay != null) return null;
  var lessons = sanitizeLessons(value.lessons);
  if (!lessons) return null;
  var savedTime = sanitizeSavedTime(value.savedTime);
  if (!savedTime) return null;
  var rhythm = sanitizeRhythm(value.rhythm);
  if (!rhythm) return null;
  var panels = sanitizePanels(value.panels);
  if (!panels) return null;
  var keywords = sanitizeKeywords(value.keywords);
  if (!keywords) return null;
  var wishEcho = sanitizeWishEcho(value.wishEcho);
  if (wishEcho === null && value.wishEcho != null) return null;
  var song = sanitizeSongStats(value.song);
  if (!song) return null;
  return {
    totals: totals,
    kindMinutes: kindMinutes,
    topDay: topDay,
    lessons: lessons,
    savedTime: savedTime,
    rhythm: rhythm,
    panels: panels,
    keywords: keywords,
    wishEcho: wishEcho,
    song: song,
  };
}

// ---------------------------------------------------------------------------
// Pages — { type, params }. params 全部可选、白名单校验；页面内容一律从
// stats 读取（不复制数据），可编辑文案一律走 captions（不进 params）。
// ---------------------------------------------------------------------------
function validMetricKeys(value) {
  if (!Array.isArray(value) || value.length !== 4) return null; // SPEC §3 ⑨: 4 个数字
  var out = [];
  for (var i = 0; i < value.length; i += 1) {
    var key = String(value[i] == null ? '' : value[i]);
    if (!METRIC_KEY_RE.test(key)) return null;
    out.push(key);
  }
  return out;
}

function sanitizePageParams(type, value) {
  var params = {};
  if (value == null) return params;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  var keys = Object.keys(value);
  for (var i = 0; i < keys.length; i += 1) {
    var key = keys[i];
    var raw = value[key];
    if (type === 'specialDay' && key === 'maxTimeline') {
      if (!isInt(raw, 1, 24)) return null;
      params.maxTimeline = raw;
    } else if (type === 'lessons' && key === 'limit') {
      if (!isInt(raw, 1, 8)) return null;
      params.limit = raw;
    } else if (type === 'yearKeywords' && key === 'topN') {
      if (!isInt(raw, 1, 20)) return null;
      params.topN = raw;
    } else if (type === 'poster' && key === 'metricKeys') {
      var metricKeys = validMetricKeys(raw);
      if (!metricKeys) return null;
      params.metricKeys = metricKeys;
    } else {
      return null; // 未知参数一律拒绝（后续线不得私挂字段）
    }
  }
  return params;
}

export function validatePage(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  var type = String(value.type == null ? '' : value.type);
  var known = PAGE_TYPES.indexOf(type) >= 0 || YEAR_PAGE_TYPES.indexOf(type) >= 0;
  if (!known) return null;
  var params = sanitizePageParams(type, value.params);
  if (params === null) return null;
  return { type: type, params: params };
}

function sameTypes(pages, order) {
  if (pages.length !== order.length) return false;
  for (var i = 0; i < order.length; i += 1) if (pages[i].type !== order[i]) return false;
  return true;
}

export function validatePages(pages, type, variant) {
  if (CHAPTER_TYPES.indexOf(type) < 0) return null;
  var v = variant == null ? 'full' : variant;
  if (CHAPTER_VARIANTS.indexOf(v) < 0) return null;
  if (!Array.isArray(pages) || !pages.length) return null;
  var out = [];
  for (var i = 0; i < pages.length; i += 1) {
    var page = validatePage(pages[i]);
    if (!page) return null;
    out.push(page);
  }
  if (v === 'short') return sameTypes(out, SHORT_PAGE_ORDER) ? out : null;
  if (type === 'week') return sameTypes(out, WEEK_PAGE_ORDER) ? out : null;
  if (type === 'month') return sameTypes(out, PAGE_TYPES) ? out : null;
  // year/full：cover 开篇、poster 收尾、六个年度专属页型齐备；总页数不锁定
  // （SPEC §2 的 18 页 vs 10+6=16，待 CTO 裁决）。cover/poster 恰好一次。
  if (out.length < 1 + YEAR_PAGE_TYPES.length + 1) return null;
  if (out[0].type !== 'cover' || out[out.length - 1].type !== 'poster') return null;
  var counts = {};
  for (var j = 0; j < out.length; j += 1) counts[out[j].type] = (counts[out[j].type] || 0) + 1;
  if (counts.cover !== 1 || counts.poster !== 1) return null;
  for (var k = 0; k < YEAR_PAGE_TYPES.length; k += 1) {
    if (!counts[YEAR_PAGE_TYPES[k]]) return null;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Captions — 用户可编辑文案 (SPEC §5: 编辑后保存在章节里)。key 约定归
// narrative/pages 线定义；契约只锁 key 形状、值上限与键数上限。
// ---------------------------------------------------------------------------
export function sanitizeCaptions(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  var out = {};
  var keys = Object.keys(value);
  for (var i = 0; i < keys.length && Object.keys(out).length < 32; i += 1) {
    var key = keys[i];
    if (!CAPTION_KEY_RE.test(key)) continue;
    var text = String(value[key] == null ? '' : value[key]).trim().slice(0, CAPTION_MAX);
    if (text) out[key] = text;
  }
  return out;
}

// ---------------------------------------------------------------------------
// Wish — { text, category, at }。心愿写在章节里，下一章开头回应（连载感）。
// ---------------------------------------------------------------------------
export function validateWish(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  var text = String(value.text == null ? '' : value.text).trim().slice(0, WISH_TEXT_MAX);
  if (!text) return null;
  var category = value.category == null ? null : value.category;
  if (category !== null && WISH_CATEGORIES.indexOf(category) < 0) return null;
  var at = value.at == null ? null : String(value.at);
  if (at !== null && Number.isNaN(Date.parse(at))) return null;
  return { text: text, category: category, at: at };
}

// ---------------------------------------------------------------------------
// Chapter — SPEC §6 存储形状 + 文件头声明的最小增补（variant, no）。
//   { id, no, type, variant, period:{from,to}, generatedAt, stats, pages,
//     captions, wish, songSeed }
// wish 在 page ⑧ 保存前为 null；captions 可为空对象；未知字段白名单丢弃。
// ---------------------------------------------------------------------------
export function validateChapter(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  var id = String(value.id == null ? '' : value.id);
  if (!UUID_RE.test(id)) return null;
  if (!isInt(value.no, 1, 1e6)) return null; // 章号：修剪不重排（见文件头）
  var type = String(value.type == null ? '' : value.type);
  if (CHAPTER_TYPES.indexOf(type) < 0) return null;
  var variant = value.variant == null ? 'full' : value.variant;
  if (CHAPTER_VARIANTS.indexOf(variant) < 0) return null;
  var period = validatePeriod(value.period);
  if (!period) return null;
  var generatedAt = String(value.generatedAt == null ? '' : value.generatedAt);
  if (!generatedAt || Number.isNaN(Date.parse(generatedAt))) return null;
  var stats = validateStats(value.stats);
  if (!stats) return null;
  var rawPages = Array.isArray(value.pages) ? value.pages : null;
  if (!rawPages) return null;
  var pages = validatePages(rawPages, type, variant);
  if (!pages) return null;
  var captions = sanitizeCaptions(value.captions);
  var wish = value.wish == null ? null : validateWish(value.wish);
  if (value.wish != null && !wish) return null;
  var songSeed = normalizeSongSeed(value.songSeed);
  if (songSeed == null) return null;
  return {
    id: id,
    no: value.no,
    type: type,
    variant: variant,
    period: period,
    generatedAt: generatedAt,
    stats: stats,
    pages: pages,
    captions: captions,
    wish: wish,
    songSeed: songSeed,
  };
}

export function createChapter(fields, options) {
  options = options || {};
  var f = fields || {};
  var type = String(f.type == null ? '' : f.type);
  if (CHAPTER_TYPES.indexOf(type) < 0) return null;
  var variant = f.variant == null ? 'full' : f.variant;
  if (CHAPTER_VARIANTS.indexOf(variant) < 0) return null;
  if (!isInt(f.no, 1, 1e6)) return null; // 章号由生成方（scheduler）显式给定
  var period = validatePeriod(f.period);
  if (!period) return null;
  var stats = validateStats(f.stats);
  if (!stats) return null;
  var rawPages = f.pages == null ? null : f.pages;
  if (rawPages == null) {
    var order = pageOrderFor(type, variant);
    if (!order) return null; // year/full 无默认页序，必须显式给 pages
    rawPages = [];
    for (var i = 0; i < order.length; i += 1) rawPages.push({ type: order[i] });
  }
  var pages = validatePages(rawPages, type, variant);
  if (!pages) return null;
  var captions = sanitizeCaptions(f.captions);
  var wish = f.wish == null ? null : validateWish(f.wish);
  if (f.wish != null && !wish) return null;
  var id = String(options.uuid == null ? randomUuid() : options.uuid);
  if (!UUID_RE.test(id)) return null;
  var now = options.now == null ? Date.now() : options.now;
  var generatedAt = new Date(now).toISOString();
  var songSeed = options.songSeed == null ? songSeedFromId(id) : normalizeSongSeed(options.songSeed);
  if (songSeed == null) return null;
  return {
    id: id,
    no: f.no,
    type: type,
    variant: variant,
    period: period,
    generatedAt: generatedAt,
    stats: stats,
    pages: pages,
    captions: captions,
    wish: wish,
    songSeed: songSeed,
  };
}

// ---------------------------------------------------------------------------
// Store text — tango-donego.story.v1 的 localStorage 载荷。
//   'empty'   → 没存过，可从空书架开始。
//   'ok'      → 清洗后的 store（无效章节丢弃；超过 120 章保留最新的，
//               最老的被修剪 — 与 relay 的「取前 N」不同：章号连续性靠
//               chapter.no 存储而非数组位置，书架按时间排列保新。
//   'unknown' → JSON 不可读或版本不认识：绝不覆盖（隔离区策略归存储线）。
// ---------------------------------------------------------------------------
export function sanitizeStoreText(text) {
  if (text == null || String(text).trim() === '') {
    return { status: 'empty', store: { v: STORY_STORE_VERSION, chapters: [] } };
  }
  var parsed;
  try { parsed = JSON.parse(String(text)); } catch (e) { return { status: 'unknown' }; }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { status: 'unknown' };
  if (parsed.v !== STORY_STORE_VERSION) return { status: 'unknown' };
  var rawChapters = Array.isArray(parsed.chapters) ? parsed.chapters : [];
  var chapters = [];
  for (var i = 0; i < rawChapters.length; i += 1) {
    var chapter = validateChapter(rawChapters[i]);
    if (chapter) chapters.push(chapter);
  }
  if (chapters.length > MAX_CHAPTERS) chapters = chapters.slice(chapters.length - MAX_CHAPTERS);
  return { status: 'ok', store: { v: STORY_STORE_VERSION, chapters: chapters } };
}

// ---------------------------------------------------------------------------
// Soundtrack input assembly — SPEC §4 输入 = 本章统计 + 存储的种子。
// stats.song 不含 chapterSeed（种子按 SPEC §6 存在章节顶层）；本函数把两
// 边拼成 soundtrack.js 的唯一入口形状。
// ---------------------------------------------------------------------------
export function songInputFor(chapter) {
  var c = validateChapter(chapter);
  if (!c) return null;
  return {
    busyness: c.stats.song.busyness,
    mood: c.stats.song.mood,
    dominantKind: c.stats.song.dominantKind,
    weeklyCounts: c.stats.song.weeklyCounts.slice(),
    graduations: c.stats.song.graduations.slice(),
    chapterSeed: c.songSeed,
  };
}
