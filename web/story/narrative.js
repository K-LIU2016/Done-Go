// web/story/narrative.js — T2 叙事线：模板文案、心愿回应、关键词提取、AI 润色。
// SPEC design/story-recap/SPEC.md §5（叙事文案）+ §3 页面库 + §2 短章；原型
// design/story-recap/prototype.html 的文案是语感基准。
//
// 职责（只此一件文件）：
//   1. 每页 3–5 个规则模板，按数据条件选择（SPEC §5 规则模板优先）；
//   2. 心愿回应规则：可量化（sleep/exercise/learning/company）给数据，
//      不可量化（other）只做温柔复述（SPEC §3 ⑧）；
//   3. 中文关键词提取：领域词典最长匹配 + 残余双字切分，零依赖（SPEC §3 ⑦）；
//   4. AI 润色：mode:'story'，输入只有统计数字（绝不包含事项原文/用法标题/
//      时间线），经 lab 服务端代理调用（key 只在服务端，本模块只见 endpoint）；
//      传输可注入（stub 可测），任何失败回退模板（SPEC §5 失败时用模板）；
//   5. 文案红线：不鸡汤、不夸大、不与他人比较、不出现「留白」（JC 指定）。
//
// 形状一律以 web/story/contracts.js 为准（红线：一律 import contracts）：
//   captions 过 sanitizeCaptions；buildPanels/extractKeywords/echoWish 的产物
//   直接可填入 validateStats 的 panels/keywords/wishEcho 槽。
//
// Pure module：无 DOM、无顶层 fetch、无存储 IO —— node --test 直接可用。
// 所有选择函数确定性：同一 (stats, meta) 永远产出同一文案。

import { pageOrderFor, isQuantifiableWish } from './contracts.js';

// ---------------------------------------------------------------------------
// 类别词表 — 原型 ② 六色光谱的 legend 用词。
// ---------------------------------------------------------------------------
export var KIND_NAMES = {
  necessary: '必要',
  create: '创造',
  connect: '相聚',
  explore: '探索',
  restore: '恢复',
  stillness: '自己的时间',
};

export var KIND_COLOR_WORDS = {
  necessary: '灰蓝',
  create: '金色',
  connect: '橘色',
  explore: '蓝色',
  restore: '绿色',
  stillness: '紫色',
};

var TYPE_NAMES = { week: '周记', month: '月章', year: '年书' };
var MONTH_CHARS = ['一', '二', '三', '四', '五', '六', '七', '八', '九', '十', '十一', '十二'];

// ---------------------------------------------------------------------------
// 文案红线 — SPEC §5 禁止项 + JC 指定避词。lintCopy 供模板自检与 AI 产出过滤。
// ---------------------------------------------------------------------------
var FORBIDDEN_WORDS = ['留白']; // JC 明确不与「留白」交叠
var CHICKEN_SOUP_WORDS = [
  '未来可期', '遇见更好的自己', '成为更好的自己', '相信自己', '你是最棒的',
  '越努力越幸运', '岁月静好', '静待花开', '破茧成蝶', '诗和远方', '正能量',
  '逆风翻盘', '向阳而生', '不负韶华', '自律给我自由', '治愈自己', '请相信',
];
var ADVICE_WORDS = ['你要', '你应该', '别忘了', '要学会', '记住，'];
var EXAGGERATION_WORDS = ['海量', '无数', '惊天', '逆天', '爆表', '无人能及', '史上最', '世界上最'];
var PEER_PATTERNS = [
  /\d+\s*%\s*的人/,                       // 「你比 90% 的人更……」（同频以外不做排名）
  /比\s*(大多数人|所有人|别人|其他人)/,
  /超过了?\s*(大多数|所有人|百分之[九八七六五])/,
];

export function lintCopy(text) {
  if (typeof text !== 'string') return { ok: false, reasons: ['not-text'] };
  var value = text.trim();
  if (!value) return { ok: false, reasons: ['empty'] };
  var reasons = [];
  for (var f = 0; f < FORBIDDEN_WORDS.length; f += 1) {
    if (value.indexOf(FORBIDDEN_WORDS[f]) >= 0) { reasons.push('forbidden-word'); break; }
  }
  for (var s = 0; s < CHICKEN_SOUP_WORDS.length; s += 1) {
    if (value.indexOf(CHICKEN_SOUP_WORDS[s]) >= 0) { reasons.push('chicken-soup'); break; }
  }
  if (includesAny(value, ADVICE_WORDS)) reasons.push('advice');
  for (var e = 0; e < EXAGGERATION_WORDS.length; e += 1) {
    if (value.indexOf(EXAGGERATION_WORDS[e]) >= 0) { reasons.push('exaggeration'); break; }
  }
  for (var p = 0; p < PEER_PATTERNS.length; p += 1) {
    if (PEER_PATTERNS[p].test(value)) { reasons.push('peer-comparison'); break; }
  }
  return { ok: reasons.length === 0, reasons: reasons };
}

function includesAny(value, words) {
  for (var i = 0; i < words.length; i += 1) if (value.indexOf(words[i]) >= 0) return true;
  return false;
}

// ---------------------------------------------------------------------------
// 数字与时段的中文格式化。
// ---------------------------------------------------------------------------
export function formatMinutes(minutes) {
  var m = typeof minutes === 'number' && Number.isFinite(minutes) && minutes > 0 ? Math.round(minutes) : 0;
  if (m < 90) return m + ' 分钟';
  var hours = Math.round((m / 60) * 10) / 10;
  var text = hours % 1 === 0 ? String(hours) : hours.toFixed(1);
  return text + ' 小时';
}

export function formatHour(hour) {
  var h = typeof hour === 'number' && Number.isFinite(hour) ? Math.round(hour) : -1;
  if (h < 0 || h > 23) return '';
  if (h === 0) return '凌晨 12 点';
  if (h <= 4) return '凌晨 ' + h + ' 点';
  if (h <= 7) return '早上 ' + h + ' 点';
  if (h <= 11) return '上午 ' + h + ' 点';
  if (h === 12) return '中午 12 点';
  if (h <= 16) return '下午 ' + (h - 12) + ' 点';
  if (h <= 18) return '傍晚 ' + (h - 12) + ' 点';
  if (h <= 22) return '晚上 ' + (h - 12) + ' 点';
  return '深夜 11 点';
}

function hmMinutes(value) {
  var match = /^(\d{1,2}):(\d{2})$/.exec(String(value == null ? '' : value));
  if (!match) return null;
  return Number(match[1]) * 60 + Number(match[2]);
}

function dateCN(ymd) {
  var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(ymd == null ? '' : ymd));
  if (!match) return '';
  return Number(match[2]) + ' 月 ' + Number(match[3]) + ' 日';
}

// ---------------------------------------------------------------------------
// meta 解析 — { type, variant, no, period, pages?, persona? }。
// ---------------------------------------------------------------------------
function metaInfo(meta) {
  var m = meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : {};
  var type = ['week', 'month', 'year'].indexOf(m.type) >= 0 ? m.type : 'month';
  var variant = m.variant === 'short' ? 'short' : 'full';
  var no = typeof m.no === 'number' && Number.isFinite(m.no) && m.no >= 1 ? Math.round(m.no) : 1;
  var period = null;
  if (m.period && typeof m.period.from === 'string') {
    var match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(m.period.from);
    if (match) period = { year: Number(match[1]), month: Number(match[2]) };
  }
  var monthName = period ? MONTH_CHARS[period.month - 1] + '月' : null;
  var periodWord = type === 'week' ? '这一周' : type === 'year' ? '这一年' : '这个月';
  var periodLabel = monthName || periodWord;
  var unitWord = type === 'week' ? '周' : type === 'year' ? '年' : '月';
  var typeName = variant === 'short' ? '短章' : TYPE_NAMES[type];
  return {
    type: type, variant: variant, no: no,
    periodWord: periodWord, periodLabel: periodLabel, unitWord: unitWord, typeName: typeName,
    pages: Array.isArray(m.pages) ? m.pages : null,
  };
}

function statsOf(stats) {
  return stats && typeof stats === 'object' && !Array.isArray(stats) ? stats : {};
}

function kindRows(stats) {
  var rows = Array.isArray(statsOf(stats).kindMinutes) ? stats.kindMinutes : [];
  var out = [];
  for (var i = 0; i < rows.length; i += 1) {
    var row = rows[i];
    if (row && typeof row.kind === 'string' && KIND_NAMES[row.kind]
        && typeof row.share === 'number' && Number.isFinite(row.share)) {
      out.push({ kind: row.kind, share: row.share, minutes: typeof row.minutes === 'number' ? row.minutes : 0 });
    }
  }
  out.sort(function (a, b) { return b.share - a.share; });
  return out;
}

function topKinds(stats) {
  var rows = kindRows(stats);
  var colorful = [];
  for (var i = 0; i < rows.length; i += 1) if (rows[i].kind !== 'necessary') colorful.push(rows[i]);
  return {
    lead: rows[0] || null,
    pair: null,
    colorful: colorful,
    totalMinutes: rows.reduce(function (sum, r) { return sum + r.minutes; }, 0),
  };
}

function twoToneKinds(stats) {
  var ranks = topKinds(stats);
  if (!ranks.lead) return null;
  var pair = null;
  if (ranks.lead.kind === 'necessary') pair = ranks.colorful[0] || null;
  else {
    for (var i = 0; i < ranks.colorful.length; i += 1) {
      if (ranks.colorful[i].kind !== ranks.lead.kind) { pair = ranks.colorful[i]; break; }
    }
  }
  ranks.pair = pair;
  return ranks;
}

// ---------------------------------------------------------------------------
// 共享条件（cover 与 poster 同源，SPEC §3 ⓪/⑨ 封面与海报同章同题）。
// ---------------------------------------------------------------------------
function whenSavedReturn(stats, meta) {
  if (metaInfo(meta).variant === 'short') return true; // 短章固定 SPEC §2 原句
  var saved = statsOf(stats).savedTime;
  return !!(saved && typeof saved.confirmedMinutes === 'number' && saved.confirmedMinutes >= 60);
}
function whenFirstGraduation(stats, meta) {
  if (metaInfo(meta).variant === 'short') return false;
  var lessons = statsOf(stats).lessons;
  return !!(lessons && lessons.firstGraduation);
}
function whenDominantColor(stats, meta) {
  if (metaInfo(meta).variant === 'short') return false;
  var lead = topKinds(stats).lead;
  return !!(lead && lead.share >= 0.4 && lead.minutes > 0);
}
function whenManyEvents(stats, meta) {
  if (metaInfo(meta).variant === 'short') return false;
  var totals = statsOf(stats).totals;
  return !!(totals && typeof totals.events === 'number' && totals.events >= 30);
}

function shortCoverTitle(meta) {
  return metaInfo(meta).periodWord + '记得不多，下一章一起写满一点';
}

// ---------------------------------------------------------------------------
// 模板注册表 — 每页 3–5 个，顺序即优先级，末位无条件兜底（when: null）。
// entry: { id, when(stats, meta) | null, captions(stats, meta) → {key: text} }
// ---------------------------------------------------------------------------

var TEMPLATES = {
  cover: [
    {
      id: 'saved-return',
      when: whenSavedReturn,
      captions: function (stats, meta) {
        var info = metaInfo(meta);
        var saved = statsOf(stats).savedTime || {};
        var minutes = typeof saved.confirmedMinutes === 'number' ? saved.confirmedMinutes : 0;
        if (info.variant === 'short') return { 'cover.title': shortCoverTitle(meta) };
        return { 'cover.title': info.periodLabel + '，你把 ' + formatMinutes(minutes) + '还给了自己' };
      },
    },
    {
      id: 'first-graduation',
      when: whenFirstGraduation,
      captions: function (stats, meta) {
        return { 'cover.title': metaInfo(meta).periodLabel + '，你第一次接住了自己的一棒' };
      },
    },
    {
      id: 'dominant-color',
      when: whenDominantColor,
      captions: function (stats, meta) {
        var lead = topKinds(stats).lead;
        return { 'cover.title': metaInfo(meta).periodLabel + '，主要是' + KIND_COLOR_WORDS[lead.kind] + '的' + KIND_NAMES[lead.kind] };
      },
    },
    {
      id: 'many-events',
      when: whenManyEvents,
      captions: function (stats, meta) {
        var totals = statsOf(stats).totals || {};
        return { 'cover.title': metaInfo(meta).periodLabel + '，' + (totals.events || 0) + ' 件事排成了队' };
      },
    },
    {
      id: 'plain-count',
      when: null,
      captions: function (stats, meta) {
        var totals = statsOf(stats).totals || {};
        return { 'cover.title': metaInfo(meta).periodLabel + '，你记下了 ' + (totals.events || 0) + ' 件事' };
      },
    },
  ],
  numbers: [
    {
      id: 'no-ai',
      when: function (stats) {
        var totals = statsOf(stats).totals || {};
        return totals.aiRelays === 0 && (totals.events || 0) > 0;
      },
      captions: function (stats) {
        var totals = statsOf(stats).totals || {};
        return { 'numbers.lead': '这一章的 ' + (totals.events || 0) + ' 件事，都是你亲手记下的。' };
      },
    },
    {
      id: 'first',
      when: function (stats) {
        var totals = statsOf(stats).totals || {};
        return totals.prevEvents == null || totals.delta == null;
      },
      captions: function (stats) {
        var totals = statsOf(stats).totals || {};
        return { 'numbers.lead': '其中 ' + (totals.aiRelays || 0) + ' 件交给了 AI 接力。这是有记录的第一章。' };
      },
    },
    {
      id: 'more',
      when: function (stats) {
        var totals = statsOf(stats).totals || {};
        return typeof totals.delta === 'number' && totals.delta > 0;
      },
      captions: function (stats) {
        var totals = statsOf(stats).totals || {};
        return { 'numbers.lead': '其中 ' + (totals.aiRelays || 0) + ' 件交给了 AI 接力。比上一章多了 ' + totals.delta + ' 件。' };
      },
    },
    {
      id: 'fewer',
      when: function (stats) {
        var totals = statsOf(stats).totals || {};
        return typeof totals.delta === 'number' && totals.delta < 0;
      },
      captions: function (stats) {
        var totals = statsOf(stats).totals || {};
        return { 'numbers.lead': '其中 ' + (totals.aiRelays || 0) + ' 件交给了 AI 接力。比上一章少了 ' + (-totals.delta) + ' 件。' };
      },
    },
    {
      id: 'flat',
      when: null,
      captions: function (stats) {
        var totals = statsOf(stats).totals || {};
        var tail = totals.delta === 0 ? '和上一章一样多。' : '和上一章差不多。';
        return { 'numbers.lead': '其中 ' + (totals.aiRelays || 0) + ' 件交给了 AI 接力。' + tail };
      },
    },
  ],
  timeColors: [
    {
      id: 'no-color',
      when: function (stats) { return topKinds(stats).totalMinutes <= 0; },
      captions: function (stats, meta) {
        return { 'timeColors.title': metaInfo(meta).periodWord + '还没有上颜色' };
      },
    },
    {
      id: 'dominant-color',
      when: function (stats) {
        var lead = topKinds(stats).lead;
        return !!(lead && lead.share >= 0.4);
      },
      captions: function (stats, meta) {
        var lead = topKinds(stats).lead;
        return { 'timeColors.title': metaInfo(meta).periodLabel + '，主要是' + KIND_COLOR_WORDS[lead.kind] + '的' + KIND_NAMES[lead.kind] };
      },
    },
    {
      id: 'two-tone',
      when: function (stats) {
        var ranks = twoToneKinds(stats);
        return !!(ranks && ranks.lead.share >= 0.25 && ranks.pair && ranks.pair.share >= 0.15);
      },
      captions: function (stats) {
        var ranks = twoToneKinds(stats);
        return {
          'timeColors.title': KIND_COLOR_WORDS[ranks.lead.kind] + '的' + KIND_NAMES[ranks.lead.kind]
            + '，夹着' + KIND_COLOR_WORDS[ranks.pair.kind] + '的' + KIND_NAMES[ranks.pair.kind],
        };
      },
    },
    {
      id: 'balanced',
      when: function (stats) {
        var lead = topKinds(stats).lead;
        return !!(lead && lead.share < 0.3);
      },
      captions: function (stats, meta) {
        return { 'timeColors.title': metaInfo(meta).periodWord + '的颜色相当平均' };
      },
    },
    {
      id: 'ranked',
      when: null,
      captions: function (stats) {
        var lead = topKinds(stats).lead;
        if (!lead) return { 'timeColors.title': '还没有上颜色的一章' };
        return { 'timeColors.title': KIND_COLOR_WORDS[lead.kind] + '的' + KIND_NAMES[lead.kind] + '排在最前' };
      },
    },
  ],
  specialDay: [
    {
      id: 'no-day',
      when: function (stats) { return !statsOf(stats).topDay; },
      captions: function () {
        return { 'specialDay.title': '还没有最特别的一天', 'specialDay.lead': '事项还太少，先不挑。' };
      },
    },
    {
      id: 'warm',
      when: function (stats) {
        var day = statsOf(stats).topDay;
        return !!(day && day.warmIndex != null && Array.isArray(day.timeline) && day.timeline[day.warmIndex]);
      },
      captions: function (stats) {
        var day = statsOf(stats).topDay;
        var warm = day.timeline[day.warmIndex];
        return {
          'specialDay.title': '那天你做了 ' + (day.events || day.timeline.length) + ' 件事',
          'specialDay.lead': '最忙的一天，你还是记下了「' + warm.title + '」。',
        };
      },
    },
    {
      id: 'span-day',
      when: function (stats) { return daySpanHours(stats) >= 14; },
      captions: function (stats) {
        var day = statsOf(stats).topDay;
        return {
          'specialDay.title': '从' + formatHour(hmHour(day.timeline[0].time)) + '到' + formatHour(hmHour(day.timeline[day.timeline.length - 1].time)) + '的一天',
          'specialDay.lead': (day.events || day.timeline.length) + ' 件事，从早排到晚。',
        };
      },
    },
    {
      id: 'busiest-day',
      when: function (stats) {
        var day = statsOf(stats).topDay;
        return !!(day && typeof day.events === 'number' && day.events >= 8);
      },
      captions: function (stats) {
        var day = statsOf(stats).topDay;
        return { 'specialDay.title': '事情最多的一天', 'specialDay.lead': (day.events || 0) + ' 件事，排在同一天。' };
      },
    },
    {
      id: 'plain-day',
      when: null,
      captions: function (stats) {
        var day = statsOf(stats).topDay || { events: 0, timeline: [] };
        var first = Array.isArray(day.timeline) && day.timeline[0] ? formatHour(hmHour(day.timeline[0].time)) : '';
        return {
          'specialDay.title': '那天你做了 ' + (day.events || 0) + ' 件事',
          'specialDay.lead': first ? '从' + first + '开始，都记下了。' : '都记下了。',
        };
      },
    },
  ],
  lessons: [
    {
      id: 'first-graduation',
      when: function (stats) {
        var lessons = statsOf(stats).lessons;
        return !!(lessons && lessons.firstGraduation);
      },
      captions: function (stats, meta) {
        var lessons = statsOf(stats).lessons || {};
        var grad = lessons.firstGraduation || {};
        var count = (lessons.learned || []).length;
        return {
          'lessons.title': count > 0 ? count + ' 个 AI 用法' : '第一次自己毕业',
          'lessons.first': dateCN(grad.date) + formatHourText(grad.time) + '，你第一次在 ' + String(grad.app || 'AI 工具') + ' 里自己毕业。那是你自己接住的第一棒。',
        };
      },
    },
    {
      id: 'top-usage',
      when: function (stats) {
        var learned = (statsOf(stats).lessons || {}).learned;
        if (!Array.isArray(learned) || learned.length < 2) return false;
        var max = 0;
        for (var i = 0; i < learned.length; i += 1) if ((learned[i].count || 0) > max) max = learned[i].count;
        return max >= 5;
      },
      captions: function (stats) {
        var learned = (statsOf(stats).lessons || {}).learned || [];
        var top = learned[0];
        for (var i = 1; i < learned.length; i += 1) if ((learned[i].count || 0) > (top.count || 0)) top = learned[i];
        return {
          'lessons.title': String(top.title) + '，用得最多',
          'lessons.first': '还没有第一次毕业的记录。',
        };
      },
    },
    {
      id: 'in-hand',
      when: function (stats) {
        var learned = (statsOf(stats).lessons || {}).learned;
        return Array.isArray(learned) && learned.length >= 1;
      },
      captions: function (stats) {
        var count = ((statsOf(stats).lessons || {}).learned || []).length;
        return { 'lessons.title': count + ' 个用法在手里', 'lessons.first': '还没有第一次毕业的记录。' };
      },
    },
    {
      id: 'none-yet',
      when: null,
      captions: function () {
        return { 'lessons.title': '还没有新的用法', 'lessons.first': '下一章，可以试一个新的。' };
      },
    },
  ],
  savedTime: [
    {
      id: 'given-away',
      when: function (stats) {
        var saved = statsOf(stats).savedTime;
        return !!(saved && saved.confirmedMinutes >= 60 && Array.isArray(saved.allocations) && saved.allocations.length > 0);
      },
      captions: function () {
        return { 'savedTime.lead': '你把它们，给了这些：' };
      },
    },
    {
      id: 'small-minutes',
      when: function (stats) {
        var saved = statsOf(stats).savedTime;
        return !!(saved && saved.confirmedMinutes > 0 && saved.confirmedMinutes < 60
          && Array.isArray(saved.allocations) && saved.allocations.length > 0);
      },
      captions: function (stats) {
        var saved = statsOf(stats).savedTime || {};
        return { 'savedTime.lead': '这 ' + (saved.confirmedMinutes || 0) + ' 分钟，也都记下了去向。' };
      },
    },
    {
      id: 'unallocated',
      when: function (stats) {
        var saved = statsOf(stats).savedTime;
        return !!(saved && saved.confirmedMinutes >= 60 && (!Array.isArray(saved.allocations) || saved.allocations.length === 0));
      },
      captions: function (stats) {
        var saved = statsOf(stats).savedTime || {};
        return { 'savedTime.lead': '省下的 ' + formatMinutes(saved.confirmedMinutes || 0) + '，还没有写下去向。' };
      },
    },
    {
      id: 'none-confirmed',
      when: null,
      captions: function (stats, meta) {
        var saved = statsOf(stats).savedTime || {};
        if (!saved.confirmedMinutes) {
          return { 'savedTime.lead': metaInfo(meta).periodWord + '还没有确认省下的时间。' };
        }
        return { 'savedTime.lead': '省下的 ' + formatMinutes(saved.confirmedMinutes) + '，还没有写下去向。' };
      },
    },
  ],
  rhythm: [
    {
      id: 'no-clock',
      when: function (stats) {
        var rhythm = statsOf(stats).rhythm;
        return !(rhythm && typeof rhythm.goldenHour === 'number');
      },
      captions: function () {
        return { 'rhythm.title': '还没有足够的时间点数据' };
      },
    },
    {
      id: 'early-golden',
      when: function (stats) {
        var rhythm = statsOf(stats).rhythm;
        return !!(rhythm && rhythm.goldenHour >= 5 && rhythm.goldenHour <= 10);
      },
      captions: function (stats) {
        return { 'rhythm.title': formatHour(statsOf(stats).rhythm.goldenHour) + '，你最常开始做事' };
      },
    },
    {
      id: 'golden',
      when: null,
      captions: function (stats) {
        return { 'rhythm.title': formatHour(statsOf(stats).rhythm && statsOf(stats).rhythm.goldenHour) + '，是你的黄金时间' };
      },
    },
  ],
  panels: [
    { id: 'busiest-week', when: function (c) { return c.len >= 2 && c.uniqueMax && c.count === c.max; }, text: function (c) { return '最忙的一周：' + c.count + ' 件事'; } },
    { id: 'calmest-week', when: function (c) { return c.len >= 2 && c.uniqueMin && c.count === c.min; }, text: function (c) { return '节奏最缓的一周：' + c.count + ' 件事'; } },
    { id: 'graduation', when: function (c) { return c.grad > 0; }, text: function (c) { return c.grad === 1 ? '有一次毕业的一周' : '有 ' + c.grad + ' 次毕业的一周'; } },
    { id: 'count', when: null, text: function (c) { return c.count + ' 件事的一周'; } },
  ],
  wish: [
    {
      id: 'matched-facts',
      when: function (c) { return c.quantifiable && c.facts.length > 0; },
      text: function (c) { return c.periodWord + '：' + c.facts.map(function (f) { return f.label + ' ' + f.value; }).join('，') + '。' + wishCloser(c.category); },
    },
    {
      id: 'no-data',
      when: function (c) { return c.quantifiable; },
      text: function (c) { return '上一章的心愿是「' + c.text + '」。这一章的数据还不足以回应，下一章再看看。'; },
    },
    {
      id: 'restated',
      when: null,
      text: function (c) { return '上一章你写下：「' + c.text + '」。新的一章，它和你一起继续。'; },
    },
  ],
  poster: [],
};

// poster 与 cover 共用选择条件，只有语气（你 → 我）不同。
TEMPLATES.poster = TEMPLATES.cover.map(function (entry) {
  return {
    id: entry.id,
    when: entry.when,
    captions: function (stats, meta) {
      var info = metaInfo(meta);
      if (info.variant === 'short') return { 'poster.title': shortCoverTitle(meta) };
      var saved = statsOf(stats).savedTime || {};
      var minutes = typeof saved.confirmedMinutes === 'number' ? saved.confirmedMinutes : 0;
      if (entry.id === 'saved-return') {
        return { 'poster.title': info.periodLabel + '，我把 ' + formatMinutes(minutes) + '还给了自己' };
      }
      if (entry.id === 'first-graduation') {
        return { 'poster.title': info.periodLabel + '，我第一次接住了自己的一棒' };
      }
      if (entry.id === 'dominant-color') {
        var lead = topKinds(stats).lead;
        return { 'poster.title': info.periodLabel + '，我的时间主要是' + KIND_COLOR_WORDS[lead.kind] + '的' + KIND_NAMES[lead.kind] };
      }
      if (entry.id === 'many-events') {
        var totals = statsOf(stats).totals || {};
        return { 'poster.title': info.periodLabel + '，我记下了 ' + (totals.events || 0) + ' 件事' };
      }
      var all = statsOf(stats).totals || {};
      return { 'poster.title': info.periodLabel + '，我记下了 ' + (all.events || 0) + ' 件事' };
    },
  };
});

export var NARRATIVE_PAGE_TYPES = [
  'cover', 'numbers', 'timeColors', 'specialDay', 'lessons',
  'savedTime', 'rhythm', 'panels', 'wish', 'poster',
];

export function templatesFor(pageType) {
  var list = TEMPLATES[String(pageType == null ? '' : pageType)];
  return Array.isArray(list) ? list.slice() : [];
}

function pickTemplate(pageType, stats, meta) {
  var entries = TEMPLATES[pageType] || [];
  for (var i = 0; i < entries.length; i += 1) {
    if (!entries[i].when || entries[i].when(stats, meta)) return entries[i];
  }
  return null;
}

export function selectTemplates(stats, meta) {
  var out = {};
  for (var p = 0; p < NARRATIVE_PAGE_TYPES.length; p += 1) {
    var page = NARRATIVE_PAGE_TYPES[p];
    var entry = pickTemplate(page, stats, meta);
    out[page] = entry ? entry.id : null;
  }
  return out;
}

function hmHour(value) {
  var minutes = hmMinutes(value);
  return minutes == null ? null : Math.floor(minutes / 60);
}

function formatHourText(time) {
  var hour = hmHour(time);
  if (hour == null) return '';
  var text = formatHour(hour);
  return text ? text : '';
}

function daySpanHours(stats) {
  var day = statsOf(stats).topDay;
  if (!day || !Array.isArray(day.timeline) || day.timeline.length < 2) return 0;
  var first = hmMinutes(day.timeline[0].time);
  var last = hmMinutes(day.timeline[day.timeline.length - 1].time);
  if (first == null || last == null || last < first) return 0;
  return (last - first) / 60;
}

// 每页固定文案（kicker 等）+ 选中模板的差异文案。
function commonCaptions(page, stats, meta) {
  var info = metaInfo(meta);
  var day = statsOf(stats).topDay;
  switch (page) {
    case 'cover':
      return { 'cover.kicker': '第 ' + info.no + ' 章 · ' + info.typeName };
    case 'numbers':
      return { 'numbers.kicker': info.periodWord + '，你记下了' };
    case 'timeColors':
      return { 'timeColors.kicker': '你的' + info.periodLabel + '是这个颜色' };
    case 'specialDay':
      return { 'specialDay.kicker': day && day.date ? '还记得 ' + dateCN(day.date) + '吗' : '最特别的一天' };
    case 'lessons':
      return { 'lessons.kicker': info.periodLabel + '，你多会了' };
    case 'savedTime':
      return { 'savedTime.kicker': 'AI 帮你省下的' };
    case 'rhythm':
      return { 'rhythm.kicker': '你最常在什么时候做事' };
    case 'panels':
      return { 'panels.kicker': '你的' + info.periodLabel + '四格' };
    case 'wish':
      return {
        'wish.kickerPrev': '上一章你写下的心愿',
        'wish.kickerNext': '写给下一章的自己',
        'wish.prompt': '一句就好，下一章我们一起看看',
      };
    case 'poster':
      return { 'poster.kicker': '探戈 Done&Go · 第 ' + info.no + ' 章' };
    default:
      return {};
  }
}

export function captionsFor(stats, meta) {
  if (!stats || typeof stats !== 'object' || Array.isArray(stats)) return {};
  var info = metaInfo(meta);
  var pages = info.pages;
  if (!pages) {
    var order = pageOrderFor(info.type, info.variant);
    pages = order || ['cover', 'numbers', 'poster'];
  }
  var out = {};
  for (var i = 0; i < pages.length; i += 1) {
    var page = String(pages[i]);
    if (NARRATIVE_PAGE_TYPES.indexOf(page) < 0) continue; // 年书专属页型等，本线不产文案
    var common = commonCaptions(page, stats, meta);
    for (var ck in common) out[ck] = common[ck];
    var entry = pickTemplate(page, stats, meta);
    if (entry && typeof entry.captions === 'function') {
      var extra = entry.captions(stats, meta) || {};
      for (var ek in extra) {
        if (ek.indexOf('__') === 0) continue;
        out[ek] = extra[ek];
      }
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// 四格 — buildPanels(weeklyCounts, graduations)。输入只有每周数字
// （SPEC §5：旁白只依据统计，不输入事项原文）。产物直接进 stats.panels 槽。
// ---------------------------------------------------------------------------
export function buildPanels(weeklyCounts, graduations) {
  var counts = Array.isArray(weeklyCounts) ? weeklyCounts : [];
  var grads = Array.isArray(graduations) ? graduations : [];
  if (!counts.length) return [];
  var len = Math.min(counts.length, 12); // 契约 panels ≤ 12
  var rows = [];
  var max = -1;
  var min = Infinity;
  for (var i = 0; i < len; i += 1) {
    var count = Math.max(0, Math.round(Number(counts[i]) || 0));
    var grad = Math.max(0, Math.round(Number(grads[i]) || 0));
    rows.push({ count: count, grad: grad });
    if (count > max) max = count;
    if (count < min) min = count;
  }
  var maxHits = 0;
  var minHits = 0;
  for (var j = 0; j < rows.length; j += 1) {
    if (rows[j].count === max) maxHits += 1;
    if (rows[j].count === min) minHits += 1;
  }
  var out = [];
  for (var k = 0; k < rows.length; k += 1) {
    var ctx = {
      i: k, len: rows.length, count: rows[k].count, grad: rows[k].grad,
      max: max, min: min, uniqueMax: maxHits === 1, uniqueMin: minHits === 1,
    };
    var rule = null;
    var rules = TEMPLATES.panels;
    for (var r = 0; r < rules.length; r += 1) {
      if (!rules[r].when || rules[r].when(ctx)) { rule = rules[r]; break; }
    }
    out.push({ label: '第 ' + (k + 1) + ' 周', caption: rule ? rule.text(ctx) : ctx.count + ' 件事的一周' });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 心愿 — 分类词典 + 回应规则（SPEC §3 ⑧ / contracts WISH_CATEGORIES）。
// 词典顺序即优先级（sleep > exercise > learning > company），首个命中定类。
// ---------------------------------------------------------------------------
export var WISH_KEYWORDS = {
  sleep: ['早睡', '早点睡', '晚睡', '熬夜', '睡前', '十二点前', '12 点前', '12点前', '睡眠', '早点休息'],
  exercise: ['跑步', '晨跑', '运动', '锻炼', '健身', '游泳', '骑行', '散步', '瑜伽', '打球'],
  learning: ['学习', '读书', '阅读', '论文', '英语', '单词', '课程', '复习', '预习', '学会', '考证', '练习', '写码', '代码'],
  company: ['陪伴', '陪陪', '陪', '家人', '妈妈', '爸爸', '父母', '孩子', '打电话', '朋友', '见面', '聊天', '视频'],
};

export function classifyWish(text) {
  var value = typeof text === 'string' ? text : String(text == null ? '' : text);
  if (!value.trim()) return 'other';
  var order = ['sleep', 'exercise', 'learning', 'company'];
  for (var i = 0; i < order.length; i += 1) {
    var words = WISH_KEYWORDS[order[i]];
    for (var w = 0; w < words.length; w += 1) {
      if (value.indexOf(words[w]) >= 0) return order[i];
    }
  }
  return 'other';
}

function wishCloser(category) {
  switch (category) {
    case 'sleep': return '早点睡这件事，有数据回应了。';
    case 'exercise': return '动起来的记录，都在这里。';
    case 'learning': return '学过的，都算数。';
    case 'company': return '陪伴的时间，看得见。';
    default: return '';
  }
}

// echoWish(prevWish, facts, meta) → 契约 wishEcho 槽。
// facts 是 stats 线算好的 {label,value}[]（可量化心愿的量化事实）；
// 本线只负责规则与措辞：可量化+有数据→数据回应；可量化+无数据→诚实说不足；
// 不可量化→温柔复述，绝不造数字（红线：不夸大）。
export function echoWish(prevWish, facts, meta) {
  if (!prevWish || typeof prevWish !== 'object') return null;
  var text = String(prevWish.text == null ? '' : prevWish.text).trim().slice(0, 60);
  if (!text) return null;
  var category = prevWish.category != null ? prevWish.category : classifyWish(prevWish.text);
  if (['sleep', 'exercise', 'learning', 'company', 'other'].indexOf(category) < 0) category = 'other';
  var rawFacts = Array.isArray(facts) ? facts : [];
  var cleanFacts = [];
  for (var i = 0; i < rawFacts.length && cleanFacts.length < 4; i += 1) {
    var row = rawFacts[i];
    if (!row || typeof row !== 'object') continue;
    var label = String(row.label == null ? '' : row.label).trim().slice(0, 12);
    var value = String(row.value == null ? '' : row.value).trim().slice(0, 24);
    if (label && value) cleanFacts.push({ label: label, value: value });
  }
  var ctx = {
    text: text,
    category: category,
    quantifiable: isQuantifiableWish(category),
    facts: cleanFacts,
    periodWord: metaInfo(meta).periodWord,
  };
  var entry = pickTemplate('wish', ctx, meta);
  var reply = entry && typeof entry.text === 'function' ? entry.text(ctx) : '';
  reply = String(reply).trim().slice(0, 120);
  if (!reply) return null;
  return {
    text: text,
    reply: reply,
    matched: ctx.quantifiable && cleanFacts.length > 0,
    facts: cleanFacts,
  };
}

// ---------------------------------------------------------------------------
// 中文关键词提取 — 词典最长匹配 + 残余双字切分（零依赖，SPEC §3 ⑦）。
//   1) 标题按 CJK/拉丁/数字分段；数字段丢弃；
//   2) CJK 段先按词典贪心最长匹配；匹配剩余的字符先剔除停用单字；
//   3) 剩余 ≥2 字时按双字切分（不重叠），再过停用词表（操作动词等）；
//   4) 拉丁段保留原样（≥2 字符，≤16 字符）；
//   5) 频次降序、并列按首现顺序，取 topN（默认 6，契约 ≤10）。
// ---------------------------------------------------------------------------
export var KEYWORD_DICTIONARY = [
  '毕业论文', '时间管理', '打电话',
  '论文', '组会', '实验', '跑步', '晨跑', '运动', '妈妈', '爸爸', '家人', '朋友', '室友',
  '火锅', '做饭', '买菜', '电话', '邮件', '导师', '汇报', '上课', '作业', '考试', '面试',
  '课程', '读书', '阅读', '写作', '代码', '项目', '会议', '纪要', '口语', '英语', '单词',
  '复盘', '计划', '睡觉', '午睡', '通勤', '地铁', '体检', '看病', '聚会', '生日', '旅行',
  '散步', '冥想', '吉他', '钢琴', '画画', '播客', '视频', '博客', '网站', '数据', '报告',
  '申请', '签证', '租房', '搬家', '打扫', '购物', '快递', '快递站', '模板', '周报', '月报',
  '健身', '球赛', '爬山', '摄影', '修图', '剪片', '字幕', '翻译', '校对', '答疑', '值班',
  '加班', '述职', '请假', '报销', '差旅', '客户', '需求', '评审', '上线', '发版', '复盘会',
];

export var KEYWORD_STOP_CHARS = '的了和与及在把让给去回做看写读跑打开买送洗修找订约聊陪问想要带搬查改审测调吃一个件篇通次天周还又都也很最比些种样'.split('');

export var KEYWORD_STOP_TOKENS = [
  '读懂', '看完', '写完', '做完', '整理', '回复', '安排', '准备', '继续',
  '一次', '一点', '这个', '那个', '什么', '一起', '还是', '以及', '然后',
];

var DICT_BY_LENGTH = { 2: [], 3: [], 4: [] };
(function buildDict() {
  var sorted = KEYWORD_DICTIONARY.slice().sort(function (a, b) { return b.length - a.length; });
  for (var i = 0; i < sorted.length; i += 1) {
    var word = sorted[i];
    if (!DICT_BY_LENGTH[word.length]) DICT_BY_LENGTH[word.length] = [];
    DICT_BY_LENGTH[word.length].push(word);
  }
})();

var DICT_LENGTHS = Object.keys(DICT_BY_LENGTH).map(Number).sort(function (a, b) { return b - a; });

function isCjk(ch) {
  var code = ch.charCodeAt(0);
  return code >= 0x3400 && code <= 0x9fff;
}

function segmentCjk(run, tokens, state) {
  var residue = '';
  var i = 0;
  while (i < run.length) {
    var matched = '';
    for (var l = 0; l < DICT_LENGTHS.length; l += 1) {
      var len = DICT_LENGTHS[l];
      if (i + len > run.length) continue;
      var candidate = run.slice(i, i + len);
      var bucket = DICT_BY_LENGTH[len];
      for (var b = 0; b < bucket.length; b += 1) {
        if (bucket[b] === candidate) { matched = candidate; break; }
      }
      if (matched) break;
    }
    if (matched) {
      pushResidue(residue, tokens, state);
      residue = '';
      tokens.push({ word: matched, order: state.order++ });
      i += matched.length;
    } else {
      residue += run[i];
      i += 1;
    }
  }
  pushResidue(residue, tokens, state);
}

function pushResidue(residue, tokens, state) {
  if (!residue) return;
  var kept = '';
  for (var i = 0; i < residue.length; i += 1) {
    if (KEYWORD_STOP_CHARS.indexOf(residue[i]) < 0) kept += residue[i];
  }
  for (var j = 0; j + 2 <= kept.length; j += 2) {
    tokens.push({ word: kept.slice(j, j + 2), order: state.order++ });
  }
}

export function extractKeywords(titles, options) {
  var opts = options && typeof options === 'object' ? options : {};
  var topN = Math.max(1, Math.min(10, Math.round(Number(opts.topN) || 6)));
  var rawTitles = Array.isArray(titles) ? titles : [];
  var counts = {};
  var firstOrder = {};
  var order = 0;
  for (var t = 0; t < rawTitles.length; t += 1) {
    var title = String(rawTitles[t] == null ? '' : rawTitles[t]);
    if (!title.trim()) continue;
    var tokens = [];
    var state = { order: order };
    var cjkRun = '';
    for (var i = 0; i < title.length; i += 1) {
      var ch = title[i];
      if (isCjk(ch)) { cjkRun += ch; continue; }
      if (cjkRun) { segmentCjk(cjkRun, tokens, state); cjkRun = ''; }
      var latin = /^[A-Za-z][A-Za-z0-9+-]*/.exec(title.slice(i));
      if (latin) {
        var word = latin[0];
        if (word.length >= 2 && word.length <= 16) tokens.push({ word: word, order: state.order++ });
        i += word.length - 1;
      }
      // 数字与标点直接跳过
    }
    if (cjkRun) segmentCjk(cjkRun, tokens, state);
    order = state.order;
    for (var k = 0; k < tokens.length; k += 1) {
      var token = tokens[k].word;
      if (token.length < 2 || token.length > 16) continue;
      if (KEYWORD_STOP_TOKENS.indexOf(token) >= 0) continue;
      if (!counts[token]) { counts[token] = 0; firstOrder[token] = tokens[k].order; }
      counts[token] += 1;
    }
  }
  var words = Object.keys(counts);
  words.sort(function (a, b) { return counts[b] - counts[a] || firstOrder[a] - firstOrder[b]; });
  var out = [];
  for (var w = 0; w < words.length && out.length < topN; w += 1) {
    out.push({ word: words[w], weight: counts[words[w]] });
  }
  return out;
}

// ---------------------------------------------------------------------------
// AI 润色 — mode:'story'，经 lab 服务端代理（D4：key 只在服务端，本模块只见
// endpoint；不写死任何真实地址）。输入只有统计数字与类别：
//   facts 白名单 = totals / kindMinutes / savedTime / rhythm(含 genre id) /
//   lessons(只有计数与毕业时间，无用法标题) / song。
//   绝不含 topDay 时间线、lessons.learned[].title、keywords（皆可能带出原文）。
// POLISH_KEYS 不含 specialDay.lead：其模板嵌入了温暖事项的标题（页面要展示
// 原文），按「输入只有统计数字」红线，这一句永不送出设备，只走模板。
// ---------------------------------------------------------------------------
export var POLISH_KEYS = [
  'cover.title', 'poster.title', 'timeColors.title', 'specialDay.title',
  'lessons.title', 'lessons.first', 'rhythm.title',
];
export var POLISH_TEXT_MAX = 24; // SPEC §5：每条 ≤ 24 字

export function buildPolishFacts(stats, meta) {
  var s = statsOf(stats);
  var info = metaInfo(meta);
  var lessons = s.lessons || {};
  var learned = Array.isArray(lessons.learned) ? lessons.learned : [];
  var rhythm = s.rhythm || {};
  var facts = {
    chapter: { type: info.type, variant: info.variant, no: info.no },
    totals: s.totals || null,
    kindMinutes: kindRows(s).map(function (r) { return { kind: r.kind, minutes: r.minutes, share: r.share }; }),
    savedTime: s.savedTime || null,
    rhythm: {
      goldenHour: typeof rhythm.goldenHour === 'number' ? rhythm.goldenHour : null,
      genreId: rhythm.genre && typeof rhythm.genre.id === 'string' ? rhythm.genre.id : null,
    },
    lessons: {
      learnedCount: learned.length,
      learnedCounts: learned.map(function (row) { return typeof row.count === 'number' ? row.count : 0; }),
      firstGraduation: lessons.firstGraduation
        ? { date: lessons.firstGraduation.date, app: lessons.firstGraduation.app } : null,
    },
    song: s.song || null,
  };
  return facts;
}

export function buildPolishRequest(captions, panels, stats, meta) {
  var cap = captions && typeof captions === 'object' ? captions : {};
  var requestItems = [];
  for (var i = 0; i < POLISH_KEYS.length; i += 1) {
    var key = POLISH_KEYS[i];
    if (typeof cap[key] === 'string' && cap[key]) requestItems.push({ key: key, current: cap[key] });
  }
  var rows = Array.isArray(panels) ? panels : [];
  for (var p = 0; p < rows.length; p += 1) {
    if (rows[p] && typeof rows[p].caption === 'string' && rows[p].caption) {
      requestItems.push({ key: 'panels.' + p, current: rows[p].caption });
    }
  }
  return { mode: 'story', facts: buildPolishFacts(stats, meta), items: requestItems };
}

function acceptedPolishText(text) {
  if (typeof text !== 'string') return null;
  var value = text.trim();
  if (!value) return null;
  if (value.length > POLISH_TEXT_MAX) return null; // SPEC §5：每条 ≤ 24 字
  if (!lintCopy(value).ok) return null;           // 红线：不鸡汤/不夸大/不出现「留白」
  return value;
}

export function applyPolishResult(captions, result) {
  var cap = captions && typeof captions === 'object' ? captions : {};
  var out = {};
  for (var k in cap) out[k] = cap[k];
  var items = result && Array.isArray(result.items) ? result.items : [];
  for (var i = 0; i < items.length; i += 1) {
    var item = items[i];
    if (!item || typeof item !== 'object') continue;
    var key = String(item.key == null ? '' : item.key);
    if (POLISH_KEYS.indexOf(key) < 0) continue;        // 只采纳润色白名单键
    if (typeof out[key] !== 'string') continue;         // 且必须是本章节已有的文案
    var text = acceptedPolishText(item.text);
    if (text) out[key] = text;                          // 否则回退模板
  }
  return out;
}

function applyPolishPanels(panels, result) {
  var rows = Array.isArray(panels) ? panels : [];
  var out = rows.map(function (row) { return { label: row.label, caption: row.caption }; });
  var items = result && Array.isArray(result.items) ? result.items : [];
  for (var i = 0; i < items.length; i += 1) {
    var item = items[i];
    if (!item || typeof item !== 'object') continue;
    var match = /^panels\.(\d+)$/.exec(String(item.key == null ? '' : item.key));
    if (!match) continue;
    var index = Number(match[1]);
    if (!out[index]) continue;
    var text = acceptedPolishText(item.text);
    if (text) out[index].caption = text;
  }
  return out;
}

function defaultTransport() {
  var fetchFn = typeof globalThis !== 'undefined' ? globalThis.fetch : null;
  if (typeof fetchFn !== 'function') return null;
  return function (endpoint, init) { return fetchFn(endpoint, init); };
}

function postPolish(request, opts) {
  var transport = opts && typeof opts.transport === 'function' ? opts.transport : defaultTransport();
  var endpoint = opts && typeof opts.endpoint === 'string' && opts.endpoint ? opts.endpoint : null;
  if (!transport || !endpoint) return Promise.resolve(null); // 无代理可用 → 模板兜底
  return transport(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(request),
  }).then(function (res) {
    if (!res || res.ok !== true) return null;
    return res.json();
  }).catch(function () { return null; });
}

export function polishCaptions(captions, stats, meta, opts) {
  var cap = captions && typeof captions === 'object' ? captions : {};
  var request = buildPolishRequest(cap, null, stats, meta);
  if (!request.items.length) return Promise.resolve(cap);
  return postPolish(request, opts).then(function (result) {
    if (!result) return cap;
    return applyPolishResult(cap, result);
  });
}

export function polishPanels(panels, stats, meta, opts) {
  var rows = Array.isArray(panels) ? panels : [];
  if (!rows.length) return Promise.resolve(rows);
  var request = buildPolishRequest(null, rows, stats, meta);
  return postPolish(request, opts).then(function (result) {
    if (!result) return rows;
    return applyPolishPanels(rows, result);
  });
}
