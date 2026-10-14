import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

const html = readFileSync(new URL('../../web/index.html', import.meta.url), 'utf8');
const script = html.match(/<script id="tango-time-core">([\s\S]*?)<\/script>/)?.[1];
const context = vm.createContext({ window: {} });
if (script) vm.runInContext(script, context);
const core = context.window.TangoTime || {};
const entry = (start, end, extra = {}) => ({ start, end, kind: 'necessary', ...extra });
const trial = (date, before, after, extra = {}) => ({ date, before, after, confirmed: true, usedAI: true, category: 'read', ...extra });

test('overlapping tasks and personal intervals occupy each minute once', () => {
  assert.equal(core.occupiedMinutes([entry('09:00', '11:00'), entry('10:00', '12:00'), entry('11:30', '12:30', { kind: 'blank' })]), 210);
});
test('the whole-day unplanned budget subtracts all scheduled categories and clamps at zero', () => {
  assert.equal(core.unplannedMinutes([entry('09:00', '11:00'), entry('12:00', '13:00', { kind: 'restore' })], 960), 780);
  assert.equal(core.unplannedMinutes([entry('00:00', '24:00')], 960), 0);
});
test('malformed intervals do not poison the time budget', () => {
  assert.equal(core.occupiedMinutes([entry('24:15', '25:00'), entry('broken', '11:00'), entry('12:00', '11:00'), entry('23:00', '24:00')]), 60);
});
test('estimated legacy reductions and unconfirmed measurements never count as confirmed time', () => {
  assert.equal(core.confirmedSavings([trial('2026-10-14', 60, 40), trial('2026-10-14', 100, 10, { confirmed: false }), { date: '2026-10-14', before: 100, after: 10 }]), 20);
});
test('review totals respect the selected date interval and ignore overruns and invalid measurements', () => {
  assert.equal(core.confirmedSavings([trial('2026-10-01', 60, 20), trial('2026-10-14', 60, 40), trial('2026-10-14', 30, 50), trial('2026-10-14', 60, -10), trial('2026-10-14', 60, NaN)], '2026-10-08', '2026-10-14'), 20);
});
test('a completed task releases the unused tail of its planned interval', () => {
  const result = core.completeTask({ id: 'paper', date: '2026-10-14', ...entry('09:00', '10:00') }, '40', true, 'read');
  assert.equal(result.entry.end, '09:40');
  assert.equal(result.entry.done, true);
  assert.equal(result.trial.before, 60);
  assert.equal(result.trial.after, 40);
  assert.equal(result.trial.taskId, 'paper');
  assert.equal(result.freed.minutes, 20);
  assert.equal(result.freed.start, '09:40');
  assert.equal(result.freed.end, '10:00');
});
test('empty, negative, out-of-range, and repeated completions are rejected', () => {
  const item = { id: 'paper', date: '2026-10-14', ...entry('09:00', '10:00') };
  for (const minutes of ['', ' ', '-1', '1441', 'no', '1.5']) assert.equal(core.completeTask(item, minutes, true, 'read'), null);
  assert.equal(core.completeTask({ ...item, done: true }, '40', true, 'read'), null);
});
test('overruns produce no free interval and include checking time in the actual duration', () => {
  const result = core.completeTask({ id: 'paper', date: '2026-10-14', ...entry('09:00', '10:00') }, '80', true, 'read');
  assert.equal(result.trial.after, 80);
  assert.equal(result.freed, null);
});
test('AI estimates require at least two confirmed comparable personal records', () => {
  assert.equal(core.estimate([trial('2026-10-14', 60, 40)], 'read', 120), null);
  assert.equal(core.estimate([trial('2026-10-14', 60, 40), trial('2026-10-13', 60, 30, { usedAI: false })], 'read', 120), null);
  assert.equal(core.estimate([trial('2026-10-14', 60, 40), trial('2026-10-13', 60, 30)], 'other', 120), null);
  const estimate = core.estimate([trial('2026-10-14', 60, 40), trial('2026-10-13', 60, 30), trial('2026-10-13', 60, 5, { category: 'mail' })], 'read', 120);
  assert.equal(estimate.low, 40);
  assert.equal(estimate.high, 60);
  assert.equal(estimate.samples, 2);
});

test('duplicated imports cannot turn one AI attempt into sufficient personal evidence', () => {
  const record = trial('2026-10-14', 60, 40, { taskId: 'paper' });
  assert.equal(core.estimate([record, { ...record }], 'read', 60), null);
});
