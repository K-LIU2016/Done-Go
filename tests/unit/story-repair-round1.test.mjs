import assert from 'node:assert/strict';
import { test } from 'node:test';

// 修复轮 1 定向钉子（对齐 2026-10-25 评审清单）：
// - stats.year 管线（computeYear + contracts 白名单保留）
// - 「第一次毕业」per-app 生平第一次口径（红线：不跨章通胀）
// - narrative 模板键 = 页面槽位；periodLabel 周记/年书不冒用月份名
// - definitions 键覆盖页面 data-metric 派生键；player.metricCardModel 双形状
// - soundtrack：奖章叮声 / player 适配器 / prepare 预建
// - freed/rhythm captions 槽；keywords min-max 阶梯
import { validateStats, sanitizeYearStats } from '../../web/story/contracts.js';
import { computeStats, computeYear } from '../../web/story/stats.js';
import { captionsFor, acceptedPolishText, classifyWish } from '../../web/story/narrative.js';
import { definitionFor } from '../../web/story/definitions.js';
import { metricCardModel, metricSample } from '../../web/story/player.js';
import { createSoundtrack, createAudioAdapter } from '../../web/story/soundtrack.js';
import { buildSavedTimeModel } from '../../web/story/pages/freed.js';
import { buildRhythmModel } from '../../web/story/pages/rhythm.js';
import { keywordFontSize } from '../../web/story/pages/four.js';
import { aggregateStats, buildDemoStatsInput, demoPeriods } from '../../web/story/demo-data.js';

var TZ = { utcOffsetMinutes: 480 };

function E(id, date, start, end, title, kind, extra) {
  return Object.assign({ id, date, start, end, title, kind }, extra || {});
}

// ---------------------------------------------------------------------------
// stats.year 管线
// ---------------------------------------------------------------------------
test('R1 computeYear：逐月行 + 首末件事 + 连续接力段（含两天段）', () => {
  var period = { from: '2026-09-28', to: '2026-10-05' };
  var entries = [
    E('a', '2026-09-28', '09:00', '10:00', '开学', 'necessary'),
    E('b', '2026-10-01', '08:00', '09:00', '读论文', 'explore', { ai: { used: true } }),
    E('c', '2026-10-02', '08:30', '09:30', '组会', 'connect', { ai: { used: true } }),
    E('d', '2026-10-05', '21:00', '22:00', '收尾', 'create'),
  ];
  var year = computeYear(period, entries);
  assert.deepEqual(year.months.map((m) => [m.m, m.events]), [[9, 1], [10, 3]]);
  assert.equal(year.months[1].kindMinutes.length, 6);
  assert.equal(year.first.title, '开学');
  assert.equal(year.last.title, '收尾');
  assert.deepEqual(
    { days: year.streak.days, from: year.streak.from, to: year.streak.to, relays: year.streak.relays },
    { days: 2, from: '2026-10-01', to: '2026-10-02', relays: 2 }
  );
});

test('R1 computeYear：单日 AI 不算「连成串」（streak null，年书页走 scattered 空态）', () => {
  var year = computeYear(
    { from: '2026-10-01', to: '2026-10-31' },
    [E('a', '2026-10-05', '09:00', '10:00', '读论文', 'explore', { ai: { used: true } })]
  );
  assert.equal(year.streak, null);
});

test('R1 computeYear：周年书跨 13 个月 → 第 13 月并入第 12 格，不静默丢', () => {
  var period = { from: '2026-01-01', to: '2027-02-28' };
  var entries = [
    E('a', '2026-01-05', '09:00', '10:00', '一月', 'create'),
    E('b', '2027-02-05', '09:00', '10:00', '十三月外', 'create'),
  ];
  var year = computeYear(period, entries);
  assert.equal(year.months.length, 12);
  var last = year.months[11];
  assert.equal(last.m, 12);
  assert.equal(last.events, 1); // 2027-02 的事并入第 12 格
  assert.equal(year.months[0].events, 1);
});

test('R1 contracts：validateStats 保留 stats.year（白名单不再剥掉）', () => {
  var stats = computeStats(
    {
      period: { from: '2026-10-01', to: '2026-10-31' },
      entries: [E('a', '2026-10-05', '09:00', '10:00', '读书', 'explore', { ai: { used: true } })],
      relays: [], usages: [],
    },
    TZ
  );
  assert.ok(stats.year);
  assert.ok(stats.year.months.length === 1);
  assert.equal(stats.year.months[0].m, 10);
  // createChapter 注入的 year 也能活着穿过契约
  assert.ok(validateStats(stats));
});

test('R1 contracts：sanitizeYearStats 拒绝伪造的 streak（天数 ≠ 日期差+1 / relays < days）', () => {
  assert.equal(sanitizeYearStats({ streak: { days: 3, from: '2026-10-01', to: '2026-10-05', relays: 3 } }), null);
  assert.equal(sanitizeYearStats({ streak: { days: 5, from: '2026-10-01', to: '2026-10-05', relays: 4 } }), null);
  assert.deepEqual(
    sanitizeYearStats({ streak: { days: 5, from: '2026-10-01', to: '2026-10-05', relays: 6 } }).streak,
    { days: 5, from: '2026-10-01', to: '2026-10-05', relays: 6 }
  );
});

test('R1 lab 年书：demo 数据 222 件事 → year.months/first/last/streak 全真值', () => {
  var input = buildDemoStatsInput('student', { period: demoPeriods('student').year.period });
  var stats = computeStats(input);
  assert.ok(stats.year.months.length >= 3);
  assert.ok(stats.year.first && stats.year.last);
  assert.equal(stats.year.first.date, '2026-07-27');
  assert.equal(stats.year.last.date, '2026-10-24');
});

// ---------------------------------------------------------------------------
// 「第一次毕业」红线（per-app 生平第一次，且落在本期才上报）
// ---------------------------------------------------------------------------
test('R1 第一次毕业：应用生平第一次不在本期 → 不上报（月章不再自称第一次）', () => {
  var stats = computeStats(
    {
      period: { from: '2026-10-01', to: '2026-10-31' },
      entries: [E('a', '2026-10-10', '09:00', '10:00', '读论文', 'explore')],
      relays: [
        { id: '10000000-0000-4000-8000-000000000001', at: '2026-09-08T15:00:00Z', event: '读论文', usageId: 'u', result: '初稿', graduated: true, graduatedApp: 'deepseek' },
        { id: '10000000-0000-4000-8000-000000000002', at: '2026-10-13T15:00:00Z', event: '读论文', usageId: 'u', result: '初稿', graduated: true, graduatedApp: 'deepseek' },
      ],
      usages: [{ id: 'u', title: '用法' }],
    },
    TZ
  );
  assert.equal(stats.lessons.firstGraduation, null); // 9-8 才是第一次；10-13 不再自称
});

test('R1 第一次毕业：生平第一次落在本期 → 上报（周章/年书与月章同一天，不再互相矛盾）', () => {
  function grad(period) {
    return computeStats(
      {
        period,
        entries: [E('a', '2026-09-08', '09:00', '10:00', '读论文', 'explore')],
        relays: [
          { id: '10000000-0000-4000-8000-000000000001', at: '2026-09-08T15:00:00Z', event: '读论文', usageId: 'u', result: '初稿', graduated: true, graduatedApp: 'deepseek' },
        ],
        usages: [],
      },
      TZ
    ).lessons.firstGraduation;
  }
  var week = grad({ from: '2026-09-07', to: '2026-09-13' });
  var year = grad({ from: '2026-01-01', to: '2026-12-31' });
  assert.equal(week.date, '2026-09-08');
  assert.equal(year.date, '2026-09-08'); // 同一个第一次
});

// ---------------------------------------------------------------------------
// narrative：模板键对齐页面槽位 / periodLabel / 润色红线
// ---------------------------------------------------------------------------
test('R1 narrative：模板键 = 页面槽位（count.lead/spectrum.title/day.warm/learned.first/freed.lead/rhythm.title）', () => {
  var captions = captionsFor(
    {
      totals: { events: 86, aiRelays: 23, prevEvents: 77, delta: 9 },
      kindMinutes: [
        { kind: 'create', minutes: 1116, share: 0.31 }, { kind: 'necessary', minutes: 792, share: 0.22 },
        { kind: 'connect', minutes: 648, share: 0.18 }, { kind: 'explore', minutes: 468, share: 0.13 },
        { kind: 'restore', minutes: 396, share: 0.11 }, { kind: 'stillness', minutes: 180, share: 0.05 },
      ],
      topDay: { date: '2026-10-18', events: 9, warmIndex: 8, timeline: [{ time: '08:30', title: '读懂一篇论文', ai: true }] },
      lessons: { learned: [{ usageId: 'paper-read', title: '论文', count: 7 }], firstGraduation: { date: '2026-10-12', time: '23:00', app: 'deepseek' } },
      savedTime: { confirmedMinutes: 360, allocations: [{ use: 'restore', minutes: 150 }] },
      rhythm: { hourly: new Array(24).fill(0), goldenHour: 22, genre: null },
      panels: [
        { label: '第 1 周', caption: '本周 3 件事' }, { label: '第 2 周', caption: '本周 4 件事' },
        { label: '第 3 周', caption: '本周 5 件事' }, { label: '第 4 周', caption: '本周 6 件事' },
      ],
      keywords: [{ word: '论文', weight: 8 }],
      wishEcho: null,
      song: { busyness: 0.6, mood: 0.7, dominantKind: 'create', weeklyCounts: [3, 4, 5, 6], graduations: [0, 1, 0, 0] },
    },
    { type: 'month', variant: 'full', no: 10, period: { from: '2026-10-01', to: '2026-10-31' } }
  );
  for (var key of ['count.lead', 'spectrum.title', 'day.warm', 'learned.first', 'freed.lead', 'rhythm.title', 'poster.title', 'cover.title']) {
    assert.equal(typeof captions[key], 'string' && captions[key].length > 0 ? 'string' : typeof captions[key], 'string', '缺槽位键 ' + key);
  }
  // 死键不再产出（页面对应槽位不存在）
  assert.equal(captions['numbers.lead'], undefined);
  assert.equal(captions['timeColors.title'], undefined);
  assert.equal(captions['specialDay.lead'], undefined);
  assert.equal(captions['lessons.first'], undefined);
  assert.equal(captions['savedTime.lead'], undefined);
  // panels 变体模板（周分桶）点亮：panels-N 覆盖
  assert.ok(captions['panels-2'].indexOf('件事') >= 0, captions['panels-2']);
});

test('R1 narrative：周记/年书封面不冒用月份名', () => {
  var stats = {
    totals: { events: 20, aiRelays: 5, prevEvents: 10, delta: 10 },
    kindMinutes: [], topDay: null, lessons: { learned: [], firstGraduation: null },
    savedTime: { confirmedMinutes: 90, allocations: [] },
    rhythm: { hourly: new Array(24).fill(0), goldenHour: null, genre: null },
    panels: [{ label: '本期', caption: 'x' }], keywords: [], wishEcho: null,
    song: { busyness: 0.5, mood: 0.5, dominantKind: 'create', weeklyCounts: [1], graduations: [0] },
  };
  var week = captionsFor(stats, { type: 'week', no: 5, period: { from: '2026-08-31', to: '2026-09-06' } });
  assert.ok(week['cover.title'].startsWith('这一周，'), week['cover.title']); // 跨月周不再标「八月」
  var year = captionsFor(stats, { type: 'year', no: 2, period: { from: '2026-07-27', to: '2026-10-24' } });
  assert.ok(year['cover.title'].startsWith('这一年，'), year['cover.title']); // 年书不再标「七月」
});

test('R1 润色红线：acceptedPolishText 导出并拒收鸡汤/夸大/比较/超长', () => {
  assert.equal(acceptedPolishText('十月，把确认过的时间记下来'), '十月，把确认过的时间记下来');
  assert.equal(acceptedPolishText('未来可期，继续加油'), null);
  assert.equal(acceptedPolishText('你比 90% 的人更专注'), null);
  assert.equal(acceptedPolishText('海量成果，史上最强的一月'), null);
  assert.equal(acceptedPolishText('这里有一段留白'), null);
  assert.equal(acceptedPolishText('这一句话的长度超过了二十四字的润色上限所以应当被整句拒收才对'), null);
});

test('R1 wish 分类单一来源：narrative.classifyWish = pages/wish.js 活表', () => {
  assert.equal(classifyWish('希望十月能早点睡'), 'sleep');
  assert.equal(classifyWish('多留一点给跑步和妈妈'), 'exercise');
  assert.equal(classifyWish('想去看一次海'), 'other');
});

// ---------------------------------------------------------------------------
// definitions / player 口径卡
// ---------------------------------------------------------------------------
test('R1 definitions：页面发出的派生键全部有口径（含 freed 承诺的长按键）', () => {
  var keys = [
    'savedTime.confirmedMinutes', 'savedTime.allocations.restore', 'lessons.learned',
    'topDay.events', 'topDay.timeline', 'year.streak.days', 'keywords.top',
    'kindMinutes.create', 'rhythm.hourly.8', 'panels.0', 'keywords.论文',
    'wishEcho.fact.早睡天数', 'poster.title', 'poster.metric',
  ];
  for (var key of keys) assert.ok(definitionFor(key), '缺口径: ' + key);
  assert.equal(definitionFor('totals.nope'), null);
});

test('R1 player：metricCardModel 兼容 definitions {title,samples} 形状（指标/样本数不再空白）', () => {
  var def = definitionFor('totals.events');
  var model = metricCardModel(def);
  assert.equal(model.available, true);
  assert.equal(model.rows[0].v, '事项总数'); // 指标行有值
  assert.equal(model.rows[3].v, '样本即本期全部事项条目'); // 样本数行有值
  var withReal = metricCardModel(def, 86);
  assert.equal(withReal.rows[3].v, '86'); // 真实样本数通道
  var legacy = metricCardModel({ label: '事项总数', source: 's', method: 'm', sample: 3 });
  assert.equal(legacy.rows[0].v, '事项总数');
  assert.equal(legacy.rows[3].v, '3');
});

test('R1 player：metricSample 给真实数字（totals/lessons/topDay/…），未知键 null', () => {
  var chapter = {
    stats: {
      totals: { events: 86, aiRelays: 23, prevEvents: 77, delta: 9 },
      lessons: { learned: [{}, {}, {}], firstGraduation: null },
      topDay: { events: 9, timeline: [{}, {}] },
      savedTime: { confirmedMinutes: 360 },
      keywords: [{ word: 'a' }, { word: 'b' }],
      rhythm: { hourly: [1, 2, 3], goldenHour: 2 },
      kindMinutes: [{ kind: 'create', minutes: 1116 }],
      year: { months: [{ m: 7 }, { m: 8 }, { m: 9 }, { m: 10 }], streak: { days: 9 } },
    },
  };
  assert.equal(metricSample(chapter, 'totals.events'), 86);
  assert.equal(metricSample(chapter, 'lessons.learned'), 3);
  assert.equal(metricSample(chapter, 'topDay.timeline'), 2);
  assert.equal(metricSample(chapter, 'savedTime.confirmedMinutes'), 360);
  assert.equal(metricSample(chapter, 'rhythm.hourly.1'), 2);
  assert.equal(metricSample(chapter, 'kindMinutes.create'), 1116);
  assert.equal(metricSample(chapter, 'year.months'), 4);
  assert.equal(metricSample(chapter, 'year.streak.days'), 9);
  assert.equal(metricSample(chapter, 'poster.title'), null);
});

// ---------------------------------------------------------------------------
// soundtrack：叮声 / 适配器 / 预建
// ---------------------------------------------------------------------------
test('R1 soundtrack：ding 未启动时静默跳过（不凭空出声，自动播放限制）', () => {
  var session = createSoundtrack({ input: null, pageCount: 3 });
  assert.deepEqual(session.ding(0), { ok: false, reason: 'not-started' });
});

test('R1 soundtrack：player 适配器映射 start/setSegment→setPage/setMuted/stop（名不再不符）', () => {
  var calls = [];
  var fakeSession = {
    start: (i) => { calls.push(['start', i]); return { ok: true }; },
    setPage: (i) => calls.push(['setPage', i]),
    setMuted: (b) => calls.push(['setMuted', b]),
    isMuted: () => false,
    unlock: () => calls.push(['unlock']),
    stop: () => calls.push(['stop']),
    prepare: () => ({ ok: true }),
  };
  var adapter = createAudioAdapter({ pageCount: 10, session: fakeSession });
  adapter.start({ busyness: 0.5, mood: 0.5, dominantKind: 'create', weeklyCounts: [1], graduations: [0], chapterSeed: 1 });
  adapter.setSegment(3);
  adapter.setMuted(true);
  adapter.unlock();
  adapter.stop();
  assert.deepEqual(calls, [['start', 0], ['setPage', 3], ['setMuted', true], ['unlock'], 'stop'].map((c) => (c === 'stop' ? ['stop'] : c)));
});

test('R1 soundtrack：prepare 可在空闲时机预建（node 无 Web Audio → no-web-audio，不抛错）', () => {
  var session = createSoundtrack({
    input: { busyness: 0.5, mood: 0.5, dominantKind: 'create', weeklyCounts: [1], graduations: [0], chapterSeed: 7 },
    pageCount: 3,
  });
  var result = session.prepare();
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-web-audio');
});

// ---------------------------------------------------------------------------
// freed/rhythm captions 槽 + 关键词阶梯
// ---------------------------------------------------------------------------
test('R1 freed：freed.lead 槽可被 captions 覆盖（narrative/润色有落点）', () => {
  var base = {
    period: { from: '2026-10-01', to: '2026-10-31' },
    stats: { savedTime: { confirmedMinutes: 360, allocations: [{ use: 'restore', minutes: 360 }] } },
    captions: {},
  };
  assert.equal(buildSavedTimeModel(base).lead, '你把它们，给了这些：');
  var overridden = JSON.parse(JSON.stringify(base));
  overridden.captions = { 'freed.lead': '这 6 小时，也都记下了去向。' };
  assert.equal(buildSavedTimeModel(overridden).lead, '这 6 小时，也都记下了去向。');
});

test('R1 rhythm：rhythm.title 槽可被 captions 覆盖；待定文案如实（同频未定稿，非「数据不足」）', () => {
  var base = {
    period: { from: '2026-10-01', to: '2026-10-31' },
    stats: { rhythm: { hourly: new Array(24).fill(0), goldenHour: 22, genre: null } },
    captions: {},
  };
  var model = buildRhythmModel(base);
  assert.equal(model.title, '晚上 10 点，是你的黄金时间');
  assert.ok(model.genrePendingNote.includes('同频线'), model.genrePendingNote);
  assert.ok(model.genrePendingNote.indexOf('数据不足') < 0);
  var overridden = JSON.parse(JSON.stringify(base));
  overridden.captions = { 'rhythm.title': '晚上 10 点，你最常开始做事' };
  assert.equal(buildRhythmModel(overridden).title, '晚上 10 点，你最常开始做事');
});

test('R1 four：真实词频（最小 count ≥1）也走满 17..38 阶梯', () => {
  assert.equal(keywordFontSize(8, 8, 1), 38);
  assert.equal(keywordFontSize(5, 8, 1), 29);
  assert.equal(keywordFontSize(1, 8, 1), 17); // 旧实现 min=0 前提不成立时最小词只有 19px
  assert.equal(keywordFontSize(10, 10), 38); // 两参数兼容
});

// ---------------------------------------------------------------------------
// demo 回退引擎与正式口径一致
// ---------------------------------------------------------------------------
test('R1 demo 回退引擎：genre 恒 null（与 stats.js 同注）；year 块有逐月真值', () => {
  var stats = aggregateStats(buildDemoStatsInput('student', { period: demoPeriods('student').year.period }));
  assert.ok(stats);
  assert.equal(stats.rhythm.genre, null);
  assert.ok(stats.year && stats.year.months.length >= 3, JSON.stringify(stats.year && stats.year.months && stats.year.months.length));
});
