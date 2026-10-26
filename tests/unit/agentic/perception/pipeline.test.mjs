// pipeline 契约（依赖 Group1 全部，全部注入假件）：编排 归属 → 敏感判定 → 快感知（card.created）
// → 深感知（card.upgraded 原地升级，含 ContextDelta）；深失败 → card.deep_failed + 快卡保留；
// 敏感命中 → 仅本地路径、默认不存原图；视频 = 帧集合一次深感知（≤30s 同步、更长 pending）。
// 假 clock / 假模型测双路时序（BUILD-PLAN L146、PRD §6.8.2 L487-499）。
// 对应实现：scripts/agentic/perception/pipeline.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPerceptionPipeline } from '../../../../scripts/agentic/perception/pipeline.mjs';

const BLOCKS = [{ id: 'b-shelf', title: '做木书架', kind: 'craft', start: '2026-10-26T19:00:00+08:00', end: '2026-10-26T21:00:00+08:00' }];

function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: ms => { t += ms; } };
}

function makeVision(result) {
  const calls = [];
  return {
    calls,
    analyze: async input => { calls.push(input); return typeof result === 'function' ? result() : result; },
  };
}

const fastResult = () => ({ seen: '正在按说明书组装书架，胶水和螺丝已就位。', change: null, suggestion: null, actions: [] });
const deepResult = () => ({
  seen: '隔板已上胶，但胶水溢出、没用夹具固定，可能会不平。',
  change: '胶水溢出、未用夹具',
  risk: '隔板可能不平',
  suggestion: '用湿布擦掉多余胶水，直尺检查水平，夹子固定 15 分钟',
  actions: ['⏱ 15 分钟后提醒我', '记下来'],
});

const imageInput = over => ({
  captureId: 'cap-1',
  ownerId: 'alice',
  kind: 'image',
  path: '/data/alice/cap-1.jpg',
  mimeType: 'image/jpeg',
  capturedAt: '2026-10-26T19:05:00+08:00',
  uploadedAt: '2026-10-26T19:06:00+08:00',
  blocks: BLOCKS,
  ...over,
});

function harness({ fast, deep, classify = () => ({ sensitive: false, category: null, localOnly: false }), attribute, extractFrames, handoffAudio, clock } = {}) {
  const events = [];
  const pipeline = createPerceptionPipeline({
    fast: fast ?? makeVision(fastResult()),
    deep: deep ?? makeVision(deepResult()),
    classifySensitive: classify,
    attribute: attribute ?? (() => ({ status: 'matched', blockId: 'b-shelf', confidence: 0.9 })),
    extractFrames,
    handoffAudio,
    clock: clock ?? { now: () => 0 },
  });
  const emit = (type, payload) => events.push({ type, payload });
  return { pipeline, events, emit };
}

test('happy path: attribution → fast card.created → deep card.upgraded with ContextDelta, ms measured by injected clock', async () => {
  const clock = makeClock();
  clockRef = clock;
  const fast = { model: 'qwen3.5-omni-flash', analyze: async () => { clock.advance(1500); return fastResult(); } };
  const deep = { model: 'qwen3-vl-plus', analyze: async () => { clock.advance(6000); return deepResult(); } };
  const { pipeline, events, emit } = harness({ fast, deep, clock });
  const started = pipeline.start(imageInput({ emit }));
  assert.deepEqual(started.attribution, { status: 'matched', blockId: 'b-shelf', confidence: 0.9 }, '归属结果同步返回（POST 202 用）');
  const done = await started.done;
  assert.deepEqual(events.map(e => e.type), ['card.created', 'card.upgraded'], '快先到、深升级，顺序固定');
  const created = events[0].payload;
  assert.equal(created.captureId, 'cap-1');
  assert.equal(created.blockId, 'b-shelf');
  assert.equal(created.confidence, 0.9);
  assert.equal(created.level, 'fast');
  assert.equal(created.model, 'qwen3.5-omni-flash');
  assert.equal(created.ms, 1500, '耗时由注入 clock 计量');
  assert.equal(created.seen, '正在按说明书组装书架，胶水和螺丝已就位。');
  assert.equal('candidates' in created, false, '无歧义时快卡不带 candidates 字段');
  const up = events[1].payload;
  assert.equal(up.captureId, 'cap-1');
  assert.equal(up.blockId, 'b-shelf');
  assert.equal(up.level, 'deep');
  assert.equal(up.model, 'qwen3-vl-plus');
  assert.equal(up.ms, 6000);
  assert.equal(up.change, '胶水溢出、未用夹具');
  assert.equal(up.risk, '隔板可能不平');
  assert.equal(up.suggestion, '用湿布擦掉多余胶水，直尺检查水平，夹子固定 15 分钟');
  assert.deepEqual(up.actions, ['⏱ 15 分钟后提醒我', '记下来']);
  assert.deepEqual(up.contextDelta, {
    blockId: 'b-shelf',
    seen: '隔板已上胶，但胶水溢出、没用夹具固定，可能会不平。',
    change: '胶水溢出、未用夹具',
    risk: '隔板可能不平',
    evidence: { imageRef: 'cap-1' },
  });
  assert.equal(done.status, 'upgraded');
  assert.equal(done.card.level, 'deep');
});

test('card.created is emitted before the deep call settles（快卡不被深路阻塞）', async () => {
  let releaseDeep;
  const gate = new Promise(resolve => { releaseDeep = resolve; });
  const deep = { model: 'qwen3-vl-plus', analyze: () => gate.then(() => deepResult()) };
  const { pipeline, events, emit } = harness({ deep });
  const started = pipeline.start(imageInput({ emit }));
  await new Promise(r => setTimeout(r, 10)); // 让快路微任务跑完
  assert.equal(events.length, 1, '深路挂起时快卡已发出');
  assert.equal(events[0].type, 'card.created');
  releaseDeep();
  const done = await started.done;
  assert.equal(done.status, 'upgraded');
  assert.equal(events.length, 2);
});

test('deep failure: card.deep_failed emitted, fast card retained（深失败快保留）', async () => {
  const deep = { model: 'qwen3-vl-plus', analyze: async () => { throw new Error('vision-http-500'); } };
  const { pipeline, events, emit } = harness({ deep });
  const done = await pipeline.start(imageInput({ emit })).done;
  assert.deepEqual(events.map(e => e.type), ['card.created', 'card.deep_failed']);
  assert.equal(events[1].payload.captureId, 'cap-1');
  assert.match(String(events[1].payload.error), /500/);
  assert.equal(done.status, 'deep-failed');
  assert.equal(done.card.level, 'fast', '快卡保留');
  assert.equal(done.card.seen, '正在按说明书组装书架，胶水和螺丝已就位。');
});

test('sensitive hit: no cloud deep call, localOnly card, original not kept（命中→仅本地+默认不存原图）', async () => {
  const fast = makeVision(fastResult());
  const deep = makeVision(deepResult());
  const deepCallsBefore = () => deep.calls.length;
  const { pipeline, events, emit } = harness({
    fast,
    deep,
    classify: () => ({ sensitive: true, category: 'identity-document', localOnly: true }),
  });
  const done = await pipeline.start(imageInput({ emit })).done;
  assert.equal(deepCallsBefore(), 0, '深感知（云端）绝不调用');
  assert.deepEqual(events.map(e => e.type), ['card.created', 'card.sensitive']);
  assert.equal(events[1].payload.category, 'identity-document');
  assert.equal(events[1].payload.localOnly, true);
  assert.equal(done.status, 'local-only');
  assert.equal(done.keepOriginal, false, '默认不保存原图');
  assert.equal(done.card.localOnly, true);
});

test('attribution none: card downgraded to a bare record, deep still runs, contextDelta.blockId null（无命中降级仅记录）', async () => {
  const { pipeline, events, emit } = harness({ attribute: () => ({ status: 'none', reason: 'no-window' }) });
  const started = pipeline.start(imageInput({ emit }));
  assert.deepEqual(started.attribution, { status: 'none', reason: 'no-window' });
  const done = await started.done;
  assert.equal(events[0].payload.blockId, null);
  assert.equal(events[1].type, 'card.upgraded');
  assert.equal(events[1].payload.contextDelta.blockId, null);
  assert.equal(done.status, 'upgraded');
});

test('attribution ambiguous: candidates ride along on the fast card（歧义候选交用户选）', async () => {
  const candidates = [{ blockId: 'b-a', confidence: 0.9 }, { blockId: 'b-b', confidence: 0.9 }];
  const { pipeline, events, emit } = harness({ attribute: () => ({ status: 'ambiguous', candidates }) });
  const started = pipeline.start(imageInput({ emit }));
  assert.equal(started.attribution.status, 'ambiguous');
  await started.done;
  assert.deepEqual(events[0].payload.candidates, candidates);
  assert.equal(events[0].payload.blockId, null, '未裁决前不落 blockId');
});

const framesResult = (durationSec, frames = ['f1.jpg', 'f2.jpg', 'f3.jpg']) => ({
  durationSec,
  frames,
  audioPath: null,
  workDir: '/tmp/frames-x',
  cleanup: async () => {},
});

test('video ≤30s: frames extracted, ONE deep call over the whole frame set（视频=帧集合一次深感知）', async () => {
  const deep = makeVision(deepResult());
  const extractCalls = [];
  const handoff = async () => {};
  const { pipeline, events, emit } = harness({
    deep,
    extractFrames: async input => { extractCalls.push(input); return framesResult(28); },
    handoffAudio: handoff,
  });
  const done = await pipeline.start(imageInput({ kind: 'video', path: '/data/alice/cap-9.mp4', mimeType: 'video/mp4', emit })).done;
  assert.equal(extractCalls.length, 1, '抽帧一次');
  assert.equal(extractCalls[0].handoffAudio, handoff, '语音管线留桩被传入抽帧');
  assert.equal(deep.calls.length, 1, '整个帧集合只发一次深感知');
  assert.equal(deep.calls[0].images.length, 3, '三帧一起进同一次请求');
  assert.equal(done.status, 'upgraded');
  assert.equal(events.at(-1).type, 'card.upgraded');
});

test('video >30s: goes pending, no deep call yet（更长后台处理，PRD L497-499）', async () => {
  const deep = makeVision(deepResult());
  const { pipeline, events, emit } = harness({ deep, extractFrames: async () => framesResult(31) });
  const done = await pipeline.start(imageInput({ kind: 'video', path: '/data/alice/cap-10.mp4', mimeType: 'video/mp4', emit })).done;
  assert.equal(done.status, 'pending');
  assert.equal(deep.calls.length, 0);
  assert.ok(events.some(e => e.type === 'card.pending'), 'pending 事件让前端知道在后台跑');
});

test('fast lane is never blocked by slow attribution input sizes: emit order is deterministic across runs', async () => {
  for (let i = 0; i < 3; i++) {
    const { pipeline, events, emit } = harness({});
    await pipeline.start(imageInput({ captureId: `cap-r${i}`, emit })).done;
    assert.deepEqual(events.map(e => e.type), ['card.created', 'card.upgraded'], `run ${i}`);
  }
});
