// tests/unit/story-year-pages.test.mjs — T9年书专属 线定向单测。
//
// 覆盖 web/story/pages/year-{common,spectrum,firstlast,streak,genres,keywords,wall}.js：
//   统一页型接口（T5页型A 约定：PAGE_TYPE/METRICS/PAGE_CSS/captionDefaults/
//   pageModel/pageView/createPage + player renderPage 适配器）、数据绑定、
//   文案变体、边界与空态、确定性、HTML 注入转义、原型/PRD 像素值锁定、
//   叙事红线（禁词与「与他人比较」零出现，断言字面量用 \u 转义保持 grep 干净）。
//
// 年度专属数据口径（重要）：
//   契约 fa41b18 的 validateStats 白名单没有逐月/首末/连续段/逐月流派字段。
//   本线四页（spectrum/firstLast/streak/genres）按「拟扩展形状
//   stats.year.{months,first,last,streak}」实现严格校验的模型层（本线
//   sanitizeYearMonths/sanitizeFirstLast/sanitizeStreak，形状见 year-common.js
//   头注）；契约未扩展前这些页渲染事实性空态——两态都有 unit。缺口已上报
//   specConflicts，待 CTO 裁决（不自行改契约）。
//
// 夜窗纪律：本文件只做 node --test 纯函数层验证；浏览器/Playwright 检查 defer。

import test from 'node:test';
import assert from 'node:assert/strict';
import { createChapter, KINDS, YEAR_PAGE_TYPES, validateStats } from '../../web/story/contracts.js';
import * as common from '../../web/story/pages/year-common.js';
import * as spectrum from '../../web/story/pages/year-spectrum.js';
import * as firstlast from '../../web/story/pages/year-firstlast.js';
import * as streak from '../../web/story/pages/year-streak.js';
import * as genres from '../../web/story/pages/year-genres.js';
import * as keywords from '../../web/story/pages/year-keywords.js';
import * as wall from '../../web/story/pages/year-wall.js';

var MODULES = [spectrum, firstlast, streak, genres, keywords, wall];

// ---------------------------------------------------------------------------
// 夹具 — 十月原型量级 × 12 个月的年章（stats 全字段过契约 validateStats）
// ---------------------------------------------------------------------------
function makeYearStats() {
  var hourly = [];
  for (var h = 0; h < 24; h += 1) hourly.push(h === 22 ? 96 : h >= 18 ? 40 : h < 6 ? 8 : 20);
  var panels = [];
  var caps = ['开学第一周', '第一次自己读完论文', '最忙的一周', '开始晨跑', '五月养成了复盘',
    '夏天把实验跑完', '七月最满', '交稿前的一周', '开学返校', '十月马拉松', '降温与收尾', '年末复盘'];
  for (var m = 1; m <= 12; m += 1) panels.push({ label: m + '月', caption: caps[m - 1] });
  return {
    totals: { events: 1032, aiRelays: 236, prevEvents: 980, delta: 52 },
    kindMinutes: [
      { kind: 'necessary', minutes: 21000, share: 0.20 },
      { kind: 'create', minutes: 33600, share: 0.32 },
      { kind: 'connect', minutes: 18900, share: 0.18 },
      { kind: 'explore', minutes: 13700, share: 0.13 },
      { kind: 'restore', minutes: 11600, share: 0.11 },
      { kind: 'stillness', minutes: 6300, share: 0.06 },
    ],
    topDay: {
      date: '2026-10-18', events: 9,
      timeline: [
        { time: '08:30', title: '读懂一篇论文', ai: true },
        { time: '13:30', title: '整理组会纪要', ai: true },
        { time: '19:00', title: '和室友吃火锅', ai: false },
      ],
      warmIndex: 1,
    },
    lessons: {
      learned: [{ usageId: 'paper-five', title: '论文 → 5 个要点', count: 37 }],
      firstGraduation: { date: '2026-02-11', time: '23:10', app: 'deepseek' },
    },
    savedTime: {
      confirmedMinutes: 4310,
      allocations: [
        { use: 'restore', minutes: 1750 },
        { use: 'connect', minutes: 1280 },
      ],
    },
    rhythm: {
      hourly: hourly,
      goldenHour: 22,
      genre: { id: 'night-creator', title: '深夜创作派', tagline: '灯熄了，你的想法才刚开始。' },
    },
    panels: panels,
    keywords: [
      { word: '论文', weight: 100 }, { word: '组会', weight: 82 }, { word: '跑步', weight: 70 },
      { word: '妈妈', weight: 55 }, { word: '实验', weight: 45 }, { word: '导师', weight: 36 },
      { word: '晨跑', weight: 28 }, { word: '邮件', weight: 20 }, { word: '火锅', weight: 12 },
      { word: '复盘', weight: 5 },
    ],
    wishEcho: null,
    song: {
      busyness: 0.62, mood: 0.7, dominantKind: 'create',
      weeklyCounts: [80, 86, 90, 88, 84, 92, 96, 86],
      graduations: [0, 1, 0, 2, 0, 1, 0, 1],
    },
  };
}

var YEAR_PAGE_ORDER = ['cover', 'numbers', 'timeColors', 'specialDay', 'lessons', 'savedTime',
  'rhythm', 'panels', 'wish', 'yearSpectrum', 'yearFirstLast', 'yearStreak',
  'yearGenres', 'yearKeywords', 'yearWall', 'poster'];

function makeYearChapter() {
  return createChapter({
    no: 12, type: 'year', variant: 'full',
    period: { from: '2026-01-01', to: '2026-12-31' },
    stats: makeYearStats(),
    pages: YEAR_PAGE_ORDER.map(function (t) { return { type: t }; }),
  }, { uuid: '11111111-1111-4111-8111-111111111111', now: Date.parse('2026-12-31T12:00:00Z') });
}

// 拟扩展形状（stats.year）夹具：12 个月逐月数据 + 首末 + 连续段。
function monthKindShares(createShare, top) {
  top = top || 'create';
  var create = createShare;
  var restPool = [
    { kind: 'necessary', share: 0.20 }, { kind: 'connect', share: 0.18 },
    { kind: 'explore', share: 0.13 }, { kind: 'restore', share: 0.11 },
    { kind: 'stillness', share: 0.06 },
  ];
  var rows = [{ kind: top, share: create }];
  var room = 1 - create;
  var sum = 0;
  for (var i = 0; i < restPool.length; i += 1) sum += restPool[i].share;
  for (var j = 0; j < restPool.length; j += 1) {
    rows.push({ kind: restPool[j].kind, share: Math.round(restPool[j].share / sum * room * 1000) / 1000 });
  }
  return rows;
}

function makeExtStats() {
  var base = makeYearStats();
  var months = [];
  var genreByM = {
    1: 'night-creator', 2: 'night-creator', 3: 'night-creator', 4: null,
    5: 'dawn-organizer', 6: 'dawn-organizer', 7: 'dawn-organizer', 8: 'dawn-organizer',
    9: 'multi-track', 10: 'night-creator', 11: 'night-creator', 12: 'night-creator',
  };
  var titles = {
    'night-creator': '深夜创作派', 'dawn-organizer': '晨光整理派', 'multi-track': '多线并行派',
  };
  var taglines = {
    'night-creator': '灯熄了，你的想法才刚开始。', 'dawn-organizer': '天刚亮，你先把一天理顺。',
    'multi-track': '几条线并行，你来回切换。',
  };
  for (var m = 1; m <= 12; m += 1) {
    var events = m === 7 ? 128 : 70 + ((m * 7) % 30);
    var gid = genreByM[m];
    months.push({
      m: m, events: events,
      kindMinutes: monthKindShares(m === 7 ? 0.40 : 0.30).map(function (r) {
        return { kind: r.kind, minutes: Math.round(r.share * 20000), share: r.share };
      }),
      genre: gid ? { id: gid, title: titles[gid], tagline: taglines[gid] } : null,
    });
  }
  base.year = {
    months: months,
    first: { date: '2026-01-02', time: '09:15', title: '新年第一件事：整理书桌', kind: 'restore', ai: false },
    last: { date: '2026-12-30', time: '22:40', title: '复盘这一年', kind: 'create', ai: true },
    streak: { days: 9, from: '2026-03-04', to: '2026-03-12', relays: 21 },
  };
  return base;
}

function makeExtChapter() {
  return {
    type: 'year', variant: 'full',
    period: { from: '2026-01-01', to: '2026-12-31' },
    stats: makeExtStats(),
    captions: {},
  };
}

var baseChapter = makeYearChapter();
var extChapter = makeExtChapter();

// ===========================================================================
// year-common — 共享工具与拟扩展形状的严格校验
// ===========================================================================
test('common: sanitizeYearMonths 接受 12 行并按月排序、KINDS 规范序', () => {
  var months = common.sanitizeYearMonths(makeExtStats().year.months);
  assert.ok(months);
  assert.equal(months.length, 12);
  assert.equal(months[0].m, 1);
  assert.equal(months[11].m, 12);
  assert.deepEqual(months[0].kindMinutes.map(function (r) { return r.kind; }), KINDS);
  assert.equal(months[6].genre.title, '晨光整理派');
  assert.equal(months[3].genre, null);
});

test('common: sanitizeYearMonths 拒绝各种非法形状', () => {
  var ok = makeExtStats().year.months;
  assert.equal(common.sanitizeYearMonths(null), null);
  assert.equal(common.sanitizeYearMonths('x'), null);
  assert.equal(common.sanitizeYearMonths(ok.concat([{ m: 13, events: 1, kindMinutes: monthKindShares(0.3), genre: null }])), null);
  var dup = JSON.parse(JSON.stringify(ok)); dup[1].m = 1;
  assert.equal(common.sanitizeYearMonths(dup), null);
  var badKm = JSON.parse(JSON.stringify(ok)); badKm[0].kindMinutes = badKm[0].kindMinutes.slice(0, 5);
  assert.equal(common.sanitizeYearMonths(badKm), null);
  var badShare = JSON.parse(JSON.stringify(ok)); badShare[0].kindMinutes[0].share = 1.5;
  assert.equal(common.sanitizeYearMonths(badShare), null);
  var badMin = JSON.parse(JSON.stringify(ok)); badMin[0].kindMinutes[0].minutes = -1;
  assert.equal(common.sanitizeYearMonths(badMin), null);
  var badGenre = JSON.parse(JSON.stringify(ok)); badGenre[0].genre = { id: 'X', title: 'x', tagline: '' };
  assert.equal(common.sanitizeYearMonths(badGenre), null);
  var badGenreTitle = JSON.parse(JSON.stringify(ok)); badGenreTitle[0].genre.title = '';
  assert.equal(common.sanitizeYearMonths(badGenreTitle), null);
});

test('common: sanitizeYearMonths 部分年（<12 行）照收', () => {
  var months = common.sanitizeYearMonths(makeExtStats().year.months.slice(0, 5));
  assert.ok(months);
  assert.equal(months.length, 5);
});

test('common: sanitizeFirstLast 校验日期/时间/类别', () => {
  var good = { date: '2026-01-02', time: '09:15', title: '整理书桌', kind: 'restore', ai: false };
  assert.deepEqual(common.sanitizeFirstLast(good), good);
  assert.equal(common.sanitizeFirstLast({ date: '2026-1-2', time: '09:15', title: 'x', kind: 'restore' }), null);
  assert.equal(common.sanitizeFirstLast({ date: '2026-01-02', time: '9:15', title: 'x', kind: 'restore' }), null);
  assert.equal(common.sanitizeFirstLast({ date: '2026-01-02', time: '09:15', title: '  ', kind: 'restore' }), null);
  assert.equal(common.sanitizeFirstLast({ date: '2026-01-02', time: '09:15', title: 'x', kind: 'work' }), null);
  assert.equal(common.sanitizeFirstLast(null), null);
});

test('common: sanitizeStreak 真值守卫（天数=日期差+1、relays≥days）', () => {
  var good = { days: 9, from: '2026-03-04', to: '2026-03-12', relays: 21 };
  assert.deepEqual(common.sanitizeStreak(good), good);
  assert.equal(common.sanitizeStreak({ days: 10, from: '2026-03-04', to: '2026-03-12', relays: 21 }), null);
  assert.equal(common.sanitizeStreak({ days: 9, from: '2026-03-04', to: '2026-03-12', relays: 8 }), null);
  assert.equal(common.sanitizeStreak({ days: 9, from: '2026-03-12', to: '2026-03-04', relays: 21 }), null);
  assert.equal(common.sanitizeStreak({ days: 0, from: '2026-03-04', to: '2026-03-03', relays: 1 }), null);
  assert.equal(common.sanitizeStreak(null), null);
});

test('common: daysBetween 平年/闰年', () => {
  assert.equal(common.daysBetween('2026-01-01', '2026-12-31'), 364);
  assert.equal(common.daysBetween('2024-01-01', '2024-12-31'), 365);
  assert.equal(common.daysBetween('2024-01-01', '2025-01-01'), 366);
  assert.equal(common.daysBetween('2026-03-04', '2026-03-12'), 8);
});

test('common: esc 转义五种字符', () => {
  assert.equal(common.esc('<a href="x">&\'z'), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;z');
});

test('common: GENRE_PALETTE 与 social PRD §3.2 六派颜色一致', () => {
  assert.equal(common.genreColor('dawn-organizer'), '#E8B04B');
  assert.equal(common.genreColor('night-creator'), '#4C7A93');
  assert.equal(common.genreColor('relay-master'), '#E95432');
  assert.equal(common.genreColor('slow-living'), '#3E7B5B');
  assert.equal(common.genreColor('academic-climber'), '#615CED');
  assert.equal(common.genreColor('multi-track'), '#C7701F');
  assert.equal(common.genreColor('unknown-id'), null);
});

// ===========================================================================
// 统一接口面 + 页型覆盖
// ===========================================================================
test('接口：六个页型齐备且恰好覆盖契约 YEAR_PAGE_TYPES', () => {
  var types = MODULES.map(function (m) { return m.PAGE_TYPE; }).sort();
  assert.deepEqual(types, YEAR_PAGE_TYPES.slice().sort());
});

test('接口：每模块导出 T5页型A 约定的完整面 + player renderPage 适配器', () => {
  for (var i = 0; i < MODULES.length; i += 1) {
    var m = MODULES[i];
    assert.equal(typeof m.PAGE_TYPE, 'string', m.PAGE_TYPE);
    assert.ok(Array.isArray(m.METRICS), m.PAGE_TYPE);
    for (var j = 0; j < m.METRICS.length; j += 1) assert.match(m.METRICS[j], /^[a-zA-Z][a-zA-Z0-9.]{0,39}$/);
    assert.equal(typeof m.PAGE_CSS, 'string');
    assert.ok(m.PAGE_CSS.indexOf('.st-page') >= 0, m.PAGE_TYPE + ' css scoped');
    assert.equal(typeof m.captionDefaults, 'function');
    assert.equal(typeof m.pageModel, 'function');
    assert.equal(typeof m.pageView, 'function');
    assert.equal(typeof m.createPage, 'function');
    assert.equal(typeof m.renderPage, 'function');
    var page = m.createPage({ model: m.pageModel(extChapter), captions: {} });
    assert.equal(page.type, m.PAGE_TYPE);
    assert.equal(typeof page.mount, 'function');
    assert.equal(typeof page.unmount, 'function');
    page.mount(null); // node 无 DOM：null 早退，不抛错
    page.unmount();
  }
});

test('接口：METRICS 键与各页 data-metric 一致', () => {
  assert.deepEqual(spectrum.METRICS, KINDS.map(function (k) { return 'kindMinutes.' + k; }));
  assert.deepEqual(firstlast.METRICS, ['totals.events']);
  assert.deepEqual(streak.METRICS, ['totals.aiRelays']);
  assert.deepEqual(genres.METRICS, ['rhythm.genre']);
  assert.deepEqual(keywords.METRICS, ['keywords.top']);
  assert.deepEqual(wall.METRICS, []);
});

test('契约：createChapter 接受含六个年页型的 year/full 章节页序', () => {
  assert.ok(baseChapter);
  assert.equal(baseChapter.pages.length, 16);
  assert.equal(baseChapter.pages[0].type, 'cover');
  assert.equal(baseChapter.pages[15].type, 'poster');
  assert.ok(validateStats(baseChapter.stats));
});

// ===========================================================================
// yearSpectrum — 12 个月光谱长卷
// ===========================================================================
test('spectrum: 无效输入返回 null', () => {
  assert.equal(spectrum.pageModel(null), null);
  assert.equal(spectrum.pageModel({}), null);
  assert.equal(spectrum.pageModel({ period: { from: '2026-01-01' } }), null);
});

test('spectrum: 契约现状（无 stats.year）→ 事实性空态模型', () => {
  var model = spectrum.pageModel(baseChapter);
  assert.ok(model);
  assert.equal(model.empty, true);
  assert.equal(model.title, '这一年还没有逐月的时间数据');
  assert.equal(model.year, '2026');
});

test('spectrum: 逐月数据 → 12 列、KINDS 底起规范序、7 月最满', () => {
  var model = spectrum.pageModel(extChapter);
  assert.equal(model.empty, false);
  assert.equal(model.columns.length, 12);
  assert.deepEqual(model.columns[0].bands.map(function (b) { return b.kind; }), KINDS);
  assert.equal(model.busiestM, 7);
  assert.equal(model.busiestEvents, 128);
  assert.equal(model.title, '十二个月，金色的创造贯穿全年');
});

test('spectrum: 视图空态不渲染列，全态 12 列 + 图例挂 kindMinutes 口径', () => {
  var emptyView = spectrum.pageView(spectrum.pageModel(baseChapter), {});
  assert.ok(emptyView.indexOf('这一年还没有逐月的时间数据') >= 0);
  assert.equal((emptyView.match(/class="st-ys-col"/g) || []).length, 0);
  var view = spectrum.pageView(spectrum.pageModel(extChapter), {});
  assert.equal((view.match(/class="st-ys-col"/g) || []).length, 12);
  assert.ok(view.indexOf('data-metric="kindMinutes.create"') >= 0);
  assert.ok(view.indexOf('role="img"') >= 0);
  assert.ok(view.indexOf('十二个月的时间光谱长卷') >= 0);
  assert.ok(view.indexOf('按事项计划时长统计') >= 0);
});

test('spectrum: 部分年（5 个月）不硬凑 12 列', () => {
  var ch = JSON.parse(JSON.stringify(extChapter));
  ch.stats.year.months = ch.stats.year.months.slice(0, 5);
  var model = spectrum.pageModel(ch);
  assert.equal(model.columns.length, 5);
  assert.equal(model.title, '5 个月，金色的创造贯穿全年');
  var view = spectrum.pageView(model, {});
  assert.equal((view.match(/class="st-ys-col"/g) || []).length, 5);
});

test('spectrum: captionDefaults 与用户编辑覆盖', () => {
  var model = spectrum.pageModel(extChapter);
  var defaults = spectrum.captionDefaults(model);
  assert.equal(defaults['yearSpectrum.title'], model.title);
  var view = spectrum.pageView(model, { 'yearSpectrum.title': '我的十二个月' });
  assert.ok(view.indexOf('我的十二个月') >= 0);
  assert.ok(view.indexOf('贯穿全年') < 0);
});

test('spectrum: 纯函数 — 确定性且不改写 chapter', () => {
  var before = JSON.stringify(extChapter);
  var a = JSON.stringify(spectrum.pageModel(extChapter));
  var b = JSON.stringify(spectrum.pageModel(extChapter));
  assert.equal(a, b);
  assert.equal(JSON.stringify(extChapter), before);
});

test('spectrum: PAGE_CSS 锁原型 p2 底色 + 长卷动效 + reduce 降级', () => {
  assert.ok(spectrum.PAGE_CSS.indexOf('#18171D') >= 0);
  assert.ok(spectrum.PAGE_CSS.indexOf('st-ys-up') >= 0);
  assert.ok(spectrum.PAGE_CSS.indexOf('.st-reduce') >= 0);
  assert.ok(spectrum.PAGE_CSS.indexOf('scaleY') >= 0);
});

test('spectrum: renderPage 适配器与 pageView(pageModel()) 完全一致', () => {
  var direct = spectrum.pageView(spectrum.pageModel(extChapter), { x: 1 });
  var via = spectrum.renderPage({ type: 'yearSpectrum', params: {} }, {
    chapter: extChapter, captions: { x: 1 },
  });
  assert.equal(via, direct);
});

// ===========================================================================
// yearFirstLast — 年度第一次和最后一次
// ===========================================================================
test('firstlast: 首末齐备 → 跨度 362 天、标题含两个日期', () => {
  var model = firstlast.pageModel(extChapter);
  assert.equal(model.mode, 'both');
  assert.equal(model.spanDays, 362);
  assert.equal(model.title, '从 1月2日，到 12月30日');
  assert.equal(model.events, 1032);
});

test('firstlast: 视图渲染首末两张时刻卡 + ✦ AI 同行 + 事件口径', () => {
  var view = firstlast.pageView(firstlast.pageModel(extChapter), {});
  assert.equal((view.match(/class="st-yfl-card/g) || []).length, 2);
  assert.ok(view.indexOf('09:15') >= 0);
  assert.ok(view.indexOf('22:40') >= 0);
  assert.ok(view.indexOf('新年第一件事：整理书桌') >= 0);
  assert.equal((view.match(/✦ AI 同行/g) || []).length, 1);
  assert.ok(view.indexOf('362') >= 0);
  assert.ok(view.indexOf('data-metric="totals.events"') >= 0);
  assert.ok(view.indexOf('1032 件事') >= 0);
});

test('firstlast: 只有第一次 → 不渲染跨度天数', () => {
  var ch = JSON.parse(JSON.stringify(extChapter));
  ch.stats.year.last = null;
  var model = firstlast.pageModel(ch);
  assert.equal(model.mode, 'first');
  assert.equal(model.title, '这一年，从 1月2日 开始');
  var view = firstlast.pageView(model, {});
  assert.equal((view.match(/class="st-yfl-card/g) || []).length, 1);
  assert.ok(view.indexOf('362') < 0);
});

test('firstlast: 契约现状（无首末）→ 事实性空态', () => {
  var model = firstlast.pageModel(baseChapter);
  assert.equal(model.mode, 'none');
  assert.equal(model.title, '这一年的开篇与收尾还没有数据');
  var view = firstlast.pageView(model, {});
  assert.ok(view.indexOf('照面') >= 0);
});

test('firstlast: 类别色点 + HTML 注入转义', () => {
  var ch = JSON.parse(JSON.stringify(extChapter));
  ch.stats.year.first.title = '<b>坏</b>标题';
  var view = firstlast.pageView(firstlast.pageModel(ch), {});
  assert.ok(view.indexOf('&lt;b&gt;坏&lt;/b&gt;标题') >= 0);
  assert.ok(view.indexOf('#5FA67F') >= 0); // restore 底色
});

test('firstlast: captionDefaults + 编辑覆盖 + CSS 锁 p1 底色', () => {
  var model = firstlast.pageModel(extChapter);
  assert.equal(firstlast.captionDefaults(model)['yearFirstLast.title'], model.title);
  var view = firstlast.pageView(model, { 'yearFirstLast.title': '首与尾' });
  assert.ok(view.indexOf('首与尾') >= 0);
  assert.ok(firstlast.PAGE_CSS.indexOf('#3A5A8C') >= 0);
  assert.ok(firstlast.PAGE_CSS.indexOf('.st-reduce') >= 0);
});

test('firstlast: 确定性 + renderPage 适配器一致', () => {
  assert.equal(JSON.stringify(firstlast.pageModel(extChapter)), JSON.stringify(firstlast.pageModel(extChapter)));
  var direct = firstlast.pageView(firstlast.pageModel(extChapter), {});
  assert.equal(firstlast.renderPage({ type: 'yearFirstLast' }, { chapter: extChapter, captions: {} }), direct);
});

// ===========================================================================
// yearStreak — 年度最长连续接力
// ===========================================================================
test('streak: 连续段 9 天 → 大数字 + 区间 + 累计口径', () => {
  var model = streak.pageModel(extChapter);
  assert.equal(model.mode, 'streak');
  assert.equal(model.title, '9 天，每天都有接力');
  assert.equal(model.dots, 9);
  assert.equal(model.overflow, false);
  var view = streak.pageView(model, {});
  assert.ok(view.indexOf('9<small>天</small>') >= 0);
  assert.ok(view.indexOf('3月4日 — 3月12日') >= 0);
  assert.ok(view.indexOf('累计 21 次 AI 接力') >= 0);
  assert.ok(view.indexOf('data-metric="year.streak.days"') >= 0);
  assert.ok(view.indexOf('接力 = 交给 AI 的事项') >= 0);
});

test('streak: 超长段（45 天）渲染保护 — 31 点 + 省略号', () => {
  var ch = JSON.parse(JSON.stringify(extChapter));
  ch.stats.year.streak = { days: 45, from: '2026-01-01', to: '2026-02-14', relays: 61 };
  var model = streak.pageModel(ch);
  assert.equal(model.dots, 31);
  assert.equal(model.overflow, true);
  var view = streak.pageView(model, {});
  assert.equal((view.match(/class="st-yst-dot"/g) || []).length, 31);
  assert.ok(view.indexOf('…') >= 0);
});

test('streak: 契约现状且有接力 → 事实性「没连成串」，不编造天数', () => {
  var model = streak.pageModel(baseChapter);
  assert.equal(model.mode, 'scattered');
  assert.equal(model.title, '这一年，接力没有连成串');
  var view = streak.pageView(model, {});
  assert.ok(view.indexOf('236 次接力') >= 0);
  assert.ok(view.indexOf('data-metric="totals.aiRelays"') >= 0);
  assert.ok(view.indexOf('<small>天</small>') < 0);
});

test('streak: 零接力 → 每件事都是你自己做完的（事实，不鸡汤）', () => {
  var ch = JSON.parse(JSON.stringify(baseChapter));
  ch.stats.totals.aiRelays = 0;
  var model = streak.pageModel(ch);
  assert.equal(model.mode, 'solo');
  assert.equal(model.title, '这一年，每件事都是你自己做完的');
  var view = streak.pageView(model, {});
  assert.ok(view.indexOf('1032 件事') >= 0);
  assert.ok(view.indexOf('都没有交给 AI') >= 0);
});

test('streak: 非法连续段（天数与日期不符）按无数据处理', () => {
  var ch = JSON.parse(JSON.stringify(extChapter));
  ch.stats.year.streak = { days: 9, from: '2026-03-04', to: '2026-03-20', relays: 21 };
  var model = streak.pageModel(ch);
  assert.equal(model.mode, 'scattered');
});

test('streak: rollValue 缓动 — 0 起 1 收、单调不减', () => {
  assert.equal(streak.rollValue(0, 9), 0);
  assert.equal(streak.rollValue(1, 9), 9);
  var series = [0, 0.25, 0.5, 0.75, 1].map(function (t) { return streak.rollValue(t, 100); });
  for (var i = 1; i < series.length; i += 1) assert.ok(series[i] >= series[i - 1]);
  assert.equal(series[2], 88); // 100*(1-0.125)=87.5 → round 88
});

test('streak: captionDefaults + CSS 锁 p4 金色底 + reduce', () => {
  var model = streak.pageModel(extChapter);
  assert.equal(streak.captionDefaults(model)['yearStreak.title'], model.title);
  assert.ok(streak.PAGE_CSS.indexOf('#5A3E1E') >= 0);
  assert.ok(streak.PAGE_CSS.indexOf('#2A1F14') >= 0);
  assert.ok(streak.PAGE_CSS.indexOf('.st-reduce') >= 0);
  assert.equal(streak.renderPage({ type: 'yearStreak' }, { chapter: extChapter, captions: {} }),
    streak.pageView(streak.pageModel(extChapter), {}));
});

// ===========================================================================
// yearGenres — 年度流派变化史
// ===========================================================================
test('genres: 逐月流派 → 3 种流派、晨光整理派最久 4 个月、3 次变化', () => {
  var model = genres.pageModel(extChapter);
  assert.equal(model.distinct, 3);
  assert.equal(model.longest.title, '晨光整理派');
  assert.equal(model.longest.months, 4);
  assert.equal(model.changes, 3);
  assert.equal(model.title, '3 种流派，走过这一年');
  assert.equal(model.chips.length, 12);
});

test('genres: 视图 12 枚月章、3 个变化标记、空月降数据点', () => {
  var view = genres.pageView(genres.pageModel(extChapter), {});
  assert.equal((view.match(/class="st-yg-chip( |")/g) || []).length, 12);
  assert.equal((view.match(/data-change="1"/g) || []).length, 3);
  assert.equal((view.match(/data-dim="1"/g) || []).length, 1);
  assert.ok(view.indexOf('—') >= 0);
  assert.ok(view.indexOf('晨光整理派 陪你最久，4 个月') >= 0);
  assert.ok(view.indexOf('流派规则与同频一致') >= 0);
});

test('genres: 年度流派卡来自契约 rhythm.genre（真值）+ 颜色映射', () => {
  var view = genres.pageView(genres.pageModel(extChapter), {});
  assert.ok(view.indexOf('data-metric="rhythm.genre"') >= 0);
  assert.ok(view.indexOf('2026 年你的时间流派') >= 0);
  assert.ok(view.indexOf('深夜创作派') >= 0);
  assert.ok(view.indexOf('#4C7A93') >= 0);
  assert.ok(view.indexOf('#E8B04B') >= 0);
});

test('genres: 契约现状（无逐月）→ 年度卡仍在 + 事实性说明', () => {
  var model = genres.pageModel(baseChapter);
  assert.equal(model.hasMonths, false);
  var view = genres.pageView(model, {});
  assert.equal((view.match(/class="st-yg-chip/g) || []).length, 0);
  assert.ok(view.indexOf('逐月的流派，要等月度章节积累起来。') >= 0);
  assert.ok(view.indexOf('深夜创作派') >= 0);
});

test('genres: 单一流派 → 「一整年，都是…」；全空 → 流派待定卡', () => {
  var ch = JSON.parse(JSON.stringify(extChapter));
  for (var i = 0; i < ch.stats.year.months.length; i += 1) {
    ch.stats.year.months[i].genre = { id: 'night-creator', title: '深夜创作派', tagline: '灯熄了，你的想法才刚开始。' };
  }
  assert.equal(genres.pageModel(ch).title, '一整年，都是深夜创作派');
  var ch2 = JSON.parse(JSON.stringify(extChapter));
  for (var j = 0; j < ch2.stats.year.months.length; j += 1) ch2.stats.year.months[j].genre = null;
  var m2 = genres.pageModel(ch2);
  assert.equal(m2.distinct, 0);
  assert.equal(m2.title, '这一年的流派');
  assert.ok(genres.pageView(m2, {}).indexOf('逐月的流派') >= 0);
});

test('genres: captionDefaults + CSS 锁 p6 底色与流派卡渐变 + reduce', () => {
  var model = genres.pageModel(extChapter);
  assert.equal(genres.captionDefaults(model)['yearGenres.title'], model.title);
  assert.ok(genres.PAGE_CSS.indexOf('#0F1424') >= 0);
  assert.ok(genres.PAGE_CSS.indexOf('linear-gradient(135deg,#3B6A82,#24475A)') >= 0);
  assert.ok(genres.PAGE_CSS.indexOf('.st-reduce') >= 0);
  assert.equal(genres.renderPage({ type: 'yearGenres' }, { chapter: extChapter, captions: {} }),
    genres.pageView(genres.pageModel(extChapter), {}));
});

// ===========================================================================
// yearKeywords — 年度十大关键词
// ===========================================================================
test('keywords: 十词按权重降序、字号 17..38 线性（T6 four.js 约定）', () => {
  var model = keywords.pageModel(baseChapter);
  assert.equal(model.count, 10);
  assert.equal(model.title, '2026 年的十个关键词');
  assert.equal(model.rows[0].word, '论文');
  assert.equal(model.rows[0].size, 38);
  assert.equal(model.rows[1].size, 34); // 17+21×0.82
  assert.equal(model.rows[9].word, '复盘');
  assert.equal(model.rows[9].size, 18); // 17+21×0.05
});

test('keywords: 视图 — 次大红字、末位降不透明度、口径键', () => {
  var view = keywords.pageView(keywords.pageModel(baseChapter), {});
  assert.equal((view.match(/class="st-ykw( |")/g) || []).length, 10);
  assert.ok(view.indexOf('st-ykw-2') >= 0);
  assert.ok(view.indexOf('st-ykw-last') >= 0);
  assert.ok(keywords.PAGE_CSS.indexOf('#B8401F') >= 0); // 次大红 = p7 原型值（CSS 类着色）
  assert.ok(view.indexOf('data-metric="keywords.top"') >= 0);
  assert.ok(view.indexOf('来自事项标题分词') >= 0);
});

test('keywords: topN 参数取前 N 且标题如实', () => {
  var model = keywords.pageModel(baseChapter, { topN: 5 });
  assert.equal(model.rows.length, 5);
  assert.equal(model.title, '2026 年的 5 个关键词');
});

test('keywords: 词数不足 / 空关键词 → 事实性文案，不硬凑', () => {
  var ch = JSON.parse(JSON.stringify(baseChapter));
  ch.stats.keywords = ch.stats.keywords.slice(0, 6);
  assert.equal(keywords.pageModel(ch).title, '2026 年的 6 个关键词');
  ch.stats.keywords = [];
  var model = keywords.pageModel(ch);
  assert.equal(model.empty, true);
  assert.equal(model.title, '2026 年还没有关键词');
  assert.ok(keywords.pageView(model, {}).indexOf('还没有抽出关键词') >= 0);
});

test('keywords: 防御性过滤（空词/零权重）+ 注入转义', () => {
  var ch = { period: { from: '2026-01-01' }, stats: { keywords: [
    { word: '好', weight: 3 }, { word: '', weight: 1 }, { word: '坏', weight: 0 },
    { word: '<x>', weight: 2 },
  ] } };
  var model = keywords.pageModel(ch);
  assert.equal(model.rows.length, 2);
  assert.ok(keywords.pageView(model, {}).indexOf('&lt;x&gt;') >= 0);
});

test('keywords: captionDefaults + 浅色页锁 p7 底色 + reduce + 适配器', () => {
  var model = keywords.pageModel(baseChapter);
  assert.equal(keywords.captionDefaults(model)['yearKeywords.title'], model.title);
  assert.ok(keywords.PAGE_CSS.indexOf('#F4EFE4') >= 0);
  assert.ok(keywords.PAGE_CSS.indexOf('#2a2620') >= 0);
  assert.ok(keywords.PAGE_CSS.indexOf('.st-reduce') >= 0);
  assert.equal(keywords.renderPage({ type: 'yearKeywords', params: { topN: 8 } }, { chapter: baseChapter, captions: {} }),
    keywords.pageView(keywords.pageModel(baseChapter, { topN: 8 }), {}));
});

// ===========================================================================
// yearWall — 年度四格墙
// ===========================================================================
test('wall: 12 个月度四格 → 十二宫格墙 + 每格月标与主题句', () => {
  var model = wall.pageModel(baseChapter);
  assert.equal(model.count, 12);
  assert.equal(model.title, '十二个月，拼成这一年');
  var view = wall.pageView(model, {});
  assert.equal((view.match(/class="st-ywall-cell"/g) || []).length, 12);
  assert.ok(view.indexOf('1月') >= 0 && view.indexOf('12月') >= 0);
  assert.ok(view.indexOf('开学第一周') >= 0);
  assert.ok(view.indexOf('aria-hidden="true"') >= 0); // 迷你四格为装饰
});

test('wall: captions[panels-i] 覆盖月度主题句（与 four.js 约定一致）', () => {
  var view = wall.pageView(wall.pageModel(baseChapter), { 'panels-0': '改写的一月' });
  assert.ok(view.indexOf('改写的一月') >= 0);
  assert.ok(view.indexOf('开学第一周') < 0);
});

test('wall: 部分年（5 个月）与空 → 如实', () => {
  var ch = JSON.parse(JSON.stringify(baseChapter));
  ch.stats.panels = ch.stats.panels.slice(0, 5);
  var model = wall.pageModel(ch);
  assert.equal(model.title, '5 个月，拼成这一年');
  assert.equal((wall.pageView(model, {}).match(/class="st-ywall-cell"/g) || []).length, 5);
  ch.stats.panels = [];
  var m0 = wall.pageModel(ch);
  assert.equal(m0.empty, true);
  assert.ok(wall.pageView(m0, {}).indexOf('拼成一面墙') >= 0);
});

test('wall: 迷你四格用原型 p7 四色循环', () => {
  var view = wall.pageView(wall.pageModel(baseChapter), {});
  assert.ok(view.indexOf('#6E8FD6') >= 0);
  assert.ok(view.indexOf('#E8B04B') >= 0);
  assert.ok(view.indexOf('#E9826A') >= 0);
  assert.ok(view.indexOf('#5FA67F') >= 0);
});

test('wall: captionDefaults + 浅色底 + reduce + 适配器', () => {
  var model = wall.pageModel(baseChapter);
  assert.equal(wall.captionDefaults(model)['yearWall.title'], model.title);
  assert.ok(wall.PAGE_CSS.indexOf('#F4EFE4') >= 0);
  assert.ok(wall.PAGE_CSS.indexOf('.st-reduce') >= 0);
  assert.equal(wall.renderPage({ type: 'yearWall' }, { chapter: baseChapter, captions: {} }),
    wall.pageView(wall.pageModel(baseChapter), {}));
});

// ===========================================================================
// 叙事红线 + 通用输出形状
// ===========================================================================
test('红线：六页 × 双夹具（契约现状 + 拟扩展）文案无禁词、无与他人比较', () => {
  var all = '';
  for (var i = 0; i < MODULES.length; i += 1) {
    var m = MODULES[i];
    all += m.pageView(m.pageModel(baseChapter), {}) || '';
    all += m.pageView(m.pageModel(extChapter), {}) || '';
    all += m.pageView(m.pageModel(extChapter, m.PAGE_TYPE === 'yearKeywords' ? { topN: 5 } : undefined), {}) || '';
  }
  assert.ok(all.indexOf('\u7559\u767d') < 0, '禁词（\\u7559\\u767d）');
  assert.ok(!/%\u7684\u4eba/.test(all), '禁「%\\u7684\\u4eba」');
  assert.ok(!/\u6bd4\s?\d+\s?%/.test(all), '禁「\\u6bd4 N%」');
});

test('输出：所有视图根节点为 scoped .st-page 页卡', () => {
  for (var i = 0; i < MODULES.length; i += 1) {
    var m = MODULES[i];
    var v1 = m.pageView(m.pageModel(baseChapter), {});
    var v2 = m.pageView(m.pageModel(extChapter), {});
    assert.ok(v1.indexOf('<div class="st-page ') === 0, m.PAGE_TYPE);
    assert.ok(v2.indexOf('<div class="st-page ') === 0, m.PAGE_TYPE);
  }
});
