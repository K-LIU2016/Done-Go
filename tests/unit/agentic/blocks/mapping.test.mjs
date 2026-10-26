// W1 sync-mapping 单测（TDD 先行）：web/agentic/sync.js 纯映射函数契约（实现须让本文件全绿）。
// 依据：BUILD-PLAN §3 W1-2、规划 DAG sync-mapping 节——
//   客户端 uid() 生成的 id 即 block id（重放幂等关键）；
//   date YYYY-MM-DD、start/end HH:MM 校验（正则同 web/index.html:781 isHM，24:00 合法）；
//   drafts 以 source:'draft' 上行（可无 start/end）；非规范字段（state/kept/use/intent/freed/
//   collaborationRef）本地保留：合并只覆盖规范字段、不丢数据。
//
// 契约：
//   entryToBlock(entry, { source } = {}) → block | null
//     规范字段 id/date/start/end/title/kind/prio/note/done/source；note 缺省 ''、done 缺省 false、
//     prio 缺省 3；draft 可无 start/end（映射为 null）；date/start/end 存在但格式非法 → 整条 null
//     （不同步脏数据）；非规范字段不上行。
//   blockToEntry(block) → entry（规范字段；start/end 为 null 时还原为 null/undefined）
//   mergeBlockIntoEntry(localEntry, block) → 新 entry：规范字段取 block，非规范字段保留 local。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryToBlock, blockToEntry, mergeBlockIntoEntry } from '../../../../web/agentic/sync.js';

test('entryToBlock：uid() 生成的 id 即 block id，规范字段一一映射并补默认值', () => {
  const block = entryToBlock({ id: 'k3x9c2ab', date: '2026-10-26', start: '09:00', end: '10:00', title: '写研究报告', kind: 'create', prio: 3 });
  assert.equal(block.id, 'k3x9c2ab');
  assert.equal(block.date, '2026-10-26');
  assert.equal(block.start, '09:00');
  assert.equal(block.end, '10:00');
  assert.equal(block.title, '写研究报告');
  assert.equal(block.kind, 'create');
  assert.equal(block.prio, 3);
  assert.equal(block.note, '');
  assert.equal(block.done, false);
  assert.equal(block.source, 'web');
});

test('entryToBlock：draft 以 source:"draft" 上行、可无 start/end；非规范字段不上行', () => {
  const draft = { id: 'd1', date: '2026-10-26', title: '待补时间的事', kind: 'necessary', prio: 3, state: 'reserved', kept: 0, intent: '' };
  const block = entryToBlock(draft, { source: 'draft' });
  assert.equal(block.source, 'draft');
  assert.ok(block.start == null);
  assert.ok(block.end == null);
  for (const key of ['state', 'kept', 'intent', 'use', 'freed', 'collaborationRef'])
    assert.ok(!(key in block), '非规范字段 ' + key + ' 不应上行');
});

test('entryToBlock 校验：date 非 YYYY-MM-DD、start/end 非 HH:MM（同 index.html isHM 正则）→ null', () => {
  const base = { id: 'x1', start: '09:00', end: '10:00', title: 't', kind: 'create' };
  assert.equal(entryToBlock({ ...base, date: '2026-10-6' }), null);   // 月份未补零
  assert.equal(entryToBlock({ ...base, date: '20261026' }), null);
  assert.equal(entryToBlock({ ...base, date: '2026-10-26', start: '9:00' }), null);
  assert.equal(entryToBlock({ ...base, date: '2026-10-26', end: '25:00' }), null);
  assert.ok(entryToBlock({ ...base, date: '2026-10-26', start: '24:00', end: '24:00' })); // 24:00 合法（同 isHM）
});

test('blockToEntry roundtrip：规范字段还原一致；无 start 的 draft 也能往返', () => {
  const entry = { id: 'ab12cd34', date: '2026-10-26', start: '14:00', end: '15:30', title: '午休', kind: 'restore', prio: 5, note: '小睡二十分钟', done: true };
  const round = blockToEntry(entryToBlock(entry));
  for (const key of ['id', 'date', 'start', 'end', 'title', 'kind', 'prio', 'note', 'done'])
    assert.equal(round[key], entry[key], key + ' 应往返一致');
  const draftRound = blockToEntry(entryToBlock({ id: 'd1', date: '2026-10-26', title: '待补时间', kind: 'necessary' }, { source: 'draft' }));
  assert.equal(draftRound.id, 'd1');
  assert.ok(draftRound.start == null);
});

test('mergeBlockIntoEntry：只覆盖规范字段，stillness 的 state/kept/use/intent/freed/collaborationRef 不丢', () => {
  const local = {
    id: 's1', date: '2026-10-26', start: '20:00', end: '21:00', title: '自由安排', kind: 'stillness', prio: 3, note: '', done: false,
    state: 'kept', kept: 45, use: 'walk', intent: '陪家人散步',
    freed: { pending: true, start: '20:00', end: '21:00', minutes: 60 },
    collaborationRef: { linkId: 'l1', groupId: 'g1' },
  };
  const block = entryToBlock({ ...local, title: '自由安排（服务端改名）', note: '服务端备注', done: true });
  const merged = mergeBlockIntoEntry(local, block);
  assert.equal(merged.id, 's1');
  assert.equal(merged.title, '自由安排（服务端改名）');
  assert.equal(merged.note, '服务端备注');
  assert.equal(merged.done, true);
  assert.equal(merged.state, 'kept');
  assert.equal(merged.kept, 45);
  assert.equal(merged.use, 'walk');
  assert.equal(merged.intent, '陪家人散步');
  assert.deepEqual(merged.freed, local.freed);
  assert.deepEqual(merged.collaborationRef, local.collaborationRef);
});
