import assert from 'node:assert/strict';
import { test } from 'node:test';

// T5页型A line: web/story/pages/{cover,count,spectrum,day,learned}.js — the
// prototype pages ⓪–④ (SPEC design/story-recap/SPEC.md §3, prototype.html
// sections .p0–.p4, storyboard story-board.png). Binding comes from the
// chapter stats validated by web/story/contracts.js; every shown number is
// long-pressable via data-metric (definitions line aligns on the exported
// METRICS lists). Editing hooks go through captions (SPEC §5 用户可以编辑
// 任何一句); caption key conventions for these five pages are defined here:
//   cover.title / cover.dedication / count.lead / spectrum.title /
//   day.warm / learned.first
// Visual values (colors, radii, sizes, animation timings) are asserted
// verbatim against prototype.html — that is this line's 逐像素 contract.

import {
  KINDS, CAPTION_MAX, createChapter,
} from '../../web/story/contracts.js';
import {
  PAGE_TYPE as COVER_TYPE, METRICS as COVER_METRICS, PAGE_CSS as COVER_CSS,
  captionDefaults as coverCaptions, pageModel as coverModel,
  pageView as coverView, createPage as createCover,
  monthZh, periodLine, chapterTag,
} from '../../web/story/pages/cover.js';
import {
  PAGE_TYPE as COUNT_TYPE, METRICS as COUNT_METRICS, PAGE_CSS as COUNT_CSS,
  pageModel as countModel, pageView as countView,
  createPage as createCount, dotPattern, rollValue, easeOutCubic,
  COUNT_ROLL_MS, DOTS_MAX, prevLabel,
} from '../../web/story/pages/count.js';
import {
  PAGE_TYPE as SPEC_TYPE, METRICS as SPEC_METRICS, PAGE_CSS as SPEC_CSS,
  pageModel as spectrumModel, pageView as spectrumView,
  createPage as createSpectrum, kindLabel, kindColorName, KIND_COLORS,
  SPEC_STAGGER_MS,
} from '../../web/story/pages/spectrum.js';
import {
  PAGE_TYPE as DAY_TYPE, METRICS as DAY_METRICS, PAGE_CSS as DAY_CSS,
  pageModel as dayModel, pageView as dayView,
  createPage as createDay, skyAt, skyMix, skyStops, dateLabel,
} from '../../web/story/pages/day.js';
import {
  PAGE_TYPE as LEARNED_TYPE, METRICS as LEARNED_METRICS, PAGE_CSS as LEARNED_CSS,
  pageModel as learnedModel, pageView as learnedView,
  createPage as createLearned, hourLabel, appName, MEDAL_STAGGER_MS,
} from '../../web/story/pages/learned.js';

// ---------------------------------------------------------------------------
// Fixtures — October chapter numbers mirror the prototype pages ⓪–④.
// ---------------------------------------------------------------------------

const OCTOBER_STATS = {
  totals: { events: 86, aiRelays: 23, prevEvents: 77, delta: 9 },
  kindMinutes: [
    { kind: 'create', minutes: 4464, share: 0.31 },
    { kind: 'necessary', minutes: 3168, share: 0.22 },
    { kind: 'connect', minutes: 2592, share: 0.18 },
    { kind: 'explore', minutes: 1872, share: 0.13 },
    { kind: 'restore', minutes: 1584, share: 0.11 },
    { kind: 'stillness', minutes: 720, share: 0.05 },
  ],
  topDay: {
    date: '2026-10-18', events: 9,
    timeline: [
      { time: '08:30', title: '读懂一篇论文', ai: true },
      { time: '10:00', title: '组会', ai: false },
      { time: '13:30', title: '整理组会纪要', ai: true },
      { time: '15:00', title: '跑实验', ai: false },
      { time: '17:20', title: '给导师回邮件', ai: true },
      { time: '19:00', title: '和室友吃火锅', ai: false },
      { time: '22:10', title: '给妈妈打电话', ai: false },
    ],
    warmIndex: 6,
  },
  lessons: {
    learned: [
      { usageId: 'paper-to-points', title: '论文 → 5 个要点', count: 7 },
      { usageId: 'meeting-notes', title: '会议 → 重点和待办', count: 5 },
      { usageId: 'polite-email', title: '口语 → 礼貌邮件', count: 3 },
      { usageId: 'idea-to-plan', title: '想法 → 分步计划', count: 1 },
    ],
    firstGraduation: { date: '2026-10-12', time: '23:00', app: 'deepseek' },
  },
  savedTime: {
    confirmedMinutes: 360,
    allocations: [
      { use: 'restore', minutes: 150 },
      { use: 'connect', minutes: 108 },
      { use: 'explore', minutes: 60 },
      { use: 'stillness', minutes: 42 },
    ],
  },
  rhythm: {
    hourly: Array.from({ length: 24 }, (_, i) => i),
    goldenHour: 22,
    genre: { id: 'night-owl', title: '深夜创作派', tagline: '灯熄了，你的想法才刚开始。' },
  },
  panels: [
    { label: '第 1 周', caption: '开学第一周，论文还没头绪' },
    { label: '第 2 周', caption: '第一次自己用 AI 读完论文' },
    { label: '第 3 周', caption: '最忙的一周，也常打电话回家' },
    { label: '第 4 周', caption: '开始晨跑，省下的时间有去处了' },
  ],
  keywords: [
    { word: '论文', weight: 9 }, { word: '组会', weight: 7 },
    { word: '跑步', weight: 8 }, { word: '妈妈', weight: 6 },
    { word: '实验', weight: 5 }, { word: '火锅', weight: 3 },
  ],
  wishEcho: null,
  song: { busyness: 0.62, mood: 0.7, dominantKind: 'create', weeklyCounts: [14, 22, 28, 22], graduations: [0, 1, 0, 0] },
};

function octoberChapter() {
  return createChapter({
    type: 'month', no: 10,
    period: { from: '2026-10-01', to: '2026-10-31' },
    stats: OCTOBER_STATS,
  }, { uuid: '11111111-1111-4111-8111-111111111111' });
}

// week chapter: no confirmed saved minutes, plain numbers headline
function weekChapter() {
  const stats = JSON.parse(JSON.stringify(OCTOBER_STATS));
  stats.totals = { events: 12, aiRelays: 3, prevEvents: 10, delta: 2 };
  stats.savedTime = { confirmedMinutes: 0, allocations: [] };
  stats.song = { busyness: 0.4, mood: 0.5, dominantKind: 'create', weeklyCounts: [12], graduations: [0] };
  return createChapter({
    type: 'week', no: 41,
    period: { from: '2026-10-06', to: '2026-10-12' },
    stats,
  }, { uuid: '22222222-2222-4222-8222-222222222222' });
}

// sparse chapter: quiet month, no topDay, no lessons, all-zero kind minutes
function sparseChapter() {
  const stats = JSON.parse(JSON.stringify(OCTOBER_STATS));
  stats.totals = { events: 4, aiRelays: 0, prevEvents: null, delta: null };
  stats.kindMinutes = KINDS.map((k) => ({ kind: k, minutes: 0, share: 0 }));
  stats.topDay = null;
  stats.lessons = { learned: [], firstGraduation: null };
  stats.savedTime = { confirmedMinutes: 0, allocations: [] };
  stats.song = { busyness: 0.1, mood: 0.5, dominantKind: 'create', weeklyCounts: [4], graduations: [0] };
  return createChapter({
    type: 'month', no: 10,
    period: { from: '2026-10-01', to: '2026-10-31' },
    stats,
  }, { uuid: '33333333-3333-4333-8333-333333333333' });
}

const METRIC_KEY_RE = /^[a-zA-Z][a-zA-Z0-9.]{0,39}$/;

function assertModuleShape(name, type, metrics, css, create) {
  assert.equal(type, name, 'PAGE_TYPE');
  assert.ok(Array.isArray(metrics) && metrics.length > 0, 'METRICS non-empty');
  for (const m of metrics) assert.match(m, METRIC_KEY_RE, `metric key ${m}`);
  assert.equal(typeof css, 'string', 'PAGE_CSS string');
  assert.equal(typeof create, 'function', 'createPage function');
  const page = create({});
  assert.equal(page.type, name);
  assert.equal(typeof page.mount, 'function');
  assert.equal(typeof page.unmount, 'function');
}

// ---------------------------------------------------------------------------
// shared helpers (each page module keeps its own copy; asserted once each)
// ---------------------------------------------------------------------------

test('cover: monthZh maps 1..12 to Chinese month names', () => {
  assert.equal(monthZh(1), '一月');
  assert.equal(monthZh(10), '十月');
  assert.equal(monthZh(12), '十二月');
});

test('cover: periodLine mirrors the prototype 2026.10.01 — 10.31', () => {
  assert.equal(periodLine({ from: '2026-10-01', to: '2026-10-31' }), '2026.10.01 — 10.31');
  assert.equal(periodLine({ from: '2026-12-28', to: '2027-01-03' }), '2026.12.28 — 2027.01.03');
});

test('cover: chapterTag 第 10 章 · 月章 / 周记 / 年书', () => {
  assert.equal(chapterTag(10, 'month'), '第 10 章 · 月章');
  assert.equal(chapterTag(41, 'week'), '第 41 章 · 周记');
  assert.equal(chapterTag(1, 'year'), '第 1 章 · 年书');
});

// ---------------------------------------------------------------------------
// ⓪ cover
// ---------------------------------------------------------------------------

test('cover: module shape', () => {
  assertModuleShape('cover', COVER_TYPE, COVER_METRICS, COVER_CSS, createCover);
});

test('cover: model binds chapter no / period / totals / saved hours', () => {
  const m = coverModel(octoberChapter(), {});
  assert.equal(m.no, 10);
  assert.equal(m.typeLabel, '月章');
  assert.equal(m.periodLine, '2026.10.01 — 10.31');
  assert.equal(m.events, 86);
  assert.equal(m.aiRelays, 23);
  assert.equal(m.savedHours, '6');
  assert.equal(m.headline, '十月，你把 6 小时还给了自己');
});

test('cover: view shows tag, period line, counts, 翻开 button, dedication', () => {
  const c = octoberChapter();
  const v = coverView(coverModel(c, {}), null);
  assert.ok(v.includes('第 10 章 · 月章'), 'tag');
  assert.ok(v.includes('2026.10.01 — 10.31'), 'period');
  assert.ok(v.includes('86 件事'), 'events count');
  assert.ok(v.includes('23 次 AI 接力'), 'relay count');
  assert.ok(v.includes('翻开这一章'), 'open button');
  assert.ok(v.includes('十月，你把 6 小时还给了自己'), 'default headline');
  assert.ok(v.includes('致'), 'dedication prefix');
  assert.ok(v.includes('戴上耳机更好'), 'hold copy');
});

test('cover: captions override headline and dedication', () => {
  const c = octoberChapter();
  const v = coverView(coverModel(c, {}), {
    'cover.title': '十月，风把日历翻厚了',
    'cover.dedication': '致 安静的湖',
  });
  assert.ok(v.includes('十月，风把日历翻厚了'));
  assert.ok(v.includes('致 安静的湖'));
  assert.ok(!v.includes('十月，你把 6 小时还给了自己'));
});

test('cover: captionDefaults exposes both keys with values ≤ CAPTION_MAX', () => {
  const d = coverCaptions(coverModel(octoberChapter(), {}));
  assert.ok(d['cover.title']);
  assert.ok(d['cover.dedication']);
  for (const k of Object.keys(d)) assert.ok(d[k].length <= CAPTION_MAX, k);
});

test('cover: week chapter without saved time falls back to events headline', () => {
  const m = coverModel(weekChapter(), {});
  assert.equal(m.typeLabel, '周记');
  assert.equal(m.headline, '这一周，你记下了 12 件事');
});

test('cover: sparse month uses the quiet headline', () => {
  assert.equal(coverModel(sparseChapter(), {}).headline, '十月，安静的一章');
});

test('cover: long caption is truncated to CAPTION_MAX in view', () => {
  const long = '十'.repeat(CAPTION_MAX) + '多余';
  const v = coverView(coverModel(octoberChapter(), {}), { 'cover.title': long });
  assert.ok(v.includes('十'.repeat(CAPTION_MAX)));
  assert.ok(!v.includes('多余'));
});

test('cover: numbers carry data-metric for the long-press 口径 card', () => {
  const v = coverView(coverModel(octoberChapter(), {}), null);
  assert.ok(v.includes('data-metric="totals.events"'));
  assert.ok(v.includes('data-metric="totals.aiRelays"'));
});

test('cover: PAGE_CSS pins prototype .p0 background and book geometry', () => {
  assert.ok(COVER_CSS.includes('linear-gradient(160deg,#2C3E35 0%,#1E2B25 100%)'));
  assert.ok(COVER_CSS.includes('linear-gradient(135deg,#E95432,#B8401F)'));
  assert.ok(COVER_CSS.includes('border-radius:6px 16px 16px 6px'));
  assert.ok(COVER_CSS.includes('width:236px'));
  assert.ok(COVER_CSS.includes('height:320px'));
});

test('cover: caption defaults never contain the banned wording', () => {
  const BANNED = '\u7559\u767d'; // JC 明确不与该词交叠（红线），以转义书写保持 grep 干净
  const d = coverCaptions(coverModel(octoberChapter(), {}));
  for (const k of Object.keys(d)) assert.ok(!d[k].includes(BANNED), k);
});

// ---------------------------------------------------------------------------
// ① count (page type 'numbers')
// ---------------------------------------------------------------------------

test('count: module shape', () => {
  assertModuleShape('numbers', COUNT_TYPE, COUNT_METRICS, COUNT_CSS, createCount);
});

test('count: dotPattern renders one dot per event, ai count exact, deterministic', () => {
  const p = dotPattern(86, 23);
  assert.equal(p.length, 86);
  assert.equal(p.filter(Boolean).length, 23);
  assert.deepEqual(dotPattern(86, 23), p, 'same input → same pattern');
  assert.equal(dotPattern(10, 0).filter(Boolean).length, 0);
  assert.deepEqual(dotPattern(0, 0), []);
  assert.equal(dotPattern(1, 1)[0], true);
});

test('count: rollValue/easeOutCubic drive the 1.2 s number roll', () => {
  assert.equal(COUNT_ROLL_MS, 1200, 'SPEC §3 ①: 1.2 秒');
  assert.equal(rollValue(86, 0), 0);
  assert.equal(rollValue(86, 1), 86);
  assert.ok(rollValue(86, 0.5) > 30 && rollValue(86, 0.5) < 86);
  assert.ok(rollValue(86, 0.25) < rollValue(86, 0.5));
  assert.ok(rollValue(86, 0.5) < rollValue(86, 0.75));
  assert.equal(easeOutCubic(0), 0);
  assert.equal(easeOutCubic(1), 1);
});

test('count: model + view bind 86 / 23 / 比九月多了 9 件', () => {
  const c = octoberChapter();
  const m = countModel(c, {});
  assert.equal(m.events, 86);
  assert.equal(m.aiRelays, 23);
  assert.equal(m.deltaText, '比九月多了 9 件。');
  assert.equal(m.periodName, '十月');
  const v = countView(m, null);
  assert.ok(v.includes('这个月，你记下了'));
  assert.ok(v.includes('86'));
  assert.ok(v.includes('件事'));
  assert.ok(v.includes('23 件'));
  assert.ok(v.includes('比九月多了 9 件。'));
  assert.ok(v.includes('交给了 AI 接力'));
});

test('count: dots markup = model dots length (86)', () => {
  const v = countView(countModel(octoberChapter(), {}), null);
  const dots = (v.match(/class="st-dot( |")/g) || []).length;
  const gold = (v.match(/class="st-dot st-dot-ai/g) || []).length;
  assert.equal(dots, 86);
  assert.equal(gold, 23);
});

test('count: prevLabel per chapter type', () => {
  assert.equal(prevLabel('month', { from: '2026-10-01', to: '2026-10-31' }), '九月');
  assert.equal(prevLabel('month', { from: '2026-01-01', to: '2026-01-31' }), '去年十二月');
  assert.equal(prevLabel('week', { from: '2026-10-06', to: '2026-10-12' }), '上一周');
  assert.equal(prevLabel('year', { from: '2026-01-01', to: '2026-12-31' }), '去年');
});

test('count: delta copy variants — first chapter / flat / fewer', () => {
  const first = JSON.parse(JSON.stringify(OCTOBER_STATS));
  first.totals = { events: 30, aiRelays: 5, prevEvents: null, delta: null };
  const flat = JSON.parse(JSON.stringify(OCTOBER_STATS));
  flat.totals = { events: 30, aiRelays: 5, prevEvents: 30, delta: 0 };
  const fewer = JSON.parse(JSON.stringify(OCTOBER_STATS));
  fewer.totals = { events: 30, aiRelays: 5, prevEvents: 35, delta: -5 };
  const mk = (s) => countView(countModel(createChapter({
    type: 'month', no: 2, period: { from: '2026-10-01', to: '2026-10-31' }, stats: s,
  }, {}), {}), null);
  assert.ok(mk(first).includes('这是你的第一章。'));
  assert.ok(mk(flat).includes('与九月持平。'));
  assert.ok(mk(fewer).includes('比九月少了 5 件。'));
});

test('count: zero relays copy states every event was done by yourself', () => {
  const s = JSON.parse(JSON.stringify(OCTOBER_STATS));
  s.totals = { events: 30, aiRelays: 0, prevEvents: null, delta: null };
  const v = countView(countModel(createChapter({
    type: 'month', no: 2, period: { from: '2026-10-01', to: '2026-10-31' }, stats: s,
  }, {}), {}), null);
  assert.ok(v.includes('每一件都是你自己做完的。'));
});

test('count: huge event counts cap at DOTS_MAX with overflow note', () => {
  const s = JSON.parse(JSON.stringify(OCTOBER_STATS));
  s.totals = { events: 600, aiRelays: 23, prevEvents: null, delta: null };
  const m = countModel(createChapter({
    type: 'month', no: 2, period: { from: '2026-10-01', to: '2026-10-31' }, stats: s,
  }, {}), {});
  assert.equal(m.dots.length, DOTS_MAX);
  assert.ok(m.dotsOverflow, 'overflow flag');
  const v = countView(m, null);
  assert.ok(v.includes(`+${600 - DOTS_MAX}`), 'overflow note shows the dropped count');
});

test('count: week chapter lead uses 这一周', () => {
  const v = countView(countModel(weekChapter(), {}), null);
  assert.ok(v.includes('这一周，你记下了'));
});

test('count: count.lead caption overrides the paragraph', () => {
  const v = countView(countModel(octoberChapter(), {}), { 'count.lead': '比想象中更多的一章。' });
  assert.ok(v.includes('比想象中更多的一章。'));
});

test('count: numbers carry data-metric', () => {
  const v = countView(countModel(octoberChapter(), {}), null);
  assert.ok(v.includes('data-metric="totals.events"'));
  assert.ok(v.includes('data-metric="totals.aiRelays"'));
});

test('count: PAGE_CSS pins prototype .p1 background and gold dot color', () => {
  assert.ok(COUNT_CSS.includes('radial-gradient(120% 80% at 20% 0%,#3A5A8C 0%,#1D2D4B 60%,#141E33 100%)'));
  assert.ok(COUNT_CSS.includes('#FFB27A'));
  assert.ok(COUNT_CSS.includes('font-size:96px'));
});

// ---------------------------------------------------------------------------
// ② spectrum (page type 'timeColors')
// ---------------------------------------------------------------------------

test('spectrum: module shape', () => {
  assertModuleShape('timeColors', SPEC_TYPE, SPEC_METRICS, SPEC_CSS, createSpectrum);
});

test('spectrum: kindLabel/kindColorName/KIND_COLORS cover all 6 kinds', () => {
  for (const k of KINDS) {
    assert.ok(kindLabel(k), `label ${k}`);
    assert.ok(kindColorName(k), `color name ${k}`);
    assert.ok(KIND_COLORS[k] && /^#[0-9A-F]{6}$/i.test(KIND_COLORS[k].base), `base ${k}`);
    assert.ok(KIND_COLORS[k] && /^#[0-9A-F]{6}$/i.test(KIND_COLORS[k].top), `top ${k}`);
  }
  assert.equal(kindLabel('create'), '创造');
  assert.equal(kindLabel('stillness'), '自己的时间');
  assert.equal(kindColorName('create'), '金色');
  assert.equal(kindColorName('connect'), '橘色');
});

test('spectrum: model sorts rows by share desc and maps flex to round(share×100)', () => {
  const m = spectrumModel(octoberChapter(), {});
  assert.deepEqual(m.rows.map((r) => r.kind), ['create', 'necessary', 'connect', 'explore', 'restore', 'stillness']);
  assert.deepEqual(m.rows.map((r) => r.flex), [31, 22, 18, 13, 11, 5]);
  assert.equal(m.title, '金色的创造，夹着橘色的相聚');
});

test('spectrum: view shows headline, bars with gradients, legend percentages', () => {
  const v = spectrumView(spectrumModel(octoberChapter(), {}), null);
  assert.ok(v.includes('你的十月是这个颜色'));
  assert.ok(v.includes('金色的创造，夹着橘色的相聚'));
  assert.ok(v.includes('linear-gradient(180deg,#F2C46A,#E8B04B)'), 'create bar gradient');
  assert.ok(v.includes('linear-gradient(180deg,#CBBDE3,#B9A8D8)'), 'stillness bar gradient');
  assert.ok(v.includes('创造 31%'));
  assert.ok(v.includes('必要 22%'));
  assert.ok(v.includes('相聚 18%'));
  assert.ok(v.includes('探索 13%'));
  assert.ok(v.includes('恢复 11%'));
  assert.ok(v.includes('自己的时间 5%'));
  assert.ok(v.includes('按事项计划时长统计'), '口径 footnote');
});

test('spectrum: near-tie top two uses the 同行 variant', () => {
  const s = JSON.parse(JSON.stringify(OCTOBER_STATS));
  s.kindMinutes = [
    { kind: 'necessary', minutes: 3900, share: 0.30 },
    { kind: 'create', minutes: 3700, share: 0.28 },
    { kind: 'connect', minutes: 3400, share: 0.26 },
    { kind: 'explore', minutes: 1000, share: 0.08 },
    { kind: 'restore', minutes: 800, share: 0.06 },
    { kind: 'stillness', minutes: 600, share: 0.05 },
  ];
  const m = spectrumModel(createChapter({
    type: 'month', no: 2, period: { from: '2026-10-01', to: '2026-10-31' }, stats: s,
  }, {}), {});
  // necessary .30 < 0.40 → 不进标题；前两个彩色类别 create .28 / connect .26
  // ≥ .28×0.85 → 同行变体
  assert.equal(m.title, '金色的创造，与橘色的相聚同行');
});

test('spectrum: dominant single color uses the 一片 variant', () => {
  const s = JSON.parse(JSON.stringify(OCTOBER_STATS));
  s.kindMinutes = [
    { kind: 'necessary', minutes: 5000, share: 0.8 },
    { kind: 'create', minutes: 300, share: 0.05 },
    { kind: 'connect', minutes: 300, share: 0.05 },
    { kind: 'explore', minutes: 300, share: 0.04 },
    { kind: 'restore', minutes: 200, share: 0.03 },
    { kind: 'stillness', minutes: 200, share: 0.03 },
  ];
  const m = spectrumModel(createChapter({
    type: 'month', no: 2, period: { from: '2026-10-01', to: '2026-10-31' }, stats: s,
  }, {}), {});
  assert.equal(m.title, '一片灰色的必要');
});

test('spectrum: all-zero minutes renders the empty state, no percentages', () => {
  const v = spectrumView(spectrumModel(sparseChapter(), {}), null);
  assert.ok(v.includes('还没有时间的颜色'));
  assert.ok(!v.includes('31%'));
});

test('spectrum: spectrum.title caption overrides', () => {
  const v = spectrumView(spectrumModel(octoberChapter(), {}), { 'spectrum.title': '橘色的相聚，托着金色的创造' });
  assert.ok(v.includes('橘色的相聚，托着金色的创造'));
});

test('spectrum: legend carries per-kind data-metric', () => {
  const v = spectrumView(spectrumModel(octoberChapter(), {}), null);
  assert.ok(v.includes('data-metric="kindMinutes.create"'));
  assert.ok(v.includes('data-metric="kindMinutes.stillness"'));
});

test('spectrum: PAGE_CSS pins prototype .p2 background and bar geometry', () => {
  assert.ok(SPEC_CSS.includes('#18171D'));
  assert.ok(SPEC_CSS.includes('height:300px'));
  assert.ok(SPEC_CSS.includes('border-radius:22px'));
  assert.equal(SPEC_STAGGER_MS, 120);
});

// ---------------------------------------------------------------------------
// ③ day (page type 'specialDay')
// ---------------------------------------------------------------------------

test('day: module shape', () => {
  assertModuleShape('specialDay', DAY_TYPE, DAY_METRICS, DAY_CSS, createDay);
});

test('day: skyAt pins the daylight palette endpoints', () => {
  assert.equal(skyAt('03:00'), '#232B52');
  assert.equal(skyAt('06:00'), '#F6C9A0');
  assert.equal(skyAt('08:30'), '#EFE9D8');
  assert.equal(skyAt('12:00'), '#E9E4CF');
  assert.equal(skyAt('16:00'), '#BCD3D6');
  assert.equal(skyAt('18:30'), '#E9B98F');
  assert.equal(skyAt('23:00'), '#3E4C86');
});

test('day: skyMix interpolates channels linearly', () => {
  assert.equal(skyMix('#000000', '#FFFFFF', 0.5), '#808080');
  assert.equal(skyMix('#000000', '#FFFFFF', 0), '#000000');
  assert.equal(skyMix('#000000', '#FFFFFF', 1), '#FFFFFF');
});

test('day: skyStops returns 4 hex stops, morning brighter than night', () => {
  const stops = skyStops('08:30', '22:10');
  assert.equal(stops.length, 4);
  for (const c of stops) assert.match(c, /^#[0-9A-F]{6}$/i);
  assert.equal(stops[3], '#3E4C86', '22:10 is night');
  const lum = (hex) => parseInt(hex.slice(1, 3), 16) + parseInt(hex.slice(3, 5), 16) + parseInt(hex.slice(5, 7), 16);
  assert.ok(lum(stops[0]) > lum(stops[3]), 'dawn brighter than night');
});

test('day: dateLabel formats 10 月 18 日', () => {
  assert.equal(dateLabel('2026-10-18'), '10 月 18 日');
  assert.equal(dateLabel('2026-01-01'), '1 月 1 日');
});

test('day: model binds date / events / timeline / warm pick', () => {
  const m = dayModel(octoberChapter(), {});
  assert.equal(m.dateLabel, '10 月 18 日');
  assert.equal(m.events, 9);
  assert.equal(m.timeline.length, 7);
  assert.equal(m.warm.title, '给妈妈打电话');
  assert.equal(m.warm.time, '22:10');
});

test('day: view shows headline, timeline times, ai ✦ marks, warm closer', () => {
  const v = dayView(dayModel(octoberChapter(), {}), null);
  assert.ok(v.includes('还记得 10 月 18 日吗'));
  assert.ok(v.includes('那天你做了'));
  assert.ok(v.includes('9 件事'));
  assert.ok(v.includes('08:30'));
  assert.ok(v.includes('读懂一篇论文'));
  assert.ok(v.includes('给妈妈打电话'));
  const aiRows = (v.match(/st-tl-ai/g) || []).length;
  assert.equal(aiRows, 3, 'three AI relayed events');
  assert.ok((v.match(/✦/g) || []).length >= 3, '✦ marks on ai rows');
  assert.ok(v.includes('给妈妈打电话'), 'warm closer names the pick');
  assert.ok(v.includes('✦ = AI 同行'), 'legend');
});

test('day: warm closer template mentions the picked event', () => {
  const m = dayModel(octoberChapter(), {});
  const v = dayView(m, null);
  assert.ok(v.includes('最忙的一天'), 'closer opening');
});

test('day: maxTimeline param truncates with an 等尾 note', () => {
  const v = dayView(dayModel(octoberChapter(), { maxTimeline: 3 }), null);
  assert.ok(v.includes('08:30'));
  assert.ok(!v.includes('22:10'), 'items beyond the cap are hidden');
  assert.ok(v.includes('等 4 件事'), 'overflow note');
});

test('day: warmIndex null falls back to first→last wrap-up', () => {
  const s = JSON.parse(JSON.stringify(OCTOBER_STATS));
  s.topDay.warmIndex = null;
  const v = dayView(dayModel(createChapter({
    type: 'month', no: 2, period: { from: '2026-10-01', to: '2026-10-31' }, stats: s,
  }, {}), {}), null);
  assert.ok(v.includes('从 08:30 到 22:10'));
});

test('day: topDay null renders the empty state', () => {
  const v = dayView(dayModel(sparseChapter(), {}), null);
  assert.ok(v.includes('这一章还没有这样的一天'));
});

test('day: page background is the data-driven sky gradient', () => {
  const v = dayView(dayModel(octoberChapter(), {}), null);
  assert.ok(v.includes('background:linear-gradient(180deg,'), 'inline sky gradient');
  assert.ok(v.includes('#EFE9D8'), '08:30 stop');
  assert.ok(v.includes('#3E4C86'), '22:10 stop');
});

test('day: day.warm caption overrides the closer', () => {
  const v = dayView(dayModel(octoberChapter(), {}), { 'day.warm': '深夜的那通电话，是你给自己的句点。' });
  assert.ok(v.includes('深夜的那通电话，是你给自己的句点。'));
});

test('day: PAGE_CSS pins the prototype timeline ink', () => {
  assert.ok(DAY_CSS.includes('rgba(31,42,42,.35)'), 'timeline rail');
  assert.ok(DAY_CSS.includes('#1f2a2a'), 'ink color');
});

// ---------------------------------------------------------------------------
// ④ learned (page type 'lessons')
// ---------------------------------------------------------------------------

test('learned: module shape', () => {
  assertModuleShape('lessons', LEARNED_TYPE, LEARNED_METRICS, LEARNED_CSS, createLearned);
});

test('learned: hourLabel maps hours to Chinese dayparts', () => {
  assert.equal(hourLabel(23), '晚上 11 点');
  assert.equal(hourLabel(22), '晚上 10 点');
  assert.equal(hourLabel(12), '中午 12 点');
  assert.equal(hourLabel(14), '下午 2 点');
  assert.equal(hourLabel(9), '上午 9 点');
  assert.equal(hourLabel(2), '凌晨 2 点');
  assert.equal(hourLabel(19), '晚上 7 点');
});

test('learned: appName maps known relay apps, passes unknown ids through', () => {
  assert.equal(appName('deepseek'), 'DeepSeek');
  assert.equal(appName('kimi'), 'Kimi');
  assert.equal(appName('doubao'), '豆包');
  assert.equal(appName('some-new-app'), 'some-new-app');
});

test('learned: model + view bind headline, medals, usage counts, dim medal', () => {
  const c = octoberChapter();
  const m = learnedModel(c, {});
  assert.equal(m.count, 4);
  assert.equal(m.medals.length, 4);
  assert.deepEqual(m.dimFlags, [false, false, false, true]);
  const v = learnedView(m, null);
  assert.ok(v.includes('十月，你多会了'));
  assert.ok(v.includes('4 个 AI 用法'));
  assert.ok(v.includes('论文 → 5 个要点'));
  assert.ok(v.includes('用了 7 次'));
  assert.ok(v.includes('想法 → 分步计划'));
  assert.ok(v.includes('st-medal-dim'), 'count===1 medal is dimmed');
});

test('learned: first graduation line binds date / daypart / app name', () => {
  const v = learnedView(learnedModel(octoberChapter(), {}), null);
  assert.ok(v.includes('10 月 12 日'));
  assert.ok(v.includes('晚上 11 点'));
  assert.ok(v.includes('DeepSeek'));
  assert.ok(v.includes('那是你自己接住的第一棒。'));
  assert.ok(v.includes('来自你的接力记录'), '口径 footnote');
});

test('learned: limit param caps medal count', () => {
  const m = learnedModel(octoberChapter(), { limit: 2 });
  assert.equal(m.medals.length, 2);
  assert.equal(m.count, 4);
});

test('learned: no learned usages renders the empty state', () => {
  const v = learnedView(learnedModel(sparseChapter(), {}), null);
  assert.ok(v.includes('这一章还没有新的用法'));
  assert.ok(!v.includes('st-medal"'));
});

test('learned: firstGraduation null drops the first-baton line', () => {
  const s = JSON.parse(JSON.stringify(OCTOBER_STATS));
  s.lessons.firstGraduation = null;
  const v = learnedView(learnedModel(createChapter({
    type: 'month', no: 2, period: { from: '2026-10-01', to: '2026-10-31' }, stats: s,
  }, {}), {}), null);
  assert.ok(!v.includes('第一棒'));
});

test('learned: learned.first caption overrides', () => {
  const v = learnedView(learnedModel(octoberChapter(), {}), { 'learned.first': '第一棒，是你自己接住的。' });
  assert.ok(v.includes('第一棒，是你自己接住的。'));
});

test('learned: data-metric on headline and first box', () => {
  const v = learnedView(learnedModel(octoberChapter(), {}), null);
  assert.ok(v.includes('data-metric="lessons.learned"'));
  assert.ok(v.includes('data-metric="lessons.firstGraduation"'));
});

test('learned: PAGE_CSS pins prototype .p4 background and medal ball gradient', () => {
  assert.ok(LEARNED_CSS.includes('radial-gradient(100% 70% at 50% 0%,#5A3E1E 0%,#2A1F14 70%)'));
  assert.ok(LEARNED_CSS.includes('radial-gradient(circle at 35% 30%,#FFE7A6,#E8B04B 60%,#9A6A10)'));
  assert.equal(MEDAL_STAGGER_MS, 280);
});

// ---------------------------------------------------------------------------
// cross-cutting
// ---------------------------------------------------------------------------

test('all five pages escape dynamic titles (no HTML injection)', () => {
  const evil = '<img src=x onerror=alert(1)>';
  const mk = (patch) => {
    const s = JSON.parse(JSON.stringify(OCTOBER_STATS));
    patch(s);
    return createChapter({
      type: 'month', no: 2, period: { from: '2026-10-01', to: '2026-10-31' }, stats: s,
    }, {});
  };
  const c1 = mk((s) => { s.topDay.timeline[0].title = evil; });
  assert.ok(!dayView(dayModel(c1, {}), null).includes('<img'));
  const c2 = mk((s) => { s.lessons.learned[0].title = evil; });
  assert.ok(!learnedView(learnedModel(c2, {}), null).includes('<img'));
  const c3 = mk((s) => { s.savedTime.confirmedMinutes = 300; });
  assert.ok(!coverView(coverModel(c3, {}), { 'cover.title': evil }).includes('<img'));
});

test('every view roots at .st-page with its page class', () => {
  const c = octoberChapter();
  assert.ok(coverView(coverModel(c, {}), null).includes('class="st-page st-cover"'));
  assert.ok(countView(countModel(c, {}), null).includes('class="st-page st-count"'));
  assert.ok(spectrumView(spectrumModel(c, {}), null).includes('class="st-page st-spectrum"'));
  assert.ok(dayView(dayModel(c, {}), null).includes('class="st-page st-day"'));
  assert.ok(learnedView(learnedModel(c, {}), null).includes('class="st-page st-learned"'));
});

test('pageModel returns null for a chapter without stats', () => {
  assert.equal(coverModel({}, {}), null);
  assert.equal(countModel({ stats: null }, {}), null);
  assert.equal(spectrumModel(null, {}), null);
  assert.equal(dayModel({}, {}), null);
  assert.equal(learnedModel({}, {}), null);
});

test('caption keys across the five pages match the contracts key regex', () => {
  const c = octoberChapter();
  const keys = [
    ...Object.keys(coverCaptions(coverModel(c, {}))),
    'count.lead', 'spectrum.title', 'day.warm', 'learned.first',
  ];
  for (const k of keys) assert.match(k, /^[-_.a-zA-Z0-9]{1,40}$/, k);
});
