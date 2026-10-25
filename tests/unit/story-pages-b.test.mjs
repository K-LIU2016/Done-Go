// tests/unit/story-pages-b.test.mjs — T6页型B 线定向单测（RED 先行）。
//
// 覆盖 web/story/pages/{freed,rhythm,four,wish,poster-page}.js 的纯函数层
// （build*Model / 规则函数），全部可在 node --test 下运行；DOM 渲染与动效
// 检查（WAAPI 入场、热力格逐列点亮、四格翻开）属浏览器验证，夜窗屏障后
// 由 tests/story/* 与 Playwright 补（deferred）。
//
// 依据：design/story-recap/SPEC.md §3 页面库 ⑤–⑨、§5 叙事红线；
// 原型 design/story-recap/prototype.html p5–p9 的数字与文案为锁定基准；
// 契约 web/story/contracts.js（fa41b18）；流派规则复用
// /home/jc/projects/Done-Go-social/design/social-sync/PRD.md §3.2（只读）。

import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as contracts from '../../web/story/contracts.js';
import {
  PAGE_TYPE as FREED_PAGE_TYPE,
  SAVED_USE_META,
  formatHours,
  formatHoursShort,
  buildSavedTimeModel,
} from '../../web/story/pages/freed.js';
import {
  PAGE_TYPE as RHYTHM_PAGE_TYPE,
  GENRES,
  DAYPARTS,
  classifyGenre,
  assembleGenreInput,
  heatOpacities,
  goldenHourTitle,
  buildRhythmModel,
} from '../../web/story/pages/rhythm.js';
import {
  PAGE_TYPE as FOUR_PAGE_TYPE,
  PANEL_COLORS,
  PANEL_CAPTION_KEY,
  keywordFontSize,
  buildPanelsModel,
} from '../../web/story/pages/four.js';
import {
  PAGE_TYPE as WISH_PAGE_TYPE,
  classifyWishText,
  nextPeriodName,
  buildWishModel,
} from '../../web/story/pages/wish.js';
import {
  PAGE_TYPE as POSTER_PAGE_TYPE,
  DEFAULT_METRIC_KEYS,
  POSTER_TITLE_KEYS,
  METRICS,
  defaultPosterTitle,
  waveformHeights,
  buildPosterModel,
} from '../../web/story/pages/poster-page.js';

// ---------------------------------------------------------------------------
// Fixture — 原型 p5–p9 的数字（prototype.html 217–296 行）逐一对齐。
// ---------------------------------------------------------------------------

const PROTOTYPE_HOURLY = [
  1, 1, 1, 0, 0, 1, 1, 2, 4, 5, 6, 4, 2, 4, 5, 5, 4, 3, 3, 5, 7, 9, 10, 6,
];

function makeStats(overrides) {
  const stats = {
    totals: { events: 86, aiRelays: 23, prevEvents: 77, delta: 9 },
    kindMinutes: [
      { kind: 'necessary', minutes: 1320, share: 0.22 },
      { kind: 'create', minutes: 1860, share: 0.31 },
      { kind: 'connect', minutes: 1080, share: 0.18 },
      { kind: 'explore', minutes: 780, share: 0.13 },
      { kind: 'restore', minutes: 660, share: 0.11 },
      { kind: 'stillness', minutes: 300, share: 0.05 },
    ],
    topDay: {
      date: '2026-10-18',
      events: 9,
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
        { usageId: 'paper-5points', title: '论文 → 5 个要点', count: 7 },
        { usageId: 'meeting-notes', title: '会议 → 重点和待办', count: 5 },
        { usageId: 'polite-email', title: '口语 → 礼貌邮件', count: 3 },
        { usageId: 'idea-steps', title: '想法 → 分步计划', count: 1 },
      ],
      firstGraduation: { date: '2026-10-12', time: '23:00', app: 'deepseek' },
    },
    // 原型 p5：运动 2.5h / 陪家人 1.8h / 学新东西 1.0h / 早点睡 0.7h = 6h
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
      hourly: PROTOTYPE_HOURLY.slice(),
      goldenHour: 22,
      genre: {
        id: 'night-creator',
        title: '深夜创作派',
        tagline: '灯熄了，你的想法才刚开始。',
      },
    },
    panels: [
      { label: '第 1 周', caption: '开学第一周，论文还没头绪' },
      { label: '第 2 周', caption: '第一次自己用 AI 读完论文' },
      { label: '第 3 周', caption: '最忙的一周，也最常打电话回家' },
      { label: '第 4 周', caption: '开始晨跑，省下的时间有去处了' },
    ],
    keywords: [
      { word: '论文', weight: 10 },
      { word: '组会', weight: 6.2 },
      { word: '跑步', weight: 4.3 },
      { word: '实验', weight: 2.4 },
      { word: '妈妈', weight: 1.4 },
      { word: '火锅', weight: 0.01 },
    ],
    wishEcho: {
      text: '希望十月能早点睡。',
      reply: '十月你有 11 天在 12 点前结束了最后一件事，比九月多 6 天。',
      matched: true,
      facts: [{ label: '早睡天数', value: '11 天' }],
    },
    song: {
      busyness: 0.62,
      mood: 0.7,
      dominantKind: 'create',
      weeklyCounts: [14, 22, 28, 22],
      graduations: [0, 2, 1, 1],
    },
  };
  if (!overrides) return stats;
  return { ...stats, ...overrides };
}

const FIXTURE_UUID = '01161f9a-4378-4c61-9d8e-2f2f1c30aaaa';

function makeChapter(overrides) {
  const fields = {
    no: 10,
    type: 'month',
    period: { from: '2026-10-01', to: '2026-10-31' },
    stats: makeStats(),
  };
  const chapter = contracts.createChapter(fields, { uuid: FIXTURE_UUID });
  assert.ok(chapter, 'fixture chapter must pass contracts.createChapter');
  return chapter;
}

// ---------------------------------------------------------------------------
// 契约集成：五页型挂进月章全页序，模型函数吃契约 chapter 不抛错、不改写。
// ---------------------------------------------------------------------------

test('fixture month chapter validates with the full 10-page order', () => {
  const chapter = makeChapter();
  assert.equal(chapter.type, 'month');
  assert.deepEqual(
    chapter.pages.map((p) => p.type),
    contracts.PAGE_TYPES,
  );
  // 本线五页型都在页序里（⑤–⑨）。
  for (const t of ['savedTime', 'rhythm', 'panels', 'wish', 'poster']) {
    assert.ok(contracts.PAGE_TYPES.includes(t), t);
  }
});

test('page modules declare their contract PAGE_TYPE ids', () => {
  assert.equal(FREED_PAGE_TYPE, 'savedTime');
  assert.equal(RHYTHM_PAGE_TYPE, 'rhythm');
  assert.equal(FOUR_PAGE_TYPE, 'panels');
  assert.equal(WISH_PAGE_TYPE, 'wish');
  assert.equal(POSTER_PAGE_TYPE, 'poster');
});

// ---------------------------------------------------------------------------
// ⑤ freed — 省下的时间去了哪（原型 p5；SPEC §3 ⑤ 只统计本人确认过的）。
// ---------------------------------------------------------------------------

test('freed: formatHours mirrors prototype integers and halves', () => {
  assert.equal(formatHours(360), '6');
  assert.equal(formatHours(390), '6.5');
  assert.equal(formatHours(372), '6.2');
  assert.equal(formatHours(0), '0');
  assert.equal(formatHoursShort(150), '2.5h');
  assert.equal(formatHoursShort(60), '1.0h');
  assert.equal(formatHoursShort(42), '0.7h');
});

test('freed: prototype allocations map to 运动/陪家人/学新东西/早点睡 rows', () => {
  const model = buildSavedTimeModel(makeChapter());
  assert.equal(model.hoursLabel, '6');
  assert.equal(model.hasConfirmed, true);
  assert.deepEqual(
    model.rows.map((r) => r.label),
    ['运动', '陪家人', '学新东西', '早点睡'],
  );
  assert.deepEqual(
    model.rows.map((r) => r.hours),
    ['2.5h', '1.8h', '1.0h', '0.7h'],
  );
  // 原型条形宽度 100%/72%/40%/28% = 相对最大去向归一。
  assert.deepEqual(
    model.rows.map((r) => r.pct),
    [100, 72, 40, 28],
  );
  assert.deepEqual(
    model.rows.map((r) => r.icon),
    ['🏃', '👨‍👩‍👧', '📚', '🌙'],
  );
});

test('freed: SAVED_USE_META covers all 6 contract KINDS exactly once', () => {
  assert.deepEqual(
    Object.keys(SAVED_USE_META).sort(),
    [...contracts.KINDS].sort(),
  );
  for (const kind of contracts.KINDS) {
    const meta = SAVED_USE_META[kind];
    assert.ok(meta && meta.label && meta.icon, kind);
  }
});

test('freed: zero confirmed minutes → factual empty state, no invented rows', () => {
  const stats = makeStats({
    savedTime: { confirmedMinutes: 0, allocations: [] },
  });
  const chapter = contracts.createChapter(
    { no: 1, type: 'month', period: { from: '2026-10-01', to: '2026-10-31' }, stats },
    { uuid: FIXTURE_UUID },
  );
  const model = buildSavedTimeModel(chapter);
  assert.equal(model.hasConfirmed, false);
  assert.deepEqual(model.rows, []);
  assert.ok(model.emptyNote.includes('还没有确认过'));
  // 红线：不鸡汤、不硬凑。
  assert.ok(!model.emptyNote.includes('留白'));
});

test('freed: rows keep allocations order on ties (stable sort)', () => {
  const stats = makeStats({
    savedTime: {
      confirmedMinutes: 120,
      allocations: [
        { use: 'create', minutes: 60 },
        { use: 'necessary', minutes: 60 },
      ],
    },
  });
  const chapter = contracts.createChapter(
    { no: 2, type: 'month', period: { from: '2026-10-01', to: '2026-10-31' }, stats },
    { uuid: FIXTURE_UUID },
  );
  const model = buildSavedTimeModel(chapter);
  assert.deepEqual(
    model.rows.map((r) => r.label),
    ['兴趣', '其他'],
  );
});

// ---------------------------------------------------------------------------
// ⑥ rhythm — 节律与流派（原型 p6；流派规则 = social PRD §3.2 只读复用）。
// ---------------------------------------------------------------------------

test('rhythm: heat opacities normalize hourly counts to 0.04..1, max = 1', () => {
  const op = heatOpacities(PROTOTYPE_HOURLY);
  assert.equal(op.length, 24);
  assert.equal(op[22], 1); // max hour
  assert.equal(op[3], 0.04); // zero count → floor
  // 单调：更大的计数不更暗。
  assert.ok(op[21] > op[20]);
  const allZero = heatOpacities(new Array(24).fill(0));
  assert.ok(allZero.every((v) => v === 0.04));
});

test('rhythm: golden hour title mirrors prototype wording (晚上 10 点)', () => {
  assert.equal(goldenHourTitle(22), '晚上 10 点，是你的黄金时间');
  assert.equal(goldenHourTitle(2), '凌晨 2 点，是你的黄金时间');
  assert.equal(goldenHourTitle(9), '上午 9 点，是你的黄金时间');
  assert.equal(goldenHourTitle(13), '下午 1 点，是你的黄金时间');
  assert.equal(goldenHourTitle(0), '凌晨 0 点，是你的黄金时间');
  const none = goldenHourTitle(null);
  assert.ok(typeof none === 'string' && !none.includes('留白'));
});

test('rhythm: GENRES are the 6 social PRD §3.2 schools with PRD colors', () => {
  assert.equal(GENRES.length, 6);
  const byId = Object.fromEntries(GENRES.map((g) => [g.id, g]));
  assert.equal(byId['dawn-organizer'].title, '晨光整理派');
  assert.equal(byId['dawn-organizer'].color, '#E8B04B');
  assert.equal(byId['night-creator'].title, '深夜创作派');
  assert.equal(byId['night-creator'].color, '#4C7A93');
  assert.equal(byId['relay-master'].title, '接力达人派');
  assert.equal(byId['relay-master'].color, '#E95432');
  assert.equal(byId['slow-living'].title, '生活慢行派');
  assert.equal(byId['slow-living'].color, '#3E7B5B');
  assert.equal(byId['academic-climber'].title, '学术攀登派');
  assert.equal(byId['academic-climber'].color, '#615CED');
  assert.equal(byId['multi-track'].title, '多线并行派');
  assert.equal(byId['multi-track'].color, '#C7701F');
  // 每个流派的 {id,title,tagline} 都能通过契约 stats.rhythm.genre 形状。
  for (const g of GENRES) {
    const stats = makeStats({
      rhythm: {
        hourly: PROTOTYPE_HOURLY.slice(),
        goldenHour: 22,
        genre: { id: g.id, title: g.title, tagline: g.tagline },
      },
    });
    const ok = contracts.createChapter(
      { no: 3, type: 'month', period: { from: '2026-10-01', to: '2026-10-31' }, stats },
      { uuid: FIXTURE_UUID },
    );
    assert.ok(ok, g.id);
    assert.equal(ok.stats.rhythm.genre.id, g.id);
  }
});

function genreInput(overrides) {
  return {
    hourly: new Array(24).fill(0),
    kindShare: { necessary: 0.2, create: 0.2, connect: 0.2, explore: 0.2, restore: 0.1, stillness: 0.1 },
    relays: 0,
    graduations: 0,
    freedShare: { family: 0, rest: 0, exercise: 0 },
    academicDominant: false,
    events: 10,
    ...overrides,
  };
}

function withHours(hourly) {
  const h = new Array(24).fill(0);
  for (const [hour, count] of hourly) h[hour] = count;
  return h;
}

test('rhythm: classifyGenre follows social PRD §3.2 rules in table order', () => {
  // 深夜创作派：night+evening ≥ 45% 且 create 占比高。
  const nightOwl = classifyGenre(
    genreInput({
      hourly: withHours([[22, 6], [23, 4], [20, 4], [14, 2]]),
      kindShare: { necessary: 0.1, create: 0.5, connect: 0.1, explore: 0.1, restore: 0.1, stillness: 0.1 },
    }),
  );
  assert.equal(nightOwl && nightOwl.id, 'night-creator');

  // 晨光整理派：morning+dawn ≥ 50% 且整理（necessary）多。
  const lark = classifyGenre(
    genreInput({
      hourly: withHours([[7, 5], [8, 5], [9, 4], [22, 2]]),
      kindShare: { necessary: 0.45, create: 0.2, connect: 0.1, explore: 0.1, restore: 0.1, stillness: 0.05 },
    }),
  );
  assert.equal(lark && lark.id, 'dawn-organizer');

  // 接力达人派：relays ≥ 8 且 graduations ≥ 2。
  const relayer = classifyGenre(
    genreInput({
      relays: 10,
      graduations: 3,
    }),
  );
  assert.equal(relayer && relayer.id, 'relay-master');

  // 生活慢行派：freedTo family+rest+exercise 合计 ≥ 60%。
  const slow = classifyGenre(
    genreInput({
      freedShare: { family: 0.4, rest: 0.1, exercise: 0.15 },
    }),
  );
  assert.equal(slow && slow.id, 'slow-living');

  // 学术攀登派：论文、文献、阅读类用法占主导。
  const academic = classifyGenre(genreInput({ academicDominant: true }));
  assert.equal(academic && academic.id, 'academic-climber');

  // 多线并行派：kindMix 熵最高、事项多。
  const multi = classifyGenre(
    genreInput({
      kindShare: { necessary: 0.17, create: 0.17, connect: 0.17, explore: 0.17, restore: 0.16, stillness: 0.16 },
      events: 40,
    }),
  );
  assert.equal(multi && multi.id, 'multi-track');

  // 都不满足 → null（流派待定，不硬编）。
  assert.equal(classifyGenre(genreInput({ events: 3 })), null);
});

test('rhythm: dawn-organizer wins over night-creator when both match (table order)', () => {
  const both = classifyGenre(
    genreInput({
      hourly: withHours([[6, 5], [7, 5], [8, 5], [22, 6], [23, 4]]),
      kindShare: { necessary: 0.4, create: 0.4, connect: 0.07, explore: 0.05, restore: 0.04, stillness: 0.04 },
    }),
  );
  assert.equal(both && both.id, 'dawn-organizer');
});

test('rhythm: thresholds are configurable (PRD: 做成可配置阈值)', () => {
  const input = genreInput({ relays: 6, graduations: 1 });
  assert.equal(classifyGenre(input), null);
  const hit = classifyGenre(input, { minRelays: 5, minGraduations: 1 });
  assert.equal(hit && hit.id, 'relay-master');
  // 放宽夜派占比也能命中（默认 0.45 不命中：evening 3/7 ≈ 0.43）。
  const sparseNightInput = genreInput({
    hourly: withHours([[22, 3], [14, 4]]),
    kindShare: { necessary: 0.1, create: 0.45, connect: 0.15, explore: 0.1, restore: 0.1, stillness: 0.1 },
  });
  assert.equal(classifyGenre(sparseNightInput), null);
  const sparseNight = classifyGenre(sparseNightInput, { nightEveningShare: 0.3 });
  assert.equal(sparseNight && sparseNight.id, 'night-creator');
});

test('rhythm: DAYPARTS are non-overlapping and cover 24 hours', () => {
  const marks = new Array(24).fill(0);
  for (const part of ['dawn', 'morning', 'evening', 'night']) {
    for (const h of DAYPARTS[part]) marks[h] += 1;
  }
  // evening+night 合起来与 dawn+morning 不重叠（PRD 只用这两组）。
  for (const h of DAYPARTS.dawn) assert.equal(marks[h], 1);
  for (const h of DAYPARTS.morning) assert.equal(marks[h], 1);
  assert.equal(DAYPARTS.night.includes(23), true);
  assert.equal(DAYPARTS.night.includes(3), true);
  assert.equal(DAYPARTS.evening.includes(22), true);
});

test('rhythm: assembleGenreInput derives from contract chapter fields only', () => {
  const input = assembleGenreInput(makeChapter());
  assert.equal(input.relays, 23); // totals.aiRelays
  assert.equal(input.graduations, 4); // Σ song.graduations = 0+2+1+1
  // freedShare：connect→family、restore→exercise、stillness→rest / confirmed。
  assert.ok(Math.abs(input.freedShare.family - 108 / 360) < 1e-9);
  assert.ok(Math.abs(input.freedShare.exercise - 150 / 360) < 1e-9);
  assert.ok(Math.abs(input.freedShare.rest - 42 / 360) < 1e-9);
  // kindShare 从 kindMinutes 分钟数归一。
  assert.ok(Math.abs(input.kindShare.create - 1860 / 6000) < 1e-9);
  assert.equal(input.events, 86);
  assert.equal(input.hourly.length, 24);
});

test('rhythm: buildRhythmModel renders prototype numbers (hour 22, 深夜创作派)', () => {
  const model = buildRhythmModel(makeChapter());
  assert.equal(model.title, '晚上 10 点，是你的黄金时间');
  assert.equal(model.genreCard.title, '深夜创作派');
  assert.equal(model.genreCard.color, '#4C7A93');
  assert.equal(model.genreCard.tagline, '灯熄了，你的想法才刚开始。');
  assert.equal(model.genreHeading, '十月你的时间流派');
  assert.equal(model.footNote, '按事项开始时间');
  assert.deepEqual(model.hourTicks, ['0 点', '6', '12', '18', '23']);
  assert.equal(model.opacities[22], 1);
});

test('rhythm: null genre / null golden hour degrade factually', () => {
  const stats = makeStats({
    rhythm: { hourly: new Array(24).fill(0), goldenHour: null, genre: null },
  });
  const chapter = contracts.createChapter(
    { no: 4, type: 'month', period: { from: '2026-10-01', to: '2026-10-31' }, stats },
    { uuid: FIXTURE_UUID },
  );
  const model = buildRhythmModel(chapter);
  assert.equal(model.genreCard, null);
  assert.ok(model.title.includes('等'));
  assert.ok(!model.title.includes('留白'));
});

// ---------------------------------------------------------------------------
// ⑦ four — 四格与关键词（原型 p7）。
// ---------------------------------------------------------------------------

test('four: panel colors are locked to the prototype cycle', () => {
  assert.deepEqual(PANEL_COLORS, ['#6E8FD6', '#E8B04B', '#E9826A', '#5FA67F']);
});

test('four: keyword font sizes reproduce prototype 38..17 ladder', () => {
  const max = 10;
  assert.equal(keywordFontSize(10, max), 38);
  assert.equal(keywordFontSize(6.2, max), 30);
  assert.equal(keywordFontSize(4.3, max), 26);
  assert.equal(keywordFontSize(2.4, max), 22);
  assert.equal(keywordFontSize(1.4, max), 20);
  assert.equal(keywordFontSize(0.01, max), 17);
});

test('four: buildPanelsModel uses captions[panels-<i>] overrides (contract captions)', () => {
  const chapter = makeChapter();
  const plain = buildPanelsModel(chapter);
  assert.equal(plain.heading, '你的十月四格');
  assert.equal(plain.panels[0].label, '第 1 周');
  assert.equal(plain.panels[0].caption, '开学第一周，论文还没头绪');
  assert.equal(plain.panels[0].color, '#6E8FD6');
  assert.equal(plain.keywordsHeading, '十月关键词');
  assert.equal(plain.keywords[0].word, '论文');
  assert.equal(plain.keywords[0].size, 38);

  const edited = contracts.createChapter(
    {
      no: 10,
      type: 'month',
      period: { from: '2026-10-01', to: '2026-10-31' },
      stats: makeStats(),
      captions: { [PANEL_CAPTION_KEY + '-1']: '被用户改过的第二周旁白' },
    },
    { uuid: FIXTURE_UUID },
  );
  const model2 = buildPanelsModel(edited);
  assert.equal(model2.panels[1].caption, '被用户改过的第二周旁白');
  assert.equal(model2.panels[0].caption, '开学第一周，论文还没头绪');
});

test('four: keyword emphasis follows rank (rank1 red, last dimmed)', () => {
  const model = buildPanelsModel(makeChapter());
  assert.equal(model.keywords[1].color, '#B8401F'); // 组会（原型红字）
  assert.equal(model.keywords[0].color, null); // 最大词默认墨色
  assert.equal(model.keywords[5].dim, true); // 最小词淡出（原型 opacity .7）
});

// ---------------------------------------------------------------------------
// ⑧ wish — 写给下一章（原型 p8；SPEC §3 ⑧ 规则匹配）。
// ---------------------------------------------------------------------------

test('wish: classifyWishText maps to contract WISH_CATEGORIES', () => {
  assert.equal(classifyWishText('希望十一月能早点睡'), 'sleep');
  assert.equal(classifyWishText('每周跑步三次'), 'exercise');
  assert.equal(classifyWishText('多读两本书，学一点统计'), 'learning');
  assert.equal(classifyWishText('多陪陪妈妈'), 'company');
  assert.equal(classifyWishText('把阳台收拾干净'), 'other');
  // 优先级 = SPEC/契约列序 sleep → exercise → learning → company。
  assert.equal(classifyWishText('早点睡，白天才有精神跑步'), 'sleep');
  assert.equal(classifyWishText('多运动，也多读书'), 'exercise');
});

test('wish: nextPeriodName for month chapters names next month', () => {
  assert.equal(
    nextPeriodName({ from: '2026-10-01', to: '2026-10-31' }, 'month'),
    '十一月',
  );
  assert.equal(
    nextPeriodName({ from: '2026-12-01', to: '2026-12-31' }, 'month'),
    '一月',
  );
  assert.equal(
    nextPeriodName({ from: '2026-01-01', to: '2026-12-31' }, 'year'),
    '明年',
  );
  assert.equal(
    nextPeriodName({ from: '2026-10-19', to: '2026-10-25' }, 'week'),
    '下一周',
  );
});

test('wish: buildWishModel echoes last wish and its facts', () => {
  const model = buildWishModel(makeChapter());
  assert.equal(model.echo.quote, '“希望十月能早点睡。”');
  assert.ok(model.echo.reply.includes('11 天'));
  assert.deepEqual(model.echo.facts, [{ label: '早睡天数', value: '11 天' }]);
  assert.equal(model.echo.matched, true);
  assert.equal(model.inputHeading, '写给十一月的自己');
  assert.equal(model.saveLabel, '存进下一章');
  assert.equal(model.placeholder, '一句就好，下个月我们一起看看');
});

test('wish: first chapter (no wishEcho) degrades factually', () => {
  const stats = makeStats({ wishEcho: null });
  const chapter = contracts.createChapter(
    { no: 1, type: 'month', period: { from: '2026-10-01', to: '2026-10-31' }, stats },
    { uuid: FIXTURE_UUID },
  );
  const model = buildWishModel(chapter);
  assert.equal(model.echo, null);
  assert.ok(model.firstChapterNote.length > 0);
  assert.ok(!model.firstChapterNote.includes('留白'));
  assert.ok(!model.firstChapterNote.includes('加油'));
});

// ---------------------------------------------------------------------------
// ⑨ poster — 收尾海报页（原型 p9；SPEC §3 ⑨ 4 个数字 + 波形）。
// ---------------------------------------------------------------------------

test('poster: default metric keys mirror the prototype quartet', () => {
  assert.deepEqual(DEFAULT_METRIC_KEYS, [
    'totals.events',
    'totals.aiRelays',
    'lessons.learned',
    'rhythm.genre',
  ]);
});

test('poster: METRICS resolve prototype values from stats', () => {
  const stats = makeStats();
  assert.deepEqual(METRICS['totals.events'].resolve(stats), { value: '86', label: '件事' });
  assert.deepEqual(METRICS['totals.aiRelays'].resolve(stats), { value: '23', label: '次 AI 接力' });
  assert.deepEqual(METRICS['lessons.learned'].resolve(stats), { value: '4', label: '个新用法' });
  assert.deepEqual(METRICS['rhythm.genre'].resolve(stats), { value: '深夜创作派', label: '时间流派' });
  assert.deepEqual(METRICS['savedTime.hours'].resolve(stats), { value: '6', label: '小时 · 你确认过的' });
  // genre 缺失 → null（显示占位，不编造）。
  const noGenre = makeStats({
    rhythm: { hourly: PROTOTYPE_HOURLY.slice(), goldenHour: null, genre: null },
  });
  assert.equal(METRICS['rhythm.genre'].resolve(noGenre), null);
});

test('poster: default title templates are rule-driven (SPEC §5 模板优先)', () => {
  const period = { from: '2026-10-01', to: '2026-10-31' };
  assert.equal(defaultPosterTitle(makeStats(), period), '十月，我把 6 小时还给了自己');
  const noSaved = makeStats({
    savedTime: { confirmedMinutes: 0, allocations: [] },
  });
  assert.equal(defaultPosterTitle(noSaved, period), '十月，你记下了 86 件事');
});

test('poster: chapter-title caption overrides the generated title', () => {
  const chapter = contracts.createChapter(
    {
      no: 10,
      type: 'month',
      period: { from: '2026-10-01', to: '2026-10-31' },
      stats: makeStats(),
      captions: { 'chapter-title': '十月，安静地长' },
    },
    { uuid: FIXTURE_UUID },
  );
  const model = buildPosterModel(chapter);
  assert.equal(model.title, '十月，安静地长');
  assert.ok(POSTER_TITLE_KEYS.includes('chapter-title'));
});

test('poster: waveform heights map melody pitches to 6..20px, sampled to 11 bars', () => {
  const pitches = [57, 69, 62, 74, 58, 71, 64, 55, 68, 73, 60, 70, 61];
  const hs = waveformHeights(pitches);
  assert.equal(hs.length, 11); // 原型 11 根
  assert.equal(hs[3], 20); // midi 74（采样内最高）→ 20
  assert.equal(hs[7], 6); // midi 55（最低）→ 6
  assert.ok(hs.every((v) => v >= 6 && v <= 20));
  assert.equal(waveformHeights([]), null);
  assert.equal(waveformHeights(null), null);
});

test('poster: buildPosterModel uses page params metricKeys when present', () => {
  const stats = makeStats();
  const chapter = contracts.createChapter(
    {
      no: 10,
      type: 'month',
      period: { from: '2026-10-01', to: '2026-10-31' },
      stats,
      pages: contracts.PAGE_TYPES.map((t) =>
        t === 'poster'
          ? { type: 'poster', params: { metricKeys: ['totals.events', 'savedTime.hours', 'lessons.learned', 'totals.aiRelays'] } }
          : { type: t },
      ),
    },
    { uuid: FIXTURE_UUID },
  );
  assert.ok(chapter, 'explicit pages with poster params must validate');
  const model = buildPosterModel(chapter);
  assert.deepEqual(
    model.metrics.map((m) => m.value),
    ['86', '6', '4', '23'],
  );
  assert.equal(model.heading, '探戈 Done&Go · 第 10 章');
  assert.equal(model.songLabel, '♪ 十月 · 时间之歌（由我的数据生成）');
  assert.equal(model.saveLabel, '保存海报');
  assert.equal(model.shareLabel, '分享这一章');
});

test('poster: melody from ctx feeds waveHeights; absent melody degrades', () => {
  const chapter = makeChapter();
  const withSong = buildPosterModel(chapter, { melodyPitches: [57, 69, 62] });
  assert.ok(Array.isArray(withSong.waveHeights) && withSong.waveHeights.length === 3);
  const silent = buildPosterModel(chapter, {});
  assert.equal(silent.waveHeights, null);
  assert.ok(silent.songLabel.includes('时间之歌'));
});

// ---------------------------------------------------------------------------
// 红线：全部文案不出现「留白」、不做与他人比较；模型不修改 chapter。
// ---------------------------------------------------------------------------

test('red lines: no 留白 / no percentile-of-people copy in any model', () => {
  const chapter = makeChapter();
  const models = [
    buildSavedTimeModel(chapter),
    buildRhythmModel(chapter),
    buildPanelsModel(chapter),
    buildWishModel(chapter),
    buildPosterModel(chapter),
  ];
  const blob = JSON.stringify(models) + JSON.stringify(GENRES);
  assert.ok(!blob.includes('留白'));
  assert.ok(!blob.includes('% 的人'));
  assert.ok(!blob.includes('%的人'));
  assert.ok(!blob.includes('超过了 9'));
});

test('build functions never mutate the chapter (pure views)', () => {
  const chapter = makeChapter();
  const before = JSON.stringify(chapter);
  buildSavedTimeModel(chapter);
  buildRhythmModel(chapter);
  buildPanelsModel(chapter);
  buildWishModel(chapter);
  buildPosterModel(chapter);
  classifyGenre(assembleGenreInput(chapter));
  assert.equal(JSON.stringify(chapter), before);
});
