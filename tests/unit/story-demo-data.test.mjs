import assert from 'node:assert/strict';
import { test } from 'node:test';

// T10示例与lab 线（demo-data）— SPEC design/story-recap/SPEC.md §7：
//   lab.html 和 scripts/story-lab.mjs 是「独立入口：可以用示例数据一键生成
//   周记、月章、年书，方便 JC 验证」。demo-data.js 是那份示例数据：
//   学生与老师两种人设、真实感 3 个月数据（原型 persona「安静的湖」= 学生），
//   全部确定性生成（种子固定），并通过 contracts.validateStatsInput 校验。
// 同源真实数据读取（readLocalStatsInput）也在本文件覆盖。

import {
  DEMO_PERSONAS, personaById, demoSpan, demoPeriods,
  buildDemoStatsInput, buildDemoChapter, previewChapter,
  readLocalStatsInput, aggregateStats,
} from '../../web/story/demo-data.js';
import {
  validateStatsInput, validateChapter, validatePeriod, SHORT_CHAPTER_MIN_EVENTS,
  KINDS, pageOrderFor, CHAPTER_TYPES, STORY_STORE_KEY,
} from '../../web/story/contracts.js';
import { variantForEvents } from '../../web/story/scheduler.js';
import { GENRES } from '../../web/story/pages/rhythm.js';

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const HM = /^(?:[01]\d|2[0-3]):[0-5]\d|24:00$/;

function days(a, b) { // inclusive day list between two ymd strings
  const out = [];
  const t = Date.parse(a + 'T00:00:00Z');
  const end = Date.parse(b + 'T00:00:00Z');
  for (let t0 = t; t0 <= end; t0 += 86400000) {
    out.push(new Date(t0).toISOString().slice(0, 10));
  }
  return out;
}
function inPeriod(date, period) { return date >= period.from && date <= period.to; }
function entriesIn(input, period) { return input.entries.filter((e) => inPeriod(e.date, period)); }
function relaysIn(input, period) {
  return input.relays.filter((r) => inPeriod(String(r.at.slice(0, 10)), period));
}
function both(fn) { for (const p of DEMO_PERSONAS) fn(p); }

// ---------------------------------------------------------------------------
// 人设目录
// ---------------------------------------------------------------------------
test('DEMO_PERSONAS：恰好学生/老师两个人设，元数据齐全且种子不同', () => {
  assert.equal(DEMO_PERSONAS.length, 2);
  const ids = DEMO_PERSONAS.map((p) => p.id).sort();
  assert.deepEqual(ids, ['student', 'teacher']);
  both((p) => {
    assert.ok(p.label && p.label.length >= 2, p.id + ' label');
    assert.ok(Number.isInteger(p.seed) && p.seed >= 0 && p.seed <= 0xffffffff, p.id + ' seed');
  });
  assert.notEqual(DEMO_PERSONAS[0].seed, DEMO_PERSONAS[1].seed);
  assert.equal(personaById('student').id, 'student');
  assert.equal(personaById('teacher').id, 'teacher');
  assert.equal(personaById('nope'), null);
  assert.equal(personaById(null), null);
});

test('demoSpan：约 3 个月（85–100 天）的有效期间，昨天及之前收口', () => {
  both((p) => {
    const span = demoSpan(p.id);
    assert.ok(validatePeriod(span), p.id);
    const list = days(span.from, span.to);
    assert.ok(list.length >= 85 && list.length <= 100, p.id + ' 天数 ' + list.length);
  });
});

test('demoPeriods：周记/月章/年书/短章四个预设，期间都在数据跨度内', () => {
  both((p) => {
    const span = demoSpan(p.id);
    const presets = demoPeriods(p.id);
    assert.deepEqual(Object.keys(presets).sort(), ['month', 'short', 'week', 'year']);
    for (const key of Object.keys(presets)) {
      const spec = presets[key];
      assert.ok(CHAPTER_TYPES.includes(spec.type), key + ' type');
      assert.ok(validatePeriod(spec.period), key + ' period');
      assert.ok(spec.period.from >= span.from && spec.period.to <= span.to, key + ' 在跨度内');
      assert.ok(spec.label, key + ' label');
    }
    // 周记 = 完整周一..周日；月章 = 完整自然月
    const w = presets.week.period;
    assert.equal(new Date(w.from + 'T00:00:00Z').getUTCDay(), 1, '周一开始');
    assert.equal(new Date(w.to + 'T00:00:00Z').getUTCDay(), 0, '周日结束');
    const m = presets.month.period;
    assert.equal(m.from.slice(8), '01', '月从 1 日开始');
    assert.equal(m.to, m.from.slice(0, 8) + String(daysInMonth(m)).padStart(2, '0'), '月到末日结束');
  });
  function daysInMonth(m) {
    return new Date(Date.UTC(+m.from.slice(0, 4), +m.from.slice(5, 7), 0)).getUTCDate();
  }
});

// ---------------------------------------------------------------------------
// 原始数据生成 — buildDemoStatsInput
// ---------------------------------------------------------------------------
test('buildDemoStatsInput：两个人设 × 四个预设期间都通过 contracts.validateStatsInput', () => {
  both((p) => {
    const presets = demoPeriods(p.id);
    for (const key of ['week', 'month', 'year', 'short']) {
      const input = buildDemoStatsInput(p.id, { period: presets[key].period });
      const clean = validateStatsInput(input);
      assert.ok(clean, p.id + '/' + key + ' 通过契约校验');
      assert.deepEqual(clean.period, presets[key].period);
      assert.ok(clean.usages.length >= 4, p.id + ' usages');
    }
  });
});

test('buildDemoStatsInput：未知人设 / 非法期间 → null；缺省期间 = 月章预设', () => {
  assert.equal(buildDemoStatsInput('nope', {}), null);
  assert.equal(buildDemoStatsInput('student', { period: { from: '2026-09-01', to: '2026-08-01' } }), null);
  assert.equal(buildDemoStatsInput('student', { period: { from: '2026-13-01', to: '2026-13-02' } }), null);
  const def = buildDemoStatsInput('student', {});
  assert.deepEqual(def.period, demoPeriods('student').month.period);
});

test('确定性：同参两次生成 deepEqual（含 id / prevChapter / relays）', () => {
  both((p) => {
    const a = buildDemoStatsInput(p.id, {});
    const b = buildDemoStatsInput(p.id, {});
    assert.deepEqual(a, b);
  });
});

test('人设差异：学生与老师的条目、用法、毕业应用都不同', () => {
  const s = buildDemoStatsInput('student', {});
  const t = buildDemoStatsInput('teacher', {});
  assert.notDeepEqual(s.entries, t.entries);
  assert.notDeepEqual(s.usages.map((u) => u.id), t.usages.map((u) => u.id));
});

test('真实感：3 个月条目量 120–420；单日无时间重叠；时间与类别全部合法', () => {
  both((p) => {
    const span = demoSpan(p.id);
    const input = buildDemoStatsInput(p.id, { period: demoPeriods(p.id).month.period });
    const inSpan = input.entries.filter((e) => inPeriod(e.date, span));
    assert.ok(inSpan.length >= 120 && inSpan.length <= 420, p.id + ' 总量 ' + inSpan.length);
    assert.ok(input.relays.length >= 20 && input.relays.length <= 200, p.id + ' 接力数 ' + input.relays.length);
    const byDay = new Map();
    for (const e of inSpan) {
      assert.match(e.date, YMD);
      assert.match(e.start, HM);
      assert.match(e.end, HM);
      assert.ok(e.start < e.end, 'start<end ' + JSON.stringify(e));
      assert.ok(KINDS.includes(e.kind));
      assert.ok(e.title && e.title.length <= 200);
      if (!byDay.has(e.date)) byDay.set(e.date, []);
      byDay.get(e.date).push(e);
    }
    for (const [date, list] of byDay) {
      const sorted = [...list].sort((a, b) => (a.start < b.start ? -1 : 1));
      for (let i = 1; i < sorted.length; i += 1) {
        assert.ok(sorted[i - 1].end <= sorted[i].start, date + ' 重叠 ' + sorted[i - 1].end + ' > ' + sorted[i].start);
      }
    }
    // 接力与 ai 条目一致：每条 relay 的日期都落在跨度内、usageId 属于人设用法池
    const usageIds = new Set(input.usages.map((u) => u.id));
    for (const r of input.relays) {
      assert.ok(inPeriod(r.at.slice(0, 10), span), 'relay 日期在跨度内');
      if (r.usageId != null) assert.ok(usageIds.has(r.usageId), 'usageId 在池内: ' + r.usageId);
      if (r.graduated === true) assert.match(r.graduatedApp, /^[a-z0-9][a-z0-9_-]{0,31}$/);
    }
    const aiCount = inSpan.filter((e) => e.ai && e.ai.used === true).length;
    assert.ok(aiCount >= 20, p.id + ' ai 条目 ' + aiCount);
  });
});

test('学生十月体量对齐原型量级：60–110 件事、≥12 次 AI 接力（原型 86/23）', () => {
  const input = buildDemoStatsInput('student', { period: { from: '2026-10-01', to: '2026-10-24' } });
  const oct = entriesIn(input, { from: '2026-10-01', to: '2026-10-24' });
  assert.ok(oct.length >= 60 && oct.length <= 110, '十月 ' + oct.length + ' 件事');
  assert.ok(relaysIn(input, { from: '2026-10-01', to: '2026-10-24' }).length >= 12, '十月接力');
});

test('短章预设：期间内事项少于 5 件 → variantForEvents 判 short（SPEC §2）', () => {
  both((p) => {
    const short = demoPeriods(p.id).short;
    const input = buildDemoStatsInput(p.id, { period: short.period });
    const n = entriesIn(input, short.period).length;
    assert.ok(n < SHORT_CHAPTER_MIN_EVENTS, p.id + ' 短章事项 ' + n);
    assert.equal(variantForEvents(n), 'short');
  });
});

test('prevChapter：月章输入带上一章（valid chapter、type month、写着给本期的愿望）', () => {
  both((p) => {
    const input = buildDemoStatsInput(p.id, {});
    assert.ok(input.prevChapter, '有上一章');
    const clean = validateChapter(input.prevChapter);
    assert.ok(clean, 'prevChapter 通过契约');
    assert.equal(clean.type, 'month');
    const cur = demoPeriods(p.id).month.period; // 如 2026-09 → prev = 2026-08
    const prevFrom = cur.from.slice(0, 5) + String(+cur.from.slice(5, 7) - 1).padStart(2, '0') + '-01';
    assert.equal(clean.period.from, prevFrom);
    assert.ok(clean.wish && clean.wish.text, '上一章有愿望');
  });
});

test('周记/短章输入 prevChapter = null（第一章路径，SPEC §8 边界）', () => {
  both((p) => {
    const presets = demoPeriods(p.id);
    assert.equal(buildDemoStatsInput(p.id, { period: presets.week.period }).prevChapter, null);
    assert.equal(buildDemoStatsInput(p.id, { period: presets.short.period }).prevChapter, null);
  });
});

// ---------------------------------------------------------------------------
// 轻量聚合（lab 口径）+ 章节组装 — buildDemoChapter
// ---------------------------------------------------------------------------
test('aggregateStats：输出通过 validateStats 的全字段校验（两个人设 × 四预设）', () => {
  both((p) => {
    for (const key of ['week', 'month', 'year', 'short']) {
      const spec = demoPeriods(p.id)[key];
      const stats = aggregateStats(buildDemoStatsInput(p.id, { period: spec.period }));
      assert.ok(stats, p.id + '/' + key);
      const again = aggregateStats(buildDemoStatsInput(p.id, { period: spec.period }));
      assert.deepEqual(stats, again, p.id + '/' + key + ' 确定性');
    }
  });
});

test('aggregateStats：与原始数据逐项一致（totals/kind 分钟/节律/省时只算本人确认）', () => {
  const spec = demoPeriods('student').month;
  const input = buildDemoStatsInput('student', { period: spec.period });
  const stats = aggregateStats(input);
  const inP = entriesIn(input, spec.period);
  assert.equal(stats.totals.events, inP.length);
  assert.equal(stats.totals.aiRelays, relaysIn(input, spec.period).length);
  // kindMinutes = 计划时长和
  const minutes = { necessary: 0, create: 0, connect: 0, explore: 0, restore: 0, stillness: 0 };
  for (const e of inP) minutes[e.kind] += hm(e.end) - hm(e.start);
  for (const row of stats.kindMinutes) assert.equal(row.minutes, minutes[row.kind], row.kind);
  // 节律：24 小时计数和 = 事项数；goldenHour 是峰值小时
  const sum = stats.rhythm.hourly.reduce((a, b) => a + b, 0);
  assert.equal(sum, inP.length);
  assert.equal(stats.rhythm.goldenHour, stats.rhythm.hourly.indexOf(Math.max(...stats.rhythm.hourly)));
  // 省时：confirmedMinutes = 期间 stillness 条目的 kept 之和（只算确认过的）
  const kept = inP.filter((e) => e.kind === 'stillness').reduce((a, e) => a + (e.kept || 0), 0);
  assert.equal(stats.savedTime.confirmedMinutes, kept);
  // song.weeklyCounts 的和 = 事项数；graduations 与每周对齐
  assert.equal(stats.song.weeklyCounts.reduce((a, b) => a + b, 0), inP.length);
  assert.equal(stats.song.graduations.length, stats.song.weeklyCounts.length);
  function hm(s) { return +s.slice(0, 2) * 60 + +s.slice(3, 5); }
});

test('buildDemoChapter：两 × 四 = 8 种组合都产出 valid chapter，页序符合契约', () => {
  both((p) => {
    for (const key of ['week', 'month', 'year', 'short']) {
      const spec = demoPeriods(p.id)[key];
      const chapter = buildDemoChapter(p.id, { type: spec.type, period: spec.period, no: 10, now: Date.UTC(2026, 9, 25, 3, 0) });
      const clean = validateChapter(chapter);
      assert.ok(clean, p.id + '/' + key);
      const events = chapter.stats.totals.events;
      const variant = variantForEvents(events);
      const order = pageOrderFor(spec.type, variant);
      if (order) {
        assert.deepEqual(clean.pages.map((x) => x.type), order, p.id + '/' + key);
      } else {
        // year/full：cover 开篇、poster 收尾、六个年度页型齐备（contracts 决定）
        assert.equal(clean.pages[0].type, 'cover');
        assert.equal(clean.pages[clean.pages.length - 1].type, 'poster');
        assert.ok(clean.pages.some((x) => x.type === 'yearSpectrum'));
        assert.ok(clean.pages.some((x) => x.type === 'yearWall'));
      }
      assert.equal(chapter.variant, variant);
    }
  });
});

test('buildDemoChapter：确定性（同参 deepEqual）；stats.totals 与聚合一致', () => {
  const opts = { type: 'month', period: demoPeriods('teacher').month.period, no: 7, now: Date.UTC(2026, 9, 25, 3, 0) };
  const a = buildDemoChapter('teacher', opts);
  const b = buildDemoChapter('teacher', opts);
  assert.deepEqual(a, b);
  const stats = aggregateStats(buildDemoStatsInput('teacher', { period: opts.period }));
  assert.deepEqual(a.stats.totals, stats.totals);
});

test('buildDemoChapter：月章愿望回声来自上一章心愿（连载感，SPEC §1.4）', () => {
  const input = buildDemoStatsInput('student', {});
  const cur = demoPeriods('student').month.period; // 2026-09
  const chapter = buildDemoChapter('student', { type: 'month', period: { from: '2026-10-01', to: '2026-10-24' }, no: 10, now: 0 });
  // 十月章的 prevChapter 是九月章：愿望「希望十月能早点睡」（对齐原型叙事）
  assert.equal(chapter.stats.wishEcho.text, '希望十月能早点睡');
  assert.equal(chapter.stats.wishEcho.matched, true);
  assert.ok(chapter.stats.wishEcho.facts.length >= 1);
  assert.ok(input.prevChapter.wish.category === 'sleep');
});

test('buildDemoChapter：无上一章时 wishEcho = null（第一章，不硬编）', () => {
  const week = demoPeriods('student').week.period;
  const chapter = buildDemoChapter('student', { type: 'week', period: week, no: 3, now: 0 });
  assert.equal(chapter.stats.wishEcho, null);
});

test('buildDemoChapter：非法输入 → null（未知人设/非法类型/坏期间）', () => {
  const period = demoPeriods('student').month.period;
  assert.equal(buildDemoChapter('nope', { type: 'month', period, no: 1, now: 0 }), null);
  assert.equal(buildDemoChapter('student', { type: 'daily', period, no: 1, now: 0 }), null);
  assert.equal(buildDemoChapter('student', { type: 'month', period: { from: '2026-13-01', to: '2026-13-02' }, no: 1, now: 0 }), null);
  assert.equal(buildDemoChapter('student', { type: 'month', period, now: 0 }), null); // 缺章号
});

test('流派 id 与 rhythm 页型流派表一致（同频共用口径）', () => {
  const ids = new Set(GENRES.map((g) => g.id));
  for (const p of DEMO_PERSONAS) {
    const chapter = buildDemoChapter(p.id, { type: 'month', period: demoPeriods(p.id).month.period, no: 5, now: 0 });
    if (chapter.stats.rhythm.genre) assert.ok(ids.has(chapter.stats.rhythm.genre.id), p.id + ' 流派 id');
  }
  assert.ok(ids.has('night-creator'), '学生 = 深夜创作派（原型）');
});

// ---------------------------------------------------------------------------
// 原型对照章 — previewChapter
// ---------------------------------------------------------------------------
test('previewChapter(student)：原型逐值对照（86 件事 / 23 接力 / 多 9 件 / 6 小时 / 深夜创作派）', () => {
  const chapter = previewChapter('student');
  const clean = validateChapter(chapter);
  assert.ok(clean, '原型章通过契约');
  assert.equal(clean.type, 'month');
  assert.equal(clean.stats.totals.events, 86);
  assert.equal(clean.stats.totals.aiRelays, 23);
  assert.equal(clean.stats.totals.prevEvents, 77);
  assert.equal(clean.stats.totals.delta, 9);
  assert.equal(clean.stats.savedTime.confirmedMinutes, 360); // 6 小时（原型 ⑤）
  assert.equal(clean.stats.rhythm.goldenHour, 22);
  assert.equal(clean.stats.rhythm.genre.id, 'night-creator');
  assert.deepEqual(clean.stats.keywords.map((k) => k.word), ['论文', '组会', '跑步', '妈妈', '实验', '火锅']);
  assert.equal(clean.stats.lessons.firstGraduation.date, '2026-10-12'); // 原型 ④
  assert.equal(clean.stats.lessons.firstGraduation.app, 'deepseek');
  assert.equal(clean.stats.song.busyness, 0.62); // 原型作曲演示输入
  assert.equal(clean.stats.song.mood, 0.7);
  assert.equal(clean.stats.song.dominantKind, 'create');
  assert.deepEqual(clean.stats.song.weeklyCounts, [14, 22, 28, 22]);
  // ② 时间光谱占比（原型 31/22/18/13/11/5）
  const shares = {};
  for (const row of clean.stats.kindMinutes) shares[row.kind] = row.share;
  assert.equal(shares.create, 0.31);
  assert.equal(shares.necessary, 0.22);
});

test('previewChapter(teacher)：教师原型章（十月聚合）也通过契约；未知人设 → null', () => {
  const chapter = previewChapter('teacher');
  assert.ok(validateChapter(chapter));
  assert.ok(chapter.stats.totals.events >= 40);
  assert.equal(previewChapter('nope'), null);
});

// ---------------------------------------------------------------------------
// 同源真实数据 — readLocalStatsInput
// ---------------------------------------------------------------------------
function fakeStorage(map) {
  return {
    getItem: (k) => (Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null),
    setItem: () => {},
  };
}
function sampleLedgerEntry(date) {
  return { id: 'r1', date, start: '09:00', end: '10:00', title: '备课', kind: 'create', done: true, ai: { used: true } };
}

test('readLocalStatsInput：账本 + 接力 + 书架上一章 → 有效 StatsInput', () => {
  const period = { from: '2026-10-01', to: '2026-10-31' };
  const prev = { ...previewChapter('student'), period: { from: '2026-09-01', to: '2026-09-30' } };
  const storage = fakeStorage({
    'tango-donego.web.v1': JSON.stringify({ v: 1, entries: [sampleLedgerEntry('2026-10-05'), sampleLedgerEntry('2026-10-06')] }),
    'tango-donego.relay.v2': JSON.stringify({ v: 2, records: [{
      id: '0e2f07a4-9c3d-4b8e-8f11-3c2a6d9f5a70', at: '2026-10-05T09:10:00+08:00', event: '备课',
      usageId: 'lesson-plan', result: '教案初稿', rating: 'much', graduated: false, graduatedApp: null, failed: null,
    }] }),
    [STORY_STORE_KEY]: JSON.stringify({ v: 1, chapters: [prev] }),
  });
  const input = readLocalStatsInput(storage, { period, usages: [{ id: 'lesson-plan', title: '一节课的教案' }] });
  const clean = validateStatsInput(input);
  assert.ok(clean);
  assert.equal(clean.entries.length, 2);
  assert.equal(clean.relays.length, 1);
  assert.deepEqual(clean.prevChapter && clean.prevChapter.id, prev.id);
});

test('readLocalStatsInput：脏条目被契约清洗丢弃；空存储返回空输入；缺 storage/期间 → null', () => {
  const period = { from: '2026-10-01', to: '2026-10-31' };
  const storage = fakeStorage({
    'tango-donego.web.v1': JSON.stringify({ v: 1, entries: [sampleLedgerEntry('2026-10-05'), { date: '2026-10-06', start: '25:00', end: '26:00', title: '坏时间', kind: 'create' }] }),
    'tango-donego.relay.v2': 'not json',
  });
  const clean = validateStatsInput(readLocalStatsInput(storage, { period }));
  assert.ok(clean);
  assert.equal(clean.entries.length, 1);
  assert.equal(clean.relays.length, 0);
  const empty = validateStatsInput(readLocalStatsInput(fakeStorage({}), { period }));
  assert.ok(empty);
  assert.equal(empty.entries.length, 0);
  assert.equal(readLocalStatsInput(null, { period }), null);
  assert.equal(readLocalStatsInput(fakeStorage({}), {}), null);
  assert.equal(readLocalStatsInput(fakeStorage({}), { period: { from: 'x', to: 'y' } }), null);
});
