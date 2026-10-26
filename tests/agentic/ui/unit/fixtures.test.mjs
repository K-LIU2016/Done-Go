// M02 fixtures 纯核单测（RED 先行 · 实现前必红）
// 依据：plan.md M02、PRD §3.2 黄金场景、§10.3 Preview JSON 字段名、prototype L249-322/L415-433/L493-504。
// 契约：web/agentic/ui/fixtures.js 具名导出
//   blocks / preview(blockId, {patched}) / boundaries / SYS_WONT / script /
//   storyEvents / narration(patched) / samplesFor(blockId) / needs / traceText / DAY0 / DAY1
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  blocks, preview, boundaries, SYS_WONT, script,
  storyEvents, narration, samplesFor, needs, traceText, DAY0, DAY1,
} from '../../../../web/agentic/ui/fixtures.js';

const SHAPE_TYPES = new Set([
  'outline', 'facts', 'table', 'cards', 'checklist', 'timeline',
  'slides', 'diffSummary', 'mapRoute', 'personCard', 'caveat', 'sample',
]); // PRD §10.3 组件目录（首批）

test('M02 blocks：黄金场景 5 块 r/c/f/b/s（prototype L249-255）', () => {
  assert.equal(blocks.length, 5);
  assert.deepEqual(blocks.map((b) => b.id), ['r', 'c', 'f', 'b', 's']);
  for (const b of blocks) {
    for (const key of ['id', 'start', 'end', 'title', 'kind', 'type', 'feas', 'needs']) {
      assert.ok(key in b, `块 ${b.id} 缺字段 ${key}`);
    }
    assert.match(b.start, /^\d{2}:\d{2}$/);
    assert.match(b.end, /^\d{2}:\d{2}$/);
  }
  const byId = Object.fromEntries(blocks.map((b) => [b.id, b]));
  assert.equal(byId.r.title, 'AI 教育的深度研究');
  assert.equal(byId.c.kind, 'create');
  assert.deepEqual(byId.c.feas, ['mid', '可交付度 中 · 缺学员与课时']); // PRD §3.2 +3s 扫描行
  assert.equal(byId.s.type, '零打扰'); // PRD §3.3 S 类零打扰
});

test('M02 preview：字段名对齐 PRD §10.3（missionId/version/confidence/shape/storyboard/narration/boundary/diff/samples/reel/scene）', () => {
  for (const id of ['r', 'c']) {
    const p = preview(id);
    for (const key of ['missionId', 'version', 'confidence', 'shape', 'storyboard', 'narration', 'boundary', 'diff', 'samples', 'reel', 'scene']) {
      assert.ok(key in p, `preview(${id}) 缺 PRD §10.3 字段 ${key}`);
    }
    assert.equal(typeof p.confidence, 'number');
    assert.ok(p.shape && typeof p.shape.kind === 'string' && typeof p.shape.title === 'string');
    assert.ok(Array.isArray(p.shape.blocks) && p.shape.blocks.length > 0);
    for (const blk of p.shape.blocks) {
      assert.ok(SHAPE_TYPES.has(blk.type), `未知 shape 类型 ${blk.type}`);
    }
    for (const ev of p.storyboard) {
      for (const key of ['at', 'actor', 'text']) assert.ok(key in ev, `storyboard 条目缺 ${key}`);
    }
    for (const key of ['will', 'wont', 'needs', 'budget']) assert.ok(key in p.boundary, `boundary 缺 ${key}`);
    assert.equal(p.scene.status, 'off'); // D-9：场景片默认关
  }
});

test('M02 preview：patched 两态（prototype L260-294）——置信度/标题/差异类都变', () => {
  const base = preview('r');
  const patched = preview('r', { patched: true });
  assert.equal(base.confidence, 64);
  assert.equal(patched.confidence, 78);
  assert.notEqual(base.title, patched.title);
  assert.equal(patched.title, '国内 K12 的 AI 教育：政策、课堂与教师准备度');
  const outlineBase = base.shape.blocks.find((b) => b.type === 'outline');
  const outlinePatched = patched.shape.blocks.find((b) => b.type === 'outline');
  const dClasses = outlinePatched.items.map((it) => it.d || '');
  assert.ok(dClasses.includes('add'), '讨论后大纲需有 add 项（课堂实践）');
  assert.ok(dClasses.includes('del'), '讨论后大纲需有 del 项（海外案例）');
  assert.ok(dClasses.includes('chg'), '讨论后大纲需有 chg 项（政策与标准）');
  assert.ok(outlineBase.items.every((it) => !it.d), '初始态大纲无差异类');
  // 课程块 patched 后为 4 课时（prototype L282-287）
  const cPatched = preview('c', { patched: true });
  const table = cPatched.shape.blocks.find((b) => b.type === 'table');
  assert.ok(table, '课程块 shape 应含 table（课时表）');
  assert.equal(table.rows.length, 4);
});

test('M02 boundaries + SYS_WONT：四栏数据 + 系统默认禁止项（prototype L296-303）', () => {
  for (const id of ['r', 'c', 'f', 'b', 's']) {
    const b = boundaries[id];
    for (const key of ['will', 'wont', 'needs', 'budget']) {
      assert.ok(Array.isArray(b[key]), `boundaries[${id}].${key} 应为数组`);
    }
  }
  assert.equal(SYS_WONT, '系统禁止：付款下单 · 以你名义发送（除非逐次确认）· 读取凭据 · 删除文件');
  assert.ok(SYS_WONT.includes('付款')); // PRD §8.1：系统默认禁止项不可被合同覆盖
});

test('M02 script：执行剧本 15 条（prototype L306-322），need/seg/deliver 结构可判', () => {
  assert.equal(script.length, 15);
  assert.equal(script[0].t, '13:30');
  assert.equal(script.at(-1).t, '18:20');
  const withNeed = script.filter((s) => s.need);
  assert.equal(withNeed.length, 3); // n1/n2/n3
  for (const s of withNeed) {
    for (const key of ['id', 'title', 'body', 'opts', 'due', 'def']) {
      assert.ok(key in s.need, `剧本 need 缺 ${key}`);
    }
  }
  const segs = script.filter((s) => s.seg);
  assert.ok(segs.length >= 8, '泳道段不足');
  for (const s of segs) {
    const [from, to, color, text] = s.seg;
    assert.match(from, /^\d{2}:\d{2}$/);
    assert.match(to, /^\d{2}:\d{2}$/);
    assert.ok('rwvudg'.includes(color), `seg 色类非法 ${color}`);
    assert.equal(typeof text, 'string');
  }
  assert.ok(script.some((s) => s.deliver === 'r') && script.some((s) => s.deliver === 'c'), '两块都要有交付节点');
});

test('M02 storyEvents：8 条、you 触点在索引 1/5（prototype L415-418 实测：13:55 与 15:28；M21 修正原 1/4 笔误）', () => {
  assert.equal(storyEvents.length, 8);
  assert.deepEqual(storyEvents.map((e) => e[3] ? 'you' : ''), ['', 'you', '', '', '', 'you', '', '']);
  for (const e of storyEvents) {
    assert.match(e[0], /^\d{2}:\d{2}$/);
    assert.equal(typeof e[1], 'string'); // 图标
    assert.equal(typeof e[2], 'string'); // 文案
  }
});

test('M02 narration：6 句、patched 变体引用工作坊与初中老师（prototype L426-433）', () => {
  const base = narration(false);
  const patched = narration(true);
  assert.equal(base.length, 6);
  assert.equal(patched.length, 6);
  assert.notEqual(base[1], patched[1], '第 2 句含受众描述，patched 后应不同');
  assert.ok(patched.join('').includes('四课时工作坊'));
  assert.ok(base.join('').includes('不发给任何人')); // 模板约束含边界句
});

test('M02 samplesFor：四 kind（cover/slide/img/route）齐全且带说明（prototype L354-364）', () => {
  const kinds = new Set();
  for (const id of ['r', 'c', 'f', 'b', 's']) {
    for (const sm of samplesFor(id)) {
      assert.ok(['cover', 'slide', 'img', 'route'].includes(sm.kind), `非法样张 kind ${sm.kind}`);
      assert.equal(typeof sm.cap, 'string');
      if (sm.kind === 'img') assert.ok(typeof sm.src === 'string');
      kinds.add(sm.kind);
    }
  }
  assert.deepEqual([...kinds].sort(), ['cover', 'img', 'route', 'slide']);
  // c 块：代码排版 slide 与整页生成 img 并列（plan.md M08 / PRD §5.2.1「示意」对照）
  const cKinds = samplesFor('c').map((sm) => sm.kind).sort();
  assert.deepEqual(cKinds, ['img', 'slide']);
});

test('M02 needs：n1/n2/n3 带截止与超时默认（prototype L309/315/321）', () => {
  assert.deepEqual(needs.map((n) => n.id), ['n1', 'n2', 'n3']);
  for (const n of needs) {
    assert.ok(Array.isArray(n.opts) && n.opts.length >= 2, `${n.id} 至少两个选项`);
    assert.match(n.due, /^\d{2}:\d{2}$/);
    assert.ok(n.def.length > 0, '超时默认行为必填（PRD §5.5）');
    assert.ok(n.b); // 所属块
  }
});

test('M02 traceText：OTel GenAI 命名的 span 树（prototype L493-504 / PRD §10.5）', () => {
  for (const needle of ['invoke_agent block', 'invoke_agent researcher#1', 'execute_tool web.search', 'chat ', 'donego.need n1', 'merge artifact']) {
    assert.ok(traceText.includes(needle), `trace 缺 ${needle}`);
  }
});

test('M02 DAY0/DAY1：交付台时间轴 13:00–19:00（prototype L246）', () => {
  assert.equal(DAY0, 780);
  assert.equal(DAY1, 1140);
});
