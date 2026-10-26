import assert from 'node:assert/strict';
import { test } from 'node:test';
import { resolveTimeText } from '../../scripts/voice-pipeline/time.mjs';

const NOW = '2026-10-26T09:00:00+08:00'; // 周一
const r = text => resolveTimeText(text, { now: NOW, tz: 'Asia/Shanghai' });

test('relative dates resolve deterministically from the spoken time text', () => {
  assert.deepEqual(r('下周三下午两点到四点'), { date: '2026-11-04', start: '14:00', end: '16:00', deadline: null, recurrence: null, vague: false });
  assert.equal(r('大后天早上九点').date, '2026-10-29');
  assert.equal(r('大后天早上九点').start, '09:00');
  assert.equal(r('周五前').deadline, '2026-10-30');
  assert.equal(r('这个月底之前').deadline, '2026-10-31');
  assert.equal(r('周六上午十点').date, '2026-10-31');
  assert.equal(r('下周五').date, '2026-11-06');
});

test('下下周X is two calendar weeks out, not next week', () => {
  assert.equal(r('下下周一').date, '2026-11-09');
  assert.equal(r('下下周五').date, '2026-11-13');
});

test('the second clock of a range inherits the first clock\'s daypart', () => {
  const x = r('每天早上七点到七点半');
  assert.equal(x.start, '07:00');
  assert.equal(x.end, '07:30');
  assert.equal(x.recurrence, '每天');
});

test('a bare clock or daypart with no date means today', () => {
  assert.equal(r('下午四点半').date, '2026-10-26');
  assert.equal(r('下午四点半').start, '16:30');
  assert.equal(r('晚上').date, '2026-10-26');
  assert.equal(r('晚上').vague, true);
});

test('no time text resolves to nothing', () => {
  assert.deepEqual(r(''), { date: null, start: null, end: null, deadline: null, recurrence: null, vague: false });
  assert.deepEqual(r(null), { date: null, start: null, end: null, deadline: null, recurrence: null, vague: false });
});
