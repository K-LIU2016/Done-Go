import assert from 'node:assert/strict';
import { test } from 'node:test';

import {
  PRIORITY_META,
  canHandoffToAI,
  normalizeNextTask,
  readAgendaTasks,
  renderNextUp,
  sortNextTasks,
} from '../../web/relay/next-up.js';

const tasks = [
  { id: 'later-p1', title: '联系导师', kind: 'connect', prio: 1, date: '2026-10-26', start: '16:00', end: '17:00' },
  { id: 'early-p3', title: '整理书桌', kind: 'necessary', prio: 3, date: '2026-10-25', start: '09:00', end: '10:00' },
  { id: 'early-p2', title: '交报告', kind: 'create', prio: 2, date: '2026-10-25', start: '18:00', end: '19:00' },
  { id: 'late-p2', title: '读论文', kind: 'explore', prio: 2, date: '2026-10-28', start: '08:00', end: '09:00' },
];

test('sortNextTasks 先按优先级，再按日期和开始时间排序', () => {
  const sorted = sortNextTasks(tasks);
  assert.deepEqual(sorted.map((task) => task.id), ['later-p1', 'early-p2', 'late-p2', 'early-p3']);
});

test('normalizeNextTask 兼容旧账本 prio 字段并默认一般优先级', () => {
  assert.deepEqual(normalizeNextTask({ id: 'x', title: '待办', kind: 'create', date: '2026-10-25', start: '', end: '' }), {
    id: 'x', title: '待办', kind: 'create', date: '2026-10-25', start: '', end: '', priority: 3, done: false,
  });
  assert.equal(normalizeNextTask({ id: 'bad', title: '', kind: 'create' }), null);
});

test('canHandoffToAI 只给未完成且非自己的时间的事项显示交给 AI', () => {
  assert.equal(canHandoffToAI({ title: '写周报', kind: 'create', done: false }), true);
  assert.equal(canHandoffToAI({ title: '自由安排', kind: 'stillness', done: false }), false);
  assert.equal(canHandoffToAI({ title: '已完成', kind: 'create', done: true }), false);
});

test('readAgendaTasks 从 web.v1 合并 entries 和 drafts，过滤已完成事项', () => {
  const storage = {
    getItem(key) {
      assert.equal(key, 'tango-donego.web.v1');
      return JSON.stringify({
        entries: [tasks[0], { ...tasks[1], done: true }],
        drafts: [{ id: 'draft-1', title: '补时间', kind: 'create', prio: 2, date: '2026-10-25', start: '', end: '' }],
      });
    },
  };
  assert.deepEqual(readAgendaTasks(storage).map((task) => task.id), ['later-p1', 'draft-1']);
});

test('renderNextUp 输出优先级色条、交给 AI 按钮和 relay 预填事件', () => {
  const html = renderNextUp(tasks.slice(0, 3));
  assert.match(html, /class="next-up"/);
  assert.match(html, /接下来的事/);
  assert.match(html, /data-priority="1"/);
  assert.match(html, new RegExp(PRIORITY_META[1].color.replace('#', '\\#')));
  assert.match(html, /交给 AI/);
  assert.match(html, /#\/relay\?event=/);
  assert.match(html, /联系导师/);
});
