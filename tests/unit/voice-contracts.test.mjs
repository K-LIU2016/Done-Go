import assert from 'node:assert/strict';
import { test } from 'node:test';
// VI·契约 — web/voice/contracts.js 契约单测（先 RED 后 GREEN，实现后置）。
// 唯一标准 design/voice-intent/SPEC.md：
//   §2.2  WS 协议（start/PCM/stop ↔ partial/final/end/error）与限额错误码
//   §2.3  intent 输入 {transcript,now,tz} 与输出 items/nonEvent schema
//   §2.3-7 优先级五档（1 最优先…5 不急），识别不到一律 3「一般」且 priorityReason 为 null
//   §3    stream-client「按 seg 合并 partial 和 final」、final 该句灰转黑
import {
  VOICE_SAMPLE_RATE,
  CLIENT_MESSAGE_TYPES,
  SERVER_MESSAGE_TYPES,
  VOICE_ERROR_CODES,
  validateClientMessage,
  validateServerMessage,
  DEFAULT_PRIORITY,
  PRIORITIES,
  PRIORITY_LABELS,
  isPriority,
  isDateStr,
  isTimeStr,
  isIsoDateTimeWithOffset,
  isTimeZone,
  ITEM_KINDS,
  validateIntentInput,
  validateIntentItem,
  normalizeIntentItem,
  validateIntentOutput,
  normalizeIntentOutput,
  initTranscriptState,
  applyServerMessage,
  transcriptView,
} from '../../web/voice/contracts.js';

// SPEC §2.3 示例条目（原样照抄）
const SPEC_ITEM = {
  title: '和导师开组会', kind: 'necessary', date: '2026-10-26', start: '15:00', end: '16:00',
  durationMin: 60, deadline: null, timeText: '明天下午三点', vague: false, recurrence: null,
  priority: 1, priorityReason: '你说「必须」，且要赶在组会前', confidence: 0.92, source: '原话片段',
};
const SPEC_INPUT = {
  transcript: '明天下午三点和导师开组会，必须的，还有记得交报告',
  now: '2026-10-25T10:12:00+08:00',
  tz: 'Asia/Shanghai',
};
const err = (r) => {
  assert.equal(r.ok, false);
  assert.equal(typeof r.field, 'string');
  assert.equal(typeof r.message, 'string');
};

test('WS 协议常量与 SPEC §2.2 一致', () => {
  assert.equal(VOICE_SAMPLE_RATE, 16000);
  assert.deepEqual(CLIENT_MESSAGE_TYPES, ['start', 'stop']);
  assert.deepEqual(SERVER_MESSAGE_TYPES, ['partial', 'final', 'end', 'error']);
  assert.deepEqual(ITEM_KINDS, ['necessary', 'create', 'connect', 'explore', 'restore', 'stillness']);
  const codes = Object.values(VOICE_ERROR_CODES);
  assert.ok(codes.includes('asr-unavailable')); // SPEC §2.2 原文命名
  for (const c of ['session-too-long', 'daily-limit', 'busy', 'unauthorized', 'bad-message']) {
    assert.ok(codes.includes(c), `missing error code: ${c}`); // SPEC §2.2 限额/鉴权/协议要求
  }
  assert.equal(new Set(codes).size, codes.length);
  for (const c of codes) assert.match(c, /^[a-z]+(-[a-z]+)*$/);
});

test('validateClientMessage：start 必须带正整数 sampleRate（SPEC 固定 16k）', () => {
  assert.deepEqual(
    validateClientMessage({ type: 'start', sampleRate: 16000 }),
    { ok: true, value: { type: 'start', sampleRate: 16000 } },
  );
  assert.deepEqual(validateClientMessage({ type: 'stop' }), { ok: true, value: { type: 'stop' } });
  err(validateClientMessage({ type: 'start' }));
  err(validateClientMessage({ type: 'start', sampleRate: '16000' }));
  err(validateClientMessage({ type: 'start', sampleRate: 0 }));
  err(validateClientMessage({ type: 'start', sampleRate: 16000.5 }));
  err(validateClientMessage({ type: 'burst' }));
  err(validateClientMessage('stop'));
  err(validateClientMessage(null));
});

test('validateServerMessage：partial/final 带 seg+text，end 无参，error 用枚举码', () => {
  assert.equal(validateServerMessage({ type: 'partial', seg: 0, text: '今天' }).ok, true);
  assert.equal(validateServerMessage({ type: 'final', seg: 3, text: '今天下午3点。' }).ok, true);
  assert.equal(validateServerMessage({ type: 'end' }).ok, true);
  for (const code of Object.values(VOICE_ERROR_CODES)) {
    assert.equal(validateServerMessage({ type: 'error', code }).ok, true, code);
  }
  err(validateServerMessage({ type: 'error', code: 'nope' }));
  err(validateServerMessage({ type: 'partial', seg: -1, text: 'x' }));
  err(validateServerMessage({ type: 'partial', seg: '0', text: 'x' }));
  err(validateServerMessage({ type: 'partial', seg: 0 }));
  err(validateServerMessage({ type: 'final', seg: 0, text: 42 }));
  err(validateServerMessage({ type: 'started' }));
  err(validateServerMessage({}));
  err(validateServerMessage(null));
});

test('优先级枚举：默认 3「一般」，五档标签（SPEC §2.3-7）', () => {
  assert.equal(DEFAULT_PRIORITY, 3);
  assert.deepEqual(PRIORITIES, [1, 2, 3, 4, 5]);
  assert.deepEqual(PRIORITY_LABELS, { 1: '最优先', 2: '优先', 3: '一般', 4: '稍缓', 5: '不急' });
  for (const p of [1, 2, 3, 4, 5]) assert.equal(isPriority(p), true);
  for (const p of [0, 6, 3.5, '3', null, undefined]) assert.equal(isPriority(p), false);
});

test('日期/时间/时区格式守卫', () => {
  assert.equal(isDateStr('2026-10-26'), true);
  assert.equal(isDateStr('2024-02-29'), true);
  assert.equal(isDateStr('2026-02-29'), false); // 2026 非闰年
  assert.equal(isDateStr('2026-10-32'), false);
  assert.equal(isDateStr('2026-1-1'), false);
  assert.equal(isDateStr(20261026), false);
  assert.equal(isTimeStr('00:00'), true);
  assert.equal(isTimeStr('23:59'), true);
  assert.equal(isTimeStr('15:30'), true);
  for (const t of ['24:00', '9:30', '15:5', '15:60', '15:00:00', 15]) assert.equal(isTimeStr(t), false);
  assert.equal(isIsoDateTimeWithOffset('2026-10-25T10:12:00+08:00'), true);
  assert.equal(isIsoDateTimeWithOffset('2026-10-25T10:12:00.481Z'), true);
  assert.equal(isIsoDateTimeWithOffset('2026-10-25T10:12:00'), false); // 必须带时区偏移
  assert.equal(isIsoDateTimeWithOffset('2026-10-25'), false);
  assert.equal(isIsoDateTimeWithOffset('2026-13-01T10:12:00+08:00'), false);
  assert.equal(isTimeZone('Asia/Shanghai'), true);
  assert.equal(isTimeZone('UTC'), true);
  assert.equal(isTimeZone('Mars/Olympus'), false);
  assert.equal(isTimeZone(''), false);
  assert.equal(isTimeZone(42), false);
});

test('validateIntentInput：SPEC §2.3 输入 {transcript, now, tz}（可选 edit）', () => {
  const r = validateIntentInput(SPEC_INPUT);
  assert.equal(r.ok, true);
  assert.deepEqual(r.value, { transcript: SPEC_INPUT.transcript, now: SPEC_INPUT.now, tz: 'Asia/Shanghai', edit: null });
  err(validateIntentInput({ ...SPEC_INPUT, transcript: '   ' }));
  err(validateIntentInput({ ...SPEC_INPUT, transcript: '' }));
  err(validateIntentInput({ now: SPEC_INPUT.now, tz: 'Asia/Shanghai' }));
  err(validateIntentInput({ ...SPEC_INPUT, now: '2026-10-25T10:12:00' }));
  err(validateIntentInput({ ...SPEC_INPUT, tz: 'Mars/Olympus' }));
  assert.equal(validateIntentInput({ ...SPEC_INPUT, edit: [SPEC_ITEM] }).ok, true);
  err(validateIntentInput({ ...SPEC_INPUT, edit: 'all' }));
  err(validateIntentInput({ ...SPEC_INPUT, edit: [{ ...SPEC_ITEM, kind: 'x' }] }));
});

test('validateIntentItem：SPEC §2.3 输出条目 schema（严格，无默认值）', () => {
  const r = validateIntentItem(SPEC_ITEM);
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.value.title, '和导师开组会');
  assert.equal(r.value.priority, 1);
  err(validateIntentItem({ ...SPEC_ITEM, title: '' }));
  err(validateIntentItem({ ...SPEC_ITEM, title: '字'.repeat(21) }));
  assert.equal(validateIntentItem({ ...SPEC_ITEM, title: '字'.repeat(20) }).ok, true);
  err(validateIntentItem({ ...SPEC_ITEM, kind: 'meeting' }));
  err(validateIntentItem({ ...SPEC_ITEM, kind: undefined }));
  for (const [field, bad] of [
    ['date', '2026-02-30'], ['date', '明天'], ['date', 20261026],
    ['start', '25:00'], ['end', '4点'],
    ['durationMin', 0], ['durationMin', -30], ['durationMin', 1.5], ['durationMin', '60'],
    ['vague', 'false'], ['recurrence', ''], ['timeText', ''],
    ['confidence', 1.2], ['confidence', -0.01], ['confidence', '0.92'],
    ['source', 5], ['deadline', '周五'],
  ]) {
    err(validateIntentItem({ ...SPEC_ITEM, [field]: bad }));
  }
  assert.equal(validateIntentItem({ ...SPEC_ITEM, confidence: 0 }).ok, true);
  assert.equal(validateIntentItem({ ...SPEC_ITEM, confidence: 1 }).ok, true);
  // 严格模式下必填：priority / vague
  const noPrio = { ...SPEC_ITEM };
  delete noPrio.priority;
  err(validateIntentItem(noPrio));
  const noVague = { ...SPEC_ITEM };
  delete noVague.vague;
  err(validateIntentItem(noVague));
  // 可空字段缺 key 等价于 null
  const partial = { ...SPEC_ITEM };
  for (const k of ['timeText', 'recurrence', 'source', 'deadline']) delete partial[k];
  assert.equal(validateIntentItem(partial).ok, true);
});

test('优先级依据不变量：priorityReason 为 null ⇒ priority 必为 3（SPEC §2.3-7）', () => {
  err(validateIntentItem({ ...SPEC_ITEM, priority: 2, priorityReason: null }));
  assert.equal(validateIntentItem({ ...SPEC_ITEM, priority: 3, priorityReason: null }).ok, true);
  assert.equal(validateIntentItem({ ...SPEC_ITEM, priority: 1, priorityReason: '紧急' }).ok, true);
  // normalize 把空依据归一成 null 后，2 档无依据依然要拒绝
  err(normalizeIntentItem({ ...SPEC_ITEM, priority: 2, priorityReason: '' }));
});

test('normalizeIntentItem：缺省优先级即 3「一般」（JC 产品要求），canonical 输出', () => {
  const r = normalizeIntentItem({ title: ' 交报告 ', kind: 'create', date: '2026-10-26', confidence: 0.5 });
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.deepEqual(r.value, {
    title: '交报告', kind: 'create', date: '2026-10-26', start: null, end: null,
    durationMin: null, deadline: null, timeText: null, vague: false, recurrence: null,
    priority: 3, priorityReason: null, confidence: 0.5, source: null,
  });
  assert.equal(normalizeIntentItem({ ...SPEC_ITEM, priority: null }).value.priority, 3);
  assert.equal(normalizeIntentItem({ ...SPEC_ITEM, vague: undefined }).value.vague, false);
  // 核心字段仍然必须：title / kind / confidence
  err(normalizeIntentItem({ kind: 'create', confidence: 0.5 }));
  err(normalizeIntentItem({ title: '交报告', confidence: 0.5 }));
  err(normalizeIntentItem({ title: '交报告', kind: 'create' }));
});

test('intent 输出：items 与 nonEvent 二选一（SPEC §2.3）', () => {
  assert.equal(validateIntentOutput({ items: [SPEC_ITEM], nonEvent: null }).ok, true);
  const ne = validateIntentOutput({ items: [], nonEvent: { suggest: 'relay', reason: '整句是提问，不是日程' } });
  assert.equal(ne.ok, true);
  assert.deepEqual(ne.value.nonEvent, { suggest: 'relay', reason: '整句是提问，不是日程' });
  err(validateIntentOutput({ items: [SPEC_ITEM], nonEvent: { suggest: 'relay', reason: 'x' } })); // 并存
  err(validateIntentOutput({ items: [], nonEvent: null })); // 双空
  err(validateIntentOutput({ nonEvent: null })); // 严格模式 items 必填
  const bad = validateIntentOutput({ items: [{ ...SPEC_ITEM, kind: 'x' }], nonEvent: null });
  err(bad);
  assert.match(bad.field, /^items\[0\]/);
  err(validateIntentOutput({ items: [], nonEvent: { suggest: '', reason: 'x' } }));
  // 严格模式要求 nonEvent 键存在；normalize 补 null
  err(validateIntentOutput({ items: [SPEC_ITEM] }));
  assert.equal(normalizeIntentOutput({ items: [SPEC_ITEM] }).value.nonEvent, null);
  const n = normalizeIntentOutput({ items: [{ title: '交报告', kind: 'create', date: '2026-10-30', confidence: 0.6 }], nonEvent: null });
  assert.equal(n.ok, true, JSON.stringify(n));
  assert.equal(n.value.items[0].priority, 3); // 缺省优先级兜底
  err(normalizeIntentOutput('nope'));
  err(normalizeIntentOutput(null));
});

test('seg 合并语义：partial 同句替换、final 灰转黑、定稿不被回退（SPEC §2/§3）', () => {
  const s0 = initTranscriptState();
  assert.deepEqual(s0, { segments: [], done: false, error: null });
  const s1 = applyServerMessage(s0, { type: 'partial', seg: 0, text: '今天下午三点' });
  assert.deepEqual(transcriptView(s1), { finalText: '', partialText: '今天下午三点' });
  const s2 = applyServerMessage(s1, { type: 'partial', seg: 0, text: '今天下午3点' });
  assert.deepEqual(transcriptView(s2), { finalText: '', partialText: '今天下午3点' }); // 同句 partial 替换，不叠加
  const s3 = applyServerMessage(s2, { type: 'final', seg: 0, text: '今天下午3点。' });
  assert.deepEqual(transcriptView(s3), { finalText: '今天下午3点。', partialText: '' }); // 该句灰转黑
  const s4 = applyServerMessage(s3, { type: 'partial', seg: 1, text: '和导师开组会' });
  assert.deepEqual(transcriptView(s4), { finalText: '今天下午3点。', partialText: '和导师开组会' }); // 已确认前缀稳定
  // 迟到的同句 partial 不得把定稿改回灰字
  const s5 = applyServerMessage(s4, { type: 'partial', seg: 0, text: '迟到的灰字' });
  assert.deepEqual(s5, s4);
  // final 幂等：重复定稿同句 = 原地替换，不新增片段
  const s6 = applyServerMessage(s5, { type: 'final', seg: 0, text: '今天下午3点。' });
  assert.equal(s6.segments.length, 2);
  // 乱序到达按 seg 排序，已确认前缀不乱
  const t0 = applyServerMessage(s0, { type: 'final', seg: 2, text: 'C。' });
  const t1 = applyServerMessage(t0, { type: 'partial', seg: 1, text: 'B' });
  assert.deepEqual(t1.segments.map((x) => x.seg), [1, 2]);
  assert.deepEqual(transcriptView(t1), { finalText: 'C。', partialText: 'B' });
  // 纯函数：旧状态不被修改
  assert.equal(s3.segments.length, 1);
  assert.equal(s3.segments[0].final, true);
  // end / error
  assert.equal(applyServerMessage(s0, { type: 'end' }).done, true);
  assert.equal(applyServerMessage(s0, { type: 'error', code: VOICE_ERROR_CODES.ASR_UNAVAILABLE }).error, 'asr-unavailable');
  // 非法消息直接抛错（网关层应先 validate 再进 reducer）
  assert.throws(() => applyServerMessage(s0, { type: 'partial', seg: 0 }), /server message/i);
  assert.throws(() => applyServerMessage(s0, { type: 'nope' }), /server message/i);
});
