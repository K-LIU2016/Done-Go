// S2D-W13 · M21 集成 harness 自测（plan.md §G4）。
//
// 被测件：tests/agentic/integration/harness.mjs —— fixture 登录、dispatcher 挂载、
// 假模型 transport / 假 checker / 假 gateway / W12 vision mock / W4 副作用台账、
// 临时 SQLite、端口 17701–17709、SSE 收集器（事件序列/HTTP/最终状态落证据）。
//
// 本文件只测 harness 基础设施本身；brief §5 黄金场景语义归 M22
// （golden-scenarios.test.mjs，依赖本 harness 的注入位）。
//
// 红线锚定：harness 是 localhost-only 测试设施——业务时间戳一律注入式确定性
// 时钟，源码禁 Date.now/new Date()/process.env/fetch，网络只绑 127.0.0.1。
// TDD：harness 未实现时每个用例独立 RED（ERR_MODULE_NOT_FOUND）。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import net from 'node:net';
import { SideEffectFence } from '../../../scripts/agentic/autonomy/side-effect-fence.mjs';
import { loadSchema, validate } from '../../../scripts/agentic/contracts.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const contractDir = join(here, '../../../contracts/agentic');

// 惰性加载被测件：模块缺失时逐用例 RED，而非整文件一个错。
let modulePromise = null;
const load = () => {
  modulePromise ??= import('./harness.mjs');
  return modulePromise;
};

const inRange = (port, H) => Number.isInteger(port) && port >= H.HARNESS_PORT_RANGE.min && port <= H.HARNESS_PORT_RANGE.max;

// 小工具：轮询等待谓词为真（测试编排用，非业务时间戳）。
async function eventually(fn, label, timeoutMs = 4000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = fn();
    if (value) return value;
    if (Date.now() > deadline) throw new Error(`eventually: timed out waiting for ${label}`);
    await new Promise(resolve => setTimeout(resolve, 10));
  }
}

function occupyPort(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => resolve(server));
  });
}

// ---------------- 端口段（17701–17709；17711–17719 归 release 健康检查） ----------------

test('M21: pickHarnessPort stays inside the W13 harness segment 17701-17709', async () => {
  const { HARNESS_PORT_RANGE, pickHarnessPort } = await load();
  const inSeg = port => inRange(port, { HARNESS_PORT_RANGE });

  const free = await pickHarnessPort();
  assert.ok(inSeg(free), `default allocation must be in 17701-17709, got ${free}`);

  const preferred = await pickHarnessPort(17705);
  assert.equal(preferred, 17705, 'a free preferred port is honoured');

  const squatter = await occupyPort(17705);
  try {
    const fallback = await pickHarnessPort(17705);
    assert.ok(inSeg(fallback) && fallback !== 17705, `busy preferred falls back inside the range, got ${fallback}`);
  } finally {
    await new Promise(resolve => squatter.close(resolve));
  }

  await assert.rejects(() => pickHarnessPort(9999), /range/i, 'out-of-range preferred ports are rejected, never silently honoured');
});

// ---------------- fixture 登录 ----------------

test('M21: fixture auth maps x-fixture-token to frozen principals, synchronously', async () => {
  const { FIXTURE_PRINCIPALS, createFixtureAuth } = await load();
  const auth = createFixtureAuth();
  const principal = auth({ headers: { 'x-fixture-token': 'primary' } });
  assert.equal(principal.ownerId, 'owner-a');
  assert.equal(principal.id, 'owner-a', 'W1/W12 路由读 principal.id，必须自带');

  assert.equal(auth({ headers: { 'x-fixture-token': 'nobody' } }), null, 'unknown token → null');
  assert.equal(auth({ headers: {} }), null, 'missing token → null');
  assert.notEqual(Object.prototype.toString.call(auth), '[object AsyncFunction]', 'resolver must stay synchronous (W10)');

  // 同 owner 双设备（golden-6 前提）
  assert.equal(FIXTURE_PRINCIPALS['device-a'].ownerId, 'owner-a');
  assert.equal(FIXTURE_PRINCIPALS['device-b'].ownerId, 'owner-a');
  assert.notEqual(FIXTURE_PRINCIPALS['device-a'].device, FIXTURE_PRINCIPALS['device-b'].device);
});

test('M21: fixture auth rejects principal registries without ownerId/id', async () => {
  const { createFixtureAuth } = await load();
  assert.throws(() => createFixtureAuth({ principals: { bad: { ownerId: 'o' } } }), /ownerId|id/i);
});

// ---------------- 确定性时钟 ----------------

test('M21: harness clock is deterministic and only advance() moves it', async () => {
  const { createDeterministicClock } = await load();
  const clock = createDeterministicClock({ startIso: '2026-10-28T10:00:00.000Z' });
  const first = clock.now();
  assert.equal(clock.now(), first, 'repeat calls are stable');
  assert.equal(clock.nowMs(), Date.parse(first));
  const moved = clock.advance(1500);
  assert.equal(Date.parse(moved) - Date.parse(first), 1500);
  assert.equal(clock.now(), moved);
  // 错误信息必须同时含 ms 与 milliseconds（M21 根因修复；校验本身不放宽）
  for (const bad of ['later', Number.NaN, Number.POSITIVE_INFINITY, null]) {
    assert.throws(
      () => clock.advance(bad),
      err => /ms/.test(err.message) && /milliseconds/.test(err.message),
      `advance(${String(bad)}) must be rejected naming ms/milliseconds`,
    );
  }
});

// ---------------- 假模型 transport（W7 modelCaller 注入位） ----------------

test('M21: fake model transport records calls, plays scripted results, tallies per run', async () => {
  const { createFakeModelTransport } = await load();
  const transport = createFakeModelTransport({ model: 'fake-glm' });
  const ok = await transport({ runId: 'run-1', prompt: 'hi', attempt: 1 });
  assert.equal(ok.ok, true);
  assert.equal(ok.model, 'fake-glm');
  assert.ok(ok.usage && typeof ok.usage === 'object');

  transport.enqueue({ ok: false, error: 'MODEL_UNRESOLVED', model: null });
  transport.enqueue({ ok: true, model: 'fake-glm', content: 'second chance', usage: { inputTokens: 2, outputTokens: 2 } });
  const failed = await transport({ runId: 'run-2', attempt: 1 });
  const retried = await transport({ runId: 'run-2', attempt: 2 });
  assert.equal(failed.ok, false);
  assert.equal(retried.content, 'second chance');

  assert.equal(transport.successfulResultsFor('run-1'), 1, 'ok && model≠null 才算真实成功');
  assert.equal(transport.successfulResultsFor('run-2'), 1, 'not-ok 脚本结果不计成功（resolved_model=NULL→UNKNOWN 语义）');
  assert.equal(transport.retryCount('run-2'), 1, 'attempt>1 计一次重试');
  assert.equal(transport.retryCount('run-1'), 0);
  assert.equal(transport.calls.length, 3);
  transport.reset();
  assert.equal(transport.calls.length, 0);
});

// ---------------- 假 checker（W9 verify 注入位） ----------------

test('M21: fake checkers default to PASS and can be scripted per checker', async () => {
  const { createFakeCheckers } = await load();
  const fake = createFakeCheckers();
  const verdictDefault = await fake.checkers.dod({ id: 'a1', version: 1 }, ['DoD'], { clock: { now: () => 0 } });
  assert.equal(verdictDefault.status, 'PASS');

  fake.script('citation', { status: 'FAIL', severity: 'HIGH', reason: 'citation missing' });
  const verdictScripted = await fake.checkers.citation({ id: 'a1', version: 1 }, [], {});
  assert.equal(verdictScripted.status, 'FAIL');
  assert.equal(verdictScripted.severity, 'HIGH');
  assert.equal(fake.calls.length, 2, '每次 checker 调用都入台账');
});

// ---------------- 假 gateway（W8 上游注入位；零真实网络） ----------------

test('M21: fake gateway records sends and answers from a script, never the network', async () => {
  const { createFakeGateway } = await load();
  const gateway = createFakeGateway();
  gateway.enqueue({ ok: true, reply: 'gateway-scripted' });
  const first = await gateway.send({ method: 'codex.turn', params: {} });
  const second = await gateway.send({ method: 'codex.turn', params: {} });
  assert.equal(first.reply, 'gateway-scripted');
  assert.equal(second.ok, true, 'script 耗尽后回退确定性默认应答');
  assert.equal(gateway.calls.length, 2);
});

// ---------------- W12 vision mock（pipeline.start 注入位） ----------------

test('M21: vision mock honours the W12 pipeline.start contract {done, attribution}', async () => {
  const { createVisionMock } = await load();
  const vision = createVisionMock();
  const events = [];
  const card = { blockId: 'blk-9', title: '现场白板', sources: 'discussion', length: 8 };
  vision.enqueueCard(card);
  const result = vision.start({
    captureId: 'cap-1', ownerId: 'owner-a', kind: 'image', path: '/tmp/fixture.png',
    mimeType: 'image/png', capturedAt: '2026-10-28T09:00:00.000Z', uploadedAt: '2026-10-28T09:00:01.000Z',
    blocks: [{ id: 'blk-9' }],
    emit: async (type, payload) => { events.push({ type, payload }); },
  });
  assert.ok(result.done && typeof result.done.then === 'function');
  assert.ok(result.attribution && typeof result.attribution === 'object');
  const done = await result.done;
  assert.equal(done.status, 'upgraded');
  assert.equal(done.card.title, '现场白板');
  assert.equal(vision.calls.length, 1);
  assert.ok(events.some(e => e.type === 'card.created'), 'must emit card.created like the real pipeline');
});

// ---------------- W4 副作用台账 + fence 配对 ----------------

test('M21: side-effect ledger records performs and pairs with the W4 fence (A5 → zero effects)', async () => {
  const { createDeterministicClock, createSideEffectLedger } = await load();
  const clock = createDeterministicClock({ startIso: '2026-10-28T10:00:00.000Z' });
  const ledger = createSideEffectLedger({ now: clock.now });
  const done = await ledger.perform('email.send', { to: 'self', subject: '周报' });
  // M21 根因修复：perform 返回 { status, effectId, effect }——调用方直取
  // effectId，status/effect 语义保留给 W4 fence（execute 包成 succeeded/output）
  assert.equal(done.status, 'performed');
  assert.equal(typeof done.effectId, 'string');
  assert.ok(done.effectId.length > 0);
  assert.equal(done.effect.kind, 'email.send');
  assert.equal(done.effect.at, clock.now(), '时间戳来自注入时钟');
  assert.equal(ledger.effects().length, 1);
  assert.equal(ledger.count('email.send'), 1);
  assert.equal(ledger.effects()[0].effectId, done.effectId, '台账与返回值指向同一条副作用');

  const fence = new SideEffectFence({ clock: () => clock.now(), phase: 'P0' });
  const blocked = await fence.execute(
    { action: { risk: 'external', requestedAutonomy: 'A5', actor: { actorId: 'actor-1', resolvedModel: 'fake-glm' } } },
    ledger.asExecutor('money.transfer', { amount: 1 }),
  );
  assert.equal(blocked.status, 'blocked');
  assert.equal(blocked.code, 'A5_NEVER_AUTOMATIC');
  assert.equal(ledger.count('money.transfer'), 0, '被 fence 拒绝的动作绝不产生副作用');
});

// ---------------- SSE 收集器 ----------------

function sseProbeHandler(req, res, pathname, env) {
  if (req.method !== 'GET' || pathname !== '/api/probe/sse') return false;
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
  res.write(`data: ${JSON.stringify({ seq: 1 })}\n\n`);
  res.write(`data: ${JSON.stringify({ seq: 2 })}\n\n`);
  // 保持 handler 未决直到断开/结束：dispatcher 在 handle 返回后即拆 client_disconnect
  // 监听（finally detach），同步返回 true 会丢断开记录（M14 SSE 语义）。
  return new Promise(resolve => {
    env.signal.addEventListener('abort', () => {
      res.end();
      resolve(true);
    });
    res.on('close', () => resolve(true));
  });
}

test('M21: SSE collector gathers ordered frames and surfaces non-SSE error bodies', async () => {
  const { createSseCollector } = await load();
  await usingHarness({ scenario: 'sse-selftest', handlers: [sseProbeHandler] }, async harness => {
    const session = await harness.as('primary').sse('/api/probe/sse');
    try {
      await eventually(() => session.frames().length >= 2, 'two SSE frames');
      const [first, second] = session.frames();
      assert.equal(first.seq, 1);
      assert.equal(second.seq, 2);
      assert.equal(session.status, 200);
      assert.match(session.contentType, /^text\/event-stream/);
    } finally {
      session.close();
    }
    await eventually(() => session.state() === 'closed', 'session closed');

    // 未登录 SSE 路径收到的是 JSON 401 信封——收集器不得误报为事件流
    const rejected = await createSseCollector().collect({ baseUrl: harness.baseUrl, path: '/api/probe/sse' });
    assert.equal(rejected.status, 401);
    assert.equal(rejected.state(), 'closed');
    assert.equal(rejected.frames().length, 0);
    assert.match(String(rejected.contentType), /^application\/json/);
  });
});

// ---------------- 组装：golden harness ----------------

test('M21: createGoldenHarness boots 127.0.0.1:<17701-17709> with health mounted and fixture login', async () => {
  await usingHarness({ scenario: 'boot-selftest' }, async harness => {
    assert.ok(inRange(harness.port, { HARNESS_PORT_RANGE: { min: 17701, max: 17709 } }), `port in 17701-17709, got ${harness.port}`);
    assert.equal(harness.baseUrl, `http://127.0.0.1:${harness.port}`);

    const health = await harness.request('GET', '/api/agentic/health');
    assert.equal(health.status, 200);
    assert.equal(health.body.status, 'ok');
    assert.ok(Array.isArray(health.body.db.migrations) && health.body.db.migrations.length > 0, 'temp SQLite 经 W0 migrate 单台账');

    const owner = await harness.as('primary').request('GET', '/api/agentic/health');
    assert.equal(owner.status, 200);

    const anon = await harness.request('GET', '/api/probe/secret');
    assert.equal(anon.status, 401);
    assert.equal(anon.body.error.code, 'AUTH_REQUIRED');

    const missing = await harness.as('primary').request('GET', '/api/definitely/not/mounted');
    assert.equal(missing.status, 404);
    assert.equal(missing.body.error.code, 'NOT_FOUND');
    assert.equal(typeof missing.body.error.requestId, 'string');
  });
});

test('M21: dispatcher mounting is ordered; first handler wins; unhandled falls to legacy', async () => {
  const first = (req, res, pathname) => {
    if (pathname !== '/api/probe/x') return false;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ handler: 'first' }));
    return true;
  };
  const second = (req, res, pathname) => {
    if (!pathname.startsWith('/api/probe/')) return false;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ handler: 'second' }));
    return true;
  };
  const legacy = (req, res, pathname) => {
    if (pathname !== '/legacy/only') return false;
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ handler: 'legacy' }));
    return true;
  };
  await usingHarness({ scenario: 'dispatch-order', handlers: [first, second], legacy }, async harness => {
    const exact = await harness.as('primary').request('GET', '/api/probe/x');
    assert.equal(exact.body.handler, 'first', '先注册的精确路径先赢');
    const broad = await harness.as('primary').request('GET', '/api/probe/y');
    assert.equal(broad.body.handler, 'second');
    const leg = await harness.as('primary').request('GET', '/legacy/only');
    assert.equal(leg.body.handler, 'legacy', '未处理请求落回 legacy');
  });
});

test('M21: withJsonBody bridges dispatcher env.readBody into req.json() for flow routes', async () => {
  const { withJsonBody } = await load();
  const flowShaped = withJsonBody(async (req, res) => {
    const input = await req.json();
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ token: req.headers['x-fixture-token'], echoed: input }));
    return true;
  });
  await usingHarness({ scenario: 'json-bridge', handlers: [flowShaped] }, async harness => {
    const res = await harness.as('primary').request('POST', '/api/probe/json', { hello: 'w13' });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.echoed, { hello: 'w13' });
    assert.equal(res.body.token, 'primary');
  });
});

test('M21: harness.adapt feeds the execution layer gate; drafts stay UNKNOWN in the sync layer', async () => {
  await usingHarness({ scenario: 'adapt-selftest' }, async harness => {
    const complete = {
      id: 'blk-ok-1', revision: 1, date: '2026-10-29', start: '09:00', end: '10:00',
      title: '晨间写作', kind: 'create', prio: 2, note: '', done: false, source: 'web',
      deleted_at: null, updated_at: '2026-10-28T09:30:00.000Z',
    };
    const draft = { ...complete, id: 'blk-draft-1', start: null, end: null, source: 'draft' };

    const good = harness.adapt(complete);
    assert.equal(good.ok, true);
    assert.equal(good.block.ownerId, 'owner-a', 'owner 一律来自 fixture 会话，不采信 DTO');
    assert.deepEqual(harness.executionLayerBlocks().map(b => b.id), ['blk-ok-1']);

    const bad = harness.adapt(draft);
    assert.equal(bad.ok, false);
    assert.equal(bad.outcome, 'UNKNOWN');
    assert.deepEqual([...bad.missing].sort(), ['end', 'start']);
    assert.equal(bad.executionReady, false);
    assert.equal(harness.executionLayerBlocks().length, 1, '被拒行不得进入执行层');

    const events = harness.events();
    assert.ok(events.some(e => e.type === 'block.execution_ready' && e.blockId === 'blk-ok-1'));
    assert.ok(events.some(e => e.type === 'block.stays_in_sync_layer' && e.outcome === 'UNKNOWN'));
  });
});

test('M21: client disconnect on SSE is recorded as outcome=UNKNOWN, never swallowed', async () => {
  await usingHarness({ scenario: 'sse-disconnect', handlers: [sseProbeHandler] }, async harness => {
    const session = await harness.as('primary').sse('/api/probe/sse');
    await eventually(() => session.frames().length >= 1, 'first frame');
    session.close();
    const event = await eventually(
      () => harness.events().find(e => e.type === 'client_disconnect'),
      'client_disconnect event',
    );
    assert.equal(event.outcome, 'UNKNOWN');
    assert.equal(event.pathname, '/api/probe/sse');
  });
});

// 同步返回形态的 SSE handler：写完头/首帧即 return true，响应保持开放——
// 真实长连接 handler 的合法形态。dispatcher 必须在 handle() 返回后继续保留
// 断连监听（M21 根因修复；修复前 finally 立即拆监听会丢 client_disconnect）。
function sseSyncReturnHandler(req, res, pathname) {
  if (req.method !== 'GET' || pathname !== '/api/probe/sse-sync') return false;
  res.writeHead(200, { 'content-type': 'text/event-stream; charset=utf-8', 'cache-control': 'no-store' });
  res.write(`data: ${JSON.stringify({ seq: 1 })}\n\n`);
  return true;
}

test('M21: sync-returning SSE handler keeps the disconnect watch; client cut still records UNKNOWN', { timeout: 20000 }, async () => {
  await usingHarness({ scenario: 'sse-sync-disconnect', handlers: [sseSyncReturnHandler] }, async harness => {
    const session = await harness.as('primary').sse('/api/probe/sse-sync');
    await eventually(() => session.frames().length >= 1, 'first frame from sync handler');
    session.close();
    const event = await eventually(
      () => harness.events().find(e => e.type === 'client_disconnect' && e.pathname === '/api/probe/sse-sync'),
      'client_disconnect for the sync-returning SSE stream',
    );
    assert.equal(event.outcome, 'UNKNOWN');
  });
});

test('M21: short requests record no disconnect and close() completes without hanging', { timeout: 20000 }, async () => {
  await usingHarness({ scenario: 'short-request-lifecycle' }, async harness => {
    const ok = await harness.as('primary').request('GET', '/api/agentic/health');
    assert.equal(ok.status, 200);
    const missing = await harness.as('primary').request('GET', '/api/definitely/not/mounted');
    assert.equal(missing.status, 404, '开放监听不改变未挂载路径的 404 语义');
    await eventually(
      () => harness.httpJournal().filter(row => row.pathname === '/api/agentic/health').length === 1,
      'journal row',
    );
    assert.equal(
      harness.events().filter(e => e.type === 'client_disconnect').length,
      0,
      '正常短请求不得产生 client_disconnect（无假阳性）',
    );
  });
  // usingHarness 的 finally 已 await close()：在 timeout 内走到这里即证明拆机
  // 完成——短请求不留监听、不挂 server.close（M21 回归证明）。
});

test('M21: HTTP journal + evidence capture event sequence, exchanges and final state', async () => {
  const evidenceDir = await mkdtemp(join(tmpdir(), 'w13-harness-evidence-'));
  try {
    await usingHarness({ scenario: 'evidence-selftest', evidenceDir }, async harness => {
      await harness.as('primary').request('GET', '/api/agentic/health');
      assert.deepEqual(harness.externalEffects(), []);
      const snapshot = harness.evidence();
      assert.equal(snapshot.scenario, 'evidence-selftest');
      assert.ok(snapshot.http.some(row => row.pathname === '/api/agentic/health' && row.status === 200));
      assert.ok(Array.isArray(snapshot.events));
      assert.ok(snapshot.finalState && typeof snapshot.finalState === 'object');
    });
    const files = readdirSync(evidenceDir).filter(name => name.endsWith('.json'));
    assert.equal(files.length, 1, 'close() 落一份证据 JSON');
    const persisted = JSON.parse(readFileSync(join(evidenceDir, files[0]), 'utf8'));
    assert.equal(persisted.scenario, 'evidence-selftest');
    assert.ok(persisted.http.length >= 1);
    assert.ok(Array.isArray(persisted.externalEffects));
  } finally {
    await rm(evidenceDir, { recursive: true, force: true });
  }
});

test('M21: close() shuts the server, closes the db and removes the temp SQLite dir', async () => {
  const { createGoldenHarness } = await load();
  const harness = await createGoldenHarness({ scenario: 'close-selftest' });
  const dbFile = harness.dbFile;
  const dir = harness.tempDir;
  assert.ok(existsSync(dbFile), 'temp SQLite 落盘');
  await harness.as('primary').request('GET', '/api/agentic/health');
  await harness.close();
  assert.equal(existsSync(dbFile), false, 'close() 清理临时库文件');
  assert.equal(existsSync(dir), false, 'close() 清理临时目录');
  await assert.rejects(
    () => harness.as('primary').request('GET', '/api/agentic/health'),
    /ECONNREFUSED|closed/i,
    'server 已关停',
  );
});

// ---------------- 红线自审（harness 源码） ----------------

test('M21: harness source self-audit — deterministic time, no env/key reads, localhost-only networking', async () => {
  await load();
  const source = readFileSync(join(here, 'harness.mjs'), 'utf8');
  assert.ok(!source.includes('Date.now('), 'no wall clock reads');
  assert.ok(!/new Date\(\s*\)/.test(source), 'no wall clock construction (no-arg Date is the only forbidden form; new Date(epochMs) converts an injected/deterministic epoch)');
  assert.ok(!source.includes('process.env'), 'no environment/key reads');
  assert.ok(!/\bfetch\s*\(/.test(source), 'no fetch calls');
  assert.ok(!/child_process/.test(source), 'no subprocess');
  for (const match of source.matchAll(/listen\(([^)]*)\)/g)) {
    assert.ok(match[1].includes("'127.0.0.1'"), `listen must bind 127.0.0.1 only: listen(${match[1]})`);
  }
  assert.ok(source.includes('hostname: url.hostname'), 'HTTP client targets the baseUrl host only');
});

// ---------------- 契约有效性（adapt 产物过冻结 schema） ----------------

test('M21: adapted execution blocks satisfy the frozen block schema', async () => {
  await usingHarness({ scenario: 'schema-selftest' }, async harness => {
    const blockSchema = loadSchema('block.schema.json', contractDir);
    const complete = {
      id: 'blk-schema-1', revision: 1, date: '2026-10-29', start: '09:00', end: '10:00',
      title: '晨间写作', kind: 'create', prio: 2, note: '', done: false, source: 'web',
      deleted_at: null, updated_at: '2026-10-28T09:30:00.000Z',
    };
    const result = harness.adapt(complete);
    assert.equal(result.ok, true);
    const check = validate(result.block, blockSchema, { schemaDir: contractDir });
    assert.equal(check.valid, true, JSON.stringify(check.errors));
  });
});

// ---------------- 守卫与边界（构造期拒绝、段耗尽、非 JSON 容错、证据落盘失败） ----------------

test('M21: pickHarnessPort refuses to leave the segment when all nine ports are busy', async () => {
  const { pickHarnessPort } = await load();
  const squatters = [];
  try {
    for (let p = 17701; p <= 17709; p++) {
      try {
        squatters.push(await occupyPort(p));
      } catch {
        // 端口已被他人占用同样计入 busy
      }
    }
    await assert.rejects(() => pickHarnessPort(), /no free port left/);
  } finally {
    await Promise.all(squatters.map(server => new Promise(resolve => server.close(resolve))));
  }
  const again = await pickHarnessPort();
  assert.ok(again >= 17701 && again <= 17709, '释放后段内可再次分配');
});

test('M21: vision mock scripting surface — setDone/setAttribution, default card, emit failure never rejects done', async () => {
  const { createVisionMock } = await load();
  const scripted = createVisionMock();
  scripted.setDone({ status: 'local-only', keepOriginal: false, card: { blockId: 'b' } });
  scripted.setAttribution({ status: 'matched', blockId: 'blk-1', confidence: 0.9 });
  const r1 = scripted.start({ captureId: 'c1', ownerId: 'owner-a', blocks: [{ id: 'blk-1' }], emit: async () => {} });
  assert.equal(r1.attribution.status, 'matched');
  assert.equal((await r1.done).status, 'local-only');

  // 无脚本卡 → 用 job 素材构造默认卡（blocks[0].id）
  const fresh = createVisionMock();
  const r2 = fresh.start({ captureId: 'c2', ownerId: 'owner-a', blocks: [{ id: 'blk-2' }], emit: async () => {} });
  const done2 = await r2.done;
  assert.equal(done2.status, 'upgraded');
  assert.equal(done2.card.blockId, 'blk-2');

  // emit 抛错 → done 永不 reject（真实管线契约），结算 failed 终态
  const boom = createVisionMock();
  const r3 = boom.start({ captureId: 'c3', ownerId: 'owner-a', blocks: [], emit: async () => { throw new Error('emit boom'); } });
  const done3 = await r3.done;
  assert.equal(done3.status, 'failed');
});

function textProbeHandler(req, res, pathname) {
  if (pathname !== '/api/probe/text') return false;
  res.writeHead(200, { 'content-type': 'text/plain' });
  res.end('plain-hello');
  return true;
}

function sseRawFrameHandler(req, res, pathname, env) {
  if (req.method !== 'GET' || pathname !== '/api/probe/sse-raw') return false;
  res.writeHead(200, { 'content-type': 'text/event-stream' });
  res.write('data: not-json\n\n');
  return new Promise(resolve => {
    env.signal.addEventListener('abort', () => {
      res.end();
      resolve(true);
    });
    res.on('close', () => resolve(true));
  });
}

test('M21: clients tolerate non-JSON bodies and raw (non-JSON) SSE frames', async () => {
  await usingHarness({ scenario: 'text-paths', handlers: [textProbeHandler, sseRawFrameHandler] }, async harness => {
    const owner = harness.as('primary');
    const text = await owner.request('GET', '/api/probe/text');
    assert.equal(text.status, 200);
    assert.equal(text.body, 'plain-hello', '非 JSON body 原样返回文本');

    const viaCollector = await owner.sse('/api/probe/text');
    assert.equal(viaCollector.state(), 'closed');
    assert.equal(viaCollector.body, 'plain-hello');

    const session = await owner.sse('/api/probe/sse-raw');
    try {
      await eventually(() => session.frames().length >= 1, 'raw frame');
      assert.equal(session.frames()[0], 'not-json', '非 JSON 帧按原字符串收集');
    } finally {
      session.close();
    }
  });
});

test('M21: construction and usage guards reject bad input loudly', async () => {
  const { createGoldenHarness, withJsonBody, createDeterministicClock, createFakeCheckers } = await load();
  assert.throws(() => createDeterministicClock({ startIso: 'not-a-date' }), /ISO-8601/);
  assert.throws(() => createFakeCheckers().script('nope', {}), /unknown checker/);
  assert.throws(() => withJsonBody('nope'), /handler function/);
  await assert.rejects(() => createGoldenHarness({ scenario: 'g', port: 17700 }), /17701-17709/);
  await assert.rejects(() => createGoldenHarness({ scenario: 'g', handlers: [{}] }), /handlers must be an array/);
  await assert.rejects(() => createGoldenHarness({ scenario: 'g', legacy: 'x' }), /legacy must be a function/);

  const harness = await createGoldenHarness({ scenario: 'guards' });
  try {
    assert.throws(() => harness.as('ghost'), /unknown fixture owner key/);
    assert.throws(() => harness.adapt({ id: 'x' }, 'ghost'), /unknown fixture owner key/);
  } finally {
    await harness.close();
  }
});

test('M21: evidence persistence failure never blocks teardown', async () => {
  const { createGoldenHarness } = await load();
  const blocker = join(tmpdir(), 'w13-harness-evidence-blocker');
  writeFileSync(blocker, 'not-a-dir', 'utf8');
  try {
    const harness = await createGoldenHarness({ scenario: 'evidence-fail', evidenceDir: blocker });
    await harness.as('primary').request('GET', '/api/agentic/health');
    await harness.close(); // 证据写入 ENOTDIR 被吞，拆机照常完成
    assert.equal(existsSync(harness.dbFile), false, '临时库照常清理');
  } finally {
    rmSync(blocker, { force: true });
  }
});

// ---------------- helpers ----------------

async function usingHarness(options, run) {
  const { createGoldenHarness } = await load();
  const harness = await createGoldenHarness(options);
  try {
    return await run(harness);
  } finally {
    await harness.close();
  }
}
