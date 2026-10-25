import assert from 'node:assert/strict';
import { test } from 'node:test';
// VI·V4意图视图 — web/voice/voice-sheet.js 单测（先 RED 后 GREEN，实现后置）。
// 唯一标准 design/voice-intent/SPEC.md：
//   §3   voice-sheet.js：底部弹层容器，含手势下拉关闭、焦点管理、桌面端居中弹窗
//   §4   语音视觉 token（--vt-* / 优先级色 p1..p5），视觉沿用 relay-v2 SPEC §3
// 纯逻辑（状态机 / 手势判定 / 焦点循环 / token 表）在无 DOM 的 Node 里可测；
// DOM 装配部分要求模块导入无副作用（不得在 import 时触碰 document/matchMedia）。
import {
  SHEET_PHASES,
  createSheetState,
  openSheet,
  finishOpening,
  beginClose,
  finishClose,
  clampTranslateY,
  beginDrag,
  moveDrag,
  endDrag,
  dragDecision,
  DRAG_CLOSE_RATIO,
  DRAG_V_CLOSE_PXMS,
  DRAG_MIN_TRANSLATE,
  DRAG_FALLBACK_TRANSLATE,
  nextTabIndex,
  FOCUSABLE_SELECTOR,
  VOICE_TOKENS,
} from '../../web/voice/voice-sheet.js';

// —— SPEC §4 token 定稿值（原型 :root 原样）——
const SPEC_VOICE_TOKENS = {
  '--vt-size': '22px',
  '--vt-line': '1.62',
  '--vt-track': '.3px',
  '--vt-weight-final': '500',
  '--vt-weight-partial': '400',
  '--vt-final': '#252722',
  '--vt-partial': '#A3A59B',
  '--vt-caret': '#E95432',
  '--p1': '#C2412D', '--p1-bg': '#FCE8E3',
  '--p2': '#C7701F', '--p2-bg': '#FDF0E1',
  '--p3': '#5E6158', '--p3-bg': '#EFEEE8',
  '--p4': '#4C7A93', '--p4-bg': '#E6EFF4',
  '--p5': '#3E7B5B', '--p5-bg': '#E5F1EA',
};

test('模块可在无 DOM 的 Node 中导入且导出齐全（导入本身不得触碰 document）', () => {
  assert.equal(typeof createSheetState, 'function');
  assert.equal(typeof openSheet, 'function');
  assert.equal(typeof finishOpening, 'function');
  assert.equal(typeof beginClose, 'function');
  assert.equal(typeof finishClose, 'function');
  assert.equal(typeof clampTranslateY, 'function');
  assert.equal(typeof beginDrag, 'function');
  assert.equal(typeof moveDrag, 'function');
  assert.equal(typeof endDrag, 'function');
  assert.equal(typeof dragDecision, 'function');
  assert.equal(typeof nextTabIndex, 'function');
  assert.ok(Array.isArray(SHEET_PHASES));
  assert.deepEqual([...SHEET_PHASES], ['closed', 'opening', 'open', 'closing']);
});

// —— 弹层状态机 ——
test('状态机：closed→opening→open→closing→closed 全链路', () => {
  let s = createSheetState();
  assert.equal(s.phase, 'closed');
  let r = openSheet(s);
  assert.ok(r.ok);
  assert.equal(r.state.phase, 'opening');
  r = finishOpening(r.state);
  assert.ok(r.ok);
  assert.equal(r.state.phase, 'open');
  r = beginClose(r.state);
  assert.ok(r.ok);
  assert.equal(r.state.phase, 'closing');
  r = finishClose(r.state);
  assert.ok(r.ok);
  assert.equal(r.state.phase, 'closed');
});

test('状态机：非法迁移被拒绝且不改变状态', () => {
  const s0 = createSheetState();
  const opened = finishOpening(openSheet(s0).state).state;
  assert.equal(opened.phase, 'open');
  assert.equal(openSheet(opened).ok, false); // 已打开不能再 open
  assert.equal(finishOpening(opened).ok, false); // open 不是 opening
  const closed = createSheetState();
  assert.equal(beginClose(closed).ok, false); // closed 不能直接 closing
  assert.equal(finishClose(closed).ok, false);
  assert.equal(finishOpening(closed).ok, false);
});

test('状态机：纯函数不可变（原 state 不被修改）', () => {
  const s0 = createSheetState();
  const snapshot = JSON.stringify(s0);
  openSheet(s0);
  moveDrag(beginDrag(finishOpening(openSheet(s0).state).state, 0).state, 80, 50);
  assert.equal(JSON.stringify(s0), snapshot);
});

// —— 下拉手势判定（SPEC §3：手势下拉关闭）——
test('dragDecision：位移超过高度 28% 关闭，否则回弹', () => {
  const height = 600;
  assert.equal(dragDecision({ translateY: 200, velocityY: 0, height }), 'close'); // 33%
  assert.equal(dragDecision({ translateY: 168, velocityY: 0, height }), 'close'); // 恰好 28%
  assert.equal(dragDecision({ translateY: 150, velocityY: 0, height }), 'settle'); // 25%
  assert.equal(dragDecision({ translateY: 0, velocityY: 0, height }), 'settle');
});

test('dragDecision：快速下甩（速度阈值）也关闭，但位移过小不关', () => {
  const height = 600;
  assert.equal(dragDecision({ translateY: 100, velocityY: 0.8, height }), 'close'); // v≥0.55px/ms 且 ≥48px
  assert.equal(dragDecision({ translateY: 30, velocityY: 0.9, height }), 'settle'); // 位移太小
  assert.equal(dragDecision({ translateY: 100, velocityY: 0.2, height }), 'settle'); // 太慢
});

test('dragDecision：高度未知时的兜底阈值', () => {
  assert.equal(dragDecision({ translateY: 200, velocityY: 0, height: 0 }), 'close');
  assert.equal(dragDecision({ translateY: 100, velocityY: 0, height: 0 }), 'settle');
  assert.equal(dragDecision({ translateY: 100, velocityY: 0.8, height: 0 }), 'close');
  assert.equal(dragDecision({ translateY: 100, velocityY: 0.8 }), 'close'); // height 缺省
});

test('clampTranslateY：只允许向下位移（≥0）', () => {
  assert.equal(clampTranslateY(-50), 0);
  assert.equal(clampTranslateY(0), 0);
  assert.equal(clampTranslateY(120), 120);
});

test('拖拽序列：begin→move 计算位移与速度，end 清除拖拽并给出决策', () => {
  const open = finishOpening(openSheet(createSheetState()).state).state;
  const none = beginDrag(createSheetState(), 100);
  assert.equal(none.ok, false); // 只有 open 态可以开始拖拽
  let r = beginDrag(open, 100);
  assert.ok(r.ok);
  assert.equal(r.state.drag.startY, 100);
  r = moveDrag(r.state, 130, 50); // 30px / 50ms = 0.6px/ms
  assert.equal(r.state.drag.translateY, 30);
  assert.ok(Math.abs(r.state.drag.velocityY - 0.6) < 1e-9);
  r = moveDrag(r.state, 80, 100); // 向上拖回 → clamp 到 0
  assert.equal(r.state.drag.translateY, 0);
  const end = endDrag(r.state);
  assert.equal(end.state.drag, null);
  assert.equal(end.decision, 'settle'); // 位移 0
  // 大位移序列 → close
  let d = beginDrag(open, 0);
  d = moveDrag(d.state, 300, 300); // 300px/600px 高度足够关
  assert.equal(endDrag(d.state).decision, 'close');
});

// —— 焦点循环（SPEC §3：焦点管理——陷阱/还原）——
test('nextTabIndex：Tab 循环（前向/后向 wrap、单元素、空集合）', () => {
  assert.equal(nextTabIndex(0, 3, false), 1);
  assert.equal(nextTabIndex(2, 3, false), 0); // 末尾 wrap 回第一个
  assert.equal(nextTabIndex(0, 3, true), 2); // 首位 shift-tab wrap 到最后
  assert.equal(nextTabIndex(2, 3, true), 1);
  assert.equal(nextTabIndex(-1, 3, false), 0); // 无当前焦点 → 第一个
  assert.equal(nextTabIndex(-1, 3, true), 2); // 后向无当前 → 最后一个
  assert.equal(nextTabIndex(0, 1, false), 0);
  assert.equal(nextTabIndex(0, 1, true), 0);
  assert.equal(nextTabIndex(0, 0, false), -1); // 无可聚焦元素
});

test('FOCUSABLE_SELECTOR 覆盖原生可聚焦元素并排除 disabled/hidden', () => {
  for (const tag of ['button', 'a[href]', 'input', 'select', 'textarea']) {
    assert.ok(FOCUSABLE_SELECTOR.includes(tag), `missing ${tag}`);
  }
  assert.ok(FOCUSABLE_SELECTOR.includes(':not([disabled])'));
  assert.ok(FOCUSABLE_SELECTOR.includes(':not([hidden])'));
});

// —— token 表（SPEC §4 + relay-v2 §3，视觉一致性锚点）——
test('VOICE_TOKENS 与 SPEC §4 定稿值一致', () => {
  for (const [name, value] of Object.entries(SPEC_VOICE_TOKENS)) {
    assert.equal(VOICE_TOKENS[name], value, `${name} 应为 ${value}`);
  }
  // relay-v2 §3 基础 token 同名沿用
  assert.equal(VOICE_TOKENS['--brand'], '#E95432');
  assert.equal(VOICE_TOKENS['--surface'], '#FFFFFF');
  assert.equal(VOICE_TOKENS['--r-md'], '14px');
});

test('手势常量已定稿（判定与实现共用）', () => {
  assert.equal(DRAG_CLOSE_RATIO, 0.28);
  assert.equal(DRAG_V_CLOSE_PXMS, 0.55);
  assert.equal(DRAG_MIN_TRANSLATE, 48);
  assert.ok(DRAG_FALLBACK_TRANSLATE >= 120 && DRAG_FALLBACK_TRANSLATE <= 200);
});
