// smoke.mjs 契约（BUILD-PLAN §3 W12-6 L146、§2.3 L65、PRD L499）：
// 真实冒烟台账——4 输入（CTO 白板/木工样张 + 自造延误屏/冰箱）× 快/深双路，记录
// 模型/延迟/建议质量，对照延迟目标 快≤2s、深≤8s；真实调用硬预算 ≤30 次（预算
// 耗尽即停，不超发）；key 经注入 getter（env DONEGO_GATEWAY_KEY → W0 gateway-key.mjs），
// 绝不进报告/日志。HTTP 冒烟走本流端口段 17651-17659（用完即关）。单测一律假件：
// 假模型（推进注入 clock 计时）、假 store/真 ':memory:' 库、环回 127.0.0.1，零真实外呼。
// 对应实现：scripts/agentic/perception/smoke.mjs
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import {
  LATENCY_TARGETS, SMOKE_CALL_BUDGET, SMOKE_PORTS, CTO_SAMPLE_DIR,
  defaultSmokeInputs, blocksFor, prepareSmokeInput, runSmoke, summarizeLedger,
  renderSmokeReport, createSmokeKeyGetter, buildCaptureMultipart,
  createSmokeHarness, smokeCaptureOverHttp,
} from '../../../../scripts/agentic/perception/smoke.mjs';
import { attributeCapture } from '../../../../scripts/agentic/perception/attribution.mjs';
import { parseMultipart } from '../../../../scripts/agentic/perception/multipart.mjs';
import { createPerceptionStore } from '../../../../scripts/agentic/perception/store.mjs';
import { jpegWithExif, PNG_BYTES } from './helpers.mjs';

function makeClock(start = 1_000_000) {
  let t = start;
  return { now: () => t, advance: ms => { t += ms; } };
}

const fastOk = () => ({ seen: '白板上写着 Q4 三个项目目标。', change: null, suggestion: null, actions: [] });
const deepOk = () => ({
  seen: '白板列出 Q4 三个目标，语音输入 11/15 上线。',
  change: '语音输入进度 11/15，落后计划',
  risk: '进度风险',
  suggestion: '生成纪要草稿，给「11/15 上线」加倒计时提醒',
  actions: ['记下来', '设提醒'],
});

/** 假输入件：临时目录里放真实字节（EXIF jpeg / 无 EXIF png），prepare 才有东西可读。 */
function tmpInput(t, { id = 'in-1', bytes = PNG_BYTES, name = 'shot.png', block } = {}) {
  const dir = mkdtempSync(join(tmpdir(), `w12-smoke-${randomUUID().slice(0, 8)}-`));
  const path = join(dir, name);
  writeFileSync(path, bytes);
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* best effort */ } });
  return { id, label: `测试输入 ${id}`, source: 'generated', path, how: '单测临时文件', block: block ?? { title: '产品周会', kind: 'meeting', note: '对目标' } };
}

test('常量：延迟目标 快≤2000ms / 深≤8000ms（PRD L499），真实调用预算 30（BUILD-PLAN L65），端口段 17651-17659', () => {
  assert.deepEqual(LATENCY_TARGETS, { fastMs: 2000, deepMs: 8000 });
  assert.equal(SMOKE_CALL_BUDGET, 30);
  assert.equal(SMOKE_PORTS[0], 17651);
  assert.equal(SMOKE_PORTS[SMOKE_PORTS.length - 1], 17659);
  assert.ok(SMOKE_PORTS.length >= 9);
});

test('defaultSmokeInputs：4 输入 = CTO 白板/木工 + 自造延误屏/冰箱，各带 PRD §6.8.3 场景块；自造件必须有造法记录', () => {
  const inputs = defaultSmokeInputs({ ctoDir: '/cto', fixtureDir: '/fix' });
  assert.deepEqual(inputs.map(i => i.id), ['whiteboard', 'craft', 'delay-board', 'fridge']);
  assert.deepEqual(inputs.map(i => i.source), ['cto', 'cto', 'generated', 'generated']);
  assert.equal(join('/cto', 'photo-whiteboard.jpg'), inputs[0].path);
  assert.equal(join('/cto', 'photo-craft.jpg'), inputs[1].path);
  assert.equal(join('/fix', 'delay-board.png'), inputs[2].path);
  assert.equal(join('/fix', 'fridge.png'), inputs[3].path);
  // 场景块对齐 PRD §6.8.3 四行：周会白板 / 木书架进度 / 车站延误屏 / 冰箱晚餐
  assert.deepEqual(inputs.map(i => i.block.title), ['产品周会', '做木书架', '去吃饭（通勤）', '做晚饭']);
  for (const i of inputs.filter(x => x.source === 'generated')) {
    assert.ok(typeof i.how === 'string' && i.how.length >= 10, `自造件 ${i.id} 需记录造法`);
  }
  for (const i of inputs) assert.ok(i.block.title && i.block.kind, `${i.id} 需带场景块`);
});

test('CTO 样张目录默认值与 BUILD-PLAN L146 路径一致', () => {
  assert.ok(CTO_SAMPLE_DIR.includes('scratchpad/media'), '指向 CTO 样张目录');
  assert.ok(defaultSmokeInputs()[0].path.endsWith('photo-whiteboard.jpg'));
});

test('blocksFor：以 capturedAt 为中心生成窗口块，归属即 matched 0.9（核心窗口）', () => {
  const input = defaultSmokeInputs()[0];
  const capturedAt = '2026-10-26T15:04:00+08:00';
  const blocks = blocksFor(input, capturedAt);
  assert.equal(blocks.length, 1);
  assert.equal(blocks[0].title, '产品周会');
  assert.equal(blocks[0].kind, 'meeting');
  assert.equal(blocks[0].start, '2026-10-26T14:54:00+08:00', 'capturedAt − 默认 10 分钟');
  assert.equal(blocks[0].end, '2026-10-26T16:54:00+08:00', 'capturedAt + 默认 110 分钟');
  assert.equal(attributeCapture({ blocks, capturedAt }).status, 'matched');
  assert.equal(attributeCapture({ blocks, capturedAt }).confidence, 0.9);
});

test('prepareSmokeInput：JPEG 读 EXIF 拍摄时间（Asia/Shanghai），PNG 无 EXIF 退回 now', async t => {
  const jpeg = tmpInput(t, { bytes: jpegWithExif({ dateTimeOriginal: '2026:10:26 19:05:00' }), name: 'photo.jpg' });
  const prepared = await prepareSmokeInput(jpeg, { now: () => '2026-10-27T10:00:00+08:00' });
  assert.equal(prepared.capturedAt, '2026-10-26T19:05:00+08:00');
  assert.equal(prepared.exifCaptured, true);

  const png = tmpInput(t, { bytes: PNG_BYTES, name: 'shot.png' });
  const p2 = await prepareSmokeInput(png, { now: () => '2026-10-27T10:00:00+08:00' });
  assert.equal(p2.capturedAt, '2026-10-27T10:00:00+08:00');
  assert.equal(p2.exifCaptured, false);
});

test('prepareSmokeInput：文件缺失抛 SMOKE_INPUT_MISSING（带 input id），真实冒烟先报缺件不瞎跑', async () => {
  const ghost = { id: 'ghost', label: '不存在的输入', source: 'generated', path: '/nonexistent/w12/ghost.png', how: 'x', block: { title: 't', kind: 'k' } };
  await assert.rejects(() => prepareSmokeInput(ghost), err => err.code === 'SMOKE_INPUT_MISSING' && err.inputId === 'ghost');
});

test('runSmoke：假模型 × 注入 clock——台账逐轮记 模型/耗时/输出，realCalls=快+深', async t => {
  const clock = makeClock();
  const fast = { model: 'qwen3.5-omni-flash', analyze: async () => { clock.advance(1500); return fastOk(); } };
  const deep = { model: 'qwen3-vl-plus', analyze: async () => { clock.advance(6000); return deepOk(); } };
  const inputs = [tmpInput(t, { id: 'wb' }), tmpInput(t, { id: 'fr' })];
  const out = await runSmoke({ inputs, fast, deep, repeat: 2, clock });
  assert.equal(out.rows.length, 4, '2 输入 × 2 轮');
  assert.equal(out.realCalls, 8, '每轮快+深各 1 次');
  assert.equal(out.budgetExhausted, false);
  assert.deepEqual(out.missing, []);
  const row = out.rows[0];
  assert.equal(row.input, 'wb');
  assert.equal(row.round, 1);
  assert.equal(row.status, 'upgraded');
  assert.equal(row.fast.ok, true);
  assert.equal(row.fast.model, 'qwen3.5-omni-flash');
  assert.equal(row.fast.ms, 1500, '耗时来自注入 clock');
  assert.ok(row.fast.seen.length > 0);
  assert.equal(row.deep.ok, true);
  assert.equal(row.deep.model, 'qwen3-vl-plus');
  assert.equal(row.deep.ms, 6000);
  assert.equal(row.deep.actions.length, 2);
  assert.ok(row.contextDelta && row.contextDelta.evidence.imageRef, 'ContextDelta 随升级卡入台账');
  assert.ok(row.suggestionCard.actions.length >= 1, '建议卡动作入台账');
});

test('runSmoke：预算耗尽即停（不超发）——budget 3 只够 1 轮，第 2 轮前刹车', async t => {
  const clock = makeClock();
  const fast = { model: 'f', analyze: async () => { clock.advance(100); return fastOk(); } };
  const deep = { model: 'd', analyze: async () => { clock.advance(100); return deepOk(); } };
  const inputs = [tmpInput(t, { id: 'a' }), tmpInput(t, { id: 'b' })];
  const out = await runSmoke({ inputs, fast, deep, repeat: 5, budget: 3, clock });
  assert.equal(out.rows.length, 1, '第 1 轮 2 次调用后，0+2 ≤ 3 允许、2+2 > 3 停');
  assert.equal(out.realCalls, 2);
  assert.equal(out.budgetExhausted, true);
});

test('runSmoke：深路失败——快卡保留入台账（status deep-failed），失败不中断其余输入', async t => {
  const clock = makeClock();
  const fast = { model: 'f', analyze: async () => { clock.advance(1200); return fastOk(); } };
  let n = 0;
  const deep = { model: 'd', analyze: async () => { n++; clock.advance(100); if (n === 1) throw new Error('vision-http-429'); return deepOk(); } };
  const inputs = [tmpInput(t, { id: 'a' }), tmpInput(t, { id: 'b' })];
  const out = await runSmoke({ inputs, fast, deep, repeat: 1, clock });
  assert.equal(out.rows.length, 2);
  const bad = out.rows[0];
  assert.equal(bad.status, 'deep-failed');
  assert.equal(bad.fast.ok, true, '快卡保留');
  assert.equal(bad.deep.ok, false);
  assert.match(bad.deep.error, /429/);
  assert.equal(out.rows[1].deep.ok, true, '后续输入继续');
  assert.equal(out.realCalls, 4);
});

test('runSmoke：敏感命中只走快路——deep 不调用（localOnly 台账化），realCalls 只计快', async t => {
  const clock = makeClock();
  const fast = { model: 'f', analyze: async () => ({ seen: '屏幕上是银行卡密码输入框', change: null, suggestion: null, actions: [] }) };
  const deep = { model: 'd', analyze: async () => { throw new Error('deep must not be called'); } };
  const inputs = [tmpInput(t, { id: 's' })];
  const out = await runSmoke({
    inputs, fast, deep, repeat: 1, clock,
    classifySensitive: () => ({ sensitive: true, category: 'bank-card', localOnly: true }),
  });
  assert.equal(out.rows[0].status, 'local-only');
  assert.equal(out.rows[0].localOnly, true);
  assert.equal(out.rows[0].deep, null, '深路未发生');
  assert.equal(out.rows[0].fast.ok, true);
  assert.equal(out.realCalls, 1);
});

test('runSmoke：缺件输入记入 missing、不炸整批（其余输入照跑）', async t => {
  const clock = makeClock();
  const fast = { model: 'f', analyze: async () => fastOk() };
  const deep = { model: 'd', analyze: async () => deepOk() };
  const ok = tmpInput(t, { id: 'ok' });
  const ghost = { id: 'ghost', label: '缺件', source: 'generated', path: '/nonexistent/x.png', how: 'x', block: { title: 't', kind: 'k' } };
  const out = await runSmoke({ inputs: [ghost, ok], fast, deep, repeat: 1, clock });
  assert.equal(out.rows.length, 1);
  assert.equal(out.missing.length, 1);
  assert.equal(out.missing[0].input, 'ghost');
  assert.equal(out.missing[0].code, 'SMOKE_INPUT_MISSING');
});

test('summarizeLedger：延迟中位数对照目标判 ok/over，无样本 no-data；min/median/max 齐全', () => {
  const row = (id, fms, dms, round = 1) => ({
    input: id, round, status: 'upgraded',
    fast: { ok: true, model: 'f', ms: fms, seen: 's' },
    deep: { ok: true, model: 'd', ms: dms, seen: 's', change: 'c', suggestion: '建议内容够长可执行', actions: ['记下来'] },
  });
  const rows = [row('a', 1800, 8100, 1), row('a', 1900, 7900, 2), row('b', 2200, null, 1)];
  rows[2].deep = { ok: false, error: 'vision-timeout' };
  rows[2].status = 'deep-failed';
  const s = summarizeLedger(rows);
  const a = s.perInput.find(x => x.id === 'a');
  assert.equal(a.fast.ms.min, 1800);
  assert.equal(a.fast.ms.median, 1850, '偶数样本取中位平均');
  assert.equal(a.fast.ms.max, 1900);
  assert.equal(a.fast.verdict, 'ok');
  assert.equal(a.fast.targetMs, LATENCY_TARGETS.fastMs);
  assert.equal(a.deep.verdict, 'ok', '深中位 8000 = 目标线，≤ 即达标');
  const b = s.perInput.find(x => x.id === 'b');
  assert.equal(b.fast.verdict, 'over');
  assert.equal(b.deep.verdict, 'no-data');
  assert.equal(s.totals.cases, 3);
  assert.equal(s.totals.fastOk, 3);
  assert.equal(s.totals.deepOk, 2);
});

test('summarizeLedger：建议质量启发式——seen/suggestion 非空 + 动作 ≥1 才 usable', () => {
  const rows = [
    { input: 'a', round: 1, status: 'upgraded',
      fast: { ok: true, model: 'f', ms: 1000, seen: '看到了东西' },
      deep: { ok: true, model: 'd', ms: 5000, seen: 'x', change: 'y', suggestion: '具体建议一句话', actions: ['记下来', '设提醒'] } },
    { input: 'b', round: 1, status: 'deep-failed',
      fast: { ok: true, model: 'f', ms: 1000, seen: '' },
      deep: { ok: false, error: 'vision-empty' } },
  ];
  const s = summarizeLedger(rows);
  assert.equal(s.perInput[0].quality.usableDeep, true);
  assert.equal(s.perInput[0].quality.actionCount, 2);
  assert.equal(s.perInput[1].quality.usableDeep, false);
  assert.equal(s.perInput[1].quality.usableFast, false, '快卡 seen 为空不可用');
});

test('renderSmokeReport：含目标对照/模型/逐轮延迟/建议原文/来源与造法/配额行，且不含任何 key', () => {
  const prepared = defaultSmokeInputs({ ctoDir: '/cto-samples', fixtureDir: '/fix' })[0];
  const rows = [{
    input: prepared.id, label: prepared.label, round: 1, status: 'upgraded', source: 'cto', path: prepared.path,
    attribution: { status: 'matched', blockId: 'blk-whiteboard', confidence: 0.9 }, blockId: 'blk-whiteboard',
    fast: { ok: true, model: 'qwen3.5-omni-flash', ms: 1450, seen: '白板三个目标' },
    deep: { ok: true, model: 'qwen3-vl-plus', ms: 6100, seen: '白板', change: '11/15 上线', suggestion: '生成纪要草稿与 3 条待办', actions: ['记下来', '设提醒'] },
    contextDelta: { blockId: 'blk-whiteboard', seen: '白板', change: '11/15', risk: null, evidence: { imageRef: 'cap_1' } },
    suggestionCard: { blockId: 'blk-whiteboard', summary: '生成纪要草稿与 3 条待办', actions: [{ id: 'act-1', label: '记下来' }] },
  }];
  const summary = summarizeLedger(rows);
  const md = renderSmokeReport({
    rows, summary,
    meta: {
      date: '2026-10-27', branch: 'feat/s2d-w12-perception', node: 'v22.22.2',
      inputs: defaultSmokeInputs({ ctoDir: '/cto-samples', fixtureDir: '/fix' }),
      realCalls: 2, budget: SMOKE_CALL_BUDGET, e2e: null,
    },
  });
  assert.match(md, /2000/); assert.match(md, /8000/);          // 延迟目标（PRD L499）
  assert.match(md, /qwen3\.5-omni-flash/); assert.match(md, /qwen3-vl-plus/);
  assert.match(md, /1450/); assert.match(md, /6100/);
  assert.match(md, /生成纪要草稿与 3 条待办/);                   // 建议原文（质量评估材料）
  assert.match(md, /photo-whiteboard\.jpg/);                    // CTO 样张来源
  assert.match(md, /PRD §6\.8\.2 L499/);
  assert.match(md, /2 \/ 30/);                                  // 配额行
  const secret = 'sk-secret-should-never-appear';
  assert.ok(!md.includes(secret));
});

test('createSmokeKeyGetter：env 优先，缺省走注入 fallback，错误原样传播；默认 fallback 指向 W0 gateway-key', async () => {
  const envKey = 'env-key-value';
  const get = createSmokeKeyGetter({ env: { DONEGO_GATEWAY_KEY: envKey }, fallback: () => { throw new Error('must not be called'); } });
  assert.equal(get(), envKey);
  let called = 0;
  const get2 = createSmokeKeyGetter({ env: {}, fallback: () => { called++; return 'w0-key'; } });
  assert.equal(get2(), 'w0-key');
  assert.equal(called, 1);
  const get3 = createSmokeKeyGetter({ env: {}, fallback: () => { const e = new Error('x'); e.code = 'GATEWAY_KEY_MISSING'; throw e; } });
  assert.throws(() => get3(), e => e.code === 'GATEWAY_KEY_MISSING');
  // 默认 fallback（未注入）= 动态加载 W0 gateway-key.mjs 的 gatewayKey()
  const mod = await import('../../../../scripts/agentic/gateway-key.mjs');
  assert.equal(typeof mod.gatewayKey, 'function');
});

test('buildCaptureMultipart：与 parseMultipart 往返一致（服务器端能原样解出文件）', () => {
  const data = jpegWithExif({ dateTimeOriginal: '2026:10:26 19:05:00' });
  const { body, contentType } = buildCaptureMultipart({ filename: 'photo.jpg', contentType: 'image/jpeg', data, boundary: 'w12smoke' });
  assert.match(contentType, /^multipart\/form-data; boundary=w12smoke$/);
  const parsed = parseMultipart(body, contentType, { maxBytes: 1 << 20 });
  assert.equal(parsed.files.length, 1);
  assert.equal(parsed.files[0].name, 'file');
  assert.equal(parsed.files[0].filename, 'photo.jpg');
  assert.ok(parsed.files[0].data.equals(data));
});

test('createSmokeHarness + smokeCaptureOverHttp：环回全链路——202→SSE card.created→card.upgraded→[DONE]，计时单调，端口在本流段且用完即还', async t => {
  const db = new DatabaseSync(':memory:');
  const store = createPerceptionStore({ db });
  const blocks = [{ id: 'blk-whiteboard', title: '产品周会', kind: 'meeting', start: '2026-10-26T14:50:00+08:00', end: '2026-10-26T17:00:00+08:00' }];
  const clock = makeClock();
  const fast = { model: 'qwen3.5-omni-flash', analyze: async () => { clock.advance(1400); return fastOk(); } };
  const deep = { model: 'qwen3-vl-plus', analyze: async () => { clock.advance(5900); return deepOk(); } };
  const { createPerceptionPipeline } = await import('../../../../scripts/agentic/perception/pipeline.mjs');
  const pipeline = createPerceptionPipeline({ fast, deep, clock });
  const dataDir = join(tmpdir(), `w12-smoke-http-${randomUUID()}`);
  mkdtempSync(dataDir);
  const auth = { authenticate: req => (req.headers.authorization === 'Bearer smoke-user' ? { id: 'smoke-owner' } : (() => { const e = new Error('unauthorized'); throw e; })()) };
  const h = await createSmokeHarness({ store, auth, pipeline, dataDir, getBlocks: async () => blocks, ports: SMOKE_PORTS });
  t.after(() => rmSync(dataDir, { recursive: true, force: true }));
  assert.ok(h.port >= 17651 && h.port <= 17659, `端口 ${h.port} 应在本流段 17651-17659`);
  const imagePath = tmpInput(t, { bytes: jpegWithExif({ dateTimeOriginal: '2026:10:26 15:04:00' }), name: 'photo.jpg' }).path;

  const out = await smokeCaptureOverHttp({ origin: h.origin, imagePath, token: 'smoke-user' });
  assert.equal(out.status, 202);
  assert.equal(out.attribution.status, 'matched');
  assert.equal(out.attribution.blockId, 'blk-whiteboard');
  const types = out.frames.map(f => f.type);
  assert.deepEqual(types, ['card.created', 'card.upgraded']);
  assert.equal(out.frames[0].model, 'qwen3.5-omni-flash');
  assert.equal(out.frames[1].suggestionCard.actions.length >= 1, true);
  assert.ok(typeof out.timings.uploadMs === 'number');
  assert.ok(out.timings.uploadMs <= out.timings.firstCardMs, '先有即时卡');
  assert.ok(out.timings.firstCardMs <= out.timings.upgradedMs, '后升级深卡');
  await h.close();
  // 端口归还：同端口可再次绑定
  const h2 = await createSmokeHarness({ store, auth, pipeline, dataDir, getBlocks: async () => blocks, ports: [h.port] });
  await h2.close();
});

test('createSmokeHarness：首选口被占自动顺延到段内下一口（EADDRINUSE 不外溢端口段）', async t => {
  const blocker = createServer(() => {});
  await new Promise(r => blocker.listen(17653, '127.0.0.1', r));
  t.after(() => new Promise(r => blocker.close(r)));
  const h = await createSmokeHarness({ ports: [17653, 17654], store: { async insertCapture(r) { return r; } }, auth: { authenticate: () => ({ id: 'x' }) }, pipeline: { start: () => ({}) }, dataDir: tmpdir() });
  t.after(() => h.close());
  assert.equal(h.port, 17654, '17653 被占，顺延用 17654');
});

test('smokeCaptureOverHttp：非 202（未带 token → 401）原样回报，计时字段 null 不炸', async t => {
  const h = await createSmokeHarness({
    ports: SMOKE_PORTS,
    store: { async insertCapture(r) { return r; }, async getCapture() { return undefined; } },
    auth: { authenticate() { const e = new Error('unauthorized'); e.status = 401; throw e; } },
    pipeline: { start: () => ({}) },
    dataDir: tmpdir(),
  });
  t.after(() => h.close());
  const imagePath = tmpInput(t, { name: 'photo.jpg', bytes: jpegWithExif({}) }).path;
  const out = await smokeCaptureOverHttp({ origin: h.origin, imagePath, token: 'wrong' });
  assert.equal(out.status, 401);
  assert.deepEqual(out.timings, { uploadMs: out.timings.uploadMs, firstCardMs: null, upgradedMs: null });
  assert.deepEqual(out.frames, []);
});

test('smokeCaptureOverHttp：SSE 帧也可来自 Node async-iterable body（readSse 双分支），[DONE] 即止', async () => {
  let call = 0;
  const sseBody = (async function* () {
    yield Buffer.from('data: ' + JSON.stringify({ type: 'card.created', model: 'm' }) + '\n\n');
    yield Buffer.from('data: [DONE]\n\n');
    yield Buffer.from('data: ' + JSON.stringify({ type: 'never-delivered' }) + '\n\n'); // [DONE] 后不再消费
  })();
  const fetchImpl = async () => {
    call++;
    return call === 1
      ? { status: 202, json: async () => ({ captureId: 'cap-x', attribution: { status: 'none', reason: 'no-window' } }) }
      : { body: sseBody };
  };
  const out = await smokeCaptureOverHttp({ origin: 'http://127.0.0.1:1', imagePath: '/dev/null', token: 't', fetchImpl, now: () => 5_000 });
  assert.equal(out.captureId, 'cap-x');
  assert.deepEqual(out.frames.map(f => f.type), ['card.created'], '[DONE] 后的内容不再进台账');
  assert.equal(out.timings.uploadMs, 0);
});

test('renderSmokeReport：失败轮/e2e/缺件/预算刹车各节如实渲染，不吞错误码', () => {
  const rows = [
    { input: 'x', label: 'L', round: 1, status: 'deep-failed', source: 'generated', path: '/p.png', how: 'h',
      attribution: { status: 'none', reason: 'no-window' }, blockId: null, error: null,
      fast: { ok: false, error: 'vision-timeout' }, deep: { ok: false, error: 'vision-http-500' },
      contextDelta: null, suggestionCard: null },
    { input: 'y', label: 'L2', round: 1, status: 'error', source: 'generated', path: '/q.png', how: 'h',
      attribution: { status: 'none', reason: 'no-blocks' }, blockId: null, error: 'frames probe failed',
      fast: null, deep: null, contextDelta: null, suggestionCard: null },
  ];
  const md = renderSmokeReport({
    rows, summary: summarizeLedger(rows),
    meta: {
      date: '2026-10-27', branch: 'b', node: 'v22', inputs: [], realCalls: 30, budget: 30, budgetExhausted: true,
      e2e: { status: 202, captureId: 'cap-e2e', attribution: { status: 'matched' }, frames: [{ type: 'card.created' }, { type: 'card.upgraded' }], timings: { uploadMs: 80, firstCardMs: 1900, upgradedMs: 7400 } },
      missing: [{ input: 'ghost', code: 'SMOKE_INPUT_MISSING', error: 'smoke input missing: ghost' }],
    },
  });
  assert.match(md, /vision-timeout/);
  assert.match(md, /vision-http-500/);
  assert.match(md, /未发生/);                    // 无 contextDelta 的轮次不编造字段
  assert.match(md, /已触发/);                    // 预算刹车
  assert.match(md, /30 \/ 30/);
  assert.match(md, /card\.created/);              // e2e 帧序列
  assert.match(md, /SMOKE_INPUT_MISSING/);       // 缺件错误码如实入报
  assert.match(md, /7400/);
});
