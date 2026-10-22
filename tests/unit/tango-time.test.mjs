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
const trial = (date, before, after, extra = {}) => ({ taskId: date + ':' + before + ':' + after, date, before, after, quality: 'accepted', confirmed: true, usedAI: true, category: 'read', dataMode: 'real', ...extra });

test('simple completion permits missing time without inventing a duration or validated savings', () => {
  const task = { id: 'simple', date: '2026-10-21', ...entry('09:00', '10:00') };
  const result = core.recordCompletion(task, '', false, '');
  assert.equal(result.entry.done, true);
  assert.equal(result.entry.end, '10:00');
  assert.equal(result.entry.completion.actual, null);
  assert.equal(result.entry.completion.timeRecorded, false);
  assert.equal(result.entry.completion.quality, 'pending');
  assert.equal(result.trial, null);
  assert.equal(result.entry.freed, undefined);
  assert.equal(core.completionSummary([result.entry]).minutes, 0);
  assert.equal(core.completionSummary([result.entry]).unrecorded, 1);
});

test('simple completion records a chosen model as self-report and edits without resetting hidden historical fields', () => {
  const task = { id: 'simple', date: '2026-10-21', ...entry('09:00', '10:00') };
  const result = core.recordCompletion(task, '25', true, 'gpt-6.1-sol');
  assert.equal(result.entry.completion.modelName, 'gpt-6.1-sol');
  assert.equal(result.trial.modelName, 'gpt-6.1-sol');
  assert.equal(result.trial.quality, 'pending');
  assert.equal(core.recordedDurations([result.trial]).samples, 0);
  assert.equal(core.completionSummary([result.entry]).minutes, 25);
  const legacy = { ...result.entry, completion: { ...result.entry.completion, helpful: 'unclear', recording: 3 } };
  const updated = core.recordCompletion(legacy, '30', false, 'do-not-keep-hidden-model');
  assert.equal(updated.entry.completion.helpful, 'unclear');
  assert.equal(updated.entry.completion.recording, 3);
  assert.equal(updated.entry.completion.modelName, '');
  for (const value of ['-1', '1441', '1.5', 'invalid']) assert.equal(core.recordCompletion(task, value, false, ''), null);
});

test('editing an old zero-duration completion keeps a valid planned interval and clears only unused derived time', () => {
  const task = { id: 'zero', date: '2026-10-21', ...entry('09:00', '09:00'), done: true, completion: { before: 60, actual: 0, plannedEnd: '10:00', quality: 'accepted' }, freed: { pending: true, minutes: 60, start: '09:00', end: '10:00' } };
  const result = core.recordCompletion(task, '25', false, '');
  assert.equal(result.entry.end, '10:00');
  assert.equal(result.entry.freed, undefined);
  const kept = core.recordCompletion({ ...task, freed: { ...task.freed, pending: false } }, '25', false, '');
  assert.equal(kept.entry.freed.pending, false);
});

test('overlapping tasks and personal intervals occupy each minute once', () => {
  assert.equal(core.occupiedMinutes([entry('09:00', '11:00'), entry('10:00', '12:00'), entry('11:30', '12:30', { kind: 'stillness' })]), 210);
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
test('review totals retain overruns and respect the selected date interval', () => {
  assert.equal(core.confirmedSavings([trial('2026-10-01', 60, 20), trial('2026-10-14', 60, 40), trial('2026-10-14', 30, 50), trial('2026-10-14', 60, -10), trial('2026-10-14', 60, NaN)], '2026-10-08', '2026-10-14'), 0);
});
test('a completed task releases the unused tail of its planned interval', () => {
  const result = core.completeTask({ id: 'paper', date: '2026-10-14', ...entry('09:00', '10:00') }, '40', true, 'read', { quality: 'accepted' });
  assert.equal(result.entry.end, '09:40');
  assert.equal(result.entry.done, true);
  assert.equal(result.trial.before, 60);
  assert.equal(result.trial.after, 40);
  assert.equal(result.trial.taskId, 'paper');
  assert.equal(result.freed.minutes, 20);
  assert.equal(result.freed.start, '09:40');
  assert.equal(result.freed.end, '10:00');
});

test('legacy, pending and rework results cannot count as accepted gains or personal evidence', () => {
  const records = ['pending', 'rework', undefined].map((quality, i) => trial('2026-10-14', 60, 10, { quality, taskId: 'p' + i }));
  assert.equal(core.confirmedSavings(records), 0);
  assert.equal(core.estimate(records, 'read', 60, 'real'), null);
  assert.equal(core.recordedDurations(records).samples, 0);
  assert.equal(core.recordedDurations(records).pending, 3);
});

test('personal intervals preserve negative and mixed outcomes', () => {
  const estimate = core.estimate([trial('2026-10-13', 60, 90), trial('2026-10-14', 60, 40)], 'read', 120, 'real');
  assert.equal(estimate.low, -60);
  assert.equal(estimate.high, 40);
});

test('preparation, checking and rework add to execution time exactly once', () => {
  const item = { id: 'p', date: '2026-10-14', ...entry('09:00', '10:00') };
  const result = core.completeTask(item, '30', true, 'read', { quality: 'accepted', preparation: '5', checking: '10', rework: '20' });
  assert.equal(result.trial.after, 65);
  assert.equal(result.entry.completion.actual, 65);
  assert.equal(result.freed, null);
  assert.equal(core.confirmedSavings([result.trial]), -5);
  for (const options of [{ quality: 'unknown' }, { quality: 'accepted', checking: '-1' }, { quality: 'accepted', rework: '1440' }]) {
    assert.equal(core.completeTask(item, '30', true, 'read', options), null);
  }
});

test('recording time requires later acceptance before offering freed time', () => {
  const result = core.completeTask({ id: 'p', date: '2026-10-14', ...entry('09:00', '10:00') }, '40', true, 'read');
  assert.equal(result.trial.quality, 'pending');
  assert.equal(result.freed, null);
  const accepted = core.reviseCompletion(result.entry, '40', true, 'read', { quality: 'accepted', checking: '5' });
  assert.equal(accepted.trial.after, 45);
  assert.equal(accepted.trial.before, 60);
  assert.equal(accepted.freed.minutes, 15);
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
  assert.equal(core.estimate([trial('2026-10-14', 60, 40)], 'read', 120, 'real'), null);
  assert.equal(core.estimate([trial('2026-10-14', 60, 40), trial('2026-10-13', 60, 30, { usedAI: false })], 'read', 120, 'real'), null);
  assert.equal(core.estimate([trial('2026-10-14', 60, 40), trial('2026-10-13', 60, 30)], 'other', 120, 'real'), null);
  const estimate = core.estimate([trial('2026-10-14', 60, 40), trial('2026-10-13', 60, 30), trial('2026-10-13', 60, 5, { category: 'mail' })], 'read', 120, 'real');
  assert.equal(estimate.low, 40);
  assert.equal(estimate.high, 60);
  assert.equal(estimate.samples, 2);
});

test('duplicated imports cannot turn one AI attempt into sufficient personal evidence', () => {
  const record = trial('2026-10-14', 60, 40, { taskId: 'paper' });
  assert.equal(core.estimate([record, { ...record }], 'read', 60, 'real'), null);
});

test('real and demo history stay isolated, deduplicate attempts, and preserve negative differences', () => {
  const real = trial('2026-10-14', 60, 90, { taskId: 'real-a' });
  const demo = trial('2026-10-13', 60, 30, { taskId: 'demo-a', dataMode: 'demo' });
  const demoSecond = trial('2026-10-12', 60, 50, { taskId: 'demo-b', dataMode: 'demo' });
  assert.equal(core.estimate([real, demo], 'read', 60, 'real'), null, 'one real record cannot be supplemented with a demo record');
  assert.equal(core.estimate([real, demo, demoSecond], 'read', 60, 'real'), null, 'demo records cannot enter a real estimate');
  const estimate = core.estimate([real, demo, demoSecond, { ...demoSecond }], 'read', 60, 'demo');
  assert.deepEqual({ low: estimate.low, high: estimate.high, samples: estimate.samples }, { low: 10, high: 30, samples: 2 });
  const negative = core.estimate([real, trial('2026-10-11', 60, 30, { taskId: 'real-b' })], 'read', 60, 'real');
  assert.deepEqual({ low: negative.low, high: negative.high }, { low: -30, high: 30 });
});

test('estimates require an explicit supported mode and reject legacy records without a matching mode', () => {
  const real = trial('2026-10-14', 60, 40, { taskId: 'real-a' });
  const realSecond = trial('2026-10-13', 60, 30, { taskId: 'real-b' });
  assert.equal(core.estimate([real, realSecond], 'read', 60), null, 'missing mode is not inferred');
  assert.equal(core.estimate([real, realSecond], 'read', 60, 'mixed'), null, 'unknown mode is rejected');
  assert.equal(core.estimate([{ ...real, dataMode: undefined }, { ...realSecond, dataMode: undefined }], 'read', 60, 'real'), null, 'legacy records without provenance cannot count');
});

test('review subtracts all actual durations from plans including overruns once per task', () => {
  const early = trial('2026-10-14', 60, 40, { taskId: 'early' });
  const late = trial('2026-10-14', 60, 90, { taskId: 'late', usedAI: false });
  const result = core.recordedDurations([
    early, { ...early }, late, trial('2026-10-01', 60, 10),
    trial('2026-10-14', 60, -10), trial('2026-10-14', 60, 10, { confirmed: false }),
  ], '2026-10-08', '2026-10-14');
  assert.equal(result.before, 120);
  assert.equal(result.after, 130);
  assert.equal(result.difference, -10);
  assert.equal(result.samples, 2);
});

test('self-reported helpfulness stays separate from the acceptance record', () => {
  const task = { id: 'paper', date: '2026-10-14', ...entry('09:00', '10:00') };
  const withAI = core.completeTask(task, '30', true, 'read', { quality: 'accepted', helpful: 'helpful' });
  assert.equal(withAI.trial.helpful, 'helpful');
  assert.equal(withAI.entry.completion.helpful, 'helpful');
  assert.equal(withAI.trial.quality, 'accepted');
  const withoutAI = core.completeTask(task, '30', false, 'read', { quality: 'accepted', helpful: 'helpful' });
  assert.equal(withoutAI.trial.helpful, null, 'no AI use means no helpfulness question');
  const invalid = core.completeTask(task, '30', true, 'read', { quality: 'pending', helpful: 'amazing' });
  assert.equal(invalid.trial.helpful, null);
});
