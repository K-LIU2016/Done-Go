// web/story/pages/year-common.js — T9年书专属 线共享层。
//
// 六个年书页型（contracts YEAR_PAGE_TYPES：yearSpectrum/yearFirstLast/
// yearStreak/yearGenres/yearKeywords/yearWall）共用的视觉 token、文案词表、
// 日期工具，以及「拟扩展年度数据形状」的严格校验器。
//
// 视觉 token 来源（只读复用，不 import 兄弟页型文件——各线文件并行落盘，
// 互相 import 会把本线测试绑到他人未提交的文件上）：
//   - KIND_COLORS/KIND_LABELS/KIND_COLOR_NAMES：prototype.html :root --k-* 与
//     .p2 六色渐变逐值（与 T5页型A spectrum.js 同值，锚在原型样式表）。
//   - GENRE_PALETTE：social-sync PRD §3.2 六派颜色（与同频/T6 rhythm.js 同
//     id 同色；SPEC §3 ⑥ 流派与同频规则共用）。
//   - 浅色页底 #F4EFE4/#2a2620、金色 #FFB27A 等：原型 p1/p4/p7 逐值。
//
// 【拟扩展年度数据形状】（重要，待 CTO 裁决）：
//   契约 fa41b18 的 validateStats 白名单没有逐月/首末/连续段字段，而 SPEC §2
//   要求年书含 12 个月光谱长卷、年度第一次和最后一次、年度最长连续接力、
//   年度流派变化史。本线不自行改契约（红线 5），按下面这个最小扩展形状实
//   现严格校验的模型层；契约未扩展前这些页渲染事实性空态（不硬凑）：
//     stats.year = {
//       months: [ { m: 1..12, events: ≥0,
//                   kindMinutes: 恒 6 行 {kind,minutes,share}（KINDS 规范序输入，
//                                           输出归一到 KINDS 序），
//                   genre: {id,title,tagline}|null } ]  // 1..12 行，m 唯一
//       first:  { date:'YYYY-MM-DD', time:'HH:MM', title:1..200, kind, ai } | null
//       last:   同 first
//       streak: { days:1..366, from, to, relays≥days } | null  // 连续每天≥1次AI接力
//     }
//   streak 真值守卫：days 必须 === daysBetween(from,to)+1 且 relays ≥ days
//   （每天都有至少一次接力 → 总次数不少于天数）。
//
// 纯模块：无 DOM、无 IO；node --test 直接 import。

import { KINDS } from '../contracts.js';

// ---------------------------------------------------------------------------
// 原型 token（prototype.html 逐值）
// ---------------------------------------------------------------------------
export var KIND_COLORS = {
  create: { base: '#E8B04B', top: '#F2C46A' },
  necessary: { base: '#7C8A99', top: '#8E9BAA' },
  connect: { base: '#E9826A', top: '#F0957F' },
  explore: { base: '#6E8FD6', top: '#86A4E0' },
  restore: { base: '#5FA67F', top: '#78B996' },
  stillness: { base: '#B9A8D8', top: '#CBBDE3' },
};

export var KIND_LABELS = {
  create: '创造', necessary: '必要', connect: '相聚',
  explore: '探索', restore: '恢复', stillness: '自己的时间',
};

export var KIND_COLOR_NAMES = {
  create: '金色', necessary: '灰色', connect: '橘色',
  explore: '蓝色', restore: '绿色', stillness: '紫色',
};

// social-sync PRD §3.2 六派（id/颜色与 web/story/pages/rhythm.js GENRES 对齐）
export var GENRE_PALETTE = [
  { id: 'dawn-organizer', title: '晨光整理派', color: '#E8B04B' },
  { id: 'night-creator', title: '深夜创作派', color: '#4C7A93' },
  { id: 'relay-master', title: '接力达人派', color: '#E95432' },
  { id: 'slow-living', title: '生活慢行派', color: '#3E7B5B' },
  { id: 'academic-climber', title: '学术攀登派', color: '#615CED' },
  { id: 'multi-track', title: '多线并行派', color: '#C7701F' },
];

export function genreColor(id) {
  for (var i = 0; i < GENRE_PALETTE.length; i += 1) {
    if (GENRE_PALETTE[i].id === id) return GENRE_PALETTE[i].color;
  }
  return null;
}

export var MONTHS_ZH = ['', '一月', '二月', '三月', '四月', '五月', '六月',
  '七月', '八月', '九月', '十月', '十一月', '十二月'];

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------
export function esc(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

var YMD_RE = /^\d{4}-\d{2}-\d{2}$/;
var HM_RE = /^(?:(?:[01]\d|2[0-3]):[0-5]\d|24:00)$/;
var GENRE_ID_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;

export function isYmd(value) {
  var s = String(value == null ? '' : value);
  return YMD_RE.test(s) && !Number.isNaN(Date.parse(s));
}

export function isHm(value) {
  return HM_RE.test(String(value == null ? '' : value));
}

// 两个 YMD 的天数差（UTC 计算，纯函数；from ≤ to 时 ≥ 0）。
export function daysBetween(from, to) {
  if (!isYmd(from) || !isYmd(to)) return null;
  var a = Date.parse(String(from) + 'T00:00:00Z');
  var b = Date.parse(String(to) + 'T00:00:00Z');
  return Math.round((b - a) / 86400000);
}

// '2026-01-02' → '1月2日'（中文无前导零）
export function mdLabel(ymd) {
  var s = String(ymd == null ? '' : ymd);
  if (!isYmd(s)) return '';
  return Number(s.slice(5, 7)) + '月' + Number(s.slice(8, 10)) + '日';
}

export function monthLabel(m) {
  return Number(m) + '月';
}

export function periodYear(chapter) {
  var from = chapter && chapter.period && chapter.period.from;
  var s = String(from == null ? '' : from);
  return s.length >= 4 ? s.slice(0, 4) : '';
}

function isIntIn(value, min, max) {
  return typeof value === 'number' && Number.isFinite(value)
    && Math.floor(value) === value && value >= min && value <= max;
}

// ---------------------------------------------------------------------------
// 拟扩展形状校验器 — 计算产物超限即拒绝（镜像契约「截断 vs 拒绝」决定 8）
// ---------------------------------------------------------------------------
function sanitizeGenreObj(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  var id = String(value.id == null ? '' : value.id);
  if (!GENRE_ID_RE.test(id)) return null;
  var title = String(value.title == null ? '' : value.title).trim();
  if (!title || title.length > 24) return null;
  var tagline = String(value.tagline == null ? '' : value.tagline).trim().slice(0, 40);
  return { id: id, title: title, tagline: tagline };
}

// stats.year.months → [{m,events,kindMinutes[6 KINDS 序],genre|null}] 按月排序；非法 → null
export function sanitizeYearMonths(value) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 12) return null;
  var seen = {};
  var rows = [];
  for (var i = 0; i < value.length; i += 1) {
    var row = value[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    var m = row.m;
    if (!isIntIn(m, 1, 12) || seen[m]) return null;
    seen[m] = true;
    if (!isIntIn(row.events, 0, 1e7)) return null;
    var km = row.kindMinutes;
    if (!Array.isArray(km) || km.length !== KINDS.length) return null;
    var byKind = {};
    for (var j = 0; j < km.length; j += 1) {
      var k = km[j];
      if (!k || typeof k !== 'object' || Array.isArray(k)) return null;
      var kind = String(k.kind == null ? '' : k.kind);
      if (KINDS.indexOf(kind) < 0 || byKind[kind]) return null;
      if (!isIntIn(k.minutes, 0, 1e7)) return null;
      if (typeof k.share !== 'number' || !Number.isFinite(k.share) || k.share < 0 || k.share > 1) return null;
      byKind[kind] = { kind: kind, minutes: k.minutes, share: k.share };
    }
    var genre = row.genre == null ? null : sanitizeGenreObj(row.genre);
    if (row.genre != null && !genre) return null;
    var bands = [];
    for (var t = 0; t < KINDS.length; t += 1) bands.push(byKind[KINDS[t]]);
    rows.push({ m: m, events: row.events, kindMinutes: bands, genre: genre });
  }
  rows.sort(function (a, b) { return a.m - b.m; });
  return rows;
}

// stats.year.first / last
export function sanitizeFirstLast(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!isYmd(value.date) || !isHm(value.time)) return null;
  var title = String(value.title == null ? '' : value.title).trim().slice(0, 200);
  if (!title) return null;
  var kind = String(value.kind == null ? '' : value.kind);
  if (KINDS.indexOf(kind) < 0) return null;
  return { date: String(value.date), time: String(value.time), title: title, kind: kind, ai: value.ai === true };
}

// stats.year.streak — 真值守卫见文件头。
export function sanitizeStreak(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  if (!isIntIn(value.days, 1, 366)) return null;
  if (!isYmd(value.from) || !isYmd(value.to)) return null;
  var span = daysBetween(value.from, value.to);
  if (span == null || span < 0 || span + 1 !== value.days) return null;
  if (!isIntIn(value.relays, value.days, 1e7)) return null;
  return { days: value.days, from: String(value.from), to: String(value.to), relays: value.relays };
}

// 防御读取：契约 stats.kindMinutes（恒 6 行）→ KINDS 序副本；非法 → null
export function readKindMinutes(stats) {
  if (!stats || !Array.isArray(stats.kindMinutes) || stats.kindMinutes.length !== KINDS.length) return null;
  var byKind = {};
  for (var i = 0; i < stats.kindMinutes.length; i += 1) {
    var row = stats.kindMinutes[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) return null;
    var kind = String(row.kind == null ? '' : row.kind);
    if (KINDS.indexOf(kind) < 0 || byKind[kind]) return null;
    if (!isIntIn(row.minutes, 0, 1e7)) return null;
    if (typeof row.share !== 'number' || !Number.isFinite(row.share) || row.share < 0 || row.share > 1) return null;
    byKind[kind] = { kind: kind, minutes: row.minutes, share: row.share };
  }
  var out = [];
  for (var t = 0; t < KINDS.length; t += 1) out.push(byKind[KINDS[t]]);
  return out;
}
