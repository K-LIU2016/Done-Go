// web/story/pages/rhythm.js — ⑥ 节律与流派（SPEC §3 ⑥，原型 p6）。
//
// 页型接口（本线五页统一）：
//   buildRhythmModel(chapter)          → 纯 view-model（node 可测，不改 chapter）
//   renderRhythmPage(chapter, ctx)     → HTMLElement（DOM 仅在调用时触碰）
//     ctx.reducedMotion?: boolean      — 跳过「热力格逐列点亮」入场动画
//
// 流派规则【复用同频分支 PRD §3.2 的规则描述】——只读
// /home/jc/projects/Done-Go-social/design/social-sync/PRD.md §3.2「时间流派
// （6 种，每周计算，规则可解释）」。本文件在本分支实现同名函数 classifyGenre
// 并保持规则与阈值语义一致；【第二期与 social-features 合并】（届时本实现
// 移入共享模块，story 与 social 引用同一份）。PRD 明言「判定要点（示意），
// 做成可配置阈值并写 unit」——默认阈值即示意值，全部可经 opts 覆盖。
//
// PRD §3.2 判定要点 → 本实现的映射（顺序即优先级，先命中先赢）：
//   1 晨光整理派  morning+dawn 占比 ≥ 50% 且整理类用法多
//       → 时段占比由 hourly 计算；「整理类」= necessary 类占比 ≥ 阈值
//   2 深夜创作派  night+evening 占比 ≥ 45% 且 create 占比高
//   3 接力达人派  relays ≥ 8 且 graduations ≥ 2
//   4 生活慢行派  freedTo 中 family、rest、exercise 合计 ≥ 60%
//   5 学术攀登派  论文、文献、阅读类用法占主导 → academicDominant 输入位
//       （语义判定需 usage 原文，stats 契约不含；由 stats 线从 usages 计算
//        后传入 assembleGenreInput 之外的场景，此处恒 false，注释见下）
//   6 多线并行派  kindMix 的熵最高、事项多 → 归一熵 ≥ 0.9 且 events ≥ 20
//   未命中 → null（流派待定，绝不硬编）。
// 时段定义（可配置 dayparts；不重叠）：dawn 5–8，morning 8–12，
// evening 18–23，night 23–24∪0–5；morning+dawn = 5–12，night+evening = 18–次日 5。

import { KINDS } from '../contracts.js';

export var PAGE_TYPE = 'rhythm';

// ---------------------------------------------------------------------------
// 流派常量 — PRD §3.2 六派（id/名称/一句话描述/颜色 原样；颜色 = PRD 表列）。
// title/tagline 长度满足契约 stats.rhythm.genre（≤24 / ≤40）。
// ---------------------------------------------------------------------------
export var GENRES = [
  { id: 'dawn-organizer', title: '晨光整理派', tagline: '天刚亮，你先把一天理顺。', color: '#E8B04B' },
  { id: 'night-creator', title: '深夜创作派', tagline: '灯熄了，你的想法才刚开始。', color: '#4C7A93' },
  { id: 'relay-master', title: '接力达人派', tagline: '把顺手的事交给 AI，你接关键的棒。', color: '#E95432' },
  { id: 'slow-living', title: '生活慢行派', tagline: '省下的时间，你在慢慢生活。', color: '#3E7B5B' },
  { id: 'academic-climber', title: '学术攀登派', tagline: '论文和文献，一步步向上。', color: '#615CED' },
  { id: 'multi-track', title: '多线并行派', tagline: '几条线并行，你来回切换。', color: '#C7701F' },
];

export function genreById(id) {
  for (var i = 0; i < GENRES.length; i += 1) if (GENRES[i].id === id) return GENRES[i];
  return null;
}

// 不重叠时段（小时集合；night 跨午夜）。
export var DAYPARTS = {
  dawn: [5, 6, 7],
  morning: [8, 9, 10, 11],
  evening: [18, 19, 20, 21, 22],
  night: [23, 0, 1, 2, 3, 4],
};

// 默认阈值（PRD §3.2 示意值；全部可被 opts 覆盖）。
export var GENRE_DEFAULTS = {
  morningDawnShare: 0.5,   // 派1：morning 与 dawn 占比 ≥ 50%
  organizeShare: 0.3,      // 派1：「整理类用法多」→ necessary 占比
  nightEveningShare: 0.45, // 派2：night 与 evening 占比 ≥ 45%
  createShareHigh: 0.35,   // 派2：「create 占比高」
  minRelays: 8,            // 派3：relays ≥ 8
  minGraduations: 2,       // 派3：graduations ≥ 2
  slowLivingShare: 0.6,    // 派4：family+rest+exercise 合计 ≥ 60%
  entropyRatio: 0.9,       // 派6：kindMix 归一熵（H/ln6）阈值
  minEvents: 20,           // 派6：「事项多」
};

function sum(list) {
  var s = 0;
  for (var i = 0; i < list.length; i += 1) s += list[i];
  return s;
}

function shareOfHours(hourly, hours) {
  var total = sum(hourly);
  if (total <= 0) return 0;
  var part = 0;
  for (var i = 0; i < hours.length; i += 1) part += hourly[hours[i]] || 0;
  return part / total;
}

function normalizedEntropy(kindShare) {
  // Shannon 熵 / ln(6)：均匀分布 = 1，单一类别 = 0。
  var total = 0;
  for (var i = 0; i < KINDS.length; i += 1) total += kindShare[KINDS[i]] || 0;
  if (total <= 0) return 0;
  var h = 0;
  for (var j = 0; j < KINDS.length; j += 1) {
    var p = (kindShare[KINDS[j]] || 0) / total;
    if (p > 0) h -= p * Math.log(p);
  }
  return h / Math.log(KINDS.length);
}

// classifyGenre — 与同频分支（social-sync）同名的流派判定函数。
// 【第二期与 social-features 合并】：social 线落地时本实现移入共享模块，
// 两侧共用同一份规则与阈值；当前在本分支实现以满足 SPEC §3 ⑥
// 「流派（与同频分支的算法共用，规则可解释）」。
//
// input（全部字段显式，纯函数不读存储）：
//   hourly[24]          各小时事项数（时段占比由此计算）
//   kindShare{}         六类占比（0..1，任意归一；缺类别按 0）
//   relays, graduations 本章接力次数 / 毕业次数
//   freedShare{}        {family, rest, exercise} 占确认省时的比例
//   academicDominant    论文、文献、阅读类用法是否占主导（由 stats 线从
//                       usages 原文判定；契约 stats 不含 usage 语义）
//   events              本章事项数
// opts 覆盖 GENRE_DEFAULTS 的阈值；dayparts 可覆盖时段小时集。
// 返回 GENRES 中的流派对象或 null（流派待定）。
export function classifyGenre(input, opts) {
  if (!input || typeof input !== 'object') return null;
  var o = {};
  for (var k in GENRE_DEFAULTS) o[k] = GENRE_DEFAULTS[k];
  if (opts) for (var ok in opts) if (ok in GENRE_DEFAULTS) o[ok] = opts[ok];
  var dayparts = (opts && opts.dayparts) || DAYPARTS;

  var hourly = Array.isArray(input.hourly) ? input.hourly : [];
  var kindShare = input.kindShare || {};
  var freed = input.freedShare || {};

  // 1 晨光整理派
  var morningDawn =
    shareOfHours(hourly, dayparts.dawn) + shareOfHours(hourly, dayparts.morning);
  if (morningDawn >= o.morningDawnShare && (kindShare.necessary || 0) >= o.organizeShare) {
    return genreById('dawn-organizer');
  }
  // 2 深夜创作派
  var nightEvening =
    shareOfHours(hourly, dayparts.night) + shareOfHours(hourly, dayparts.evening);
  if (nightEvening >= o.nightEveningShare && (kindShare.create || 0) >= o.createShareHigh) {
    return genreById('night-creator');
  }
  // 3 接力达人派
  if ((input.relays || 0) >= o.minRelays && (input.graduations || 0) >= o.minGraduations) {
    return genreById('relay-master');
  }
  // 4 生活慢行派
  var slow =
    (freed.family || 0) + (freed.rest || 0) + (freed.exercise || 0);
  if (slow >= o.slowLivingShare) return genreById('slow-living');
  // 5 学术攀登派
  if (input.academicDominant === true) return genreById('academic-climber');
  // 6 多线并行派
  if (
    normalizedEntropy(kindShare) >= o.entropyRatio &&
    (input.events || 0) >= o.minEvents
  ) {
    return genreById('multi-track');
  }
  return null;
}

// 把契约 chapter 组装成 classifyGenre 输入（只读 stats 字段；academicDominant
// 恒 false——契约 stats 不含 usage 语义，语义判定由 stats 线从 usages 原文
// 计算后另行传入；第二期与 social-features 合并时统一）。
// freedShare 映射：connect→family、restore→exercise、stillness→rest
// （账本 use 只有大类，social freedTo 语义就近对齐；归一分母 = confirmedMinutes）。
export function assembleGenreInput(chapter) {
  var stats = chapter && chapter.stats;
  if (!stats) return null;
  var hourly = (stats.rhythm && stats.rhythm.hourly) || new Array(24).fill(0);
  var kindShare = {};
  var totalMinutes = 0;
  var rows = (stats.kindMinutes || []).slice(0, KINDS.length);
  for (var i = 0; i < rows.length; i += 1) totalMinutes += rows[i].minutes || 0;
  for (var j = 0; j < KINDS.length; j += 1) {
    var kind = KINDS[j];
    var row = null;
    for (var r = 0; r < rows.length; r += 1) if (rows[r].kind === kind) row = rows[r];
    kindShare[kind] = row && totalMinutes > 0 ? row.minutes / totalMinutes : 0;
  }
  var saved = stats.savedTime || { confirmedMinutes: 0, allocations: [] };
  var confirmed = saved.confirmedMinutes || 0;
  var freedShare = { family: 0, rest: 0, exercise: 0 };
  var allocs = Array.isArray(saved.allocations) ? saved.allocations : [];
  for (var a = 0; a < allocs.length; a += 1) {
    var use = allocs[a].use;
    var share = confirmed > 0 ? allocs[a].minutes / confirmed : 0;
    if (use === 'connect') freedShare.family = share;
    else if (use === 'restore') freedShare.exercise = share;
    else if (use === 'stillness') freedShare.rest = share;
  }
  var graduations = 0;
  var weekly = (stats.song && stats.song.graduations) || [];
  for (var w = 0; w < weekly.length; w += 1) graduations += weekly[w] || 0;
  return {
    hourly: hourly.slice(),
    kindShare: kindShare,
    relays: (stats.totals && stats.totals.aiRelays) || 0,
    graduations: graduations,
    freedShare: freedShare,
    academicDominant: false,
    events: (stats.totals && stats.totals.events) || 0,
  };
}

// ---------------------------------------------------------------------------
// 热力格与黄金时段（原型 p6）。
// ---------------------------------------------------------------------------

export var HEAT_MIN = 0.04; // 原型 p6 最暗格 opacity≈.02–.05，取 0.04 地板
export var HEAT_MAX = 1;

// hourly[24] → opacity[24]：相对最大值线性归一到 [HEAT_MIN, HEAT_MAX]；
// 全零时全部 HEAT_MIN（不出现除零，也不假装有峰值）。
export function heatOpacities(hourly) {
  if (!Array.isArray(hourly) || hourly.length !== 24) return null;
  var max = 0;
  for (var i = 0; i < 24; i += 1) if (hourly[i] > max) max = hourly[i];
  var out = new Array(24);
  for (var j = 0; j < 24; j += 1) {
    out[j] = max > 0 ? HEAT_MIN + (HEAT_MAX - HEAT_MIN) * (hourly[j] / max) : HEAT_MIN;
  }
  return out;
}

// 中文时段 + 12 小时制（原型 p6「晚上 10 点」；22 → 晚上 10 点）。
function daypart(hour) {
  if (hour >= 0 && hour <= 4) return '凌晨';
  if (hour <= 7) return '清晨';
  if (hour <= 11) return '上午';
  if (hour === 12) return '中午';
  if (hour <= 17) return '下午';
  return '晚上';
}

export function goldenHourTitle(hour) {
  if (hour == null || typeof hour !== 'number' || hour < 0 || hour > 23) {
    return '你的黄金时间，等数据再多一点告诉你';
  }
  // 12 小时制：0 → 0 点（凌晨零点口语），12 → 12 点（中午），其余 hour%12。
  var h12 = hour === 0 ? 0 : hour === 12 ? 12 : hour % 12;
  return daypart(hour) + ' ' + h12 + ' 点，是你的黄金时间';
}

export function buildRhythmModel(chapter) {
  var stats = chapter && chapter.stats;
  var rhythm = (stats && stats.rhythm) || {};
  var hourly = Array.isArray(rhythm.hourly) ? rhythm.hourly : [];
  var genreStored = rhythm.genre || null;
  var genreKnown = genreStored ? genreById(genreStored.id) : null;
  return {
    pageType: PAGE_TYPE,
    kicker: '你最常在什么时候做事',
    title: goldenHourTitle(rhythm.goldenHour == null ? null : rhythm.goldenHour),
    opacities: heatOpacities(hourly) || new Array(24).fill(HEAT_MIN),
    hourTicks: ['0 点', '6', '12', '18', '23'], // 原型 p6 标尺
    genreHeading: monthNameOf(chapter) + '你的时间流派',
    genreCard: genreStored
      ? {
          title: genreStored.title,
          tagline: genreStored.tagline,
          // 颜色不在契约存储里（只存 id/title/tagline），按 id 回查六派色板。
          color: genreKnown ? genreKnown.color : '#3B6A82',
        }
      : null,
    genrePendingNote: '本期数据还不足以判定流派',
    footNote: '按事项开始时间',
  };
}

// 月份名（'2026-10-01' → '十月'）；供本页与 four/poster 页共用的一致口径。
export function monthNameOf(chapter) {
  var from = chapter && chapter.period && String(chapter.period.from || '');
  var m = /^(\d{4})-(\d{2})-/.exec(from);
  if (!m) return '';
  var names = ['一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'];
  return names[parseInt(m[2], 10) - 1] || '';
}

// ---------------------------------------------------------------------------
// DOM 渲染（原型 p6：.pg.p6 → inner → k, big, .heat 24 格, .hours, .arche, foot）。
// 动效「热力格逐列点亮」（SPEC §3 ⑥）：24 格按列 stagger 淡入；
// reducedMotion 直接终态。
// ---------------------------------------------------------------------------

function el(tag, className, text) {
  var node = document.createElement(tag);
  if (className) node.className = className;
  if (text != null) node.textContent = text;
  return node;
}

export function renderRhythmPage(chapter, ctx) {
  ctx = ctx || {};
  var model = buildRhythmModel(chapter);
  var page = el('section', 'pg p6');
  page.dataset.storyPage = PAGE_TYPE;

  var inner = el('div', 'inner');
  page.appendChild(inner);

  inner.appendChild(el('span', 'k', model.kicker));

  var title = el('h1', 'big');
  title.style.fontSize = '34px';
  title.textContent = model.title;
  title.dataset.metric = 'rhythm.goldenHour';
  inner.appendChild(title);

  var heat = el('div', 'heat');
  heat.style.marginTop = '24px';
  inner.appendChild(heat);
  model.opacities.forEach(function (opacity, index) {
    var cell = el('i');
    cell.style.opacity = String(opacity);
    cell.dataset.metric = 'rhythm.hourly.' + index;
    cell.setAttribute('aria-hidden', 'true');
    heat.appendChild(cell);
    if (cell.animate && !ctx.reducedMotion) {
      cell.style.opacity = '0';
      cell.animate(
        [{ opacity: '0' }, { opacity: String(opacity) }],
        { duration: 260, delay: index * 45, fill: 'forwards', easing: 'ease-out' }
      ).onfinish = function () { cell.style.opacity = String(opacity); };
    }
  });

  var hours = el('div', 'hours');
  model.hourTicks.forEach(function (t) { hours.appendChild(el('span', null, t)); });
  inner.appendChild(hours);

  var arche = el('div', 'arche');
  arche.style.marginTop = '22px';
  if (model.genreCard) {
    arche.style.background = 'linear-gradient(135deg,' + model.genreCard.color + ',#24475A)';
    arche.appendChild(el('small', null, model.genreHeading));
    var name = el('b', null, model.genreCard.title);
    name.dataset.metric = 'rhythm.genre';
    arche.appendChild(name);
    var tag = el('p', null, model.genreCard.tagline);
    tag.style.cssText = 'font-size:13px;opacity:.9;margin-top:4px';
    arche.appendChild(tag);
  } else {
    arche.appendChild(el('small', null, model.genreHeading));
    arche.appendChild(el('b', null, '流派待定'));
    var note = el('p', null, model.genrePendingNote);
    note.style.cssText = 'font-size:13px;opacity:.9;margin-top:4px';
    arche.appendChild(note);
  }
  inner.appendChild(arche);

  var foot = el('div', 'foot');
  foot.appendChild(el('span', null, model.footNote));
  foot.appendChild(el('span', null, '轻点继续 ›'));
  inner.appendChild(foot);

  return page;
}
