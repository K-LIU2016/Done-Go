import assert from 'node:assert/strict';
import { test } from 'node:test';
// Pure-function tests for the AI parse mode helpers (decision D3, frontend
// half). No DOM involved: web/ai-parse.js must stay importable by node.
import { allowedDates, buildParseRequest, diffMerge, PARSE_KINDS, resolveParse, validateAndExtract } from '../../web/ai-parse.js';

const NOW = new Date(2026, 9, 22, 14, 5); // Thursday 2026-10-22 14:05, local time
const TODAY = '2026-10-22';
const RAW = '晚上10点给妈妈打电话';
const ruleItem = (over = {}) => ({ id: 'r1', title: '给妈妈打电话', kind: 'connect', prio: 3, date: TODAY, start: '10:00', end: '11:00', at: true, ...over });
const wrapLLM = (obj, tail = '请查收，祝一切顺利。') =>
  '<think>用户说了时段，需要换算成 24 小时制。</think>整理结果如下：\n```json\n' + JSON.stringify(obj) + '\n```\n' + tail;
const valid = (over = {}) => ({ date: TODAY, start: '22:00', end: '23:00', title: '给妈妈打电话', kind: 'connect', prio: 3, ...over });

test('buildParseRequest produces a donego chat body anchored to now, without rule times', () => {
  const body = buildParseRequest(RAW, ruleItem(), NOW);
  assert.deepEqual(Object.keys(body).sort(), ['mode', 'prompt', 'stream']);
  assert.equal(body.mode, 'parse');
  assert.equal(body.stream, false);
  assert.ok(body.prompt.includes('2026-10-22'));
  assert.ok(body.prompt.includes('星期四'));
  assert.ok(body.prompt.includes('14:05'));
  assert.ok(body.prompt.includes(RAW));
  // The rule engine's times are withheld on purpose: anchoring the model on
  // the (possibly wrong) rule times is exactly what parse mode must fix.
  assert.ok(!body.prompt.includes('10:00'));
  assert.ok(!body.prompt.includes('11:00'));
  assert.ok(body.prompt.length < 60000);
});

test('晚上10点 parses to 22:00 through think tags, fences and prose, and diffMerge flags the rule 10:00', () => {
  const parsed = validateAndExtract(wrapLLM(valid()), RAW, [ruleItem()], NOW);
  assert.deepEqual(parsed, { date: TODAY, start: '22:00', end: '23:00', title: '给妈妈打电话', kind: 'connect', prio: 3 });
  const diff = diffMerge([ruleItem()], parsed);
  assert.equal(diff.fallback, false);
  assert.equal(diff.hasDiff, true);
  const byKey = Object.fromEntries(diff.fields.map((f) => [f.key, f]));
  assert.equal(byKey.start.ruleValue, '10:00');
  assert.equal(byKey.start.aiValue, '22:00');
  assert.equal(byKey.start.differs, true);
  assert.equal(byKey.start.suggestAdopt, true);
  assert.equal(byKey.end.ruleValue, '11:00');
  assert.equal(byKey.end.aiValue, '23:00');
  assert.equal(byKey.end.differs, true);
  assert.equal(byKey.end.suggestAdopt, true);
  assert.equal(byKey.title.differs, false);
  assert.equal(byKey.title.suggestAdopt, false);
  assert.deepEqual(diff.adopt, parsed);
});

test('non-JSON, truncated, scalar and array replies are rejected; diffMerge(rule, null) is a no-fake-success fallback view', () => {
  const badReplies = [
    '',
    '   ',
    '抱歉，我无法整理这句话。',
    '{"date":"2026-10-22","start":',
    'null',
    '42',
    '```json\n[' + JSON.stringify(valid()) + ']\n```',
    '结果是：[' + JSON.stringify(valid()) + ']'
  ];
  for (const bad of badReplies) {
    assert.equal(validateAndExtract(bad, RAW, [ruleItem()], NOW), null, 'should reject: ' + JSON.stringify(String(bad).slice(0, 40)));
  }
  const rule = ruleItem();
  const diff = diffMerge([rule], null);
  assert.equal(diff.fallback, true);
  assert.equal(diff.adopt, null);
  assert.deepEqual(diff.ruleItem, rule);
  assert.ok(diff.fields.every((f) => f.differs === false && f.suggestAdopt === false));
});

test('out-of-range or inverted times are rejected; single-digit hours are canonicalized', () => {
  assert.equal(validateAndExtract(wrapLLM(valid({ start: '25:00' })), RAW, [ruleItem()], NOW), null);
  assert.equal(validateAndExtract(wrapLLM(valid({ start: '9:70' })), RAW, [ruleItem()], NOW), null);
  assert.equal(validateAndExtract(wrapLLM(valid({ start: '24:30' })), RAW, [ruleItem()], NOW), null);
  assert.equal(validateAndExtract(wrapLLM(valid({ start: '22:00', end: '21:00' })), RAW, [ruleItem()], NOW), null);
  const morning = validateAndExtract(
    wrapLLM({ date: '2026-10-23', start: '9:30', end: null, title: '晨跑', kind: 'restore' }),
    '明早9点半晨跑',
    [ruleItem()],
    NOW
  );
  assert.deepEqual(morning, { date: '2026-10-23', start: '09:30', end: '', title: '晨跑', kind: 'restore', prio: 3 });
});

test('dates the user never mentioned are rejected', () => {
  assert.equal(validateAndExtract(wrapLLM(valid({ date: '2026-10-25' })), RAW, [ruleItem()], NOW), null);
  const meeting = { date: '2026-10-23', start: '15:00', end: '16:00', title: '开会', kind: 'necessary' };
  assert.equal(validateAndExtract(wrapLLM({ ...meeting, date: '2026-10-24' }), '明天下午3点开会', [ruleItem()], NOW), null);
  assert.equal(validateAndExtract(wrapLLM(meeting), '明天下午3点开会', [ruleItem()], NOW).date, '2026-10-23');
  const gym = { start: '20:00', end: '21:00', title: '健身', kind: 'restore' };
  assert.equal(validateAndExtract(wrapLLM(valid({ ...gym, date: '2026-10-28' })), '周三晚上8点健身', [ruleItem()], NOW).start, '20:00');
  assert.equal(validateAndExtract(wrapLLM(valid({ ...gym, date: '2026-10-29' })), '周三晚上8点健身', [ruleItem()], NOW), null);
  const checkup = { start: '10:00', end: '11:00', title: '体检', kind: 'necessary' };
  assert.equal(validateAndExtract(wrapLLM(valid({ ...checkup, date: '2026-10-25' })), '10月25日上午10点体检', [ruleItem()], NOW).date, '2026-10-25');
  assert.equal(validateAndExtract(wrapLLM(valid({ ...checkup, date: '2026-10-26' })), '10月25日上午10点体检', [ruleItem()], NOW), null);
  assert.equal(validateAndExtract(wrapLLM(valid({ date: '2026-02-30' })), '10月25日上午10点体检', [ruleItem()], NOW), null);
});

test('明晚 resolves to tomorrow and the diff flags both date and start against the rule result', () => {
  const parsed = validateAndExtract(wrapLLM(valid({ date: '2026-10-23' })), '明晚10点给妈妈打电话', [ruleItem()], NOW);
  assert.equal(parsed.date, '2026-10-23');
  assert.equal(parsed.start, '22:00');
  const diff = diffMerge([ruleItem()], parsed);
  const byKey = Object.fromEntries(diff.fields.map((f) => [f.key, f]));
  assert.equal(byKey.date.ruleValue, TODAY);
  assert.equal(byKey.date.aiValue, '2026-10-23');
  assert.equal(byKey.date.differs, true);
  assert.equal(byKey.date.suggestAdopt, true);
  assert.equal(byKey.start.suggestAdopt, true);
  assert.equal(diff.adopt.date, '2026-10-23');
});

test('fallback semantics: a failed or timed-out parse keeps the untouched rule result', () => {
  const rule = ruleItem();
  const failed = resolveParse('', RAW, [rule], NOW);
  assert.equal(failed.source, 'rule');
  assert.equal(failed.aiParsed, null);
  assert.deepEqual(failed.item, rule); // keeps the rule 10:00 — no fake AI success
  assert.equal(failed.diff.fallback, true);
  const ok = resolveParse(wrapLLM(valid()), RAW, [rule], NOW);
  assert.equal(ok.source, 'ai');
  assert.equal(ok.aiParsed.start, '22:00');
  assert.equal(ok.item.start, '22:00');
});

test('schema strictness: kind enum, prio type and bounds, title trim/cap, unknown fields ignored', () => {
  assert.equal(validateAndExtract(wrapLLM(valid({ kind: 'meeting' })), RAW, [ruleItem()], NOW), null);
  const noKind = { ...valid() };
  delete noKind.kind;
  assert.equal(validateAndExtract(wrapLLM(noKind), RAW, [ruleItem()], NOW), null);
  for (const prio of [0, 6, 2.5, '3']) assert.equal(validateAndExtract(wrapLLM(valid({ prio })), RAW, [ruleItem()], NOW), null, 'prio ' + JSON.stringify(prio));
  const noPrio = validateAndExtract(wrapLLM({ date: TODAY, start: '22:00', end: null, title: '给妈妈打电话', kind: 'connect' }), RAW, [ruleItem()], NOW);
  assert.equal(noPrio.prio, 3);
  const noTitle = { ...valid() };
  delete noTitle.title;
  assert.equal(validateAndExtract(wrapLLM(noTitle), RAW, [ruleItem()], NOW), null);
  assert.equal(validateAndExtract(wrapLLM(valid({ title: '   ' })), RAW, [ruleItem()], NOW), null);
  assert.equal(validateAndExtract(wrapLLM(valid({ title: '啊'.repeat(40) })), RAW, [ruleItem()], NOW).title.length, 30);
  const noTime = validateAndExtract(
    wrapLLM({ date: TODAY, start: null, end: null, title: '给妈妈打电话', kind: 'connect' }),
    '记得给妈妈打电话',
    [ruleItem({ start: '', end: '', at: false })],
    NOW
  );
  assert.deepEqual(noTime, { date: TODAY, start: '', end: '', title: '给妈妈打电话', kind: 'connect', prio: 3 });
  assert.equal(validateAndExtract(wrapLLM(valid({ minutes: 45, extra: true })), RAW, [ruleItem()], NOW).start, '22:00');
  assert.deepEqual(PARSE_KINDS, ['necessary', 'restore', 'create', 'connect', 'explore', 'stillness']);
});

test('allowedDates keeps today plus exactly the mentioned dates', () => {
  assert.deepEqual(allowedDates('', null, NOW), [TODAY]);
  assert.deepEqual(allowedDates('明晚10点', null, NOW), [TODAY, '2026-10-23']);
  assert.deepEqual(allowedDates('后天和大后天都要跑步', null, NOW), [TODAY, '2026-10-24', '2026-10-25']);
  assert.deepEqual(allowedDates('周三晚上8点健身', null, NOW), [TODAY, '2026-10-28']);
  assert.ok(allowedDates('晚上10点', [ruleItem()], NOW).includes(TODAY));
});
