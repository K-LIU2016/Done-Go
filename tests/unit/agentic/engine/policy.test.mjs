// S2D-W2 · M4 policy 单测（TDD 先行：本文件即 policy.mjs 的实现契约）
// 依据：BUILD-PLAN §3 W2-3 L108（§8.2 判定 + Grant 生命周期 + 审计；A4 永远逐次
//       确认；系统默认禁止项不可被合同覆盖）；PRD §8.1 L593–614（Contract 规格、
//       SYSTEM_WONT 六条）、§8.2 L619–626（七条件）、§8.4 L635–638（审计）、
//       §4.2 L191（grant 状态机）、§4.3 L201–212（A0–A5）；V3-19；
//       .s2d/plan.md M4 subtasks 1–6（越权用例表 ≥20 条）。
//
// 被测契约：
//   export const SYSTEM_WONT = [六条默认禁止]
//   createPolicyEngine({db, now}) → { normalizeContract, decide, grantIssue,
//     grantActivate, grantConsume, grantRevoke, grantInvalidateForContract,
//     getGrant, listAudit }
//   · normalizeContract(contract) → { contract, hash }：wont 并入 SYSTEM_WONT；
//     contract.will 与 SYSTEM_WONT 相交 → 抛 {code:'SYSTEM_WONT_IMMUTABLE'}；
//     autonomy 非 A1|A2|A3 → 抛 {code:'AUTONOMY_OUT_OF_CONTRACT'}（§8.1 L599）
//   · decide({action, grant, contract, spent, estimate}) → {allow, reason, need?}
//     判定顺序：Grant 生命周期（proposed/consumed/revoked/expired/invalidated/hash
//     不匹配）→ SYSTEM_WONT → A5/A4 → 七条件；拒绝原因代码：
//     GRANT_NOT_ACTIVE / GRANT_CONSUMED / GRANT_REVOKED / GRANT_EXPIRED /
//     GRANT_INVALIDATED / SYSTEM_WONT / A5_NEVER_AUTO / A4_REQUIRES_CONFIRMATION /
//     AUTONOMY_EXCEEDED / CAPABILITY_NOT_GRANTED / RESOURCE_OUT_OF_SCOPE /
//     DATA_CLASS_NOT_DISCLOSED / BUDGET_EXCEEDED / OUT_OF_WINDOW
//   · action = {key, capability, resource, dataClass|dataClasses, autonomy}
//   · Grant 状态机：issue→proposed，activate→active，consume→consumed（一次性，
//     二次消费拒绝），revoke→revoked，expires_at 过后在 decide 时惰性置 expired，
//     grantInvalidateForContract(hash)→invalidated（V3-19 精准失效）
//   · 审计（§8.4）：发放/激活/消费/撤销/失效/过期与**所有判定拒绝**都写 audit
//     （owner_id、actor、action、contract_hash、outcome、external_id、created_at）
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { fakeClock, makeDb } from './helpers.mjs';
import { createPolicyEngine, SYSTEM_WONT } from '../../../../scripts/agentic/engine/policy.mjs';

const NOW_IN_WINDOW = '2026-10-26T09:30:00+08:00';

const baseContract = () => ({
  id: 'c_1', missionId: 'm_1', version: 1, hash: null,
  goal: '整理课程设计', deliverables: [], definitionOfDone: ['课件完成'],
  autonomy: 'A3',
  will: ['检索公开资料', '写入交付库'], wont: ['不访问社媒账号'],
  needs: [],
  capabilities: [{ capability: 'fs.read', scope: { folders: ['/data/research'] } }],
  dataDisclosure: [{ dataClass: 'public', to: 'cloud-model', fields: ['*'] }],
  budget: { modelCalls: 40, tokens: 100000, costCap: null, localSlots: 1 },
  window: {
    prepStart: '2026-10-26T08:00:00+08:00',
    start: '2026-10-26T09:00:00+08:00',
    end: '2026-10-26T12:00:00+08:00',
    overrun: 'deliver_best',
  },
  interruption: 'needs_only',
});

const baseAction = () => ({
  key: 'read-source', capability: 'fs.read', resource: '/data/research/paper.pdf',
  dataClass: 'public', autonomy: 'A2',
});

const baseGrantSpec = () => ({
  ownerId: 'owner-1', actor: 'block-agent', contractHash: 'h'.repeat(64),
  capabilities: ['fs.read'], scope: { folders: ['/data/research'] },
  dataDisclosure: [{ dataClass: 'public', to: 'cloud-model', fields: ['*'] }],
  expiresAt: '2026-10-26T18:00:00+08:00',
});

function freshEngine(opts = {}) {
  const db = makeDb();
  const clock = fakeClock(NOW_IN_WINDOW);
  clock.set(NOW_IN_WINDOW);
  const engine = createPolicyEngine({ db, now: clock.now });
  return { db, clock, engine, ...opts };
}

/** 发一个已激活、绑定给定合同的 Grant。 */
async function activeGrant(engine, contract, over = {}) {
  const issued = await engine.grantIssue({ ...baseGrantSpec(), contractHash: contract.hash, ...over });
  await engine.grantActivate(issued.id);
  return engine.getGrant(issued.id);
}

async function decideCase(engine, over = {}) {
  const contract = (await engine.normalizeContract(baseContract())).contract;
  const grant = await activeGrant(engine, contract);
  return engine.decide({
    action: baseAction(), grant, contract,
    spent: { modelCalls: 10, tokens: 1000 }, estimate: { modelCalls: 1, tokens: 100 },
    ...over,
  });
}

test('SYSTEM_WONT carries the six PRD §8.1 default prohibitions', () => {
  assert.equal(SYSTEM_WONT.length, 6);
  const joined = SYSTEM_WONT.join('|');
  assert.ok(joined.includes('付款'), '不付款下单');
  assert.ok(joined.includes('发送'), '不以本人名义对外发送（除非逐次确认）');
  assert.ok(joined.includes('凭据'), '不读取凭据');
  assert.ok(joined.includes('未授权'), '不访问未授权来源');
  assert.ok(joined.includes('打扰'), '不在自己的时间打扰');
  assert.ok(joined.includes('删除') || joined.includes('删'), '不删除文件');
});

test('normalizeContract unions system wont and yields a stable hash', async () => {
  const { engine } = freshEngine();
  const { contract, hash } = await engine.normalizeContract(baseContract());
  assert.equal(contract.wont.length, baseContract().wont.length + SYSTEM_WONT.length, '并入六条系统默认 wont');
  for (const item of SYSTEM_WONT) assert.ok(contract.wont.includes(item));
  assert.match(hash, /^[0-9a-f]{64}$/);
  const reordered = baseContract();
  reordered.budget = { tokens: 100000, modelCalls: 40, localSlots: 1, costCap: null };
  assert.equal((await engine.normalizeContract(reordered)).hash, hash, '规范化后字段顺序不影响 hash');
});

test('contract trying to override system wont is rejected (SYSTEM_WONT_IMMUTABLE)', async () => {
  const { engine } = freshEngine();
  const hostile = baseContract();
  hostile.will.push(SYSTEM_WONT[0]); // 声称“会做”一条系统默认禁止项
  await assert.rejects(() => engine.normalizeContract(hostile), (e) => e.code === 'SYSTEM_WONT_IMMUTABLE');
});

test('contract with A4/A5 autonomy is rejected at normalization (§8.1 L599)', async () => {
  const { engine } = freshEngine();
  for (const autonomy of ['A4', 'A5']) {
    const hostile = baseContract(); hostile.autonomy = autonomy;
    await assert.rejects(() => engine.normalizeContract(hostile), (e) => e.code === 'AUTONOMY_OUT_OF_CONTRACT');
  }
});

test('grant lifecycle: proposed → active → consumed; consume is one-shot; revoke works', async () => {
  const { engine } = freshEngine();
  const contract = (await engine.normalizeContract(baseContract())).contract;
  const issued = await engine.grantIssue({ ...baseGrantSpec(), contractHash: contract.hash });
  assert.equal(engine.getGrant(issued.id).status, 'proposed');
  await engine.grantActivate(issued.id);
  assert.equal(engine.getGrant(issued.id).status, 'active');
  await engine.grantConsume(issued.id, { externalId: 'ext-42' });
  const consumed = engine.getGrant(issued.id);
  assert.equal(consumed.status, 'consumed');
  assert.ok(consumed.consumed_at);
  await assert.rejects(() => engine.grantConsume(issued.id, { externalId: 'ext-43' }), (e) => e.code === 'GRANT_ALREADY_CONSUMED', '相同批准只能消费一次');
  const other = await engine.grantIssue({ ...baseGrantSpec(), contractHash: contract.hash });
  await engine.grantActivate(other.id);
  await engine.grantRevoke(other.id);
  assert.equal(engine.getGrant(other.id).status, 'revoked');
});

test('expired grant is lazily marked and denied; contract change invalidates old grants (V3-19)', async () => {
  const { engine, clock } = freshEngine();
  const contract = (await engine.normalizeContract(baseContract())).contract;
  const grant = await activeGrant(engine, contract, { expiresAt: '2026-10-26T09:00:00+08:00' }); // 已过期 30 分钟
  const verdict = await engine.decide({
    action: baseAction(), grant, contract,
    spent: { modelCalls: 0, tokens: 0 }, estimate: { modelCalls: 1, tokens: 1 },
  });
  assert.equal(verdict.allow, false);
  assert.equal(verdict.reason, 'GRANT_EXPIRED');
  assert.equal(engine.getGrant(grant.id).status, 'expired', 'decide 时惰性落 expired');

  await engine.grantInvalidateForContract(contract.hash, { reason: 'CONTRACT_CHANGED' });
  assert.equal(engine.getGrant(grant2.id).status, 'invalidated', '合同 hash 变化 → 旧 Grant invalidated（精准失效）');
});

// ── 越权用例表（BUILD-PLAN W2-4 L109：≥20 条；每条 CASE-xx 在证据文件抄录） ──
// 矩阵 = §8.2 七条件各自反例 + 生命周期组合；expect 为期望 reason（或 allow:true）
const CASES = [
  { id: 'CASE-01', label: '黄金允许：A2 读动作全条件满足', mutate: {}, expect: { allow: true } },
  { id: 'CASE-02', label: '能力不在 grant.capabilities', mutate: { action: { capability: 'fs.write' } }, expect: { allow: false, reason: 'CAPABILITY_NOT_GRANTED' } },
  { id: 'CASE-03', label: '资源出 grant.scope', mutate: { action: { resource: '/etc/passwd' } }, expect: { allow: false, reason: 'RESOURCE_OUT_OF_SCOPE' } },
  { id: 'CASE-04', label: '披露 dataClass 越级（private 未披露）', mutate: { action: { dataClass: 'private' } }, expect: { allow: false, reason: 'DATA_CLASS_NOT_DISCLOSED' } },
  { id: 'CASE-05', label: '预算 spent+estimate 溢出（modelCalls）', mutate: { spent: { modelCalls: 40, tokens: 0 }, estimate: { modelCalls: 1, tokens: 0 } }, expect: { allow: false, reason: 'BUDGET_EXCEEDED' } },
  { id: 'CASE-06', label: '预算边界：spent+estimate == budget 放行（≤ 语义）', mutate: { spent: { modelCalls: 39, tokens: 0 }, estimate: { modelCalls: 1, tokens: 0 } }, expect: { allow: true } },
  { id: 'CASE-07', label: '预算 tokens 维度溢出', mutate: { spent: { modelCalls: 0, tokens: 99999 }, estimate: { modelCalls: 1, tokens: 2 } }, expect: { allow: false, reason: 'BUDGET_EXCEEDED' } },
  { id: 'CASE-08', label: '窗口外：早于 prepStart', mutate: { now: '2026-10-26T07:59:59+08:00' }, expect: { allow: false, reason: 'OUT_OF_WINDOW' } },
  { id: 'CASE-09', label: '窗口边界：now == prepStart 放行（含准备窗）', mutate: { now: '2026-10-26T08:00:00+08:00' }, expect: { allow: true } },
  { id: 'CASE-10', label: '窗口边界：now == end 放行（闭区间）', mutate: { now: '2026-10-26T12:00:00+08:00' }, expect: { allow: true } },
  { id: 'CASE-11', label: '窗口外：晚于 end', mutate: { now: '2026-10-26T12:00:01+08:00' }, expect: { allow: false, reason: 'OUT_OF_WINDOW' } },
  { id: 'CASE-12', label: 'A3 合同请求 A4 动作 → 需逐次确认', mutate: { action: { autonomy: 'A4' } }, expect: { allow: false, reason: 'A4_REQUIRES_CONFIRMATION', need: true } },
  { id: 'CASE-13', label: 'A4 动作即使合同写 A4（非法合同未规范化）也永远逐次确认', mutate: { action: { autonomy: 'A4' }, contract: { autonomy: 'A4' } }, expect: { allow: false, reason: 'A4_REQUIRES_CONFIRMATION', need: true } },
  { id: 'CASE-14', label: 'A5 任何情况永不自动', mutate: { action: { autonomy: 'A5' } }, expect: { allow: false, reason: 'A5_NEVER_AUTO' } },
  { id: 'CASE-15', label: 'A5 即使能力在清单内也永不自动', mutate: { action: { autonomy: 'A5', capability: 'fs.read' } }, expect: { allow: false, reason: 'A5_NEVER_AUTO' } },
  { id: 'CASE-16', label: '动作 autonomy 超过合同（A3 动作 vs A2 合同）', mutate: { action: { autonomy: 'A3' }, contract: { autonomy: 'A2' } }, expect: { allow: false, reason: 'AUTONOMY_EXCEEDED' } },
  { id: 'CASE-17', label: '命中系统默认禁止（付款类动作）', mutate: { action: { capability: 'payment.pay', autonomy: 'A2' } }, expect: { allow: false, reason: 'SYSTEM_WONT' } },
  { id: 'CASE-18', label: 'Grant 已过期', mutate: { grant: { expiresAt: '2026-10-26T08:00:00+08:00' } }, expect: { allow: false, reason: 'GRANT_EXPIRED' } },
  { id: 'CASE-19', label: 'Grant 已撤销', mutate: { grantStatus: 'revoked' }, expect: { allow: false, reason: 'GRANT_REVOKED' } },
  { id: 'CASE-20', label: 'Grant hash 与当前合同不符（合同变化后的在途消费）', mutate: { grant: { contractHash: '0'.repeat(64) } }, expect: { allow: false, reason: 'GRANT_INVALIDATED' } },
  { id: 'CASE-21', label: 'Grant 已消费后再次使用', mutate: { grantStatus: 'consumed' }, expect: { allow: false, reason: 'GRANT_CONSUMED' } },
  { id: 'CASE-22', label: 'Grant 仍是 proposed（未激活）', mutate: { grantStatus: 'proposed' }, expect: { allow: false, reason: 'GRANT_NOT_ACTIVE' } },
  { id: 'CASE-23', label: '组合：过期 Grant + 能力缺失 → 生命周期优先（可判定先因）', mutate: { grant: { expiresAt: '2026-10-26T08:00:00+08:00' }, action: { capability: 'fs.write' } }, expect: { allow: false, reason: 'GRANT_EXPIRED' } },
  { id: 'CASE-24', label: '组合：窗口外 + 预算溢出 → OUT_OF_WINDOW 先于 BUDGET', mutate: { now: '2026-10-26T13:00:00+08:00', spent: { modelCalls: 40, tokens: 0 }, estimate: { modelCalls: 1, tokens: 0 } }, expect: { allow: false, reason: 'OUT_OF_WINDOW' } },
  { id: 'CASE-25', label: 'dataClasses 数组部分未披露（⊆ 语义失败）', mutate: { action: { dataClasses: ['public', 'private'] } }, expect: { allow: false, reason: 'DATA_CLASS_NOT_DISCLOSED' } },
  { id: 'CASE-26', label: 'dataClasses 数组全部已披露（⊆ 语义通过）', mutate: { action: { dataClasses: ['public'] } }, expect: { allow: true } },
];

test('policy decision matrix: 26 numbered cases (≥20 required)', async () => {
  assert.ok(CASES.length >= 20, `用例表必须 ≥20 条，当前 ${CASES.length}`);
  const seen = new Set();
  for (const c of CASES) {
    seen.add(c.id);
    const { engine, clock, db } = freshEngine();
    const contractRaw = { ...baseContract(), ...(c.mutate.contract ?? {}) };
    const contract = (await engine.normalizeContract(contractRaw)).contract;
    let grantRow = await activeGrant(engine, contract);
    if (c.mutate.grantStatus === 'revoked') { await engine.grantRevoke(grantRow.id); grantRow = engine.getGrant(grantRow.id); }
    if (c.mutate.grantStatus === 'consumed') { await engine.grantConsume(grantRow.id, { externalId: 'e1' }); grantRow = engine.getGrant(grantRow.id); }
    if (c.mutate.grantStatus === 'proposed') { grantRow = engine.getGrant((await engine.grantIssue({ ...baseGrantSpec(), contractHash: contract.hash })).id); }
    if (c.mutate.grant) {
      const reissued = await engine.grantIssue({ ...baseGrantSpec(), contractHash: contract.hash, ...c.mutate.grant });
      if (c.mutate.grant.contractHash === undefined || c.mutate.grant.contractHash === contract.hash) await engine.grantActivate(reissued.id);
      grantRow = engine.getGrant(reissued.id);
    }
    if (c.mutate.now) clock.set(c.mutate.now);
    const verdict = await engine.decide({
      action: { ...baseAction(), ...(c.mutate.action ?? {}) },
      grant: grantRow,
      contract,
      spent: { modelCalls: 10, tokens: 1000 },
      estimate: { modelCalls: 1, tokens: 100 },
    });
    if (c.expect.allow) {
      assert.equal(verdict.allow, true, `${c.id} ${c.label} 应放行，实际 ${verdict.reason}`);
    } else {
      assert.equal(verdict.allow, false, `${c.id} ${c.label} 应拒绝`);
      assert.equal(verdict.reason, c.expect.reason, `${c.id} ${c.label} 期望 ${c.expect.reason}`);
      if (c.expect.need) assert.ok(verdict.need, `${c.id} 拒绝时应生成 Need 描述（§8.2 L626）`);
      // 每一次拒绝都写审计（§8.4）
      const audits = engine.listAudit({ grantId: grantRow.id });
      assert.ok(audits.some((a) => a.outcome === 'deny' && a.action === 'decide'), `${c.id} 拒绝必须落审计`);
    }
    db.close();
  }
  assert.equal(seen.size, CASES.length, 'CASE 编号不得重复');
});

test('audit trail records lifecycle events with who/when/contract/external id (§8.4)', async () => {
  const { engine, db } = freshEngine();
  const contract = (await engine.normalizeContract(baseContract())).contract;
  const grant = await activeGrant(engine, contract);
  await engine.grantConsume(grant.id, { externalId: 'ext-777' });
  await engine.grantRevoke((await activeGrant(engine, contract)).id);
  const audits = engine.listAudit({ ownerId: 'owner-1' });
  const actions = audits.map((a) => a.action);
  for (const expected of ['grant.issue', 'grant.activate', 'grant.consume', 'grant.revoke']) {
    assert.ok(actions.includes(expected), `审计缺 ${expected}`);
  }
  const consumeAudit = audits.find((a) => a.action === 'grant.consume');
  assert.equal(consumeAudit.external_id, 'ext-777', '消费审计带外部 ID');
  assert.equal(consumeAudit.contract_hash, contract.hash, '审计带合同版本');
  assert.ok(consumeAudit.actor && consumeAudit.created_at, '审计带谁/何时');
  db.close();
});

test('revoke takes effect at next check for in-flight consumption (V3-19 / §8.4 L638)', async () => {
  const { engine, db } = freshEngine();
  const contract = (await engine.normalizeContract(baseContract())).contract;
  const grant = await activeGrant(engine, contract);
  await engine.grantRevoke(grant.id); // 在途请求到达前撤权
  const verdict = await engine.decide({
    action: baseAction(), grant: engine.getGrant(grant.id), contract,
    spent: { modelCalls: 0, tokens: 0 }, estimate: { modelCalls: 1, tokens: 1 },
  });
  assert.equal(verdict.allow, false);
  assert.equal(verdict.reason, 'GRANT_REVOKED');
  db.close();
});
