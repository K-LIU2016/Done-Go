import assert from 'node:assert/strict';
import { test } from 'node:test';
// VI·V4意图视图 — web/voice/intent-view.js 单测（先 RED 后 GREEN，实现后置）。
// 唯一标准 design/voice-intent/SPEC.md：
//   §2.3  intent 输出 schema / 规则先行→LLM 精修→「有差异的字段闪一下高亮」/ 纠正带 edit
//   §2.3-7 优先级五档，无依据=3 一般且 priorityReason=null
//   §2.3-8 不确定字段 null → 前端标黄「没说具体几点」，宁缺勿编
//   §3    intent-view.js：② 理解中（转写锁定、高亮时间/优先级线索词、骨架卡）
//         → ③ 事件卡（标题、类别、时间 chip、优先级 chip、依据、模糊黄 chip）；
//         点卡片可编辑标题、日期时间、优先级；全部加入/再说一次/口头纠正
// 纯逻辑（阶段状态机、线索词高亮、可编辑字段合并、chip 文案）在无 DOM 的 Node 里可测。
import {
  INTENT_PHASES,
  EDITABLE_FIELDS,
  COMPARE_FIELDS,
  TIME_CUES,
  PRIORITY_CUES,
  KIND_LABELS,
  createIntentState,
  beginUnderstanding,
  showDraft,
  applyRefine,
  editItem,
  confirmAll,
  reaskIntent,
  finalItems,
  countLine,
  highlightCues,
  formatTimeChip,
  kindLabel,
} from '../../web/voice/intent-view.js';
import { DEFAULT_PRIORITY, PRIORITY_LABELS } from '../../web/voice/contracts.js';

const NOW = '2026-10-25T10:12:00+08:00'; // 周日（SPEC §2.3 输入示例）
const TZ = 'Asia/Shanghai';
const CTX = { now: NOW, tz: TZ };

// 原型 ③ 屏的 4 件事（SPEC §2.3 schema 字段齐全，值按原型语义）
const baseItem = (over) => ({
  title: '和导师开组会', kind: 'necessary', date: '2026-10-26', start: '15:00', end: '16:00',
  durationMin: 60, deadline: null, timeText: '明天下午三点', vague: false, recurrence: null,
  priority: 1, priorityReason: '你说「必须」，且要赶在组会前', confidence: 0.92, source: '原话片段',
  ...over,
});
const FOUR_ITEMS = [
  baseItem({ title: '整理实验数据', date: null, start: null, end: null, durationMin: null, deadline: '2026-10-26', timeText: '明天下午三点', priority: 1, priorityReason: '你说「必须」，且要赶在组会前' }),
  baseItem({ title: '和导师开组会', priority: 2, priorityReason: '和导师有约，时间已定', confidence: 0.9 }),
  baseItem({ title: '交课程报告', kind: 'create', date: null, start: null, end: null, durationMin: null, deadline: '2026-10-30', timeText: '周五前', priority: 2, priorityReason: '有明确截止日', confidence: 0.88 }),
  baseItem({ title: '跑步', kind: 'restore', date: '2026-10-25', start: null, end: null, durationMin: null, deadline: null, timeText: '晚上', vague: true, priority: 5, priorityReason: '你说「有空的话」', confidence: 0.7 }),
];

// —— ② 理解中：线索词高亮（SPEC §3：高亮时间和优先级线索词）——
test('highlightCues：SPEC 原型句标出 时间「明天下午三点」「周五前」与 优先级「必须」「有空的话」', () => {
  const text = '明天下午三点要跟导师开组会，必须把实验数据先整理好。还有周五前交课程报告，晚上有空的话去跑个步。';
  const marks = highlightCues(text).filter((s) => s.cue).map((s) => s.cue);
  const words = highlightCues(text).filter((s) => s.cue).map((s) => s.text);
  assert.deepEqual(words, ['明天下午三点', '必须', '周五前', '有空的话']);
  assert.deepEqual(marks, ['time', 'priority', 'time', 'priority']);
});

test('highlightCues：日期词族（今天/明天/后天/大后天/这周五/下周三/周末/月底/下个月/每周一）', () => {
  for (const w of ['今天', '明天', '后天', '大后天', '这周五', '下周三', '周末', '月底', '下个月', '每周一', '周五']) {
    const got = highlightCues(`我们${w}再说`).filter((s) => s.cue).map((s) => s.text);
    assert.deepEqual(got, [w], `${w} 应被识别为时间线索`);
  }
});

test('highlightCues：时刻与时段词族（下午三点半/15:30/三点/中午/傍晚/晚上/上午/凌晨）', () => {
  for (const w of ['下午三点半', '15:30', '三点', '中午', '傍晚', '晚上', '上午', '凌晨', '一个半小时', '半小时后', '十分钟前']) {
    const got = highlightCues(`那就${w}出发`).filter((s) => s.cue).map((s) => s.text);
    assert.deepEqual(got, [w], `${w} 应被识别为时间线索`);
  }
});

test('highlightCues：优先级线索词族（SPEC §2.3-7 显式五档）', () => {
  const families = [
    ['必须', '务必', '紧急', '最重要'],
    ['比较重要', '优先', '尽快'],
    ['晚点', '不着急'],
    ['有空再说', '随便', '可以的话', '有空的话'],
  ];
  for (const fam of families) {
    for (const w of fam) {
      const got = highlightCues(`这件事${w}做`).filter((s) => s.cue).map((s) => s.text);
      assert.deepEqual(got, [w], `${w} 应被识别为优先级线索`);
    }
  }
});

test('highlightCues：无线索的句子返回单一普通段，标记按原文顺序且不重叠', () => {
  const segs = highlightCues('你好呀，随便聊聊');
  // 「随便」是优先级线索（有空再说、随便 → 5 档），所以只剩它
  assert.deepEqual(segs.map((s) => s.text).join(''), '你好呀，随便聊聊');
  let cursor = 0;
  for (const s of segs) {
    const at = '你好呀，随便聊聊'.indexOf(s.text, cursor);
    assert.ok(at >= cursor, '顺序错误');
    cursor = at + s.text.length;
  }
  assert.deepEqual(highlightCues('今天天气不错')[0].cue, 'time');
  assert.deepEqual(highlightCues('嗯那个就是然后'), [{ text: '嗯那个就是然后', cue: null }]);
});

test('PRIORITY_CUES / TIME_CUES 是只读线索表（含原型用词）', () => {
  for (const w of ['必须', '有空的话', '可以的话']) assert.ok(PRIORITY_CUES.includes(w), w);
  for (const w of ['今天', '明天', '晚上', '中午']) assert.ok(TIME_CUES.includes(w), w);
});

// —— 阶段状态机（② 理解中 → ③ 事件卡 → 完成）——
test('createIntentState：初始 idle，阶段枚举定稿', () => {
  assert.equal(createIntentState().phase, 'idle');
  assert.deepEqual([...INTENT_PHASES], ['idle', 'understanding', 'events', 'nonEvent', 'error', 'done']);
});

test('beginUnderstanding：锁定转写 + 记录 now/tz 上下文', () => {
  const r = beginUnderstanding(createIntentState(), { transcript: '明天三点开会', now: NOW, tz: TZ });
  assert.ok(r.ok);
  assert.equal(r.state.phase, 'understanding');
  assert.equal(r.state.transcript, '明天三点开会');
  assert.equal(r.state.context.now, NOW);
  assert.equal(r.state.context.tz, TZ);
  assert.ok(r.state.marks.some((s) => s.cue === 'time'));
});

test('beginUnderstanding：非法输入被拒（空转写/缺时区 now/坏 tz），state 不变', () => {
  for (const bad of [{ transcript: '  ', now: NOW, tz: TZ }, { transcript: 'x', now: '2026-10-25T10:12:00', tz: TZ }, { transcript: 'x', now: NOW, tz: 'Not/AZone' }]) {
    const r = beginUnderstanding(createIntentState(), bad);
    assert.equal(r.ok, false, JSON.stringify(bad));
    assert.ok(r.field);
  }
  const s = beginUnderstanding(createIntentState(), { transcript: 'x', now: NOW, tz: TZ }).state;
  const before = JSON.stringify(s);
  beginUnderstanding(s, { transcript: '', now: NOW, tz: TZ });
  assert.equal(JSON.stringify(s), before, '纯函数不得改写入参');
});

test('showDraft：理解中 → 事件卡（规则草稿，provenance=rule）', () => {
  const s = beginUnderstanding(createIntentState(), { transcript: '明天三点开会', now: NOW, tz: TZ }).state;
  const r = showDraft(s, { items: FOUR_ITEMS });
  assert.ok(r.ok);
  assert.equal(r.state.phase, 'events');
  assert.equal(r.state.provenance, 'rule');
  assert.equal(r.state.items.length, 4);
  assert.equal(r.state.items[3].title, '跑步');
});

test('showDraft：nonEvent 草稿 → 非日程阶段', () => {
  const s = beginUnderstanding(createIntentState(), { transcript: '今天天气怎么样', now: NOW, tz: TZ }).state;
  const r = showDraft(s, { nonEvent: { suggest: 'relay', reason: '像一句闲聊' } });
  assert.ok(r.ok);
  assert.equal(r.state.phase, 'nonEvent');
  assert.equal(r.state.nonEvent.suggest, 'relay');
});

test('showDraft：schema 不合法的草稿被拒（priority=1 却无依据）', () => {
  const s = beginUnderstanding(createIntentState(), { transcript: 'x', now: NOW, tz: TZ }).state;
  const bad = [FOUR_ITEMS[1], { ...FOUR_ITEMS[2], priority: 1, priorityReason: null }];
  const r = showDraft(s, { items: bad });
  assert.equal(r.ok, false);
  assert.equal(r.state.phase, 'understanding');
});

test('showDraft：LLM 精修已到（events）后迟到的草稿要被忽略（stale）', () => {
  const s0 = beginUnderstanding(createIntentState(), { transcript: 'x', now: NOW, tz: TZ }).state;
  const refined = applyRefine(s0, { items: FOUR_ITEMS }).state; // 无草稿直接精修（超时兜底路径）
  const r = showDraft(refined, { items: FOUR_ITEMS.slice(0, 2) });
  assert.equal(r.ok, false);
  assert.equal(r.state, refined); // 原样返回
});

// —— LLM 精修合并（SPEC §2.3：逐字段替换，有差异的字段闪一下高亮）——
test('applyRefine：替换字段并报告可视差异（changed 用于闪光）', () => {
  const s0 = showDraft(
    beginUnderstanding(createIntentState(), { transcript: 'x', now: NOW, tz: TZ }).state,
    { items: FOUR_ITEMS },
  ).state;
  const llm = FOUR_ITEMS.map((it, i) => (i === 1 ? { ...it, start: '16:00', end: '17:00', confidence: 0.95 } : it));
  const r = applyRefine(s0, { items: llm });
  assert.ok(r.ok);
  assert.equal(r.state.provenance, 'llm');
  assert.equal(r.state.items[1].start, '16:00');
  assert.deepEqual(r.changed, [{ index: 1, fields: ['start', 'end'] }]); // confidence 不在可视比较字段里
});

test('applyRefine：用户已编辑（dirty）的字段不被精修覆盖，也不闪光', () => {
  const s0 = showDraft(
    beginUnderstanding(createIntentState(), { transcript: 'x', now: NOW, tz: TZ }).state,
    { items: FOUR_ITEMS },
  ).state;
  const edited = editItem(s0, 1, { title: '导师组会' }).state;
  assert.equal(edited.items[1].title, '导师组会');
  const llm = FOUR_ITEMS.map((it, i) => (i === 1 ? { ...it, title: '和导师开组会', priority: 1 } : it));
  const r = applyRefine(edited, { items: llm });
  assert.ok(r.ok);
  assert.equal(r.state.items[1].title, '导师组会'); // 用户编辑胜出
  assert.equal(r.state.items[1].priority, 1); // 未编辑字段照常精修
  const c1 = r.changed.find((c) => c.index === 1);
  assert.deepEqual(c1.fields, ['priority']); // title 不闪
});

test('applyRefine：mode=correct（口头纠正返回）时 dirty 让位，全部按纠正结果替换', () => {
  const s0 = showDraft(
    beginUnderstanding(createIntentState(), { transcript: 'x', now: NOW, tz: TZ }).state,
    { items: FOUR_ITEMS },
  ).state;
  const edited = editItem(s0, 3, { title: '夜跑' }).state;
  const corr = FOUR_ITEMS.map((it, i) => (i === 3 ? { ...it, title: '晨跑', start: '08:00' } : it));
  const r = applyRefine(edited, { items: corr }, { mode: 'correct' });
  assert.ok(r.ok);
  assert.equal(r.state.items[3].title, '晨跑'); // 纠正结果覆盖手动编辑
  assert.equal(r.state.items[3].start, '08:00');
  assert.deepEqual(r.state.dirty[3], []); // dirty 清空
  const c3 = r.changed.find((c) => c.index === 3);
  assert.ok(c3.fields.includes('title') && c3.fields.includes('start'));
});

test('applyRefine：理解中阶段直接精修（规则草稿超时未到）也允许', () => {
  const s0 = beginUnderstanding(createIntentState(), { transcript: 'x', now: NOW, tz: TZ }).state;
  const r = applyRefine(s0, { items: FOUR_ITEMS });
  assert.ok(r.ok);
  assert.equal(r.state.phase, 'events');
  assert.equal(r.state.provenance, 'llm');
});

test('applyRefine：nonEvent 输出 → 非日程阶段', () => {
  const s0 = showDraft(
    beginUnderstanding(createIntentState(), { transcript: 'x', now: NOW, tz: TZ }).state,
    { items: FOUR_ITEMS },
  ).state;
  const r = applyRefine(s0, { nonEvent: { suggest: 'relay', reason: '是提问不是日程' } });
  assert.ok(r.ok);
  assert.equal(r.state.phase, 'nonEvent');
});

test('applyRefine：非法输出被拒且 state 原样返回', () => {
  const s0 = showDraft(
    beginUnderstanding(createIntentState(), { transcript: 'x', now: NOW, tz: TZ }).state,
    { items: FOUR_ITEMS },
  ).state;
  const bad = { items: [{ ...FOUR_ITEMS[0], title: '' }] };
  const r = applyRefine(s0, bad);
  assert.equal(r.ok, false);
  assert.equal(r.state, s0);
});

// —— 可编辑字段（SPEC §3：点卡片可编辑标题、日期时间、优先级）——
test('EDITABLE_FIELDS 恰为 标题/日期时间/优先级；COMPARE_FIELDS 不含 confidence/source', () => {
  assert.deepEqual([...EDITABLE_FIELDS], ['title', 'date', 'start', 'end', 'deadline', 'priority']);
  assert.equal(COMPARE_FIELDS.includes('confidence'), false);
  assert.equal(COMPARE_FIELDS.includes('source'), false);
  assert.ok(COMPARE_FIELDS.includes('priority') && COMPARE_FIELDS.includes('title') && COMPARE_FIELDS.includes('vague'));
});

test('editItem：合法修改生效并标记 dirty', () => {
  const s0 = showDraft(
    beginUnderstanding(createIntentState(), { transcript: 'x', now: NOW, tz: TZ }).state,
    { items: FOUR_ITEMS },
  ).state;
  const r = editItem(s0, 2, { date: '2026-10-29', start: '20:00' });
  assert.ok(r.ok);
  assert.equal(r.state.items[2].date, '2026-10-29');
  assert.equal(r.state.items[2].start, '20:00');
  assert.deepEqual([...r.state.dirty[2]], ['date', 'start']);
  assert.equal(r.state.dirty[1], undefined); // 其它条目不受影响
});

test('editItem：改优先级自动补/清依据（守住 §2.3-7 不变量）', () => {
  const s0 = showDraft(
    beginUnderstanding(createIntentState(), { transcript: 'x', now: NOW, tz: TZ }).state,
    { items: FOUR_ITEMS },
  ).state;
  const up = editItem(s0, 3, { priority: 1 }); // 跑步 → 最优先
  assert.ok(up.ok);
  assert.equal(up.state.items[3].priority, 1);
  assert.ok(typeof up.state.items[3].priorityReason === 'string' && up.state.items[3].priorityReason.length > 0);
  assert.ok(up.state.items[3].priorityReason.includes('最优先'));
  const down = editItem(s0, 0, { priority: 3 }); // 必须项 → 一般
  assert.ok(down.ok);
  assert.equal(down.state.items[0].priorityReason, null);
});

test('editItem：非法修改被拒（标题超 20 字/坏日期/坏时间/坏优先级/越界 index）', () => {
  const s0 = showDraft(
    beginUnderstanding(createIntentState(), { transcript: 'x', now: NOW, tz: TZ }).state,
    { items: FOUR_ITEMS },
  ).state;
  assert.equal(editItem(s0, 0, { title: '一'.repeat(21) }).ok, false);
  assert.equal(editItem(s0, 0, { title: '' }).ok, false);
  assert.equal(editItem(s0, 0, { date: '2026-13-01' }).ok, false);
  assert.equal(editItem(s0, 0, { start: '25:00' }).ok, false);
  assert.equal(editItem(s0, 0, { priority: 6 }).ok, false);
  assert.equal(editItem(s0, 9, { title: 'x' }).ok, false);
  assert.equal(editItem(s0, 0, { confidence: 0.1 }).ok, false); // 非可编辑字段
  const before = JSON.stringify(s0);
  editItem(s0, 0, { title: '' });
  assert.equal(JSON.stringify(s0), before);
});

test('editItem：仅 events 阶段可编辑', () => {
  const s = beginUnderstanding(createIntentState(), { transcript: 'x', now: NOW, tz: TZ }).state;
  assert.equal(editItem(s, 0, { title: 'y' }).ok, false);
});

// —— 确认 / 重说 / 计数 ——
test('confirmAll：携带用户编辑后的最终条目进入 done', () => {
  const s0 = showDraft(
    beginUnderstanding(createIntentState(), { transcript: 'x', now: NOW, tz: TZ }).state,
    { items: FOUR_ITEMS },
  ).state;
  const edited = editItem(s0, 1, { title: '导师组会' }).state;
  const r = confirmAll(edited);
  assert.ok(r.ok);
  assert.equal(r.state.phase, 'done');
  assert.equal(r.items.length, 4);
  assert.equal(r.items[1].title, '导师组会');
  assert.deepEqual(finalItems(r.state), r.items);
});

test('confirmAll：非 events 阶段拒绝', () => {
  const s = beginUnderstanding(createIntentState(), { transcript: 'x', now: NOW, tz: TZ }).state;
  assert.equal(confirmAll(s).ok, false);
});

test('reaskIntent：回到干净的初始态（供「再说一次」重开语音）', () => {
  const s0 = showDraft(
    beginUnderstanding(createIntentState(), { transcript: 'x', now: NOW, tz: TZ }).state,
    { items: FOUR_ITEMS },
  ).state;
  const s1 = reaskIntent(s0);
  assert.equal(s1.phase, 'idle');
  assert.equal(s1.items.length, 0);
  assert.deepEqual(s1, createIntentState());
});

test('countLine：1 件事 / N 件事', () => {
  const one = showDraft(
    beginUnderstanding(createIntentState(), { transcript: 'x', now: NOW, tz: TZ }).state,
    { items: [FOUR_ITEMS[1]] },
  ).state;
  assert.equal(countLine(one), '听出了 1 件事');
  const four = showDraft(
    beginUnderstanding(createIntentState(), { transcript: 'x', now: NOW, tz: TZ }).state,
    { items: FOUR_ITEMS },
  ).state;
  assert.equal(countLine(four), '听出了 4 件事');
});

// —— 时间 chip 文案（原型 ③ 屏的 chip 语义）——
test('formatTimeChip：原型四张卡的文案', () => {
  assert.deepEqual(formatTimeChip(FOUR_ITEMS[1], CTX), { label: '明天 10/26 · 15:00–16:00', warn: false });
  assert.deepEqual(formatTimeChip(FOUR_ITEMS[2], CTX), { label: '截止 周五 10/30', warn: false });
  assert.deepEqual(formatTimeChip(FOUR_ITEMS[3], CTX), { label: '晚上', warn: true }); // 模糊 → 黄 chip
  assert.deepEqual(formatTimeChip(FOUR_ITEMS[0], CTX), { label: '截止 明天 10/26', warn: false });
});

test('formatTimeChip：日期词与时刻的其余组合', () => {
  assert.deepEqual(formatTimeChip(baseItem({ date: '2026-10-25', start: '09:00', end: null }), CTX), { label: '今天 10/25 · 09:00', warn: false });
  assert.deepEqual(formatTimeChip(baseItem({ date: '2026-11-02', start: '19:00', end: null }), CTX), { label: '周一 11/02 · 19:00', warn: false }); // 跨月
});

test('formatTimeChip：无时间信息 → 待定 + 模糊黄标', () => {
  assert.deepEqual(formatTimeChip(baseItem({ date: null, start: null, end: null, durationMin: null, timeText: null, vague: true }), CTX), { label: '时间待定', warn: true });
  assert.deepEqual(formatTimeChip(baseItem({ date: null, start: null, end: null, durationMin: null, timeText: null, vague: false }), CTX), { label: '时间待定', warn: false });
  // 只说了时长
  assert.deepEqual(formatTimeChip(baseItem({ date: null, start: null, end: null, durationMin: 45, timeText: null }), CTX), { label: '约 45 分钟', warn: false });
  // 重复事项保留原文（SPEC §2.3-6）
  assert.deepEqual(formatTimeChip(baseItem({ date: null, start: '19:00', end: null, recurrence: '每周一', timeText: null }), CTX), { label: '每周一 · 19:00', warn: false });
});

// —— 标签 ——
test('kindLabel：六类都有中文标签（含 app 既有词「静驻」）', () => {
  assert.deepEqual(Object.keys(KIND_LABELS).sort(), ['connect', 'create', 'explore', 'necessary', 'restore', 'stillness'].sort());
  assert.equal(kindLabel('necessary'), '必要');
  assert.equal(kindLabel('create'), '创造');
  assert.equal(kindLabel('connect'), '连接');
  assert.equal(kindLabel('explore'), '探索');
  assert.equal(kindLabel('restore'), '恢复');
  assert.equal(kindLabel('stillness'), '静驻');
  assert.equal(kindLabel('unknown'), '');
});

test('优先级文案与 contracts 一致（无依据默认一般）', () => {
  assert.equal(PRIORITY_LABELS[DEFAULT_PRIORITY], '一般');
  assert.equal(PRIORITY_LABELS[1], '最优先');
  assert.equal(PRIORITY_LABELS[5], '不急');
});
