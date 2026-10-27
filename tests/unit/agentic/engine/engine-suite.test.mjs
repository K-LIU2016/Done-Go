// S2D-W2 · M7 engine-suite 跨模块冒烟单测（TDD 先行）
// 依据：.s2d/plan.md M7 subtask 2（M1–M6 公共 API 组合走一遍黄金路径最小版）；
//       BUILD-PLAN §3 W2 L103–110。本文件同时固定 scripts/agentic/engine/index.mjs
//       的 barrel 导出面（三工厂 + hash/db 工具，plan.md M7 files）。
// 黄金路径：内存库迁移 → 合同规范化+hash → Grant 发放/激活 → §8.2 判定放行 →
//           event-clock 定时器触发 → run-engine 3 步（含 outbox 动作登记+派发+
//           读回核验）→ 终态 succeeded + 审计在案。
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeClock, fakeSleeper, makeDb } from './helpers.mjs';
import {
  createEventClock, createRunEngine, createPolicyEngine, createOutbox,
  openEngineDb, applyEngineMigrations, canonicalJson, sha256Hex,
  contractHash, stepInputHash,
} from '../../../../scripts/agentic/engine/index.mjs';

test('golden path: policy → event-clock → run-engine+outbox compose to a succeeded run', { timeout: 30_000 }, async () => {
  const db = makeDb();
  const clock = fakeClock('2026-10-26T09:00:00+08:00');
  const sleeper = fakeSleeper();

  // barrel 面
  assert.equal(typeof openEngineDb, 'function');
  assert.equal(typeof applyEngineMigrations, 'function');
  assert.equal(typeof canonicalJson, 'function');
  assert.equal(typeof sha256Hex, 'function');
  assert.equal(typeof contractHash, 'function');
  assert.equal(typeof stepInputHash, 'function');

  const policy = createPolicyEngine({ db, now: clock.now });
  const { contract, hash } = await policy.normalizeContract({
    id: 'c_1', missionId: 'm_1', version: 1, autonomy: 'A2',
    will: ['检索公开资料'], wont: [],
    dataDisclosure: [{ dataClass: 'public', to: 'cloud-model', fields: ['*'] }],
    budget: { modelCalls: 40, tokens: 100000, costCap: null, localSlots: 1 },
    window: { prepStart: '2026-10-26T08:00:00+08:00', start: '2026-10-26T09:00:00+08:00', end: '2026-10-26T12:00:00+08:00', overrun: 'deliver_best' },
  });

  const issued = await policy.grantIssue({
    ownerId: 'o_1', actor: 'block-agent', contractHash: hash,
    capabilities: ['fs.read'], scope: { folders: ['/data/research'] },
    dataDisclosure: [{ dataClass: 'public', to: 'cloud-model', fields: ['*'] }],
    expiresAt: '2026-10-26T18:00:00+08:00',
  });
  await policy.grantActivate(issued.id);
  const verdict = await policy.decide({
    action: { key: 'read', capability: 'fs.read', resource: '/data/research/a.pdf', dataClass: 'public', autonomy: 'A2' },
    grant: policy.getGrant(issued.id), contract,
    spent: { modelCalls: 0, tokens: 0 }, estimate: { modelCalls: 1, tokens: 10 },
  });
  assert.equal(verdict.allow, true);

  const ec = createEventClock({ db, now: clock.now });
  const timer = ec.schedule('2026-10-26T09:05:00+08:00', { type: 'window.start', missionId: 'm_1' }, { dedupKey: 'm_1:start' });
  clock.advance(300);
  const fired = ec.tick();
  assert.equal(fired.length, 1);
  assert.equal(fired[0].id, timer);

  const outbox = createOutbox({ db });
  const engine = createRunEngine({ db, outbox, now: clock.now, sleep: sleeper.sleep, retryBaseMs: 10 });
  const run = engine.startRun({ missionId: 'm_1', contractHash: hash, dod: ['报告完成'], budget: { modelCalls: 40, tokens: 100000, costCap: null, localSlots: 1 } });
  await run.step('research', { q: 'k12' }, async (ctx) => { ctx.spend({ modelCalls: 1 }); return { docs: 5 }; });
  await run.step('deliver', { kind: 'notify' }, async (ctx) => {
    const entry = await ctx.registerAction({ actionKey: 'notify-1', payload: { to: 'user' } });
    const d = await outbox.dispatch(entry, {
      send: async () => ({ externalId: 'ext-1', receipt: { ok: true } }),
      verify: async () => ({ ok: true }),
    });
    assert.equal(d.status, 'verified');
    return 'delivered';
  });
  await run.step('wrap', { n: 1 }, async () => 'wrapped');
  await run.finish({ dodMet: true });

  assert.equal(engine.getRun(run.id).status, 'succeeded');
  assert.equal(outbox.listByStatus('verified').length, 1);
  const audits = policy.listAudit({ ownerId: 'o_1' });
  assert.ok(audits.length >= 2, 'Grant 发放/激活等全在审计中');
  db.close();
});
