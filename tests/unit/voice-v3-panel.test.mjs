import assert from 'node:assert/strict';
import { test } from 'node:test';
import { timeLabel, toEntryDraft } from '../../web/voice/v3-panel.js';

const TODAY = '2026-10-26'; // 周一

test('timeLabel reads like a person would say it', () => {
  assert.equal(timeLabel({ date: '2026-10-27', start: '15:00', end: null }, TODAY), '明天 15:00');
  assert.equal(timeLabel({ date: '2026-11-04', start: '14:00', end: '16:00' }, TODAY), '周三 14:00–16:00 · 11/4');
  assert.equal(timeLabel({ date: null, deadline: '2026-10-30' }, TODAY), '10/30 前');
  assert.equal(timeLabel({ recurrence: '每天', start: '07:00', end: '07:30' }, TODAY), '每天 07:00–07:30');
  assert.equal(timeLabel({ date: TODAY, vague: true, timeText: '晚上' }, TODAY), '今天 晚上');
  assert.equal(timeLabel({ date: null }, TODAY), '时间待定');
});

test('toEntryDraft maps a v3 item to a Kira entry and leaves untimed items for the draft list', () => {
  assert.deepEqual(toEntryDraft({ title: '跟导师开组会', date: '2026-10-27', start: '15:00', priority: 2 }, TODAY), { title: '跟导师开组会', prio: 2, date: '2026-10-27', start: '15:00', end: '16:00', note: '' });
  const deadline = toEntryDraft({ title: '交课程报告', deadline: '2026-10-30', priority: 9 }, TODAY);
  assert.deepEqual([deadline.date, deadline.start, deadline.end, deadline.prio, deadline.note], ['2026-10-30', '', '', 3, '截止 2026-10-30']);
  assert.equal(toEntryDraft({ title: '视频会议', date: TODAY, start: '16:30', remind: '提前十分钟上线' }, TODAY).note, '提前十分钟上线');
  assert.equal(toEntryDraft({ title: '晚场', date: TODAY, start: '23:30' }, TODAY).end, '23:59');
});
