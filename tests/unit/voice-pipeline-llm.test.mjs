import assert from 'node:assert/strict';
import { test } from 'node:test';
import { cleanSegment, structureUtterance, ruleItems } from '../../scripts/voice-pipeline/llm.mjs';

const NOW = '2026-10-26T09:00:00+08:00';
const reply = content => async () => ({ ok: true, json: async () => ({ choices: [{ message: { content } }] }) });
const hang = () => new Promise(() => {});

test('cleanSegment returns the local model text, or falls back to the rule cleanup on timeout/error', async () => {
  const ok = await cleanSegment({ a: '嗯， 那个明天下午呃三点吧， 要跟老师开个组会。', b: '嗯那个明天下午二三点吧要跟老师开个组会' }, { fetch: reply('明天下午三点跟老师开组会。'), timeoutMs: 500 });
  assert.deepEqual(ok, { text: '明天下午三点跟老师开组会。', source: 'local' });
  const slow = await cleanSegment({ a: '嗯， 那个明天下午呃三点吧， 要跟老师开个组会。', b: '' }, { fetch: hang, timeoutMs: 30 });
  assert.equal(slow.source, 'rule');
  assert.equal(slow.text, '明天下午三点吧，要跟老师开个组会。');
});

test('structureUtterance resolves dates from timeText deterministically, never from the model', async () => {
  const model = JSON.stringify({ clean: '明天下午三点跟导师开组会，周五前交课程报告。', items: [
    { title: '跟导师开组会', timeText: '明天下午三点', date: '1999-01-01', priority: 3 },
    { title: '交课程报告', timeText: '周五前', priority: 2, remind: null },
  ] });
  const out = await structureUtterance({ a: 'A 文本', b: 'B 文本' }, { fetch: reply(model), now: NOW, timeoutMs: 500 });
  assert.equal(out.source, 'cloud');
  assert.equal(out.clean, '明天下午三点跟导师开组会，周五前交课程报告。');
  assert.deepEqual(out.items.map(i => [i.title, i.date, i.start, i.deadline, i.priority]), [
    ['跟导师开组会', '2026-10-27', '15:00', null, 3],
    ['交课程报告', null, null, '2026-10-30', 2],
  ]);
});

test('structureUtterance drops empty or filler-only items and clamps priority', async () => {
  const model = JSON.stringify({ clean: '好的。', items: [{ title: '嗯', timeText: null }, { title: '', timeText: '明天' }, { title: '写周报', timeText: '今天', priority: 9 }] });
  const out = await structureUtterance({ a: 'x', b: 'y' }, { fetch: reply(model), now: NOW, timeoutMs: 500 });
  assert.deepEqual(out.items.map(i => [i.title, i.date, i.priority]), [['写周报', '2026-10-26', 3]]);
});

test('structureUtterance falls back to the rule draft when the cloud model times out or returns junk', async () => {
  const slow = await structureUtterance({ a: '明天下午三点开组会', b: '' }, { fetch: hang, now: NOW, timeoutMs: 30 });
  assert.equal(slow.source, 'rule');
  assert.equal(slow.items[0].date, '2026-10-27');
  const junk = await structureUtterance({ a: '明天下午三点开组会', b: '' }, { fetch: reply('不是 JSON'), now: NOW, timeoutMs: 500 });
  assert.equal(junk.source, 'rule');
});

test('ruleItems gives instant cards from cleaned text and skips small talk', () => {
  assert.equal(ruleItems('今天天气挺好的，心情也不错。', NOW).length, 0);
  assert.equal(ruleItems('明天上午十点开会', NOW)[0].start, '10:00');
});
