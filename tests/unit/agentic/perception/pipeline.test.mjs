// pipeline 契约（依赖 Group1 全部，全部注入假件）：编排 归属 → 敏感判定 → 快感知（card.created）
// → 深感知（card.upgraded 原地升级，含 ContextDelta）；深失败 → card.deep_failed + 快卡保留；
// 敏感命中 → 仅本地路径、默认不存原图；视频 = 帧集合一次深感知（≤30s 同步、更长 pending）。
// 假 clock / 假模型测双路时序（BUILD-PLAN L146、PRD §6.8.2 L487-499）。
// 对应实现：scripts/agentic/perception/pipeline.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createPerceptionPipeline, MAX_SYNC_VIDEO_SEC } from '../../../../scripts/agentic/perception/pipeline.mjs';

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

function harness({ fast, deep, local, classify = () => ({ sensitive: false, category: null, localOnly: false }), attribute, probeVideo, extractFrames, handoffAudio, clock } = {}) {
  const events = [];
  const pipeline = createPerceptionPipeline({
    fast: fast ?? makeVision(fastResult()),
    deep: deep ?? makeVision(deepResult()),
    local,
    classifySensitive: classify,
    attribute: attribute ?? (() => ({ status: 'matched', blockId: 'b-shelf', confidence: 0.9 })),
    probeVideo,
    extractFrames,
    handoffAudio,
    clock: clock ?? { now: () => 0 },
  });
  const emit = (type, payload) => events.push({ type, payload });
  return { pipeline, events, emit };
}

test('happy path: attribution → fast card.created → deep card.upgraded with ContextDelta, ms measured by injected clock', async () => {
  const clock = makeClock();
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
  // 修复轮断言更新：local 未配置（默认部署）时必须补发终态事件 card.local_only——
  // 否则 SSE 客户端永远等不到 [DONE]（card.sensitive 是中间态，评审 HIGH）。
  assert.deepEqual(events.map(e => e.type), ['card.created', 'card.sensitive', 'card.local_only']);
  assert.equal(events[1].payload.category, 'identity-document');
  assert.equal(events[1].payload.localOnly, true);
  assert.equal(events[2].payload.localOnly, true);
  assert.equal(events[2].payload.reason, 'local-vision-not-configured', '终态帧说明为何没有本地升级');
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

test('video ≤30s: probe first, frames extracted, ONE deep call over the whole frame set（视频=帧集合一次深感知）', async () => {
  const deep = makeVision(deepResult());
  const extractCalls = [];
  const probeCalls = [];
  const handoff = async () => {};
  const { pipeline, events, emit } = harness({
    deep,
    probeVideo: async path => { probeCalls.push(path); return { durationSec: 28, hasAudio: false }; },
    extractFrames: async input => { extractCalls.push(input); return framesResult(28); },
    handoffAudio: handoff,
  });
  const done = await pipeline.start(imageInput({ kind: 'video', path: '/data/alice/cap-9.mp4', mimeType: 'video/mp4', emit })).done;
  assert.deepEqual(probeCalls, ['/data/alice/cap-9.mp4'], '先探时长（一次 probe）再决定抽帧');
  assert.equal(extractCalls.length, 1, '抽帧一次');
  assert.equal(extractCalls[0].handoffAudio, handoff, '语音管线留桩被传入抽帧');
  assert.equal(deep.calls.length, 1, '整个帧集合只发一次深感知');
  assert.equal(deep.calls[0].images.length, 3, '三帧一起进同一次请求');
  assert.equal(done.status, 'upgraded');
  assert.equal(events.at(-1).type, 'card.upgraded');
});

test('video >30s: probe-first → goes pending without paying extraction, no dangling cleanup（更长后台处理，PRD L497-499）', async () => {
  const deep = makeVision(deepResult());
  let extractCalled = 0;
  const { pipeline, events, emit } = harness({
    deep,
    probeVideo: async () => ({ durationSec: 31, hasAudio: true }),
    extractFrames: async () => { extractCalled++; return framesResult(31); },
  });
  const done = await pipeline.start(imageInput({ kind: 'video', path: '/data/alice/cap-10.mp4', mimeType: 'video/mp4', emit })).done;
  assert.equal(done.status, 'pending');
  assert.equal(done.durationSec, 31);
  assert.equal(extractCalled, 0, '>30s 不付全量抽帧/音轨代价（评审 HIGH：5 分钟视频先抽 ≤15 JPEG+wav 再被搁置）');
  assert.equal('cleanup' in done, false, 'pending 返回值不悬挂 cleanup（清理责任不跨模块悬空）');
  assert.equal(deep.calls.length, 0);
  const pending = events.find(e => e.type === 'card.pending');
  assert.ok(pending, 'pending 事件让前端知道在后台跑');
  assert.equal(pending.payload.durationSec, 31);
});

test('fast lane is never blocked by slow attribution input sizes: emit order is deterministic across runs', async () => {
  for (let i = 0; i < 3; i++) {
    const { pipeline, events, emit } = harness({});
    await pipeline.start(imageInput({ captureId: `cap-r${i}`, emit })).done;
    assert.deepEqual(events.map(e => e.type), ['card.created', 'card.upgraded'], `run ${i}`);
  }
});

// ---- 补测（实现期追加，无删改先行断言）：快路失败降级 / 本地敏感路径 / 边界与兜底 ----

test('fast failure degrades: card.fast_failed emitted, deep lane still upgrades（快路失败不陪葬深路）', async () => {
  const fast = { model: 'qwen3.5-omni-flash', analyze: async () => { throw new Error('vision-timeout'); } };
  const { pipeline, events, emit } = harness({ fast });
  const done = await pipeline.start(imageInput({ emit })).done;
  assert.deepEqual(events.map(e => e.type), ['card.fast_failed', 'card.upgraded']);
  assert.equal(done.status, 'upgraded');
  assert.equal(done.card.seen, deepResult().seen, '深感知的 seen 直接成卡');
  assert.equal(done.card.contextDelta.seen, deepResult().seen, '快卡缺失时 ContextDelta 回退深感知 seen');
});

test('both lanes fail: done settles (never rejects) with status failed', async () => {
  const fast = { model: 'qwen3.5-omni-flash', analyze: async () => { throw new Error('vision-timeout'); } };
  const deep = { model: 'qwen3-vl-plus', analyze: async () => { throw new Error('vision-http-503'); } };
  const { pipeline, events, emit } = harness({ fast, deep });
  const done = await pipeline.start(imageInput({ emit })).done;
  assert.deepEqual(events.map(e => e.type), ['card.fast_failed', 'card.deep_failed']);
  assert.equal(done.status, 'failed');
  assert.equal(done.card, null);
});

test('sensitive hit with configured local adapter: upgraded locally via minicpm-v, cloud deep never called', async () => {
  const deep = makeVision(deepResult());
  const localCalls = [];
  const local = {
    model: 'minicpm-v',
    configured: true,
    analyze: async input => { localCalls.push(input); return deepResult(); },
  };
  const { pipeline, events, emit } = harness({
    deep,
    local,
    classify: () => ({ sensitive: true, category: 'bank-card', localOnly: true }),
  });
  const done = await pipeline.start(imageInput({ emit })).done;
  assert.equal(deep.calls.length, 0, '云端深感知绝不调用');
  assert.equal(localCalls.length, 1, '本地 minicpm-v 跑一次深分析');
  assert.deepEqual(events.map(e => e.type), ['card.created', 'card.sensitive', 'card.upgraded']);
  assert.equal(events[2].payload.model, 'minicpm-v');
  assert.equal(events[2].payload.localOnly, true);
  assert.equal(events[2].payload.contextDelta.evidence.imageRef, 'cap-1');
  assert.equal(done.status, 'local-only');
  assert.equal(done.keepOriginal, false);
  assert.equal(done.card.model, 'minicpm-v');
  assert.equal(done.card.localOnly, true);
});

test('sensitive hit but local adapter fails: card.local_failed, fast card retained local-only', async () => {
  const local = { model: 'minicpm-v', configured: true, analyze: async () => { throw new Error('local endpoint down'); } };
  const { pipeline, events, emit } = harness({
    local,
    classify: () => ({ sensitive: true, category: 'medical-record', localOnly: true }),
  });
  const done = await pipeline.start(imageInput({ emit })).done;
  assert.deepEqual(events.map(e => e.type), ['card.created', 'card.sensitive', 'card.local_failed']);
  assert.match(String(events[2].payload.error), /local endpoint down/);
  assert.equal(done.status, 'local-only');
  assert.equal(done.keepOriginal, false);
  assert.equal(done.card.level, 'fast', '快卡保留');
  assert.equal(done.card.localOnly, true);
});

test('video exactly MAX_SYNC_VIDEO_SEC stays synchronous and cleans up frame tempdir after deep', async () => {
  const deep = makeVision(deepResult());
  let cleaned = false;
  const fr = framesResult(MAX_SYNC_VIDEO_SEC);
  const extract = async input => ({ ...fr, cleanup: async () => { cleaned = true; throw new Error('cleanup boom'); } });
  const { pipeline, emit } = harness({ deep, probeVideo: async () => ({ durationSec: MAX_SYNC_VIDEO_SEC, hasAudio: false }), extractFrames: extract });
  const done = await pipeline.start(imageInput({ kind: 'video', path: '/data/alice/cap-30.mp4', mimeType: 'video/mp4', emit })).done;
  assert.equal(done.status, 'upgraded', '30s（含）同步走完双路');
  assert.equal(deep.calls.length, 1);
  assert.equal(cleaned, true, '深路结束后抽帧临时目录被清理（清理自身报错不拖垮结果）');
});

test('probe failure: done settles to status error with card.error event（fail-closed，done 永不 reject）', async () => {
  const deep = makeVision(deepResult());
  let extractCalled = 0;
  const { pipeline, events, emit } = harness({
    deep,
    probeVideo: async () => { throw new Error('ffprobe probe failed: no video stream'); },
    extractFrames: async () => { extractCalled++; return framesResult(10); },
  });
  const done = await pipeline.start(imageInput({ kind: 'video', path: '/data/alice/cap-p.mp4', mimeType: 'video/mp4', emit })).done;
  assert.equal(done.status, 'error');
  assert.match(String(done.error), /no video stream/);
  assert.deepEqual(events.map(e => e.type), ['card.error']);
  assert.equal(extractCalled, 0, 'probe 失败不抽帧');
  assert.equal(deep.calls.length, 0);
});

test('extractFrames failure: done settles to status error with card.error event（done 永不 reject）', async () => {
  const deep = makeVision(deepResult());
  const { pipeline, events, emit } = harness({
    deep,
    probeVideo: async () => ({ durationSec: 10, hasAudio: false }),
    extractFrames: async () => { throw new Error('frame extraction failed: ffmpeg exit 1'); },
  });
  const done = await pipeline.start(imageInput({ kind: 'video', path: '/data/alice/cap-x.mp4', mimeType: 'video/mp4', emit })).done;
  assert.equal(done.status, 'error');
  assert.match(String(done.error), /ffmpeg exit 1/);
  assert.deepEqual(events.map(e => e.type), ['card.error']);
  assert.equal(deep.calls.length, 0);
});

test('defaults wire the real Group1 modules: attributeCapture/classifySensitive/disk readImage; no emit still safe', async t => {
  const dir = mkdtempSync(join(tmpdir(), 'w12-pipe-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  const file = join(dir, 'cap-1'); // 故意无扩展名：连带覆盖 mimeType 缺省与 mimeOf 兜底分支
  const bytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 4]);
  writeFileSync(file, bytes);
  const fast = makeVision(fastResult());
  const deep = makeVision(deepResult());
  const pipeline = createPerceptionPipeline({ fast, deep }); // 其余全默认：真归属/真敏感判定/磁盘读图/默认 clock/默认 emit
  const started = pipeline.start({
    captureId: 'cap-d1',
    ownerId: 'alice',
    kind: 'image',
    path: file,
    capturedAt: '2026-10-26T19:05:00+08:00',
    uploadedAt: '2026-10-26T19:06:00+08:00',
    blocks: BLOCKS,
  });
  assert.deepEqual(started.attribution, { status: 'matched', blockId: 'b-shelf', confidence: 0.9 }, '真 attributeCapture 按窗口命中');
  const done = await started.done;
  assert.equal(fast.calls[0].images[0].imageBase64, bytes.toString('base64'), '磁盘加载为 base64 content part（vision.mjs 形状）');
  assert.equal(fast.calls[0].images[0].mimeType, 'image/jpeg', '无扩展名回退默认 MIME');
  assert.match(fast.calls[0].prompt, /做木书架/, '快提示词携带归属块标题');
  assert.equal(done.status, 'upgraded', '真 classifySensitive 判非敏感 → 深路照常');
  assert.equal(deep.calls[0].images[0].imageBase64, bytes.toString('base64'));
});

test('classify returning null（防御分支）is treated as non-sensitive: deep lane runs', async () => {
  const { pipeline, events, emit } = harness({ classify: () => null });
  const done = await pipeline.start(imageInput({ emit })).done;
  assert.equal(done.status, 'upgraded');
  assert.deepEqual(events.map(e => e.type), ['card.created', 'card.upgraded']);
});

test('non-Error throw surfaces as string in card.deep_failed payload', async () => {
  const deep = { model: 'qwen3-vl-plus', analyze: async () => { throw 'plain-string failure'; } }; // eslint-disable-line no-throw-literal
  const { pipeline, events, emit } = harness({ deep });
  const done = await pipeline.start(imageInput({ emit })).done;
  assert.equal(done.status, 'deep-failed');
  assert.equal(events[1].payload.error, 'plain-string failure');
});
