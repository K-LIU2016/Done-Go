// web/story/demo-data.js — 时光故事书示例数据（SPEC design/story-recap/SPEC.md §7：
// 「lab.html 和 scripts/story-lab.mjs（独立入口）：可以用『示例数据』一键生成
// 周记、月章、年书，方便 JC 验证」）。
//
// T10示例与lab line deliverable. Three jobs, all deterministic:
//
// 1. 人设示例数据 — 学生（原型 persona「安静的湖」）与老师两种人设，真实感
//    3 个月原始数据（2026-07-27 .. 2026-10-24）：账本条目（六类、无同日重叠、
//    深夜/清晨节律人设化）、AI 接力记录（真实场景库 usageId、三档自评、毕业
//    应用）、本人确认的省时去向（stillness 条目 state/kept/use）。同一人设
//    同参两次生成 deepEqual —— 种子固定，全部随机决策走 contracts.createRng，
//    绝不 Math.random。
// 2. lab 口径轻量聚合 aggregateStats + buildDemoChapter —— 仅 lab/预览/
//    prevChapter 组装用；正式统计口径是 web/story/stats.js（统计线，D2）。
//    stats.js 交付后 lab.html 会优先 import 它，本函数只作回退，两边字段都
//    通过 contracts.validateStats。流派判定复用 pages/rhythm.js 的
//    classifyGenre（SPEC §3 ⑥ 与同频分支共用，规则可解释），绝不自定流派。
// 3. 同源真实数据 readLocalStatsInput —— lab 与正式 app 同源时直接读
//    localStorage：旧账本 tango-donego.web.v1 的 entries、接力
//    tango-donego.relay.v2 的 records、上一章 tango-donego.story.v1。
//
// Pure module: no DOM, no fetch, no storage IO (storage 对象由调用方注入)。
// All dates are local wall-clock YYYY-MM-DD strings; relay `at` uses explicit
// +08:00 so generation is timezone-independent (same discipline as scheduler).

import {
  KINDS, createRng, createChapter, validateStatsInput, validatePeriod,
  STORY_STORE_KEY, sanitizeStoreText, WISH_CATEGORIES,
} from './contracts.js';
import { variantForEvents } from './scheduler.js';
import { assembleGenreInput, classifyGenre } from './pages/rhythm.js';

// ---------------------------------------------------------------------------
// 日历助手（纯字符串运算；scheduler 的 shiftYmd 未导出，这里自带最小集）
// ---------------------------------------------------------------------------
function parseYmd(ymd) {
  return { y: +ymd.slice(0, 4), m: +ymd.slice(5, 7), d: +ymd.slice(8, 10) };
}
function ymdOf(y, m, d) {
  return y + '-' + String(m).padStart(2, '0') + '-' + String(d).padStart(2, '0');
}
function shiftYmd(ymd, days) {
  var p = parseYmd(ymd);
  var t = Date.UTC(p.y, p.m - 1, p.d) + days * 86400000;
  return new Date(t).toISOString().slice(0, 10);
}
function dayCount(period) {
  return Math.round((Date.parse(period.to + 'T00:00:00Z') - Date.parse(period.from + 'T00:00:00Z')) / 86400000) + 1;
}
function lastDayOfMonth(y, m) {
  return new Date(Date.UTC(y, m, 0)).getUTCDate();
}
function prevMonthOf(ymd) {
  var p = parseYmd(ymd);
  var y = p.m === 1 ? p.y - 1 : p.y;
  var m = p.m === 1 ? 12 : p.m - 1;
  return { y: y, m: m, first: ymdOf(y, m, 1), last: ymdOf(y, m, lastDayOfMonth(y, m)) };
}
function monthZh(m) {
  return ['', '一月', '二月', '三月', '四月', '五月', '六月', '七月', '八月', '九月', '十月', '十一月', '十二月'][m];
}
function mondayOf(ymd) {
  var t = Date.parse(ymd + 'T00:00:00Z');
  var dow = new Date(t).getUTCDay(); // 0=周日
  return shiftYmd(ymd, dow === 0 ? -6 : 1 - dow);
}
function hmToMin(hm) { return +hm.slice(0, 2) * 60 + +hm.slice(3, 5); }
function minToHm(min) {
  var m = Math.max(0, Math.min(24 * 60, Math.round(min)));
  return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
}
function pick(rng, list) { return list[Math.floor(rng() * list.length) % list.length]; }
function clamp(x, lo, hi) { return Math.min(hi, Math.max(lo, x)); }
function seedMix(a, b) { return ((a ^ b) >>> 0); } // JS ^ 是有符号 32 位；种子必须落在 uint32
function uuidFromRng(rng) {
  var hex = '';
  for (var i = 0; i < 32; i += 1) hex += Math.floor(rng() * 16).toString(16);
  return hex.slice(0, 8) + '-' + hex.slice(8, 12) + '-4' + hex.slice(13, 16) + '-8' + hex.slice(17, 20) + '-' + hex.slice(20, 32);
}

// ---------------------------------------------------------------------------
// 人设档案 — 标题池（关键词名词刻意重复，喂 keywords/四格）、用法池
// （id/标题逐字来自 web/relay/scenes.zh.json）、节律参数、愿望类别。
// ---------------------------------------------------------------------------
var SPAN = { from: '2026-07-27', to: '2026-10-24' }; // 周一起、共 90 天（≈3 个月）

var PERSONAS = [
  {
    id: 'student',
    label: '学生 · 安静的湖',
    relayPersona: 'student',
    seed: 0x51091025,
    dedication: '致 安静的湖',
    // 每周（周一起）事项预算；W2 = 暑假在家（短章周）；W12 = 最忙一周（原型）
    weekPlan: [10, 3, 6, 9, 12, 16, 15, 17, 14, 14, 10, 24, 22],
    sparseWeek: 1,
    titles: {
      necessary: ['洗衣服', '采购日用品', '取快递', '整理报销单据', '预约体检', '缴房租', '收拾实验室工位'],
      create: ['读懂一篇论文', '写论文引言', '改论文图', '跑实验', '整理实验数据', '写周报', '读懂 GNN 综述', '改论文摘要'],
      connect: ['组会', '和导师聊进展', '给妈妈打电话', '和室友吃火锅', '朋友生日聚会', '实验室聚餐', '给导师回邮件'],
      explore: ['看一节公开课', '学 LaTeX 模板', '读《如何阅读文献》', '试新笔记法', '查下一周文献'],
      restore: ['晨跑 5 公里', '夜跑 3 公里', '游泳', '拉伸', '散步'],
    },
    usageMap: [
      { re: /综述/, id: 'survey-read' },
      { re: /论文/, id: 'paper-read' },
      { re: /组会|纪要/, id: 'meeting-notes' },
      { re: /导师|邮件/, id: 'advisor-mail' },
      { re: /摘要/, id: 'abstract-en' },
      { re: /汇报|讲稿/, id: 'presentation-prep' },
      { re: /周报/, id: 'weekly-report' },
      { re: /实验|文献|数据/, id: 'lab-report' },
    ],
    usages: [
      { id: 'paper-read', title: '读懂一篇论文' },
      { id: 'meeting-notes', title: '整理会议纪要' },
      { id: 'advisor-mail', title: '给导师写邮件' },
      { id: 'abstract-en', title: '摘要翻成英文' },
      { id: 'survey-read', title: '把综述读薄' },
      { id: 'presentation-prep', title: '写汇报讲稿' },
      { id: 'weekly-report', title: '写好周报' },
      { id: 'lab-report', title: '补实验报告的讨论' },
    ],
    graduationApps: ['deepseek', 'kimi', 'doubao', 'qwen'],
    // 毕业事件：[日期, 标题, usageId, app] —— 第一个是「第一次毕业」(10-12 晚 11 点，原型 ④)
    graduations: [
      ['2026-10-12', '读懂一篇论文', 'paper-read', 'deepseek'],
      ['2026-10-14', '整理实验数据', 'lab-report', 'kimi'],
      ['2026-10-19', '写论文引言', 'paper-read', 'doubao'],
      ['2026-10-22', '整理组会纪要', 'meeting-notes', 'qwen'],
    ],
    forcedDays: {
      '2026-10-18': { count: 9, warm: ['22:10', '给妈妈打电话', 'connect'] }, // 原型 ③ 最特别的一天
    },
    kindWeights: { weekday: { necessary: 0.14, create: 0.34, connect: 0.16, explore: 0.16, restore: 0.20 },
                   weekend: { necessary: 0.10, create: 0.20, connect: 0.32, explore: 0.14, restore: 0.24 } },
    aiChance: { create: 0.5, necessary: 0.18, connect: 0.15, explore: 0.35, restore: 0.05 },
    rating: { much: 0.62, little: 0.89 }, // 累积阈值：much 62% / little 27% / none 11%
    dayStart: { weekday: 8 * 60 + 30, weekend: 10 * 60, jitter: 70 },
    dayEnd: 24 * 60,
    eveningCluster: 0.55, // 晚间创作块概率（深夜创作派节律）
    durations: { necessary: [30, 90], create: [60, 180], connect: [45, 120], explore: [45, 120], restore: [30, 75] },
    wishCategory: 'sleep',
    wishText: function (m) { return '希望' + monthZh(m) + '能早点睡'; },
    wishFact: '12 点前收工',
    keywordPool: ['论文', '组会', '实验', '邮件', '跑步', '妈妈', '火锅', '室友', '导师', '综述'],
    panelsByMonth: {
      8: ['回家，论文暂停一周', '返校，收拾工位', '开学第一周，课表排满', '文献综述开了头'],
      9: ['新学期，节奏渐稳', '第一次组会汇报', '实验跑通了一版', '月底开始晨跑'],
      10: ['国庆回家三天', '最忙的一周，也常打电话', '第一次自己读完论文', '开始晨跑，省时有去处'],
    },
  },
  {
    id: 'teacher',
    label: '老师 · 清晨的备课桌',
    relayPersona: 'teacher',
    seed: 0x7e0a0311,
    dedication: '致 讲台上的你',
    weekPlan: [6, 4, 3, 8, 14, 18, 17, 16, 15, 14, 9, 24, 17],
    sparseWeek: 2, // 8 月中旬暑假（短章周）
    titles: {
      necessary: ['上课', '批改作业', '教研会议', '值班自习', '月考监考', '交教学进度表', '备课'],
      create: ['写新教案', '出练习题', '写教学反思', '做课件', '写学生评语', '整理错题本'],
      connect: ['和家长沟通', '和学生谈话', '听同事的课', '年级组会', '和家长通话', '班主任例会'],
      explore: ['读教学期刊', '看一节名师课例', '研修课程视频', '读《给教师的建议》'],
      restore: ['快走 40 分钟', '打羽毛球', '拉伸', '早起散步'],
    },
    usageMap: [
      { re: /教案|课件|备课/, id: 'lesson-plan' },
      { re: /题|月考|练习/, id: 'quiz-10' },
      { re: /评语/, id: 'comments-30' },
      { re: /家长|通知/, id: 'parent-notice' },
      { re: /成绩|分析/, id: 'grade-analysis' },
      { re: /纪要|会议|教研|例会/, id: 'meeting-notes' },
      { re: /谈话/, id: 'student-talk' },
      { re: /听课|课例/, id: 'peer-review' },
    ],
    usages: [
      { id: 'lesson-plan', title: '一节课的教案' },
      { id: 'quiz-10', title: '出 10 道练习题' },
      { id: 'comments-30', title: '写 30 条学生评语' },
      { id: 'parent-notice', title: '家长群通知' },
      { id: 'grade-analysis', title: '分析一次考试成绩' },
      { id: 'meeting-notes', title: '整理会议纪要' },
      { id: 'student-talk', title: '准备一次学生谈话' },
      { id: 'peer-review', title: '写听课评价' },
    ],
    graduationApps: ['deepseek', 'kimi'],
    graduations: [
      ['2026-09-08', '出练习题', 'quiz-10', 'deepseek'],
      ['2026-09-21', '写学生评语', 'comments-30', 'kimi'],
      ['2026-10-13', '分析一次考试成绩', 'grade-analysis', 'deepseek'],
      ['2026-10-20', '家长群通知', 'parent-notice', 'kimi'],
    ],
    forcedDays: {
      '2026-10-15': { count: 8, warm: ['20:30', '和家长沟通', 'connect'] }, // 月考周
    },
    kindWeights: { weekday: { necessary: 0.34, create: 0.22, connect: 0.20, explore: 0.10, restore: 0.14 },
                   weekend: { necessary: 0.14, create: 0.26, connect: 0.16, explore: 0.22, restore: 0.22 } },
    aiChance: { create: 0.42, necessary: 0.22, connect: 0.14, explore: 0.30, restore: 0.05 },
    rating: { much: 0.5, little: 0.85 },
    dayStart: { weekday: 6 * 60 + 40, weekend: 8 * 60, jitter: 50 },
    dayEnd: 22 * 60 + 30,
    eveningCluster: 0.3,
    durations: { necessary: [40, 120], create: [45, 150], connect: [30, 90], explore: [40, 110], restore: [30, 70] },
    wishCategory: 'exercise',
    wishText: function (m) { return '希望' + monthZh(m) + '每周运动三次'; },
    wishFact: '运动次数',
    keywordPool: ['上课', '备课', '作业', '教案', '家长', '考试', '评语', '教研', '读书', '谈话'],
    panelsByMonth: {
      8: ['暑假，读书和休整', '备下学期的课', '开学前教研培训', '课表和班级名单定下'],
      9: ['开学第一周，嗓子冒烟', '第一次用 AI 出题', '月考临近，批改堆积', '家长会开了两个小时'],
      10: ['国庆假期改完一摞卷子', '月考周，最忙一天 8 件事', '成绩分析交给 AI 初稿', '重新开始快走'],
    },
  },
];

export var DEMO_PERSONAS = PERSONAS.map(function (p) {
  return { id: p.id, label: p.label, relayPersona: p.relayPersona, seed: p.seed, dedication: p.dedication };
});

export function personaById(id) {
  for (var i = 0; i < PERSONAS.length; i += 1) if (PERSONAS[i].id === id) return PERSONAS[i];
  return null;
}

export function demoSpan(personaId) {
  if (!personaById(personaId)) return null;
  return { from: SPAN.from, to: SPAN.to };
}

// 四个一键预设：周记 = 最近完整周；月章 = 最近完整月（与调度触发一致）；
// 年书 = 数据全跨度（年书页型预览）；短章 = 人设的暑假周（<5 件事，SPEC §2）。
export function demoPeriods(personaId) {
  var persona = personaById(personaId);
  if (!persona) return null;
  var weekMonday = '2026-10-12';
  var monthFirst = '2026-09-01';
  var pm = parseYmd(monthFirst);
  return {
    week: { type: 'week', period: { from: weekMonday, to: shiftYmd(weekMonday, 6) }, label: '最近完整周（10.12–10.18）' },
    month: {
      type: 'month',
      period: { from: monthFirst, to: ymdOf(pm.y, pm.m, lastDayOfMonth(pm.y, pm.m)) },
      label: '最近完整月（2026 年 9 月，与触发日历一致）',
    },
    year: { type: 'year', period: { from: SPAN.from, to: SPAN.to }, label: '数据全跨度（年书预览，90 天）' },
    short: {
      type: 'week',
      period: (function () {
        var monday = shiftYmd(SPAN.from, persona.sparseWeek * 7);
        return { from: monday, to: shiftYmd(monday, 6) };
      })(),
      label: '暑假空周（事项少于 5 件 → 3 页短章）',
    },
  };
}

// ---------------------------------------------------------------------------
// 原始数据生成
// ---------------------------------------------------------------------------
function weightedKind(rng, weights) {
  var keys = Object.keys(weights);
  var total = 0;
  for (var i = 0; i < keys.length; i += 1) total += weights[keys[i]];
  var x = rng() * total;
  for (var j = 0; j < keys.length; j += 1) {
    x -= weights[keys[j]];
    if (x <= 0) return keys[j];
  }
  return keys[keys.length - 1];
}

function durationFor(rng, persona, kind) {
  var range = persona.durations[kind] || [30, 60];
  var min = range[0];
  var step = 15;
  return min + Math.floor(rng() * ((range[1] - min) / step + 1)) * step;
}

function buildDay(rng, persona, ymd, weekday, targetCount) {
  var weekend = weekday === 0 || weekday === 6;
  var weights = weekend ? persona.kindWeights.weekend : persona.kindWeights.weekday;
  var entries = [];
  var cursor = persona.dayStart[weekend ? 'weekend' : 'weekday'] + Math.floor(rng() * persona.dayStart.jitter) - persona.dayStart.jitter / 2;
  var gap = 0;
  for (var n = 0; n < targetCount; n += 1) {
    var kind = weightedKind(rng, weights);
    var dur = durationFor(rng, persona, kind);
    var title = pick(rng, persona.titles[kind]);
    var useAI = rng() < (persona.aiChance[kind] || 0);
    var entry = {
      id: '',
      date: ymd,
      start: minToHm(cursor),
      end: minToHm(cursor + dur),
      title: title,
      kind: kind,
      done: true,
    };
    if (useAI) {
      entry.ai = { used: true };
      if ((kind === 'create' || kind === 'necessary') && rng() < 0.6) {
        entry.completion = { before: dur, actual: Math.max(15, Math.round(dur * (0.3 + rng() * 0.25) / 15) * 15), usedAI: true };
      }
    }
    entries.push(entry);
    gap = 15 + Math.floor(rng() * 5) * 15;
    cursor += dur + gap;
    if (cursor + 45 > persona.dayEnd) break; // 放不下再一件事就收工
  }
  // 晚间创作块（学生深夜创作派 / 老师偶得）：当天还有空间时补一段晚间事项
  // （稀疏日 targetCount ≤ 1 不加 —— 短章周必须保持事项 <5）
  if (entries.length && targetCount > 1 && rng() < persona.eveningCluster) {
    var eveningStart = 19 * 60 + 30 + Math.floor(rng() * 4) * 30;
    var lastEnd = hmToMin(entries[entries.length - 1].end);
    if (eveningStart >= lastEnd && eveningStart + 60 <= persona.dayEnd) {
      var eveningKind = weightedKind(rng, { create: 0.6, explore: 0.25, connect: 0.15 });
      var eveningTitle = eveningKind === 'connect'
        ? pick(rng, persona.titles.connect)
        : pick(rng, persona.titles[eveningKind]);
      var eveningAI = rng() < (persona.aiChance[eveningKind] || 0);
      var eveningEntry = {
        id: '', date: ymd, start: minToHm(eveningStart), end: minToHm(eveningStart + durationFor(rng, persona, eveningKind)),
        title: eveningTitle, kind: eveningKind, done: true,
      };
      if (eveningAI) eveningEntry.ai = { used: true };
      entries.push(eveningEntry);
    }
  }
  return entries;
}

function forceDay(persona, ymd, spec) {
  // 原型钉住的「最特别的一天」：target 件事 + 固定温暖事件（原型 ③）。
  // 与温暖事件时段重叠的基础条目直接舍弃（保证同日无重叠）。
  var base = buildDay(createRng(seedMix(persona.seed, 0x0f1e2d3c)), persona, ymd, new Date(ymd + 'T00:00:00Z').getUTCDay(), spec.count - 1);
  base.sort(function (a, b) { return a.start < b.start ? -1 : 1; });
  var warmStart = spec.warm[0];
  var warmEnd = minToHm(hmToMin(spec.warm[0]) + 30);
  base = base.filter(function (e) { return e.end <= warmStart || e.start >= warmEnd; });
  var warm = { id: '', date: ymd, start: warmStart, end: warmEnd, title: spec.warm[1], kind: spec.warm[2], done: true };
  var out = [];
  var i = 0;
  for (; i < base.length; i += 1) {
    if (base[i].start > warm.start) break;
    out.push(base[i]);
  }
  out.push(warm);
  for (; i < base.length; i += 1) out.push(base[i]);
  return out;
}

function graduationByDate(persona) {
  var map = {};
  for (var i = 0; i < persona.graduations.length; i += 1) {
    var g = persona.graduations[i];
    map[g[1] + '|' + g[0]] = g; // title|date → graduation spec
  }
  return map;
}

function usageIdFor(persona, title) {
  for (var i = 0; i < persona.usageMap.length; i += 1) {
    if (persona.usageMap[i].re.test(title)) return persona.usageMap[i].id;
  }
  return persona.usages[0].id;
}

function ratingFor(rng, persona) {
  var x = rng();
  if (x < persona.rating.much) return 'much';
  if (x < persona.rating.little) return 'little';
  return 'none';
}

// 生成整段原始数据（entries + relays + stillness 省时流）
function generateRaw(persona) {
  var rng = createRng(persona.seed);
  var entries = [];
  var stillness = [];
  var gradMap = graduationByDate(persona);
  var firstMonday = mondayOf(SPAN.from);
  var weeks = Math.round(dayCount({ from: SPAN.from, to: SPAN.to }) / 7);

  for (var w = 0; w < weeks; w += 1) {
    var monday = shiftYmd(firstMonday, w * 7);
    var budget = persona.weekPlan[w] != null ? persona.weekPlan[w] : 12;
    var days = [];
    for (var d = 0; d < 7; d += 1) {
      var ymd = shiftYmd(monday, d);
      if (ymd < SPAN.from || ymd > SPAN.to) continue;
      days.push(ymd);
    }
    if (budget < 5) {
      // 暑假空周：只在前几天各放 1 件事（保证 <5，喂短章）
      var sparseDays = Math.max(1, budget);
      for (var s = 0; s < sparseDays && s < days.length; s += 1) {
        entries.push.apply(entries, buildDay(rng, persona, days[s], new Date(days[s] + 'T00:00:00Z').getUTCDay(), 1));
      }
      continue;
    }
    var perDay = budget / days.length;
    for (var k = 0; k < days.length; k += 1) {
      var ymd2 = days[k];
      var spec = persona.forcedDays && persona.forcedDays[ymd2];
      if (spec) {
        entries.push.apply(entries, forceDay(persona, ymd2, spec));
        continue;
      }
      var jitter = 0.7 + rng() * 0.6;
      var target = clamp(Math.round(perDay * jitter), 1, 4);
      entries.push.apply(entries, buildDay(rng, persona, ymd2, new Date(ymd2 + 'T00:00:00Z').getUTCDay(), target));
    }
  }

  // stillness 省时流：每月 4–6 条本人确认（state kept 为主，穿插 partial/reserved）。
  // 落位避让当天已有条目（候选晚间时段里挑不重叠的；都冲突则前移一天）。
  var monthly = [['2026-07-27', '2026-08-05'], ['2026-08-06', '2026-09-05'], ['2026-09-06', '2026-10-05'], ['2026-10-06', '2026-10-24']];
  var uses = ['restore', 'connect', 'explore', 'stillness'];
  var useTitles = { restore: '把省下的时间给运动', connect: '把省下的时间给家人', explore: '把省下的时间学点新东西', stillness: '把省下的时间用来早睡' };
  var eveningSlots = ['21:00', '20:30', '22:00', '19:30'];
  var sparseFrom = shiftYmd(mondayOf(SPAN.from), persona.sparseWeek * 7);
  var sparseTo = shiftYmd(sparseFrom, 6); // 短章周保持真空：省时流不落位在这里
  function overlapsAny(date, startHm, endHm) {
    for (var q = 0; q < entries.length; q += 1) {
      if (entries[q].date !== date) continue;
      if (startHm < entries[q].end && entries[q].start < endHm) return true;
    }
    for (var q2 = 0; q2 < stillness.length; q2 += 1) {
      if (stillness[q2].date !== date) continue;
      if (startHm < stillness[q2].end && stillness[q2].start < endHm) return true;
    }
    return false;
  }
  for (var m = 0; m < monthly.length; m += 1) {
    var count = 4 + Math.floor(rng() * 3);
    for (var c = 0; c < count; c += 1) {
      var sFrom = monthly[m][0] > SPAN.from ? monthly[m][0] : SPAN.from;
      var sTo = monthly[m][1] < SPAN.to ? monthly[m][1] : SPAN.to;
      var span = Math.round((Date.parse(sTo + 'T00:00:00Z') - Date.parse(sFrom + 'T00:00:00Z')) / 86400000);
      var symd = shiftYmd(sFrom, Math.floor(rng() * (span + 1)));
      var use = uses[Math.floor(rng() * uses.length)];
      var keptMin = [30, 45, 60, 90][Math.floor(rng() * 4)];
      var state = c === count - 1 && m % 2 === 1 ? 'partial' : (c === 0 && m === 3 ? 'reserved' : 'kept');
      if (symd >= sparseFrom && symd <= sparseTo) continue;
      var placed = null;
      for (var tryDay = 0; tryDay < 3 && !placed; tryDay += 1) {
        var dateTry = shiftYmd(symd, -tryDay);
        if (dateTry < sFrom || (dateTry >= sparseFrom && dateTry <= sparseTo)) break;
        for (var sl = 0; sl < eveningSlots.length; sl += 1) {
          var s0 = eveningSlots[sl];
          var e0 = minToHm(hmToMin(s0) + keptMin);
          if (!overlapsAny(dateTry, s0, e0)) { placed = { date: dateTry, start: s0, end: e0 }; break; }
        }
      }
      if (!placed) continue; // 找不到空位就少一条（省时流不硬凑）
      var row = {
        id: '', date: placed.date, start: placed.start, end: placed.end,
        title: useTitles[use], kind: 'stillness', done: true, state: state, use: use,
      };
      if (state !== 'reserved') row.kept = state === 'partial' ? Math.round(keptMin / 2) : keptMin;
      stillness.push(row);
    }
  }

  entries.sort(function (a, b) { return a.date < b.date ? -1 : a.date > b.date ? 1 : a.start < b.start ? -1 : 1; });
  var all = entries.concat(stillness).sort(function (a, b) {
    return a.date < b.date ? -1 : a.date > b.date ? 1 : a.start < b.start ? -1 : 1;
  });
  for (var e = 0; e < all.length; e += 1) all[e].id = persona.id + '-e' + String(e + 1).padStart(4, '0');

  // relays：ai 条目 1:1 生成；毕业事件钉死在指定日期/用法/应用
  var relays = [];
  var gradUsed = {};
  for (var i = 0; i < all.length; i += 1) {
    var entry = all[i];
    if (!entry.ai || entry.ai.used !== true) continue;
    var grad = gradMap[entry.title + '|' + entry.date];
    var failed = null;
    if (!grad && rng() < 0.04) failed = rng() < 0.6 ? 'timeout' : 'format';
    var record = {
      id: uuidFromRng(rng),
      at: entry.date + 'T' + entry.start + ':00+08:00',
      event: entry.title,
      usageId: usageIdFor(persona, entry.title),
      result: failed ? '' : pick(rng, ['初稿已生成，可直接修改', '要点已列出，待你核对', '草稿完成，留了待补的位置']),
      rating: failed ? null : ratingFor(rng, persona),
      graduated: !!grad,
      graduatedApp: grad ? grad[3] : null,
      failed: failed,
    };
    if (grad) gradUsed[grad[0] + grad[1]] = true;
    relays.push(record);
  }
  // 毕业事件若未自然命中（当天 ai 条目没生成），补一条钉死的接力
  for (var g2 = 0; g2 < persona.graduations.length; g2 += 1) {
    var spec2 = persona.graduations[g2];
    if (gradUsed[spec2[0] + spec2[1]]) continue;
    relays.push({
      id: uuidFromRng(rng),
      at: spec2[0] + 'T23:00:00+08:00',
      event: spec2[1],
      usageId: spec2[2],
      result: '第一次自己完成，毕业！',
      rating: 'much',
      graduated: true,
      graduatedApp: spec2[3],
      failed: null,
    });
  }
  relays.sort(function (a, b) { return a.at < b.at ? -1 : 1; });
  return { entries: all, relays: relays };
}

// ---------------------------------------------------------------------------
// lab 口径轻量聚合 — aggregateStats(input)
//   正式口径 = web/story/stats.js（统计线）；此处仅 lab 回退/预览/prevChapter。
//   字段形状全部经 contracts.validateStats（单测逐项断言与原始数据一致）。
// ---------------------------------------------------------------------------
export function aggregateStats(input) {
  var clean = validateStatsInput(input);
  if (!clean) return null;
  var period = clean.period;
  var days = dayCount(period);
  var inP = clean.entries.filter(function (e) { return e.date >= period.from && e.date <= period.to; });
  var relaysP = clean.relays.filter(function (r) { return r.at.slice(0, 10) >= period.from && r.at.slice(0, 10) <= period.to; });

  // 上一期（同长度紧前窗口）——环比与愿望对照用
  var prevPeriod = { from: shiftYmd(period.from, -days), to: shiftYmd(period.from, -1) };
  var inPrev = clean.entries.filter(function (e) { return e.date >= prevPeriod.from && e.date <= prevPeriod.to; });

  // totals
  var totals = {
    events: inP.length,
    aiRelays: relaysP.length,
    prevEvents: inPrev.length,
    delta: inP.length - inPrev.length,
  };

  // kindMinutes（按计划时长）
  var minutes = {};
  var order = KINDS;
  for (var k0 = 0; k0 < order.length; k0 += 1) minutes[order[k0]] = 0;
  for (var i = 0; i < inP.length; i += 1) {
    minutes[inP[i].kind] += hmToMin(inP[i].end) - hmToMin(inP[i].start);
  }
  var totalMinutes = 0;
  for (var k1 in minutes) totalMinutes += minutes[k1];
  var kindMinutes = order.map(function (kind) {
    return { kind: kind, minutes: minutes[kind], share: totalMinutes > 0 ? minutes[kind] / totalMinutes : 0 };
  });

  // topDay
  var byDay = {};
  for (var j = 0; j < inP.length; j += 1) {
    if (!byDay[inP[j].date]) byDay[inP[j].date] = [];
    byDay[inP[j].date].push(inP[j]);
  }
  var topDate = null;
  var topList = null;
  for (var date in byDay) {
    if (!topList || byDay[date].length > topList.length || (byDay[date].length === topList.length && date < topDate)) {
      topDate = date; topList = byDay[date];
    }
  }
  var topDay = null;
  if (topList && topList.length) {
    var sorted = topList.slice().sort(function (a, b) { return a.start < b.start ? -1 : 1; }).slice(0, 24);
    var timeline = sorted.map(function (e) {
      return { time: e.start, title: e.title, ai: !!(e.ai && e.ai.used === true) };
    });
    var warmIndex = null;
    for (var wI = sorted.length - 1; wI >= 0; wI -= 1) {
      if (sorted[wI].kind === 'connect' || sorted[wI].kind === 'restore') { warmIndex = wI; break; }
    }
    topDay = { date: topDate, events: topList.length, timeline: timeline, warmIndex: warmIndex };
  }

  // lessons（本期用法使用次数 Top4 + 第一次毕业）
  var usageTitles = {};
  for (var u = 0; u < clean.usages.length; u += 1) usageTitles[clean.usages[u].id] = clean.usages[u].title;
  var usageCounts = {};
  for (var r = 0; r < relaysP.length; r += 1) {
    if (!relaysP[r].usageId) continue;
    if (!usageCounts[relaysP[r].usageId]) usageCounts[relaysP[r].usageId] = 0;
    usageCounts[relaysP[r].usageId] += 1;
  }
  var learnedIds = Object.keys(usageCounts).sort(function (a, b) { return usageCounts[b] - usageCounts[a] || (a < b ? -1 : 1); }).slice(0, 4);
  var learned = learnedIds.map(function (id) {
    return { usageId: id, title: usageTitles[id] || id, count: usageCounts[id] };
  });
  var firstGrad = null;
  for (var r2 = 0; r2 < relaysP.length; r2 += 1) {
    if (relaysP[r2].graduated === true) {
      firstGrad = {
        date: relaysP[r2].at.slice(0, 10),
        time: relaysP[r2].at.slice(11, 16),
        app: relaysP[r2].graduatedApp || 'ai',
      };
      break;
    }
  }

  // savedTime（只算本人确认过的 kept 分钟，SPEC §1.3 红线）
  var confirmed = 0;
  var allocMap = {};
  for (var s = 0; s < inP.length; s += 1) {
    var en = inP[s];
    if (en.kind !== 'stillness' || !en.kept) continue;
    confirmed += en.kept;
    if (!allocMap[en.use || 'stillness']) allocMap[en.use || 'stillness'] = 0;
    allocMap[en.use || 'stillness'] += en.kept;
  }
  var allocations = Object.keys(allocMap).map(function (use) { return { use: use, minutes: allocMap[use] }; });

  // rhythm（24 小时热力 + 黄金时段；流派走 rhythm 页型的共用规则）
  var hourly = new Array(24).fill(0);
  for (var h = 0; h < inP.length; h += 1) hourly[+inP[h].start.slice(0, 2)] += 1;
  var goldenHour = null;
  var maxCount = 0;
  for (var hh = 0; hh < 24; hh += 1) if (hourly[hh] > maxCount) { maxCount = hourly[hh]; goldenHour = hh; }
  var weekly = weeklyBuckets(inP, relaysP, period);
  var song = {
    busyness: clamp((inP.length / days) * 30 / 110, 0.05, 0.95),
    mood: moodOf(relaysP),
    dominantKind: dominantOf(minutes),
    weeklyCounts: weekly.counts,
    graduations: weekly.graduations,
  };
  var draftStats = {
    totals: totals, kindMinutes: kindMinutes, topDay: topDay,
    lessons: { learned: learned, firstGraduation: firstGrad },
    savedTime: { confirmedMinutes: confirmed, allocations: allocations },
    rhythm: { hourly: hourly, goldenHour: goldenHour, genre: null },
    panels: [], keywords: [], wishEcho: null, song: song,
  };
  var genreInput = assembleGenreInput({ stats: draftStats });
  var genre = genreInput ? classifyGenre(genreInput) : null;
  draftStats.rhythm.genre = genre
    ? { id: genre.id, title: genre.title, tagline: genre.tagline }
    : null;

  // panels / keywords —— 事实性模板（不鸡汤、不夸大；润色归 narrative/代理）
  draftStats.panels = panelsFor(inP, period, weekly);
  draftStats.keywords = keywordsFor(clean, inP);
  draftStats.wishEcho = wishEchoFor(clean, inP, inPrev, period, prevPeriod);
  return draftStats;
}

function weeklyBuckets(inP, relaysP, period) {
  var mondays = [];
  for (var monday = mondayOf(period.from); monday <= mondayOf(period.to); monday = shiftYmd(monday, 7)) mondays.push(monday);
  var weeklyCounts = new Array(mondays.length).fill(0);
  for (var i = 0; i < inP.length; i += 1) {
    var m = mondayOf(inP[i].date);
    var b = mondays.indexOf(m);
    if (b >= 0) weeklyCounts[b] += 1;
  }
  var graduations = new Array(mondays.length).fill(0);
  for (var r = 0; r < relaysP.length; r += 1) {
    if (relaysP[r].graduated !== true) continue;
    var gb = mondays.indexOf(mondayOf(relaysP[r].at.slice(0, 10)));
    if (gb >= 0) graduations[gb] += 1;
  }
  return { counts: weeklyCounts, graduations: graduations, mondays: mondays };
}

function moodOf(relaysP) {
  var rated = relaysP.filter(function (r) { return r.rating != null; });
  if (!rated.length) return 0.5;
  var much = rated.filter(function (r) { return r.rating === 'much'; }).length;
  return much / rated.length;
}

function dominantOf(minutes) {
  var best = 'necessary';
  var bestMin = -1;
  for (var kind in minutes) {
    if (minutes[kind] > bestMin) { bestMin = minutes[kind]; best = kind; }
  }
  return best;
}

function panelsFor(inP, period, weekly) {
  var dayList = dayCount(period);
  if (!inP.length) {
    return [{ label: '本期', caption: '本期记得不多，下一章一起写满一点' }]; // SPEC §2 短章文案基调
  }
  if (dayList <= 8) {
    return [{ label: '这一周', caption: '这一周记下了 ' + inP.length + ' 件事' }];
  }
  if (dayList > 45) {
    // 年书/长跨度：按月格（≤12 行，事实性）
    var byMonth = {};
    for (var i = 0; i < inP.length; i += 1) {
      var key = inP[i].date.slice(0, 7);
      byMonth[key] = (byMonth[key] || 0) + 1;
    }
    return Object.keys(byMonth).sort().slice(0, 12).map(function (key) {
      return { label: monthZh(+key.slice(5, 7)), caption: byMonth[key] + ' 件事' };
    });
  }
  var out = [];
  for (var b = 0; b < weekly.counts.length && out.length < 12; b += 1) {
    out.push({ label: '第 ' + (b + 1) + ' 周', caption: weekly.counts[b] + ' 件事' });
  }
  return out;
}

function keywordsFor(clean, inP) {
  // 事实性词频：统计各词在期间标题中的出现次数，取前 6
  var words = DEMO_KEYWORDS(clean);
  var counts = {};
  for (var i = 0; i < inP.length; i += 1) {
    for (var w = 0; w < words.length; w += 1) {
      if (inP[i].title.indexOf(words[w]) >= 0) counts[words[w]] = (counts[words[w]] || 0) + 1;
    }
  }
  var list = Object.keys(counts).sort(function (a, b) { return counts[b] - counts[a]; }).slice(0, 6);
  return list.map(function (word) { return { word: word, weight: counts[word] }; });
}

function DEMO_KEYWORDS(clean) {
  // 真实数据没有词池：用简单双字词统计太粗糙，退而求事实——取标题里的人设名词
  var pool = [];
  for (var i = 0; i < clean.entries.length && pool.length < 40; i += 1) {
    var title = clean.entries[i].title;
    for (var w = 0; w < KEYWORD_SEEDS.length; w += 1) {
      if (title.indexOf(KEYWORD_SEEDS[w]) >= 0 && pool.indexOf(KEYWORD_SEEDS[w]) < 0) pool.push(KEYWORD_SEEDS[w]);
    }
  }
  return pool.length ? pool : KEYWORD_SEEDS.slice(0, 6);
}

var KEYWORD_SEEDS = ['论文', '组会', '实验', '邮件', '跑步', '妈妈', '火锅', '室友', '导师', '综述',
  '上课', '备课', '作业', '教案', '家长', '考试', '评语', '教研', '读书', '谈话', '卷子', '快走'];

function wishEchoFor(clean, inP, inPrev, period, prevPeriod) {
  var prev = clean.prevChapter;
  if (!prev || !prev.wish || !prev.wish.text) return null;
  var text = prev.wish.text;
  var category = prev.wish.category;
  var facts = [];
  var reply;
  if (category && category !== 'other' && WISH_CATEGORIES.indexOf(category) >= 0) {
    if (category === 'sleep') {
      var before = countEarlyDays(inP);
      var beforePrev = countEarlyDays(inPrev);
      facts.push({ label: '12 点前收工', value: before + ' 天' });
      var tail1 = beforePrev > 0 ? '，' + deltaWord(before - beforePrev, '天') : '';
      if (beforePrev > 0) facts.push({ label: '比上一期', value: diffLabel(before - beforePrev, '天') });
      reply = '本期你有 ' + before + ' 天在 12 点前结束最后一件事' + tail1 + '。';
    } else {
      var kindMap = { exercise: 'restore', learning: 'explore', company: 'connect' };
      var kind = kindMap[category];
      var verb = { exercise: '运动', learning: '学新东西', company: '陪伴他人' }[category];
      var n = kind ? inP.filter(function (e) { return e.kind === kind; }).length : 0;
      var nPrev = kind ? inPrev.filter(function (e) { return e.kind === kind; }).length : 0;
      facts.push({ label: verb + '次数', value: String(n) + ' 次' });
      var tail2 = nPrev > 0 ? '，' + deltaWord(n - nPrev, '次') : '';
      if (nPrev > 0) facts.push({ label: '比上一期', value: diffLabel(n - nPrev, '次') });
      reply = '本期你' + verb + '了 ' + n + ' 次' + tail2 + '。';
    }
    return { text: text, reply: reply.slice(0, 120), matched: true, facts: facts };
  }
  return { text: text, reply: '上一章你写下了这句话；这一章先记着，下一章一起看看。', matched: false, facts: [] };
}

function deltaWord(delta, unit) {
  if (delta > 0) return '比上一期多 ' + delta + ' ' + unit;
  if (delta < 0) return '比上一期少 ' + -delta + ' ' + unit;
  return '和上一期一样';
}

function countEarlyDays(inP) {
  var byDay = {};
  for (var i = 0; i < inP.length; i += 1) {
    if (!byDay[inP[i].date] || inP[i].end > byDay[inP[i].date]) byDay[inP[i].date] = inP[i].end;
  }
  var n = 0;
  for (var date in byDay) if (byDay[date] < '24:00') n += 1;
  return n;
}

function diffLabel(delta, unit) {
  if (delta > 0) return '多 ' + delta + ' ' + unit;
  if (delta < 0) return '少 ' + -delta + ' ' + unit;
  return '持平';
}

// ---------------------------------------------------------------------------
// prevChapter —— 上一章（上一自然月）的 lab 口径章节 + 写给本期的愿望
// ---------------------------------------------------------------------------
function isMonthStart(period) {
  return period && period.from && period.from.slice(8) === '01' && dayCount(period) >= 20;
}

function buildPrevChapter(persona, currentPeriod, currentNo, now) {
  if (!isMonthStart(currentPeriod)) return null;
  var pm = prevMonthOf(currentPeriod.from);
  if (pm.first < SPAN.from) return null;
  var raw = generateRaw(persona);
  var stats = aggregateStats({
    period: { from: pm.first, to: pm.last },
    entries: raw.entries, relays: raw.relays, usages: persona.usages, prevChapter: null,
  });
  if (!stats) return null;
  var curMonth = parseYmd(currentPeriod.from).m;
  return createChapter(
    {
      type: 'month',
      no: Math.max(1, currentNo - 1),
      period: { from: pm.first, to: pm.last },
      stats: stats,
      captions: {},
      wish: {
        text: persona.wishText(curMonth),
        category: persona.wishCategory,
        at: pm.last + 'T20:00:00+08:00',
      },
    },
    { uuid: uuidFromRng(createRng(seedMix(persona.seed, 0x9e3779b9))), now: now == null ? Date.UTC(2026, 9, 25, 3, 0) : now }
  );
}

// ---------------------------------------------------------------------------
// buildDemoStatsInput / buildDemoChapter
// ---------------------------------------------------------------------------
export function buildDemoStatsInput(personaId, options) {
  var persona = personaById(personaId);
  if (!persona) return null;
  var opts = options || {};
  var period = opts.period == null ? demoPeriods(personaId).month.period : validatePeriod(opts.period);
  if (!period) return null;
  var raw = generateRaw(persona);
  var now = opts.now == null ? Date.UTC(2026, 9, 25, 3, 0) : opts.now;
  var prevChapter = opts.prevChapter === undefined
    ? buildPrevChapter(persona, period, 10, now)
    : opts.prevChapter;
  return {
    period: period,
    entries: raw.entries,
    relays: raw.relays,
    usages: persona.usages.map(function (u) { return { id: u.id, title: u.title }; }),
    prevChapter: prevChapter,
  };
}

// 年书页序：月章 10 页 + 六个年度页型（contracts 校验：cover 开篇、poster 收尾、
// 六页齐备；总页数未锁定 —— SPEC §2 的 18 页 vs 16 页差距待 CTO 裁决）。
var YEAR_PAGES = ['cover', 'numbers', 'timeColors', 'specialDay', 'lessons', 'savedTime', 'rhythm', 'panels', 'wish',
  'yearSpectrum', 'yearFirstLast', 'yearStreak', 'yearGenres', 'yearKeywords', 'yearWall', 'poster'];

export function buildDemoChapter(personaId, options) {
  var persona = personaById(personaId);
  if (!persona) return null;
  var opts = options || {};
  var presets = demoPeriods(personaId);
  var type = opts.type;
  if (['week', 'month', 'year'].indexOf(type) < 0) return null;
  var period = opts.period == null ? presets[type].period : validatePeriod(opts.period);
  if (!period) return null;
  var no = opts.no;
  if (!(typeof no === 'number' && Number.isFinite(no) && Math.floor(no) === no && no >= 1)) return null;
  var now = opts.now;
  var input = buildDemoStatsInput(personaId, { period: period, now: now });
  var events = input.entries.filter(function (e) { return e.date >= period.from && e.date <= period.to; }).length;
  var variant = variantForEvents(events);
  var stats = aggregateStats(input);
  if (!stats) return null;
  var fields = { type: type, variant: variant, no: no, period: period, stats: stats, captions: {} };
  if (type === 'year') {
    // year/full 无默认页序（contracts）：月章 10 页 + 六个年度页型，cover 开篇 poster 收尾
    fields.pages = YEAR_PAGES.map(function (t) { return { type: t }; });
  }
  return createChapter(fields, {
    uuid: uuidFromRng(createRng(seedMix(persona.seed, songTag(period, type)))),
    now: now,
  });
}

function songTag(period, type) {
  return seedMix(seedMix(0x10001905, period.from.split('-').reduce(function (a, x) { return seedMix(a, +x); }, 0)), seedMix(period.to.split('-').reduce(function (a, x) { return seedMix(a, +x); }, 0), type.length));
}

// ---------------------------------------------------------------------------
// previewChapter —— 「原型对照章」
//   student = 原型 ⓪–⑨ 逐值钉死（86/23/77/+9、6 小时、深夜创作派、
//   10-18 最特别一天、10-12 第一次毕业、作曲输入 0.62/0.7/create/[14,22,28,22]），
//   供 JC 与 design/story-recap/prototype.html 逐页比对；
//   teacher = 十月真实感聚合章。
// ---------------------------------------------------------------------------
export function previewChapter(personaId) {
  var persona = personaById(personaId);
  if (!persona) return null;
  if (personaId === 'student') {
    return createChapter(
      {
        type: 'month', no: 10, period: { from: '2026-10-01', to: '2026-10-31' },
        stats: studentPrototypeStats(),
        captions: { 'cover.title': '十月，你把 6 小时还给了自己', 'cover.dedication': '致 安静的湖' },
        wish: null,
      },
      { uuid: '86c0ffee-0000-4000-8000-000000000010', now: Date.UTC(2026, 9, 31, 12, 0) }
    );
  }
  return buildDemoChapter('teacher', {
    type: 'month', period: { from: '2026-10-01', to: '2026-10-24' }, no: 12, now: Date.UTC(2026, 9, 25, 3, 0),
  });
}

function studentPrototypeStats() {
  var kindRows = [
    ['create', 1116, 0.31], ['necessary', 792, 0.22], ['connect', 648, 0.18],
    ['explore', 468, 0.13], ['restore', 396, 0.11], ['stillness', 180, 0.05],
  ].map(function (row) { return { kind: row[0], minutes: row[1], share: row[2] }; });
  var hourly = [1, 1, 0, 0, 0, 0, 1, 1, 4, 6, 7, 5, 3, 2, 4, 5, 4, 3, 2, 4, 6, 8, 14, 5];
  return {
    totals: { events: 86, aiRelays: 23, prevEvents: 77, delta: 9 },
    kindMinutes: kindRows,
    topDay: {
      date: '2026-10-18', events: 9,
      timeline: [
        { time: '08:30', title: '读懂一篇论文', ai: true },
        { time: '10:00', title: '组会', ai: false },
        { time: '12:00', title: '食堂午饭', ai: false },
        { time: '13:30', title: '整理组会纪要', ai: true },
        { time: '15:00', title: '跑实验', ai: false },
        { time: '17:20', title: '给导师回邮件', ai: true },
        { time: '19:00', title: '和室友吃火锅', ai: false },
        { time: '20:30', title: '整理实验数据', ai: false },
        { time: '22:10', title: '给妈妈打电话', ai: false },
      ],
      warmIndex: 8,
    },
    lessons: {
      learned: [
        { usageId: 'paper-read', title: '论文 → 5 个要点', count: 7 },
        { usageId: 'meeting-notes', title: '会议 → 重点和待办', count: 5 },
        { usageId: 'advisor-mail', title: '口语 → 礼貌邮件', count: 3 },
        { usageId: 'homework-plan', title: '想法 → 分步计划', count: 1 },
      ],
      firstGraduation: { date: '2026-10-12', time: '23:00', app: 'deepseek' },
    },
    savedTime: {
      confirmedMinutes: 360,
      allocations: [
        { use: 'restore', minutes: 150 }, { use: 'connect', minutes: 108 },
        { use: 'explore', minutes: 60 }, { use: 'stillness', minutes: 42 },
      ],
    },
    rhythm: {
      hourly: hourly,
      goldenHour: 22,
      genre: { id: 'night-creator', title: '深夜创作派', tagline: '灯熄了，你的想法才刚开始。' },
    },
    panels: [
      { label: '第 1 周', caption: '开学第一周，论文还没头绪' },
      { label: '第 2 周', caption: '第一次自己用 AI 读完论文' },
      { label: '第 3 周', caption: '最忙的一周，也最常打电话回家' },
      { label: '第 4 周', caption: '开始晨跑，省下的时间有去处了' },
    ],
    keywords: [
      { word: '论文', weight: 38 }, { word: '组会', weight: 26 }, { word: '跑步', weight: 30 },
      { word: '妈妈', weight: 20 }, { word: '实验', weight: 22 }, { word: '火锅', weight: 17 },
    ],
    wishEcho: {
      text: '希望十月能早点睡',
      reply: '十月你有 11 天在 12 点前结束了最后一件事，比九月多 6 天。',
      matched: true,
      facts: [{ label: '12 点前收工', value: '11 天' }, { label: '比九月', value: '多 6 天' }],
    },
    song: { busyness: 0.62, mood: 0.7, dominantKind: 'create', weeklyCounts: [14, 22, 28, 22], graduations: [0, 1, 2, 1] },
  };
}

// ---------------------------------------------------------------------------
// 同源真实数据 — readLocalStatsInput(storage, { period, usages })
// ---------------------------------------------------------------------------
var LEDGER_KEY = 'tango-donego.web.v1';
var RELAY_KEY = 'tango-donego.relay.v2';

export function readLocalStatsInput(storage, options) {
  if (!storage || typeof storage.getItem !== 'function') return null;
  var opts = options || {};
  var period = validatePeriod(opts.period);
  if (!period) return null;
  function readJson(key) {
    var raw = null;
    try { raw = storage.getItem(key); } catch (e) { return null; }
    if (raw == null) return null;
    try { return JSON.parse(raw); } catch (e2) { return null; }
  }
  var ledger = readJson(LEDGER_KEY);
  var entries = ledger && Array.isArray(ledger.entries) ? ledger.entries : [];
  var relayStore = readJson(RELAY_KEY);
  var records = relayStore && Array.isArray(relayStore.records) ? relayStore.records : [];
  var usages = Array.isArray(opts.usages)
    ? opts.usages.filter(function (u) { return u && typeof u.id === 'string' && typeof u.title === 'string'; })
    : [];
  // 上一章：书架里 period.to 早于本期 from 的最新一章（连载回应，SPEC §1.4）
  var prevChapter = null;
  var story = sanitizeStoreText(safeGet(storage, STORY_STORE_KEY));
  if (story && story.status === 'ok') {
    var chapters = story.store.chapters || [];
    for (var i = 0; i < chapters.length; i += 1) {
      var c = chapters[i];
      if (c.period && c.period.to < period.from) {
        if (!prevChapter || c.period.to > prevChapter.period.to) prevChapter = c;
      }
    }
  }
  return { period: period, entries: entries, relays: records, usages: usages, prevChapter: prevChapter };
}

function safeGet(storage, key) {
  try { return storage.getItem(key); } catch (e) { return null; }
}
