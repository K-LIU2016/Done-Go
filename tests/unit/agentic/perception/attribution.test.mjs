// attribution 契约（纯函数，blocks 注入，不依赖 W1 代码）：
// 拍摄时间（EXIF→上传时间兜底）× 日程窗口 ± 准备窗（默认 30min 可注入）× 块类型 → blockId+置信度；
// 多命中 → 候选列表交用户选；无命中 → null+理由；stillness 零打扰块排除；时区 Asia/Shanghai。
// 置信度分层约定：核心窗口（start ≤ t ≤ end）0.9；仅准备窗（start−prep ≤ t < start 或 end < t ≤ end+prep）0.5。
// 最高层唯一命中 → matched；最高层并列 → ambiguous（候选按置信度降序、并列按 start 升序）。
// 对应实现：scripts/agentic/perception/attribution.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { attributeCapture } from '../../../../scripts/agentic/perception/attribution.mjs';

const block = (id, start, end, kind = 'focus', title = id) => ({ id, title, kind, start, end });
// 当天：2026-10-26（周一）。核心用例块：15:00–16:00 产品周会（PRD §6.8.3 场景）。
const MEETING = block('b-meeting', '2026-10-26T15:00:00+08:00', '2026-10-26T16:00:00+08:00', 'meeting', '产品周会');
const t = (h, m = 0, s = 0) => `2026-10-26T${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}+08:00`;

test('core window: interior, exact start and exact end all match at 0.9', () => {
  for (const time of [t(15, 30), t(15, 0, 0), t(16, 0, 0)]) {
    assert.deepEqual(attributeCapture({ blocks: [MEETING], capturedAt: time }), { status: 'matched', blockId: 'b-meeting', confidence: 0.9 }, time);
  }
});

test('prep window (default 30min): edges match at 0.5, one second past does not', () => {
  assert.deepEqual(attributeCapture({ blocks: [MEETING], capturedAt: t(14, 30) }), { status: 'matched', blockId: 'b-meeting', confidence: 0.5 }, 'start−30min 恰好落在准备窗');
  assert.deepEqual(attributeCapture({ blocks: [MEETING], capturedAt: t(16, 30) }), { status: 'matched', blockId: 'b-meeting', confidence: 0.5 }, 'end+30min 恰好落在准备窗');
  assert.deepEqual(attributeCapture({ blocks: [MEETING], capturedAt: t(14, 29, 59) }), { status: 'none', reason: 'no-window' }, '准备窗前一秒不命中');
  assert.deepEqual(attributeCapture({ blocks: [MEETING], capturedAt: t(16, 30, 1) }), { status: 'none', reason: 'no-window' }, '准备窗后一秒不命中');
  // 准备窗内侧边界仍属准备层（14:30:01 < 15:00）
  assert.deepEqual(attributeCapture({ blocks: [MEETING], capturedAt: t(14, 31) }), { status: 'matched', blockId: 'b-meeting', confidence: 0.5 });
});

test('prep window is injectable (准备窗可注入)', () => {
  assert.deepEqual(attributeCapture({ blocks: [MEETING], capturedAt: t(14, 45), prepWindowMin: 0 }), { status: 'none', reason: 'no-window' }, 'prep=0 时 14:45 不命中');
  assert.deepEqual(attributeCapture({ blocks: [MEETING], capturedAt: t(14, 45), prepWindowMin: 15 }), { status: 'matched', blockId: 'b-meeting', confidence: 0.5 });
  assert.deepEqual(attributeCapture({ blocks: [MEETING], capturedAt: t(13, 30), prepWindowMin: 90 }), { status: 'matched', blockId: 'b-meeting', confidence: 0.5 }, '90 分钟准备窗覆盖 13:30');
});

test('capturedAt missing falls back to uploadedAt（EXIF 缺失用上传时间兜底）', () => {
  assert.deepEqual(attributeCapture({ blocks: [MEETING], uploadedAt: t(15, 20) }), { status: 'matched', blockId: 'b-meeting', confidence: 0.9 });
  assert.deepEqual(attributeCapture({ blocks: [MEETING], uploadedAt: t(15, 50) }).confidence, 0.9);
  assert.deepEqual(attributeCapture({ blocks: [MEETING], capturedAt: null, uploadedAt: null }), { status: 'none', reason: 'no-time' }, '两个时间都没有 → 有理由的 none');
});

test('no blocks at all → none with reason', () => {
  assert.deepEqual(attributeCapture({ blocks: [], capturedAt: t(15, 0) }), { status: 'none', reason: 'no-blocks' });
});

test('stillness（零打扰）blocks are excluded from attribution entirely', () => {
  const stillness = block('b-still', t(14, 0), t(17, 0), 'stillness', '零打扰');
  assert.deepEqual(attributeCapture({ blocks: [stillness], capturedAt: t(15, 0) }), { status: 'none', reason: 'no-window' }, '只有零打扰块 → 排除后无命中');
  // 零打扰块与普通块重叠时不进入候选
  const out = attributeCapture({ blocks: [stillness, MEETING], capturedAt: t(15, 30) });
  assert.equal(out.status, 'matched');
  assert.equal(out.blockId, 'b-meeting');
});

test('disjoint blocks: attribution lands on the one that covers the time', () => {
  const blocks = [
    block('b-morning', t(9, 0), t(11, 0), 'focus', '上午深度工作'),
    MEETING,
    block('b-night', '2026-10-26T21:00:00+08:00', '2026-10-26T22:00:00+08:00', 'focus', '晚间复盘'),
  ];
  for (const [time, expected] of [[t(10, 0), 'b-morning'], [t(15, 10), 'b-meeting'], [t(21, 40), 'b-night'], [t(12, 0), null]]) {
    const out = attributeCapture({ blocks, capturedAt: time });
    if (expected === null) assert.equal(out.status, 'none', time);
    else assert.deepEqual(out, { status: 'matched', blockId: expected, confidence: 0.9 }, time);
  }
});

test('overlapping core hits → ambiguous candidates for the user to resolve（多命中交用户选）', () => {
  const a = block('b-a', t(15, 0), t(17, 0), 'focus', 'A');
  const b = block('b-b', t(16, 0), t(18, 0), 'focus', 'B');
  const out = attributeCapture({ blocks: [b, a], capturedAt: t(16, 30) }); // 乱序输入
  assert.equal(out.status, 'ambiguous');
  assert.equal(out.candidates.length, 2);
  assert.deepEqual(out.candidates.map(c => c.blockId).sort(), ['b-a', 'b-b']);
  assert.ok(out.candidates.every(c => c.confidence === 0.9));
  // 并列时按 start 升序稳定排序
  assert.deepEqual(out.candidates.map(c => c.blockId), ['b-a', 'b-b']);
});

test('one core + one prep-only hit → matched to the core block, not ambiguous', () => {
  const core = block('b-core', t(15, 0), t(16, 0), 'focus', '核心');
  const neighbor = block('b-next', t(16, 20), t(17, 0), 'focus', '紧随其后'); // 16:10 在其准备窗内
  const out = attributeCapture({ blocks: [core, neighbor], capturedAt: t(16, 10) });
  assert.deepEqual(out, { status: 'matched', blockId: 'b-core', confidence: 0.9 });
});

test('two prep-only hits → ambiguous at 0.5', () => {
  const a = block('b-a', t(15, 0), t(15, 30), 'focus', 'A'); // 准备窗向后延到 16:00
  const b = block('b-b', t(15, 40), t(16, 10), 'focus', 'B'); // 准备窗向前到 15:10；15:35 落在两者准备窗内
  const out = attributeCapture({ blocks: [a, b], capturedAt: t(15, 35) });
  assert.equal(out.status, 'ambiguous');
  assert.ok(out.candidates.every(c => c.confidence === 0.5));
  assert.deepEqual(out.candidates.map(c => c.blockId), ['b-a', 'b-b']);
});

test('cross-midnight block matches on both sides of 00:00（跨午夜）', () => {
  const night = block('b-night', '2026-10-26T23:00:00+08:00', '2026-10-27T01:00:00+08:00', 'focus', '深夜赶工');
  assert.deepEqual(attributeCapture({ blocks: [night], capturedAt: '2026-10-26T23:45:00+08:00' }), { status: 'matched', blockId: 'b-night', confidence: 0.9 });
  assert.deepEqual(attributeCapture({ blocks: [night], capturedAt: '2026-10-27T00:30:00+08:00' }), { status: 'matched', blockId: 'b-night', confidence: 0.9 });
  assert.deepEqual(attributeCapture({ blocks: [night], capturedAt: '2026-10-27T01:30:00+08:00' }), { status: 'matched', blockId: 'b-night', confidence: 0.5 }, '结束后的准备窗');
  assert.deepEqual(attributeCapture({ blocks: [night], capturedAt: '2026-10-27T01:30:01+08:00' }), { status: 'none', reason: 'no-window' }, '准备窗后一秒');
});

test('UTC instants normalize into Asia/Shanghai windows', () => {
  const night = block('b-night', '2026-10-26T23:00:00+08:00', '2026-10-27T01:00:00+08:00', 'focus', '深夜赶工');
  // 2026-10-26T16:45:00Z == 2026-10-27T00:45+08 → 核心命中
  assert.deepEqual(attributeCapture({ blocks: [night], capturedAt: '2026-10-26T16:45:00Z' }), { status: 'matched', blockId: 'b-night', confidence: 0.9 });
  // 2026-10-26T14:45:00Z == 22:45+08 → 会前准备窗
  assert.deepEqual(attributeCapture({ blocks: [night], capturedAt: '2026-10-26T14:45:00Z' }), { status: 'matched', blockId: 'b-night', confidence: 0.5 });
});

test('zero-length block matches only at the exact instant (inclusive both edges)', () => {
  const instant = block('b-ping', t(12, 0), t(12, 0), 'meeting', '整点打卡');
  assert.deepEqual(attributeCapture({ blocks: [instant], capturedAt: t(12, 0) }), { status: 'matched', blockId: 'b-ping', confidence: 0.9 });
  assert.deepEqual(attributeCapture({ blocks: [instant], capturedAt: t(12, 1) }), { status: 'matched', blockId: 'b-ping', confidence: 0.5 }, '落入会后准备窗');
  assert.deepEqual(attributeCapture({ blocks: [instant], capturedAt: t(12, 31) }), { status: 'none', reason: 'no-window' });
});

test('ambiguous candidates sort by confidence desc, then start asc（确定性排序）', () => {
  const coreA = block('b-coreA', t(15, 0), t(16, 30), 'focus', 'A');
  const coreB = block('b-coreB', t(14, 0), t(16, 30), 'focus', 'B');
  const prep = block('b-prep', t(17, 0), t(18, 0), 'focus', 'C'); // 16:20 仅在其准备窗
  const out = attributeCapture({ blocks: [prep, coreB, coreA], capturedAt: t(16, 20) });
  assert.equal(out.status, 'ambiguous');
  assert.deepEqual(out.candidates.map(c => [c.blockId, c.confidence]), [['b-coreB', 0.9], ['b-coreA', 0.9], ['b-prep', 0.5]]);
});

test('attribution is a pure function: same input, same output, no mutation of blocks', () => {
  const blocks = [MEETING, block('b-other', t(18, 0), t(19, 0), 'focus', '晚饭')] ;
  const snapshot = JSON.stringify(blocks);
  const one = attributeCapture({ blocks, capturedAt: t(15, 30) });
  const two = attributeCapture({ blocks, capturedAt: t(15, 30) });
  assert.deepEqual(one, two);
  assert.equal(JSON.stringify(blocks), snapshot, '输入 blocks 不被改动');
});
