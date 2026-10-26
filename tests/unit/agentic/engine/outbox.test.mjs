// S2D-W2 · M5 outbox 单测（TDD 先行：本文件即 outbox.mjs 的实现契约）
// 依据：BUILD-PLAN §3 W2-2 L107（outbox 半句：registered → dispatched →
//       verified|unknown|failed，unknown 不重做只对账）；PRD §9.2 L675、§8.4 L638；
//       V3-20（原子登记/幂等/稳定 ID 派发）、V3-21（读回核验，仅 2xx ≠ verified）、
//       V3-22（unknown 用原外部 ID 对账，禁止生成新 ID 重做）——权威定义
//       Done-Go-classic/docs/PRD-V3.md L273/275/277；.s2d/plan.md M5 subtasks 1–5。
//
// 被测契约：
//   createOutbox({db}) → { register, dispatch, reconcile, get, listByStatus, recover }
//   · register({runId, stepId, actionKey, payload}) → entry：同 action_key 幂等
//     （返回既有条目，不重复插行）；external_id 默认 = action_key（稳定 ID，V3-20）
//   · dispatch(entry, {send, verify})：
//       entry.status !== 'registered' → {dispatched:false, reason:'NOT_REGISTERED'}
//         （dispatched 之后绝不自动重发；run cancelled → reason:'RUN_CANCELLED'）
//       置 dispatched → send(payload)：
//         resolve {externalId?, receipt?} → externalId 写入（覆盖默认）→
//         verify({externalId, payload}) → {ok:true} → verified；
//         verify 抛错或 {ok:false} → unknown（仅 2xx/无读回 ≠ verified，V3-21）
//         send 抛错且 err.preSend === true（请求未离机，如连接被拒）→ failed，
//           attempts+1，可再次 dispatch 重试
//         send 其他失败（超时/断线）→ unknown，保留原 external_id（V3-22）
//   · reconcile(entry, {probe})：probe({externalId, actionKey}) →
//       {status:'verified'|'failed'|'unknown', receipt?} → verified|failed|
//       保持 unknown 且 entry.manual=1（人工接管标记，provider 无法安全查明）
//   · recover({send, verify, probe})：重启恢复一批——registered→派发（每条至多
//     send 一次）；dispatched 未核验→只用原 externalId verify（绝不 resend）；
//     unknown→probe 对账；返回处理统计
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { makeDb } from './helpers.mjs';
import { createOutbox } from '../../../../scripts/agentic/engine/outbox.mjs';

const okVerify = async () => ({ ok: true });

test('register persists a registered entry and is idempotent on action_key', () => {
  const db = makeDb();
  const outbox = createOutbox({ db });
  const a = outbox.register({ runId: 'r_1', stepId: 's_1', actionKey: 'send-email-1', payload: { to: 'a@b.c' } });
  const b = outbox.register({ runId: 'r_1', stepId: 's_1', actionKey: 'send-email-1', payload: { to: 'a@b.c' } });
  assert.equal(a.id, b.id, '同 action_key 返回既有条目（幂等）');
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM outbox WHERE action_key = ?').get('send-email-1').n, 1);
  assert.equal(a.status, 'registered');
  assert.equal(a.external_id, 'send-email-1', 'external_id 默认 = action_key（稳定 ID，V3-20）');
  db.close();
});

test('dispatch happy path: registered → dispatched → verified with read-back (V3-21)', async () => {
  const db = makeDb();
  const outbox = createOutbox({ db });
  const entry = outbox.register({ runId: 'r_1', stepId: 's_1', actionKey: 'send-email-1', payload: { to: 'a@b.c' } });
  let sent = null;
  let verifiedWith = null;
  const res = await outbox.dispatch(entry, {
    send: async (payload) => { sent = payload; return { externalId: 'prov-123', receipt: { id: 'prov-123' } }; },
    verify: async (ctx) => { verifiedWith = ctx; return { ok: true, fields: { delivered: true } }; },
  });
  assert.deepEqual(sent, { to: 'a@b.c' });
  assert.equal(verifiedWith.externalId, 'prov-123', 'verify 必须用 send 返回的外部 ID 读回');
  assert.equal(res.dispatched, true);
  assert.equal(res.status, 'verified');
  const row = outbox.get(entry.id);
  assert.equal(row.status, 'verified');
  assert.equal(row.external_id, 'prov-123');
  assert.ok(row.receipt, 'provider 回执落库（V3-21 先记录 receipt）');
  db.close();
});

test('2xx without successful read-back verification is NOT verified → unknown (V3-21)', async () => {
  const db = makeDb();
  const outbox = createOutbox({ db });
  const entry = outbox.register({ runId: 'r_1', stepId: 's_1', actionKey: 'send-email-1', payload: {} });
  const res = await outbox.dispatch(entry, {
    send: async () => ({ externalId: 'prov-123' }),
    verify: async () => ({ ok: false, fields: { delivered: false } }), // 读回不匹配
  });
  assert.equal(res.status, 'unknown', 'send 成功但读回核验不过 → unknown');
  assert.equal(outbox.get(entry.id).status, 'unknown');
  assert.equal(outbox.get(entry.id).external_id, 'prov-123', 'unknown 保留原 external_id');
  db.close();
});

test('send timeout/disconnect → unknown keeping original external_id; no auto redo (V3-22)', async () => {
  const db = makeDb();
  const outbox = createOutbox({ db });
  const entry = outbox.register({ runId: 'r_1', stepId: 's_1', actionKey: 'send-email-1', payload: {} });
  const res = await outbox.dispatch(entry, {
    send: async () => { const e = new Error('socket hang up'); e.code = 'ETIMEDOUT'; throw e; },
    verify: okVerify,
  });
  assert.equal(res.dispatched, true);
  assert.equal(res.status, 'unknown');
  const row = outbox.get(entry.id);
  assert.equal(row.status, 'unknown');
  assert.equal(row.external_id, 'send-email-1', '未拿到 provider ID 时保留稳定 action_key 作为原外部 ID');
  // 绝不自动重发：再 dispatch 拒绝
  let sends = 0;
  const again = await outbox.dispatch(row, { send: async () => { sends += 1; return { externalId: 'new-id' }; }, verify: okVerify });
  assert.equal(again.dispatched, false);
  assert.equal(again.reason, 'NOT_REGISTERED');
  assert.equal(sends, 0, 'unknown 条目不得生成新 ID 重做');
  db.close();
});

test('pre-send failure (request never left) → failed, retryable via re-dispatch', async () => {
  const db = makeDb();
  const outbox = createOutbox({ db });
  const entry = outbox.register({ runId: 'r_1', stepId: 's_1', actionKey: 'send-email-1', payload: {} });
  const refused = async () => { const e = new Error('connect ECONNREFUSED'); e.preSend = true; throw e; };
  const first = await outbox.dispatch(entry, { send: refused, verify: okVerify });
  assert.equal(first.status, 'failed', 'registered 状态发送前失败 → failed');
  assert.equal(first.attempts, 1);
  // failed 可按退避重试（测试零等待直接重试）
  const second = await outbox.dispatch(outbox.get(entry.id), {
    send: async () => ({ externalId: 'prov-9' }), verify: okVerify,
  });
  assert.equal(second.dispatched, true);
  assert.equal(second.status, 'verified');
  assert.equal(outbox.get(entry.id).attempts, 2);
  db.close();
});

test('reconcile: probe confirms → verified; denies → failed; unknowable → stays unknown + manual flag (V3-22)', async () => {
  const db = makeDb();
  const outbox = createOutbox({ db });
  const e1 = outbox.register({ runId: 'r', stepId: 's', actionKey: 'a-1', payload: {} });
  const e2 = outbox.register({ runId: 'r', stepId: 's', actionKey: 'a-2', payload: {} });
  const e3 = outbox.register({ runId: 'r', stepId: 's', actionKey: 'a-3', payload: {} });
  // 三个都打到 unknown
  for (const key of ['a-1', 'a-2', 'a-3']) {
    await outbox.dispatch(outbox.listByStatus('registered').find((e) => e.action_key === key), {
      send: async () => { throw new Error('timeout'); }, verify: okVerify,
    });
  }
  const confirmed = await outbox.reconcile(outbox.get(e1.id), { probe: async ({ externalId }) => ({ status: 'verified', receipt: { id: externalId } }) });
  assert.equal(confirmed.status, 'verified');
  assert.equal(outbox.get(e1.id).status, 'verified');

  const denied = await outbox.reconcile(outbox.get(e2.id), { probe: async () => ({ status: 'failed' }) });
  assert.equal(denied.status, 'failed');
  assert.equal(outbox.get(e2.id).status, 'failed');

  let probedWith = null;
  const unknowable = await outbox.reconcile(outbox.get(e3.id), {
    probe: async (ctx) => { probedWith = ctx; return { status: 'unknown' }; },
  });
  assert.equal(unknowable.status, 'unknown', 'provider 无法安全查明 → 保持 unknown');
  assert.equal(probedWith.externalId, 'a-3', '对账必须用原外部 ID');
  const row = outbox.get(e3.id);
  assert.equal(row.status, 'unknown');
  assert.equal(row.manual, 1, '给出人工接管标记');
  db.close();
});

test('recover after restart: registered dispatched once; dispatched verified without resend; unknown reconciled (mock counts)', async () => {
  const db = makeDb();
  const outbox = createOutbox({ db });
  // 崩溃点位 1：registered（尚未 send）
  const reg = outbox.register({ runId: 'r', stepId: 's', actionKey: 'k-registered', payload: { n: 1 } });
  // 崩溃点位 2：dispatched（send 已成功、verify 未跑）——直接把库置为该状态模拟
  const disp = outbox.register({ runId: 'r', stepId: 's', actionKey: 'k-dispatched', payload: { n: 2 } });
  db.prepare("UPDATE outbox SET status='dispatched', external_id='k-dispatched' WHERE id = ?").run(disp.id);
  // 崩溃点位 3：unknown（send 超时）
  const unk = outbox.register({ runId: 'r', stepId: 's', actionKey: 'k-unknown', payload: { n: 3 } });
  db.prepare("UPDATE outbox SET status='unknown', external_id='k-unknown' WHERE id = ?").run(unk.id);

  const counts = { send: 0, verify: 0, probe: 0 };
  const restarted = createOutbox({ db }); // 新实例 = 模拟重启
  const stats = await restarted.recover({
    send: async (payload) => { counts.send += 1; return { externalId: `prov-${payload.n}` }; },
    verify: async () => { counts.verify += 1; return { ok: true }; },
    probe: async () => { counts.probe += 1; return { status: 'verified' }; },
  });
  assert.equal(counts.send, 1, '只有 registered 条目被 send（恰好一次）');
  assert.equal(counts.verify, 2, 'registered→派发后核验 + dispatched→原 ID 补核验');
  assert.equal(counts.probe, 1, 'unknown 只走 probe 对账');
  assert.deepEqual(stats, { dispatched: 1, verified: 3, reconciled: 1 }, '统计口径：1 派发、3 终态 verified、1 条经对账');
  assert.equal(restarted.get(reg.id).status, 'verified');
  assert.equal(restarted.get(disp.id).external_id, 'k-dispatched', 'dispatched 条目核验不换外部 ID');
  assert.equal(restarted.get(disp.id).status, 'verified');
  assert.equal(restarted.get(unk.id).status, 'verified');
  db.close();
});
