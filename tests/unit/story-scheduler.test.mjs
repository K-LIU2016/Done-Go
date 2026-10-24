import assert from 'node:assert/strict';
import { test } from 'node:test';

// T8 调度存储线（scheduler）— SPEC design/story-recap/SPEC.md §2 触发表 + §6：
//   周记 = 周日 20:00 本地；月章 = 每月 1 日 09:00 本地（生成上个月）；
//   年书 = 12 月 31 日 20:00 本地（生成全年）；周年书 = 注册满一周年。
// 全部纯函数：时区由调用方按「now 瞬间的 UTC 偏移（分钟，东正西负）」显式
// 注入，node 里无需切系统时区即可证明边界（跨时区、DST、闰年、跨年）。

import {
  wallClock, epochFromWall, dueChapterSpecs, nextChapterNo, variantForEvents,
  bannerFor, chapterKey,
} from '../../web/story/scheduler.js';
import { SHORT_CHAPTER_MIN_EVENTS } from '../../web/story/contracts.js';

const BEIJING = 480; // UTC+8，无夏令时
const UTC = 0;
const EST = -300;    // 美东标准时 UTC-5（2026-11-01 夏令时结束后）
const EDT = -240;    // 美东夏令时 UTC-4

// 与实现独立的瞬时构造：本地墙钟 (y, m, d, hh, mm) + 偏移 → epoch ms。
function T(y, m, d, hh, mm, off) { return Date.UTC(y, m - 1, d, hh, mm) - off * 60000; }

function chapterStub(no, type, from, to) { return { no, type, period: { from, to } }; }
function dueOf(specs, type, reason) {
  return (specs || []).find((s) => s.type === type && (reason == null || s.reason === reason)) || null;
}

// ---------------------------------------------------------------------------
// 墙钟换算 — 时区边界的地基
// ---------------------------------------------------------------------------

test('wallClock：同一瞬间在不同偏移下的本地墙钟（北京周日 20:00 = UTC 周日 12:00）', () => {
  const inst = Date.UTC(2026, 9, 25, 12, 0); // 2026-10-25T12:00Z（周日）
  const bj = wallClock(inst, BEIJING);
  assert.equal(bj.ymd, '2026-10-25');
  assert.equal(bj.hour, 20);
  assert.equal(bj.minute, 0);
  assert.equal(bj.weekday, 0); // 0 = 周日
  const u = wallClock(inst, UTC);
  assert.equal(u.ymd, '2026-10-25');
  assert.equal(u.hour, 12);
  assert.equal(u.weekday, 0);
  const ny = wallClock(inst, EDT); // 北京 20:00 = 纽约(EDT) 08:00
  assert.equal(ny.hour, 8);
  assert.equal(ny.weekday, 0);
});

test('wallClock：跨月/跨年墙钟（UTC 7-31 17:30 = 北京 8-1 01:30）', () => {
  const bj = wallClock(Date.UTC(2026, 6, 31, 17, 30), BEIJING);
  assert.equal(bj.ymd, '2026-08-01');
  assert.equal(bj.month, 8);
  assert.equal(bj.day, 1);
  assert.equal(bj.hour, 1);
});

test('wallClock：非法输入返回 null（now 非有限 / 偏移越界或非整数）', () => {
  assert.equal(wallClock('x', BEIJING), null);
  assert.equal(wallClock(Number.NaN, BEIJING), null);
  assert.equal(wallClock(Date.now(), 900), null);     // > UTC+14
  assert.equal(wallClock(Date.now(), -841), null);    // < UTC-14
  assert.equal(wallClock(Date.now(), 480.5), null);   // 非整数
  assert.equal(wallClock(Date.now(), 840) != null, true);  // 边界 UTC+14 合法
  assert.equal(wallClock(Date.now(), -840) != null, true); // 边界 UTC-14 合法
});

test('epochFromWall：墙钟 → 瞬时，与 Date.UTC 互逆（含负偏移与闰日）', () => {
  assert.equal(epochFromWall(2026, 10, 25, 20, 0, BEIJING), Date.UTC(2026, 9, 25, 12, 0));
  assert.equal(epochFromWall(2026, 11, 1, 20, 0, EST), Date.UTC(2026, 10, 2, 1, 0)); // EST 20:00 = 次日 01:00Z
  const back = wallClock(epochFromWall(2028, 2, 29, 9, 0, BEIJING), BEIJING);
  assert.equal(back.ymd, '2028-02-29');
  assert.equal(back.hour, 9);
  assert.equal(epochFromWall(2026, 10, 25, 20, 0, 'x'), null); // 非法偏移
});

// ---------------------------------------------------------------------------
// 周记 — 周日 20:00 本地，period = 周一 .. 触发周日（含当天）
// ---------------------------------------------------------------------------

test('周记：周日 20:00 整点生效；19:59:59.999 仍属于上一周（北京 UTC+8）', () => {
  const justBefore = T(2026, 10, 25, 19, 59, BEIJING) + 59999; // 19:59:59.999
  let specs = dueChapterSpecs(justBefore, { utcOffsetMinutes: BEIJING, registeredAt: null, chapters: [] });
  let week = dueOf(specs, 'week');
  assert.equal(week.period.from, '2026-10-12'); // 最近一个过了 20:00 的周日是 10-18
  assert.equal(week.period.to, '2026-10-18');
  const atTrigger = T(2026, 10, 25, 20, 0, BEIJING); // 整点（含）
  specs = dueChapterSpecs(atTrigger, { utcOffsetMinutes: BEIJING, registeredAt: null, chapters: [] });
  week = dueOf(specs, 'week');
  assert.equal(week.period.from, '2026-10-19'); // 周一
  assert.equal(week.period.to, '2026-10-25');   // 触发周日（当天）
  assert.equal(week.reason, 'weekly');
});

test('周记：周三打开只补最近一个完整周，不追溯更早（错过的周跳过）', () => {
  const specs = dueChapterSpecs(T(2026, 10, 28, 9, 0, BEIJING), { utcOffsetMinutes: BEIJING, registeredAt: null, chapters: [] });
  const weeks = specs.filter((s) => s.type === 'week');
  assert.equal(weeks.length, 1);
  assert.equal(weeks[0].period.from, '2026-10-19');
  assert.equal(weeks[0].period.to, '2026-10-25');
});

test('周记：同一瞬间不同时区 → 不同的周章（时区边界不串台）', () => {
  const inst = T(2026, 10, 25, 20, 0, BEIJING); // 北京已过 20:00；UTC 侧才 12:00
  const bj = dueOf(dueChapterSpecs(inst, { utcOffsetMinutes: BEIJING, registeredAt: null, chapters: [] }), 'week');
  assert.equal(bj.period.to, '2026-10-25');
  const u = dueOf(dueChapterSpecs(inst, { utcOffsetMinutes: UTC, registeredAt: null, chapters: [] }), 'week');
  assert.equal(u.period.to, '2026-10-18'); // UTC 侧最近触发的周日还是 10-18
});

test('周记：DST 结束日（2026-11-01 美东 02:00 EDT→EST）偏移由调用方按瞬间给出', () => {
  const atEight = T(2026, 11, 1, 20, 0, EST); // 当日 20:00 已是 EST
  assert.equal(atEight, Date.UTC(2026, 10, 2, 1, 0)); // EST 20:00 = 次日 01:00Z
  let specs = dueChapterSpecs(atEight, { utcOffsetMinutes: EST, registeredAt: null, chapters: [] });
  let week = dueOf(specs, 'week');
  assert.equal(week.period.from, '2026-10-26'); // 周一
  assert.equal(week.period.to, '2026-11-01');   // 触发周日
  specs = dueChapterSpecs(atEight - 1000, { utcOffsetMinutes: EST, registeredAt: null, chapters: [] });
  week = dueOf(specs, 'week');
  assert.equal(week.period.to, '2026-10-25'); // 19:59:59 → 仍是上一周
});

// ---------------------------------------------------------------------------
// 月章 — 每月 1 日 09:00 本地，生成上个月（闰年/跨年边界）
// ---------------------------------------------------------------------------

test('月章：1 日 09:00 整点生成上个月；08:59 时最近触发的还是上上个月', () => {
  const before = T(2027, 3, 1, 8, 59, BEIJING);
  let m = dueOf(dueChapterSpecs(before, { utcOffsetMinutes: BEIJING, registeredAt: null, chapters: [] }), 'month');
  assert.equal(m.period.from, '2027-01-01'); // 3 月触发点未到 → 最近触发 2-1 → 1 月
  assert.equal(m.period.to, '2027-01-31');
  const at = T(2027, 3, 1, 9, 0, BEIJING);
  m = dueOf(dueChapterSpecs(at, { utcOffsetMinutes: BEIJING, registeredAt: null, chapters: [] }), 'month');
  assert.equal(m.period.from, '2027-02-01');
  assert.equal(m.period.to, '2027-02-28'); // 2027 非闰年
  assert.equal(m.reason, 'monthly');
});

test('月章：闰年二月 29 天（2028-03-01 09:00 → 2028-02-01..02-29）', () => {
  const specs = dueChapterSpecs(T(2028, 3, 1, 9, 0, BEIJING), { utcOffsetMinutes: BEIJING, registeredAt: null, chapters: [] });
  const m = dueOf(specs, 'month');
  assert.equal(m.period.from, '2028-02-01');
  assert.equal(m.period.to, '2028-02-29');
});

test('月章：跨年边界 — 1 月 1 日 09:00 生成去年 12 月', () => {
  const specs = dueChapterSpecs(T(2027, 1, 1, 9, 0, BEIJING), { utcOffsetMinutes: BEIJING, registeredAt: null, chapters: [] });
  const m = dueOf(specs, 'month');
  assert.equal(m.period.from, '2026-12-01');
  assert.equal(m.period.to, '2026-12-31');
});

// ---------------------------------------------------------------------------
// 年书 — 12 月 31 日 20:00 本地，生成全年
// ---------------------------------------------------------------------------

test('年书：12-31 20:00 整点生成当年；19:59 时最近触发的是去年', () => {
  let specs = dueChapterSpecs(T(2026, 12, 31, 19, 59, BEIJING), { utcOffsetMinutes: BEIJING, registeredAt: null, chapters: [] });
  let y = dueOf(specs, 'year', 'newYear');
  assert.equal(y.period.from, '2025-01-01');
  assert.equal(y.period.to, '2025-12-31');
  specs = dueChapterSpecs(T(2026, 12, 31, 20, 0, BEIJING), { utcOffsetMinutes: BEIJING, registeredAt: null, chapters: [] });
  y = dueOf(specs, 'year', 'newYear');
  assert.equal(y.period.from, '2026-01-01');
  assert.equal(y.period.to, '2026-12-31');
});

test('年书：年中打开补最近一个已过的 12-31（2027-06 → 2026 年书）', () => {
  const specs = dueChapterSpecs(T(2027, 6, 15, 12, 0, BEIJING), { utcOffsetMinutes: BEIJING, registeredAt: null, chapters: [] });
  const y = dueOf(specs, 'year', 'newYear');
  assert.equal(y.period.from, '2026-01-01');
  assert.equal(y.period.to, '2026-12-31');
});

// ---------------------------------------------------------------------------
// 周年书 — 注册满一周年（pinned：周年日本地 20:00 触发；2/29 注册 → 次年 2/28）
// ---------------------------------------------------------------------------

test('周年书：周年日 20:00 本地触发，period = 注册本地日 .. 周年日前一天', () => {
  const registeredAt = T(2025, 10, 25, 14, 30, BEIJING);
  const before = dueChapterSpecs(T(2026, 10, 25, 19, 59, BEIJING), { utcOffsetMinutes: BEIJING, registeredAt, chapters: [] });
  assert.equal(dueOf(before, 'year', 'anniversary'), null);
  const at = dueChapterSpecs(T(2026, 10, 25, 20, 0, BEIJING), { utcOffsetMinutes: BEIJING, registeredAt, chapters: [] });
  const a = dueOf(at, 'year', 'anniversary');
  assert.equal(a.period.from, '2025-10-25');
  assert.equal(a.period.to, '2026-10-24');
});

test('周年书：2 月 29 日注册 → 次年 2 月 28 日触发（闰日 pinned）', () => {
  const registeredAt = Date.UTC(2024, 1, 29, 10, 0); // UTC 时区
  const specs = dueChapterSpecs(Date.UTC(2025, 1, 28, 20, 0), { utcOffsetMinutes: UTC, registeredAt, chapters: [] });
  const a = dueOf(specs, 'year', 'anniversary');
  assert.equal(a.period.from, '2024-02-29');
  assert.equal(a.period.to, '2025-02-27');
});

test('周年书与新历年书同 period（1 月 1 日注册）只出一本，reason=anniversary', () => {
  const registeredAt = T(2026, 1, 1, 8, 0, BEIJING);
  const now = T(2027, 6, 1, 12, 0, BEIJING); // 已过 2027-01-01 20:00（周年）与 2026-12-31 20:00（年书）
  const specs = dueChapterSpecs(now, { utcOffsetMinutes: BEIJING, registeredAt, chapters: [] });
  const years = specs.filter((s) => s.type === 'year');
  assert.equal(years.length, 1);
  assert.equal(years[0].reason, 'anniversary');
  assert.equal(years[0].period.from, '2026-01-01');
  assert.equal(years[0].period.to, '2026-12-31');
});

// ---------------------------------------------------------------------------
// 注册门槛 — 注册前不完整的周/月/年不出章（period.from ≥ 注册本地日）
// ---------------------------------------------------------------------------

test('注册门槛：注册当周之后的周章可出，注册当月/当年的月章年章不出', () => {
  const registeredAt = T(2026, 10, 25, 14, 30, BEIJING); // 周日注册
  // 11-01（周日）20:00：周 10-26..11-01（from ≥ 10-25 ✓）；10 月月章 from 10-01 ✗；2025 年书 ✗；周年未到
  const specs = dueChapterSpecs(T(2026, 11, 1, 20, 0, BEIJING), { utcOffsetMinutes: BEIJING, registeredAt, chapters: [] });
  const week = dueOf(specs, 'week');
  assert.equal(week.period.from, '2026-10-26');
  assert.equal(week.period.to, '2026-11-01');
  assert.equal(dueOf(specs, 'month'), null);
  assert.equal(dueOf(specs, 'year'), null);
});

test('注册门槛：注册当年的年书让位给周年书', () => {
  const registeredAt = T(2026, 3, 10, 9, 0, BEIJING);
  const atYearEnd = dueChapterSpecs(T(2026, 12, 31, 20, 0, BEIJING), { utcOffsetMinutes: BEIJING, registeredAt, chapters: [] });
  assert.equal(dueOf(atYearEnd, 'year', 'newYear'), null); // 2026 年书 from 01-01 < 03-10
  const later = dueChapterSpecs(T(2027, 3, 10, 20, 0, BEIJING), { utcOffsetMinutes: BEIJING, registeredAt, chapters: [] });
  const a = dueOf(later, 'year', 'anniversary');
  assert.equal(a.period.from, '2026-03-10');
  assert.equal(a.period.to, '2027-03-09');
});

test('注册时间缺失或在未来 → 不设门槛（防御：绝不全部静默封锁）', () => {
  const now = T(2027, 1, 1, 9, 0, BEIJING);
  const future = dueChapterSpecs(now, { utcOffsetMinutes: BEIJING, registeredAt: now + 1e10, chapters: [] });
  assert.equal(dueOf(future, 'month').period.from, '2026-12-01');
  const missing = dueChapterSpecs(now, { utcOffsetMinutes: BEIJING, chapters: [] }); // registeredAt 缺省
  assert.equal(dueOf(missing, 'month').period.from, '2026-12-01');
});

// ---------------------------------------------------------------------------
// 与既有章节的去重、多章排序、输入校验
// ---------------------------------------------------------------------------

test('已存在的章节抑制对应 spec（type+period 精确匹配；垃圾条目不炸）', () => {
  const now = T(2026, 10, 28, 9, 0, BEIJING);
  const chapters = [chapterStub(1, 'week', '2026-10-19', '2026-10-25'), null, { no: 2 }];
  const specs = dueChapterSpecs(now, { utcOffsetMinutes: BEIJING, registeredAt: null, chapters });
  assert.equal(dueOf(specs, 'week'), null);
  assert.equal(dueOf(specs, 'month') != null, true); // 9 月月章仍在
  assert.equal(dueOf(specs, 'year') != null, true);  // 2025 年书仍在
});

test('多章同时到期按（period.to，单位粒度）排序：周 → 月 → 年', () => {
  // 2029-01-01（周一）09:00：周(12-25..31) + 月(12 月) + 年(2028) 同时到期
  const specs = dueChapterSpecs(T(2029, 1, 1, 9, 0, BEIJING), { utcOffsetMinutes: BEIJING, registeredAt: null, chapters: [] });
  assert.deepEqual(specs.map((s) => s.type), ['week', 'month', 'year']);
  assert.equal(specs[0].period.to, '2028-12-31');
  assert.equal(specs[2].period.to, '2028-12-31');
});

test('2028-12-31 恰是周日：20:00 时周记与年书同时到期，周记在前', () => {
  // 11 月月章 12-01 已到期 — 先存好，隔离「周 vs 年同 period.to」的排序断言。
  const chapters = [chapterStub(1, 'month', '2028-11-01', '2028-11-30')];
  const specs = dueChapterSpecs(T(2028, 12, 31, 20, 0, BEIJING), { utcOffsetMinutes: BEIJING, registeredAt: null, chapters });
  assert.deepEqual(specs.map((s) => s.type), ['week', 'year']);
  assert.equal(specs[0].period.from, '2028-12-25');
  assert.equal(specs[0].period.to, '2028-12-31');
});

test('spec 形状：{type, period:{from,to}, reason}，日期零填充', () => {
  const specs = dueChapterSpecs(T(2026, 10, 28, 9, 0, BEIJING), { utcOffsetMinutes: BEIJING, registeredAt: null, chapters: [] });
  assert.ok(specs.length >= 2);
  for (const s of specs) {
    assert.deepEqual(Object.keys(s).sort(), ['period', 'reason', 'type']);
    assert.match(s.period.from, /^\d{4}-\d{2}-\d{2}$/);
    assert.match(s.period.to, /^\d{4}-\d{2}-\d{2}$/);
  }
});

test('dueChapterSpecs：非法输入返回 null（now 非有限 / 偏移缺失或非法）', () => {
  assert.equal(dueChapterSpecs(Number.NaN, { utcOffsetMinutes: BEIJING }), null);
  assert.equal(dueChapterSpecs('now', { utcOffsetMinutes: BEIJING }), null);
  assert.equal(dueChapterSpecs(Date.now(), { utcOffsetMinutes: 480.5 }), null);
  assert.equal(dueChapterSpecs(Date.now(), {}), null);
  assert.equal(dueChapterSpecs(Date.now(), null), null);
});

test('chapterKey：type+period 的规范化去重键', () => {
  const p = { from: '2026-10-19', to: '2026-10-25' };
  assert.equal(chapterKey('week', p), chapterKey('week', { from: '2026-10-19', to: '2026-10-25' }));
  assert.notEqual(chapterKey('week', p), chapterKey('month', p));
  assert.notEqual(chapterKey('week', p), chapterKey('week', { from: '2026-10-19', to: '2026-10-26' }));
});

// ---------------------------------------------------------------------------
// 章号、短章变体、首页横幅（二期数据结构）
// ---------------------------------------------------------------------------

test('nextChapterNo：空书架 → 1；取最大 no + 1（乱序/垃圾条目也稳）', () => {
  assert.equal(nextChapterNo([]), 1);
  assert.equal(nextChapterNo([{ no: 1 }, { no: 2 }]), 3);
  assert.equal(nextChapterNo([{ no: 5 }, { no: 2 }, { no: 2 }]), 6);
  assert.equal(nextChapterNo([{}, { no: 'x' }, null]), 1);
  assert.equal(nextChapterNo('junk'), 1);
});

test('variantForEvents：少于 5 件为短章，5 件起整章（契约 SHORT_CHAPTER_MIN_EVENTS=5）', () => {
  assert.equal(SHORT_CHAPTER_MIN_EVENTS, 5);
  assert.equal(variantForEvents(0), 'short');
  assert.equal(variantForEvents(4), 'short');
  assert.equal(variantForEvents(5), 'full');
  assert.equal(variantForEvents(86), 'full');
  assert.equal(variantForEvents(4.5), null);
  assert.equal(variantForEvents('86'), null);
  assert.equal(variantForEvents(-1), null);
});

test('bannerFor：无待生成 → 不可见、无文案（nextNo 照常计算）', () => {
  const now = T(2026, 10, 28, 9, 0, BEIJING);
  const chapters = [
    chapterStub(1, 'week', '2026-10-19', '2026-10-25'),
    chapterStub(2, 'month', '2026-09-01', '2026-09-30'),
    chapterStub(3, 'year', '2025-01-01', '2025-12-31'),
  ];
  const b = bannerFor(now, { utcOffsetMinutes: BEIJING, registeredAt: null, chapters });
  assert.equal(b.visible, false);
  assert.equal(b.text, '');
  assert.equal(b.count, 0);
  assert.equal(b.latest, null);
  assert.deepEqual(b.specs, []);
  assert.equal(b.nextNo, 4);
});

test('bannerFor：单章到期 → 「📖 你的第 N 章到了」，latest 指向该章 spec', () => {
  const now = T(2026, 10, 28, 9, 0, BEIJING);
  const chapters = [
    chapterStub(1, 'week', '2026-10-19', '2026-10-25'),
    chapterStub(2, 'month', '2026-09-01', '2026-09-30'),
  ];
  const b = bannerFor(now, { utcOffsetMinutes: BEIJING, registeredAt: null, chapters });
  assert.equal(b.visible, true);
  assert.equal(b.count, 1);
  assert.equal(b.nextNo, 3);
  assert.equal(b.text, '📖 你的第 3 章到了');
  assert.equal(b.latest.type, 'year'); // 剩下唯一待生成的是 2025 年书
  assert.equal(b.specs.length, 1);
});

test('bannerFor：多章到期 → 文案带总数，latest = 排序最后（粒度最大）那章', () => {
  const now = T(2029, 1, 1, 9, 0, BEIJING);
  const b = bannerFor(now, { utcOffsetMinutes: BEIJING, registeredAt: null, chapters: [] });
  assert.equal(b.visible, true);
  assert.equal(b.count, 3);
  assert.equal(b.nextNo, 1);
  assert.equal(b.text, '📖 你的第 1 章到了（共 3 章待翻开）');
  assert.equal(b.latest.type, 'year');
  assert.equal(b.specs.length, 3);
});

test('bannerFor：非法输入（坏偏移）不炸、不可见', () => {
  const b = bannerFor(Date.now(), { utcOffsetMinutes: 9999, chapters: [] });
  assert.equal(b.visible, false);
  assert.equal(b.count, 0);
});
