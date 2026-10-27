// S2D-W13 · M22 golden-handlers 定向单测（branch 覆盖补齐：防御分支/纯函数）。
//
// golden-scenarios.test.mjs 锁定 §5 场景语义（7 用例）；本文件覆盖场景面之外
// 的接缝行为：W1 sync 覆盖层的坏体/设备门、W4 确认的非法输入、A5 入口校验、
// mission 状态/run 前置、delivery 非 family 版本链与声明不符核验、trace 矩阵
// 的显式查询回放、scenarioParsePatch 纯规则表、构造参数校验。
// 全部经 createGoldenHarness（同一组合根 + 真实流件），零真实外呼。

import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';

import { createGoldenHarness } from './harness.mjs';
import { createScenarioParsePatch } from './golden-handlers.mjs';

test('createScenarioParsePatch：规则表纯函数（无匹配→none；时长/旁白→boundary.wont.add）', () => {
  const parsePatch = createScenarioParsePatch();
  assert.deepEqual(parsePatch('今天天气不错'), { patch: null, origin: 'none' });
  assert.deepEqual(parsePatch(''), { patch: null, origin: 'none' });
  const duration = parsePatch('把第二节时长改成 8 秒');
  assert.equal(duration.origin, 'rules');
  assert.deepEqual(duration.patch, { boundary: { wont: { add: ['时长超过 8 秒'] } } });
  const both = parsePatch('时长改成 30 秒，旁白去掉第一句');
  assert.deepEqual(both.patch, { boundary: { wont: { add: ['时长超过 30 秒', '旁白第一句'] } } });
  const narrationOnly = parsePatch('旁白去掉第一句就行');
  assert.deepEqual(narrationOnly.patch, { boundary: { wont: { add: ['旁白第一句'] } } });
});

test('blocks sync 覆盖层：坏 JSON 体（dispatcher 400）与非 {baseRevision,changes} 形状 → 400 CONTRACT_INVALID', async () => {
  const harness = await createGoldenHarness({ scenario: 'gh-blocks-guard' });
  try {
    const owner = harness.as('primary');
    const shaped = await owner.request('POST', '/api/blocks/sync', { nonsense: true });
    assert.equal(shaped.status, 400);
    assert.equal(shaped.body.error.code, 'CONTRACT_INVALID');
    // 坏 JSON：dispatcher 统一读体（harness 客户端恒带 json 头，手发坏体）
    const bad = await new Promise(resolve => {
      const req = http.request(
        { hostname: '127.0.0.1', port: harness.port, path: '/api/blocks/sync', method: 'POST', headers: { 'x-fixture-token': 'primary', 'x-tango-client': 'tango-settings/1', 'content-type': 'application/json' }, agent: false },
        res => {
          const chunks = [];
          res.on('data', c => chunks.push(c));
          res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) }));
        },
      );
      req.on('error', () => resolve({ status: -1, body: null }));
      req.end('{not-json');
    });
    assert.equal(bad.status, 400);
    assert.equal(bad.body.error.code, 'CONTRACT_INVALID');
  } finally {
    await harness.close();
  }
});

test('blocks：未知子路径由 W1 路由原样 404（不接管非 /api/blocks*）', async () => {
  const harness = await createGoldenHarness({ scenario: 'gh-blocks-404' });
  try {
    const owner = harness.as('primary');
    const unknown = await owner.request('DELETE', '/api/blocks/nonsense');
    assert.equal(unknown.status, 404);
    const outside = await owner.request('GET', '/api/not-blocks-at-all');
    assert.equal(outside.status, 404); // 无 handler 接管 → harness 冻结 404
  } finally {
    await harness.close();
  }
});

test('contracts：非法目标（无 goal/无 kind/无 action）→ 400；未签约 owner 确认 → 404 NOT_FOUND', async () => {
  const harness = await createGoldenHarness({ scenario: 'gh-contracts-guard' });
  try {
    const owner = harness.as('primary');
    const stranger = harness.as('secondary');
    assert.equal((await owner.request('POST', '/api/contracts/c/sign', { goal: '' })).status, 400);
    assert.equal((await owner.request('POST', '/api/actions/x/confirm', { kind: 'A9', action: 'email.send' })).status, 400);
    assert.equal((await owner.request('POST', '/api/actions/x/confirm', { kind: 'A4' })).status, 400);
    assert.equal((await owner.request('POST', '/api/actions/x/execute', { kind: 'A4', action: 'email.send' })).status, 400);
    const unsigned = await stranger.request('POST', '/api/actions/any/confirm', { kind: 'A4', action: 'email.send' });
    assert.equal(unsigned.status, 404);
    assert.equal(unsigned.body.error.code, 'NOT_FOUND');
  } finally {
    await harness.close();
  }
});

test('contracts：A5 自动执行 → 403 A5_NEVER_AUTOMATIC，零副作用（P0 fence）', async () => {
  const harness = await createGoldenHarness({ scenario: 'gh-a5' });
  try {
    const owner = harness.as('primary');
    const a5 = await owner.request('POST', '/api/actions/auto/execute', { kind: 'A5', action: 'money.transfer' });
    assert.equal(a5.status, 403);
    assert.equal(a5.body.error.details.internalCode, 'A5_NEVER_AUTOMATIC');
    assert.equal(harness.externalEffects().length, 0);
  } finally {
    await harness.close();
  }
});

test('missions：未知状态/未知任务/未 ready 起跑/无任务恢复 的防御分支', async () => {
  const harness = await createGoldenHarness({ scenario: 'gh-missions-guard' });
  try {
    const owner = harness.as('primary');
    assert.equal((await owner.request('POST', '/api/missions', { goal: '' })).status, 400);
    const mission = await owner.request('POST', '/api/missions', { goal: 'g' });
    assert.equal(mission.status, 200);
    assert.equal((await owner.request('POST', `/api/missions/${mission.body.id}/state`, { to: 'nonsense' })).status, 400);
    assert.equal((await owner.request('POST', '/api/missions/missing/state', { to: 'admitted' })).status, 404);
    assert.equal((await owner.request('POST', `/api/missions/${mission.body.id}/runs`, { steps: 1 })).status, 409); // 未 ready
    assert.equal((await owner.request('POST', '/api/runs/run-none/resume', {})).status, 404); // owner 无 runnable mission
    // 非法转迁（ready 之后再度 admitted：scanned→scan 不存在）→ 409
    for (const state of ['admitted', 'planning', 'ready']) {
      assert.equal((await owner.request('POST', `/api/missions/${mission.body.id}/state`, { to: state })).status, 200);
    }
    assert.equal((await owner.request('POST', `/api/missions/${mission.body.id}/state`, { to: 'admitted' })).status, 409);
  } finally {
    await harness.close();
  }
});

test('delivery：声明与引擎裁决不符的 verify → 400；未创建 family 的版本链走真实 store；benefit 空仓 → 0', async () => {
  const harness = await createGoldenHarness({ scenario: 'gh-delivery-guard' });
  try {
    const owner = harness.as('primary');
    const created = await owner.request('POST', '/api/artifacts', { version: 1, content: 'v1' });
    assert.equal(created.status, 200);
    const mismatch = await owner.request('POST', `/api/artifacts/${created.body.id}/verify`, { verdict: 'VERIFIED', check: { severity: 'LOW', status: 'UNKNOWN' } });
    assert.equal(mismatch.status, 400); // 引擎给 UNKNOWN，场景声明 VERIFIED → 以引擎为准拒绝
    const badPut = await owner.request('POST', '/api/artifacts', { version: 0, content: '' });
    assert.equal(badPut.status, 400);
    const chain = await owner.request('GET', `/api/artifacts/${created.body.id}/versions`);
    assert.equal(chain.status, 200); // family 已含该工件 → family 链
    const benefit = await owner.request('GET', '/api/artifacts/benefit');
    assert.equal(benefit.status, 200);
    assert.equal(benefit.body.count, 0); // 无 accepted → 0
    const foreign = await owner.request('GET', '/api/artifacts/artifact-not-mine');
    assert.equal(foreign.status, 404);
    assert.equal((await owner.request('GET', '/api/inbox')).status, 200);
  } finally {
    await harness.close();
  }
});

test('runs trace：POST 后 GET matrix 走缓存行；无 POST 时 GET 走 obs_spans 显式查询回放', async () => {
  const harness = await createGoldenHarness({ scenario: 'gh-trace-matrix' });
  try {
    const owner = harness.as('primary');
    const traced = await owner.request('POST', '/api/runs/run-m/trace', {
      actors: [{ actor: 'a1', resolvedModel: 'm1', modelSource: 'gateway' }],
    });
    assert.equal(traced.status, 200);
    const cached = await owner.request('GET', '/api/runs/run-m/matrix');
    assert.equal(cached.body.rows.length, 1);
    assert.equal(cached.body.rows[0].actor, 'a1');
    const replayed = await owner.request('GET', '/api/runs/run-never-traced/matrix');
    assert.equal(replayed.status, 200);
    assert.deepEqual(replayed.body.rows, []);
    assert.equal((await owner.request('POST', '/api/runs/run-m/trace', { actors: 'not-array' })).status, 200); // actors 非 array → 空行集
  } finally {
    await harness.close();
  }
});

test('captures：非法 fixture → 400；未知扫描回读 → 404；跨 owner 不可见', async () => {
  const harness = await createGoldenHarness({ scenario: 'gh-captures-guard' });
  try {
    const owner = harness.as('primary');
    const intruder = harness.as('secondary');
    assert.equal((await owner.request('POST', '/api/captures', { fixture: '' })).status, 400);
    assert.equal((await owner.request('GET', '/api/captures/cap-none/scan')).status, 404);
    const uploaded = await owner.request('POST', '/api/captures', { fixture: 'fixtures/capture-board.png' });
    assert.equal(uploaded.status, 200);
    assert.equal((await intruder.request('GET', `/api/captures/${uploaded.body.captureId}/scan`)).status, 404);
  } finally {
    await harness.close();
  }
});

test('构造守卫：缺 context/非组合根 → 拒绝构造', async () => {
  const { createGoldenScenarioHandlers } = await import('./golden-handlers.mjs');
  assert.throws(() => createGoldenScenarioHandlers({}), /integration context is required/);
  assert.throws(() => createGoldenScenarioHandlers({ context: { auth: null } }), /composed M13 root/);
});
