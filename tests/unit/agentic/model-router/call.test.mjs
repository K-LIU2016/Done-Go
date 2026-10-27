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
//     .complete(taskClass, messages, { dataClass, actor, ownerId, budget })
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

function makeService({ decision = selectedDecision(), responder, ledger } = {}) {
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
  ledger.record({ ownerId: 'owner-1', actor: 'a@w7', taskClass: 'reason', dataClass: 'public', model: 'gpt-6-sol', provenance: {}, status: 'selected' });
  ledger.record({ ownerId: 'owner-1', actor: 'a@w7', taskClass: 'code', dataClass: 'public', model: null, provenance: {}, status: 'unknown' });
  const mine = ledger.list({ ownerId: 'owner-1' });
  assert.equal(mine.length, 2);
  assert.deepEqual(ledger.list({ ownerId: 'owner-2' }), [], 'cross-owner ledger rows must be invisible');
  assert.equal(mine.find(r => r.status === 'unknown').model, null, 'UNKNOWN rows keep model=NULL');
});
