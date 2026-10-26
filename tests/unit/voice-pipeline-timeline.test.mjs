import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveTimeline } from '../../scripts/voice-pipeline/timeline.mjs';

const NOW = '2026-10-26T14:03:00+08:00'; // 周一
const pick = items => items.map(i => [i.title, i.date, i.start, i.end]);

test('chains "接下来/之后 N 小时" after the previous item, on the inherited day', () => {
  const out = resolveTimeline([
    { title: '看端侧智能新闻', day: '明天', clock: '早上七点到八点' },
    { title: '推进 Argus 基础设施项目', day: '明天', anchor: 'prev', durationMin: 120 },
    { title: '推进 Mystic 项目', day: '明天', anchor: 'prev', durationMin: 240 },
    { title: '写周报', anchor: 'prev', durationMin: 180 },
  ], { now: NOW });
  assert.deepEqual(pick(out), [
    ['看端侧智能新闻', '2026-10-27', '07:00', '08:00'],
    ['推进 Argus 基础设施项目', '2026-10-27', '08:00', '10:00'],
    ['推进 Mystic 项目', '2026-10-27', '10:00', '14:00'],
    ['写周报', '2026-10-27', '14:00', '17:00'],
  ]);
});

test('anchors on now: rounds up to 5 minutes, applies gap and duration', () => {
  const out = resolveTimeline([
    { title: '写方案', anchor: 'now', durationMin: 120 },
    { title: '喝水', anchor: 'now', gapMin: 30 },
  ], { now: NOW });
  assert.deepEqual(pick(out), [['写方案', '2026-10-26', '14:05', '16:05'], ['喝水', '2026-10-26', '14:35', null]]);
});

test('an item with only a start time is assumed to last an hour for chaining', () => {
  const out = resolveTimeline([
    { title: '开周会', day: '明天', clock: '上午九点' },
    { title: '整理会议纪要', anchor: 'prev', gapMin: 10, durationMin: 30 },
  ], { now: NOW });
  assert.deepEqual(pick(out), [['开周会', '2026-10-27', '09:00', null], ['整理会议纪要', '2026-10-27', '10:10', '10:40']]);
});

test('deadline, repeat and daypart keep their own shapes', () => {
  const [deadline, offWork, repeat, vague] = resolveTimeline([
    { title: '交课程报告', deadline: '周五' },
    { title: '发周报', deadline: '周五下班前' },
    { title: '跑步', repeat: '每天', clock: '早上七点到七点半' },
    { title: '给妈妈打电话', day: '明天', daypart: '晚上' },
  ], { now: NOW });
  assert.equal(deadline.deadline, '2026-10-30');
  assert.equal(deadline.date, null);
  assert.deepEqual([offWork.deadline, offWork.date], ['2026-10-30', null]);
  assert.deepEqual([repeat.recurrence, repeat.start, repeat.end], ['每天', '07:00', '07:30']);
  assert.deepEqual([vague.date, vague.start, vague.vague, vague.timeText], ['2026-10-27', null, true, '晚上']);
});

test('never runs past midnight and never chains across a different day', () => {
  const out = resolveTimeline([
    { title: '加班', clock: '晚上十点' },
    { title: '复盘', anchor: 'prev', durationMin: 180 },
    { title: '开会', day: '周三', anchor: 'prev', durationMin: 60 },
    { title: '没头没尾', anchor: 'prev', durationMin: 60, day: null },
  ], { now: NOW });
  assert.deepEqual(pick(out).slice(0, 3), [['加班', '2026-10-26', '22:00', null], ['复盘', '2026-10-26', '23:00', '23:59'], ['开会', '2026-10-28', null, null]]);
});

test('drops empty and filler titles, clamps priority, keeps remind', () => {
  const out = resolveTimeline([{ title: '嗯' }, { title: '' }, { title: '视频会议', clock: '下午四点半', remind: '提前十分钟上线', priority: 9 }], { now: NOW });
  assert.equal(out.length, 1);
  assert.deepEqual([out[0].start, out[0].remind, out[0].priority], ['16:30', '提前十分钟上线', 3]);
});

test('crosses midnight forward instead of chaining backwards or piling at 23:59', () => {
  const late = resolveTimeline([
    { title: '通宵赶稿', clock: '晚上十点到凌晨一点' },
    { title: '睡觉', anchor: 'prev', durationMin: 420 },
  ], { now: NOW });
  assert.deepEqual(pick(late), [['通宵赶稿', '2026-10-26', '22:00', '01:00'], ['睡觉', '2026-10-27', '01:00', '08:00']]);
  const pile = resolveTimeline([
    { title: '加班', clock: '晚上十一点' },
    { title: '复盘', anchor: 'prev', durationMin: 120 },
    { title: '写日记', anchor: 'prev', durationMin: 30 },
  ], { now: NOW });
  assert.deepEqual(pick(pile), [['加班', '2026-10-26', '23:00', null], ['复盘', '2026-10-27', '00:00', '02:00'], ['写日记', '2026-10-27', '02:00', '02:30']]);
  const nearMidnight = resolveTimeline([{ title: '吃药', anchor: 'now', gapMin: 30 }], { now: '2026-10-26T23:40:00+08:00' });
  assert.deepEqual(pick(nearMidnight), [['吃药', '2026-10-27', '00:10', null]]);
});

test('a daypart-only follow-up without its own day still chains onto the previous day', () => {
  const out = resolveTimeline([
    { title: '面试', day: '明天', clock: '上午十点' },
    { title: '复盘面试', anchor: 'prev', daypart: '中午', durationMin: 30 },
  ], { now: NOW });
  assert.deepEqual(pick(out), [['面试', '2026-10-27', '10:00', null], ['复盘面试', '2026-10-27', '11:00', '11:30']]);
});
