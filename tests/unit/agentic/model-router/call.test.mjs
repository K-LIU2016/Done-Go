// W7 M5 · model-router-call 单测（测试先行 · RED 基线）
//
// 钉住 `scripts/agentic/model-router/transport.mjs` + `call.mjs` +
// `scripts/agentic/db/migrations/w7-2-model-router.sql` 的契约（plan.md M5）。
// 绝不联网：fetch 全注入 mock；key 只经注入、不读不打印。
//
// API 契约：
//   createChatTransport({ baseUrl, apiKey, fetch, timeoutMs }) → { chat(payload) }
//     · POST `${baseUrl}/chat/completions`，headers: Authorization Bearer（注入 key）、JSON
//     · 2xx → 返回解析后的 JSON body；403 → 抛 FORBIDDEN（.status=403）
//     · 超时（AbortSignal）→ 抛 UPSTREAM_UNAVAILABLE
//   createSelectionLedger({ db }) → { record(sel), list({ownerId}) }   // 表 w7_model_selections
//   createCompletionService({ select, transport, ledger, clock })
//     .complete(taskClass, messages, { dataClass, actor, ownerId, budget, localAvailable })
//     · select port 鸭子类型同 M4 selectModel：localAvailable 原样透传、now 由注入 clock 派生
//     · router 判 unknown / 双方都无 model 来源 → { ok:false, reason:'no-model-source' }，
//       台账 model=NULL status='unknown'（actor 显式绑定模型：无 resolved model ≠ 完成）
//     · resolvedModel = response.model || selection.model
//     · 成功 → { ok:true, content, model: resolvedModel, usage, provenance }
//     · timeout → UPSTREAM_UNAVAILABLE；403 → FORBIDDEN；均记台账 status='failed' 再上抛
//     · secret → FORBIDDEN（transport 不得被调用）；budget.calls<=0 → BUDGET_EXCEEDED
import test from 'node:test';
import assert from 'node:assert/strict';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAgenticDb, migrate } from '../../../../scripts/agentic/db/index.mjs';
import { createChatTransport } from '../../../../scripts/agentic/model-router/transport.mjs';
import {
  createCompletionService,
  createSelectionLedger,
} from '../../../../scripts/agentic/model-router/call.mjs';
import { selectModel } from '../../../../scripts/agentic/model-router/router.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../');
const migrationsDir = join(root, 'scripts/agentic/db/migrations');

const NOW = '2026-10-27T08:30:00Z';
const BASE = 'http://127.0.0.1:17681/v1'; // 端口仅为 URL 拼接断言（brief 批准段 17681–17689），fetch 全 mock，不联网

function freshLedger() {
  const db = openAgenticDb(':memory:');
  migrate(db, migrationsDir);
  return { ledger: createSelectionLedger({ db }), db };
}

function mockFetch(responder) {
  const fn = async (url, init) => {
    fn.calls.push({ url, init });
    return responder(fn.calls.length, url, init);
  };
  fn.calls = [];
  return fn;
}

const okResponse = body => ({ status: 200, ok: true, json: async () => body });

function selectedDecision(model = 'gpt-6-sol') {
  return {
    status: 'selected', model, provider: 'codex', locality: 'cloud',
    provenance: { rule: 'reason→sol', inputsHash: 'a'.repeat(64), decidedAt: NOW }, reason: 'rule hit',
  };
}

const unknownDecision = () => ({
  status: 'unknown', provenance: { rule: 'no-rule', inputsHash: 'b'.repeat(64), decidedAt: NOW }, reason: 'no rule hit',
});

// ---------------- 迁移 ----------------

test('M5 · w7-2-model-router.sql 建出 w7_model_selections 台账', () => {
  const db = openAgenticDb(':memory:');
  const applied = migrate(db, migrationsDir);
  assert.ok(applied.includes('w7-2-model-router.sql'), `got ${applied}`);
  const row = db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='w7_model_selections'").get();
  assert.ok(row, 'ledger table must exist after migration');
});

// ---------------- transport（注入 fetch / key） ----------------

test('M5 · transport.chat：POST /chat/completions，Bearer=注入 key，body 透传', async () => {
  const fetcher = mockFetch(() => okResponse({ model: 'gpt-6-sol', choices: [{ message: { content: 'hi' } }] }));
  const transport = createChatTransport({ baseUrl: BASE, apiKey: 'injected-test-key', fetch: fetcher, timeoutMs: 1000 });
  const body = await transport.chat({ model: 'gpt-6-sol', messages: [{ role: 'user', content: 'q' }] });
  assert.equal(body.model, 'gpt-6-sol');
  assert.equal(fetcher.calls.length, 1);
  const { url, init } = fetcher.calls[0];
  assert.equal(url, `${BASE}/chat/completions`);
  assert.equal(init.method, 'POST');
  assert.equal(init.headers.Authorization, 'Bearer injected-test-key', 'key must come from injection only');
  assert.equal(JSON.parse(init.body).model, 'gpt-6-sol');
});

test('M5 负面 · transport 403 → FORBIDDEN（结构化上抛不吞）', async () => {
  const fetcher = mockFetch(() => ({ status: 403, ok: false, json: async () => ({ error: { message: 'denied' } }) }));
  const transport = createChatTransport({ baseUrl: BASE, apiKey: 'k', fetch: fetcher, timeoutMs: 1000 });
  await assert.rejects(
    () => transport.chat({ model: 'm', messages: [] }),
    err => err.code === 'FORBIDDEN' && err.status === 403,
  );
});

test('M5 负面 · transport timeout（AbortSignal）→ UPSTREAM_UNAVAILABLE', async () => {
  const fetcher = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => {
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  const transport = createChatTransport({ baseUrl: BASE, apiKey: 'k', fetch: fetcher, timeoutMs: 20 });
  await assert.rejects(
    () => transport.chat({ model: 'm', messages: [] }),
    err => err.code === 'UPSTREAM_UNAVAILABLE',
  );
});

// ---------------- complete：负面路径先行 ----------------

// 注：RED 基线此处原为 `decision = selectedDecision()`（对象），但 helper 会以
// 函数形式调用 decision(...)——实现前该文件在 import 阶段即整体失败，此潜在
// bug 从未暴露。修正为传工厂本身（断言全部保持不变，仅修 mock 接线）。
function makeService({ decision = selectedDecision, responder, ledger } = {}) {
  const fetcher = mockFetch(responder ?? (() => okResponse({
    model: 'gpt-6-sol', choices: [{ message: { content: 'answer' } }], usage: { total_tokens: 42 },
  })));
  const transport = createChatTransport({ baseUrl: BASE, apiKey: 'k', fetch: fetcher, timeoutMs: 1000 });
  const led = ledger ?? freshLedger().ledger;
  const select = async (taskClass, dataClass, opts) => decision(taskClass, dataClass, opts);
  const service = createCompletionService({ select, transport, ledger: led, clock: { now: () => Date.parse(NOW) } });
  return { service, fetcher, ledger: led };
}

const OPTS = { dataClass: 'public', actor: 'planner@w7', ownerId: 'owner-1', budget: { calls: 3, tokens: 9000 } };

test('M5 负面 · router 判 unknown → ok:false，台账 model=NULL status=unknown，transport 不被调', async () => {
  const { service, fetcher, ledger } = makeService({ decision: unknownDecision });
  const result = await service.complete('reason', [{ role: 'user', content: 'q' }], OPTS);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-model-source');
  assert.equal(fetcher.calls.length, 0, 'unknown selection must not call the transport');
  const rows = ledger.list({ ownerId: 'owner-1' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model, null);
  assert.equal(rows[0].status, 'unknown');
});

test('M5 负面 · transport 返回体无 model 且选择无 model → UNKNOWN 台账', async () => {
  let called = 0;
  const decision = () => { called += 1; return called === 1 ? selectedDecision('') : unknownDecision(); };
  const fetcher = mockFetch(() => okResponse({ choices: [{ message: { content: 'ghost' } }] })); // 无 response.model
  const led = freshLedger().ledger;
  const transport = createChatTransport({ baseUrl: BASE, apiKey: 'k', fetch: fetcher, timeoutMs: 1000 });
  const service = createCompletionService({
    select: decision, transport, ledger: led, clock: { now: () => Date.parse(NOW) },
  });
  // 选择给出空 model 字符串 = 无模型来源
  const result = await service.complete('reason', [{ role: 'user', content: 'q' }], OPTS);
  assert.equal(result.ok, false);
  assert.equal(result.reason, 'no-model-source');
  assert.equal(led.list({ ownerId: 'owner-1' })[0].status, 'unknown');
});

test('M5 正例 · response.model 缺失但选择带 model 来源 → resolvedModel=selection.model', async () => {
  const fetcher = mockFetch(() => okResponse({ choices: [{ message: { content: 'answer' } }] }));
  const led = freshLedger().ledger;
  const transport = createChatTransport({ baseUrl: BASE, apiKey: 'k', fetch: fetcher, timeoutMs: 1000 });
  const service = createCompletionService({
    select: async () => selectedDecision('gpt-6-sol'),
    transport, ledger: led, clock: { now: () => Date.parse(NOW) },
  });
  const result = await service.complete('reason', [{ role: 'user', content: 'q' }], OPTS);
  assert.equal(result.ok, true);
  assert.equal(result.model, 'gpt-6-sol', 'provenance is an acceptable model source');
  assert.equal(result.content, 'answer');
  const row = led.list({ ownerId: 'owner-1' })[0];
  assert.equal(row.model, 'gpt-6-sol');
  assert.equal(row.status, 'selected');
});

test('M5 负面 · transport timeout → UPSTREAM_UNAVAILABLE，台账 failed 后上抛', async () => {
  const fetcher = (url, init) => new Promise((_, reject) => {
    init.signal.addEventListener('abort', () => {
      const err = new Error('This operation was aborted');
      err.name = 'AbortError';
      reject(err);
    });
  });
  const led = freshLedger().ledger;
  const transport = createChatTransport({ baseUrl: BASE, apiKey: 'k', fetch: fetcher, timeoutMs: 20 });
  const service = createCompletionService({
    select: async () => selectedDecision(), transport, ledger: led, clock: { now: () => Date.parse(NOW) },
  });
  await assert.rejects(
    () => service.complete('reason', [{ role: 'user', content: 'q' }], OPTS),
    err => err.code === 'UPSTREAM_UNAVAILABLE',
  );
  const row = led.list({ ownerId: 'owner-1' })[0];
  assert.equal(row.status, 'failed');
  assert.equal(row.model, 'gpt-6-sol', 'ledger keeps the attempted model for audit');
});

test('M5 负面 · transport 403 → FORBIDDEN，台账 failed', async () => {
  const { service, ledger } = makeService({
    responder: () => ({ status: 403, ok: false, json: async () => ({}) }),
  });
  await assert.rejects(
    () => service.complete('reason', [{ role: 'user', content: 'q' }], OPTS),
    err => err.code === 'FORBIDDEN',
  );
  assert.equal(ledger.list({ ownerId: 'owner-1' })[0].status, 'failed');
});

test('M5 负面 · dataClass=secret → FORBIDDEN 且 transport 零调用', async () => {
  const boom = async () => { const err = new Error('secret must be rejected by the router'); err.code = 'FORBIDDEN'; throw err; };
  const { service, fetcher, ledger } = makeService({ decision: boom });
  await assert.rejects(
    () => service.complete('reason', [{ role: 'user', content: 'q' }], { ...OPTS, dataClass: 'secret' }),
    err => err.code === 'FORBIDDEN',
  );
  assert.equal(fetcher.calls.length, 0);
  assert.equal(ledger.list({ ownerId: 'owner-1' })[0].status, 'rejected');
});

test('M5 负面 · 预算耗尽（budget.calls=0）→ BUDGET_EXCEEDED，不选型不调用', async () => {
  const { service, fetcher } = makeService();
  await assert.rejects(
    () => service.complete('reason', [{ role: 'user', content: 'q' }], { ...OPTS, budget: { calls: 0, tokens: 100 } }),
    err => err.code === 'BUDGET_EXCEEDED',
  );
  assert.equal(fetcher.calls.length, 0);
});

// ---------------- 台账 owner 隔离 ----------------

test('M5 负面 · 台账跨 owner 查询隔离', async () => {
  const { ledger } = freshLedger();
  ledger.record({ ownerId: 'owner-1', actor: 'a@w7', taskClass: 'reason', dataClass: 'public', model: 'gpt-6-sol', provenance: { rule: 'r' }, status: 'selected' });
  ledger.record({ ownerId: 'owner-1', actor: 'a@w7', taskClass: 'code', dataClass: 'public', model: null, provenance: {}, status: 'unknown' });
  const mine = ledger.list({ ownerId: 'owner-1' });
  assert.equal(mine.length, 2);
  assert.deepEqual(ledger.list({ ownerId: 'owner-2' }), [], 'cross-owner ledger rows must be invisible');
  assert.equal(mine.find(r => r.status === 'unknown').model, null, 'UNKNOWN rows keep model=NULL');
  assert.deepEqual(mine.find(r => r.status === 'selected').provenance, { rule: 'r' }, 'provenance round-trips as parsed JSON');
});

// ---------------- 补充负面路径（fail-closed 构造/校验分支） ----------------

const rejectsCode = (promise, code) => assert.rejects(promise, err => err.code === code);

test('M5 负面 · transport 构造缺 baseUrl/apiKey/fetch/timeoutMs → CONTRACT_INVALID', () => {
  const fetcher = mockFetch(() => okResponse({}));
  const cases = [
    { fetch: fetcher, apiKey: 'k', timeoutMs: 10 },               // 缺 baseUrl
    { baseUrl: BASE, fetch: fetcher, timeoutMs: 10 },              // 缺 apiKey
    { baseUrl: BASE, apiKey: 'k', timeoutMs: 10 },                 // 缺 fetch（绝不回退全局 fetch）
    { baseUrl: BASE, apiKey: 'k', fetch: fetcher },                // 缺 timeoutMs
    { baseUrl: BASE, apiKey: 'k', fetch: fetcher, timeoutMs: 0 },  // 非正数
    { baseUrl: BASE, apiKey: 'k', fetch: fetcher, timeoutMs: 'x' },// 非数字
  ];
  for (const options of cases) {
    assert.throws(() => createChatTransport(options), err => err.code === 'CONTRACT_INVALID');
  }
});

test('M5 · baseUrl 尾斜杠归一后仍 POST /chat/completions', async () => {
  const fetcher = mockFetch(() => okResponse({ model: 'm' }));
  const transport = createChatTransport({ baseUrl: `${BASE}/`, apiKey: 'k', fetch: fetcher, timeoutMs: 1000 });
  await transport.chat({ model: 'm', messages: [] });
  assert.equal(fetcher.calls[0].url, `${BASE}/chat/completions`);
});

test('M5 负面 · chat 载荷非对象（null/数组）→ CONTRACT_INVALID', async () => {
  const transport = createChatTransport({ baseUrl: BASE, apiKey: 'k', fetch: mockFetch(() => okResponse({})), timeoutMs: 1000 });
  await rejectsCode(transport.chat(null), 'CONTRACT_INVALID');
  await rejectsCode(transport.chat([]), 'CONTRACT_INVALID');
});

test('M5 负面 · transport 401 → FORBIDDEN；429 → RATE_LIMITED；500 → UPSTREAM_UNAVAILABLE（带 status）', async () => {
  for (const [status, code] of [[401, 'FORBIDDEN'], [429, 'RATE_LIMITED'], [500, 'UPSTREAM_UNAVAILABLE']]) {
    const transport = createChatTransport({
      baseUrl: BASE, apiKey: 'k', timeoutMs: 1000,
      fetch: mockFetch(() => ({ status, ok: false, json: async () => ({}) })),
    });
    await assert.rejects(
      () => transport.chat({ model: 'm', messages: [] }),
      err => err.code === code && err.status === status,
    );
  }
});

test('M5 负面 · 2xx 响应非 JSON / JSON 非对象 / fetch 返回非对象 → UPSTREAM_UNAVAILABLE', async () => {
  const badJson = { status: 200, ok: true, json: async () => { throw new Error('not json'); } };
  const arrayBody = { status: 200, ok: true, json: async () => [] };
  for (const response of [badJson, arrayBody, null]) {
    const transport = createChatTransport({ baseUrl: BASE, apiKey: 'k', fetch: mockFetch(() => response), timeoutMs: 1000 });
    await rejectsCode(transport.chat({ model: 'm', messages: [] }), 'UPSTREAM_UNAVAILABLE');
  }
});

test('M5 负面 · ledger 构造缺 db / record 入参非法 → 结构化拒绝', () => {
  assert.throws(() => createSelectionLedger({}), /db handle is required/);
  const { ledger } = freshLedger();
  const base = { ownerId: 'o', actor: 'a', taskClass: 'reason', dataClass: 'public', model: null, provenance: null, status: 'unknown' };
  assert.throws(() => ledger.record(null), err => err.code === 'CONTRACT_INVALID');
  assert.throws(() => ledger.record({ ...base, status: 'bogus' }), err => err.code === 'CONTRACT_INVALID');
  assert.throws(() => ledger.record({ ...base, model: 42 }), err => err.code === 'CONTRACT_INVALID');
  assert.throws(() => ledger.record({ ...base, provenance: 'x' }), err => err.code === 'CONTRACT_INVALID');
  assert.throws(() => ledger.record({ ...base, ownerId: '' }), err => err.code === 'CONTRACT_INVALID');
  assert.throws(() => ledger.list({ ownerId: '' }), err => err.code === 'CONTRACT_INVALID');
  // '' model 归一为 NULL = UNKNOWN；recordedAt 可注入（确定性簿记）
  const row = ledger.record({ ...base, model: '', recordedAt: NOW }).record;
  assert.equal(row.model, null);
  assert.equal(ledger.list({ ownerId: 'o' })[0].recordedAt, NOW);
});

test('M5 负面 · service 构造缺 select/transport/ledger/clock → CONTRACT_INVALID', () => {
  const good = {
    select: async () => selectedDecision(),
    transport: createChatTransport({ baseUrl: BASE, apiKey: 'k', fetch: mockFetch(() => okResponse({})), timeoutMs: 10 }),
    ledger: freshLedger().ledger,
    clock: { now: () => Date.parse(NOW) },
  };
  const drop = key => { const options = { ...good }; delete options[key]; return options; };
  for (const key of ['select', 'transport', 'ledger', 'clock']) {
    assert.throws(() => createCompletionService(drop(key)), err => err.code === 'CONTRACT_INVALID', `missing ${key}`);
  }
  assert.throws(() => createCompletionService({ ...good, transport: {} }), err => err.code === 'CONTRACT_INVALID');
  assert.throws(() => createCompletionService({ ...good, ledger: {} }), err => err.code === 'CONTRACT_INVALID');
  assert.throws(() => createCompletionService({ ...good, clock: {} }), err => err.code === 'CONTRACT_INVALID');
});

test('M5 负面 · complete 入参缺失（taskClass/messages/opts/actor/ownerId/dataClass）→ CONTRACT_INVALID', async () => {
  const { service, fetcher } = makeService();
  await rejectsCode(service.complete('', [{ role: 'user', content: 'q' }], OPTS), 'CONTRACT_INVALID');
  await rejectsCode(service.complete('reason', [], OPTS), 'CONTRACT_INVALID');
  await rejectsCode(service.complete('reason', 'not-array', OPTS), 'CONTRACT_INVALID');
  await rejectsCode(service.complete('reason', [{ role: 'user', content: 'q' }], null), 'CONTRACT_INVALID');
  for (const key of ['actor', 'ownerId', 'dataClass']) {
    const bad = { ...OPTS }; delete bad[key];
    await rejectsCode(service.complete('reason', [{ role: 'user', content: 'q' }], bad), 'CONTRACT_INVALID', `missing ${key}`);
  }
  assert.equal(fetcher.calls.length, 0);
});

test('M5 负面 · 预算缺失或 tokens=0 → BUDGET_EXCEEDED（不选型不调用）', async () => {
  const { service, fetcher } = makeService();
  const noBudget = { ...OPTS }; delete noBudget.budget;
  await rejectsCode(service.complete('reason', [{ role: 'user', content: 'q' }], noBudget), 'BUDGET_EXCEEDED');
  await rejectsCode(
    service.complete('reason', [{ role: 'user', content: 'q' }], { ...OPTS, budget: { calls: 3, tokens: 0 } }),
    'BUDGET_EXCEEDED',
  );
  assert.equal(fetcher.calls.length, 0);
});

test('M5 负面 · select 抛结构化错误 → 台账 rejected 后原样上抛（不吞）', async () => {
  const original = new Error('router rejected');
  original.code = 'FORBIDDEN';
  const led = freshLedger().ledger;
  const service = createCompletionService({
    select: async () => { throw original; },
    transport: createChatTransport({ baseUrl: BASE, apiKey: 'k', fetch: mockFetch(() => okResponse({})), timeoutMs: 10 }),
    ledger: led,
    clock: { now: () => Date.parse(NOW) },
  });
  await assert.rejects(
    () => service.complete('reason', [{ role: 'user', content: 'q' }], OPTS),
    err => err === original, 'the router error must be rethrown as-is',
  );
  const row = led.list({ ownerId: 'owner-1' })[0];
  assert.equal(row.status, 'rejected');
  assert.equal(row.model, null);
  assert.equal(row.provenance, null);
});

test('M5 负面 · select 返回非对象 / 非法 status → CONTRACT_INVALID 且台账 rejected', async () => {
  for (const decision of [null, { status: 'bogus', provenance: {} }]) {
    const led = freshLedger().ledger;
    const service = createCompletionService({
      select: async () => decision,
      transport: createChatTransport({ baseUrl: BASE, apiKey: 'k', fetch: mockFetch(() => okResponse({})), timeoutMs: 10 }),
      ledger: led, clock: { now: () => Date.parse(NOW) },
    });
    await rejectsCode(service.complete('reason', [{ role: 'user', content: 'q' }], OPTS), 'CONTRACT_INVALID');
    assert.equal(led.list({ ownerId: 'owner-1' })[0].status, 'rejected');
  }
});

test('M5 · 成功路径透传 usage；provenance 非对象时按 null 记账', async () => {
  const led = freshLedger().ledger;
  const service = createCompletionService({
    select: async () => ({ ...selectedDecision(), provenance: 'not-an-object' }),
    transport: createChatTransport({
      baseUrl: BASE, apiKey: 'k', timeoutMs: 1000,
      fetch: mockFetch(() => okResponse({ model: 'gpt-6-sol', choices: [{ message: { content: 'answer' } }], usage: { total_tokens: 42 } })),
    }),
    ledger: led, clock: { now: () => Date.parse(NOW) },
  });
  const result = await service.complete('reason', [{ role: 'user', content: 'q' }], OPTS);
  assert.equal(result.ok, true);
  assert.deepEqual(result.usage, { total_tokens: 42 });
  const row = led.list({ ownerId: 'owner-1' })[0];
  assert.equal(row.provenance, null, 'malformed provenance is recorded as null, never guessed');
  assert.equal(row.recordedAt, new Date(Date.parse(NOW)).toISOString(), 'recorded_at derives from the injected clock');
});

// ---------------- select port 鸭子类型（M4 selectModel 直接接线） ----------------

test('M5 · select=selectModel 直接接线：complete 透传 localAvailable、now 由注入 clock 派生', async () => {
  // 文档契约（call.mjs 头注/JSDoc）：select 是 M4 selectModel 的鸭子类型 port，
  // W13 按文档 `select: selectModel` 接线必须开箱即用，不得在测试外重造适配器。
  const led = freshLedger().ledger;
  const service = createCompletionService({
    select: selectModel, // 直接注入 M4 真实现，零适配
    transport: { chat: async () => ({ model: 'gpt-6.1-sol', choices: [{ message: { content: 'hi' } }], usage: { total_tokens: 5 } }) },
    ledger: led,
    clock: { now: () => Date.parse(NOW) },
  });
  const result = await service.complete('code', [{ role: 'user', content: 'x' }], {
    ...OPTS, localAvailable: true,
  });
  assert.equal(result.ok, true);
  assert.equal(result.model, 'gpt-6.1-sol');
  // 红线⑥：select 收到的 now 必须由注入 clock 派生（毫秒 ISO 形式），不是真实 wall clock。
  assert.equal(result.provenance.decidedAt, new Date(Date.parse(NOW)).toISOString());
  assert.equal(led.list({ ownerId: 'owner-1' })[0].status, 'selected');
});

test('M5 负面 · select=selectModel 但 complete 未声明 localAvailable → CONTRACT_INVALID（不猜测本地可用性）', async () => {
  const led = freshLedger().ledger;
  const service = createCompletionService({
    select: selectModel,
    transport: { chat: async () => { throw new Error('must not be called'); } },
    ledger: led,
    clock: { now: () => Date.parse(NOW) },
  });
  await rejectsCode(service.complete('code', [{ role: 'user', content: 'x' }], OPTS), 'CONTRACT_INVALID');
  assert.equal(led.list({ ownerId: 'owner-1' })[0].status, 'rejected');
});
