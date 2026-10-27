// W9 M4 · w9-contract-consistency（G2 串行收口，依赖 M1+M2+M3 全部实现）
//
// 只读校验冻结契约（不改 contracts/agentic/**）：FROZEN 基线哨兵 + 三域产出对象全部过
// 冻结 schema + 跨域组合语义（收益门禁、跨 owner 全链拒绝）。依据 plan §G2-M4 与 brief 裁决①③⑤。
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openAgenticDb, migrate } from '../../../../scripts/agentic/db/index.mjs';
import { loadSchema, validate } from '../../../../scripts/agentic/contracts.mjs';
import { createArtifactStore } from '../../../../scripts/agentic/delivery/artifact-store.mjs';
import { createAcceptance } from '../../../../scripts/agentic/delivery/acceptance.mjs';
import { acceptedBenefit } from '../../../../scripts/agentic/delivery/benefit.mjs';
import { saveVerdict } from '../../../../scripts/agentic/verifier/verdict.mjs';
import { verify } from '../../../../scripts/agentic/verifier/engine.mjs';
import { dbVerdictGate } from '../../../../scripts/agentic/verifier/db-gate.mjs';
import { createNeedStore } from '../../../../scripts/agentic/inbox/need-store.mjs';
import { needView } from '../../../../scripts/agentic/inbox/attention-projection.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../..');
const contractDir = join(root, 'contracts/agentic');

// 与冻结工件本身逐字一致（已对账三方副本：基 60fdc73、本 worktree、w0-contracts worktree 均为
// `v1 b9d9bdfa0511905a95b729753b82e5734adab6bb`）。brief/plan 行文里的 `…574adab6bb` 是转写笔误
// （5734→574a），以文件为准；本断言仍是严格相等哨兵。
const FROZEN_EXPECTED = 'v1 b9d9bdfa0511905a95b729753b82e5734adab6bb';

// 哨兵：W9 开工时（基 60fdc73）29 个冻结 schema 文件的 SHA-256。任何 diff 都必须先过新的冻结流程。
const SCHEMA_SHA256 = {
  'acceptance.schema.json': '80a4a69926816c9a3b2293bf9912c800f2123869c1553b81fa23493d9f309043',
  'api-error.schema.json': 'cddb64877697aab4d770354f6b00254c01dd5ebe32d0f91914bbfebeb83aacbe',
  'artifact-ref.schema.json': '7e6cc06a27ba31f90be6b97fef04c65336391e38d80c65973302a5d5d6644dd8',
  'artifact.schema.json': '3dac4c5d51145bf54595f3bdb683aa4b67f3e2e58a7ee8d47f3c4804ce5f60cb',
  'block.schema.json': 'c915ec4acca65865d7b67015bdd84cff12fc9931f5c3ddfe8cf83590eced0909',
  'codex-choice.schema.json': 'd618bccfa6538cc2cb4e0131fd3a764e4d444e09765fe85ecc02d44032ad2d8b',
  'codex-plan.schema.json': '6c16abdcdc254f36d819e8139efc313fd396ea11497c5a9d4f5c0ab733884e2e',
  'connector.schema.json': '5b8248a33bee40ab44251ca90afe2751db7df2c2b2dcb6ddf1cbf498273c9c3f',
  'context-delta.schema.json': '154b1ec2d80430c90e8611cfd92add937ceb777ca2411253320fd3244be9c87f',
  'contract.schema.json': 'd238a99247303cd863b62fef07b3233a6ca5ace91cb938efef5bdc8e885bb862',
  'evidence.schema.json': '6c6a4be92d6935ceb0b61007f1de07aac2f7d3d758b19708c5f370718213700d',
  'fact.schema.json': '68165570847b841a8392407cc9ac671b03dd011b49fb874ca7b462168d9dd8fe',
  'grant-ref.schema.json': 'a2d5b55b116367b8df16ccff361282307613bbdef467ee839fd353ac19804caa',
  'grant.schema.json': '994da40acde0906435a09cd6cd48b7b4d0ee6273c834a350c81a577bf085bb27',
  'mission.schema.json': '2233b556e1de99280a1d1d249245190bcf7be7b344e82f4e1ba3ef1d89e419bd',
  'need.schema.json': '7edddd02ea67a396a5b6815b812059eeea7be6f87b267154f73f98fe4d2e4599',
  'playbook.schema.json': 'b0ce62d93a5d2087d426d62736f16316d6543e6a4652e9975a85b63cd36190dd',
  'preview-reel.schema.json': 'ba4c3507456be5fc3c08ddeac764676d65d175607ebe83515532bd8cc739217b',
  'preview-sample.schema.json': '01a42c78fc113ac74671519b2001057e3a1733e3cfaf715cbf75cdf8ba845005',
  'preview-scene.schema.json': '88a870f568b5bffdf189837e085e627db89cb008816fc4216fac194f5b6d5804',
  'preview.schema.json': '51a036421483a0b0137cbbcab3d7c7e99064bc644171bcd92653b8b6036082b6',
  'run.schema.json': '3475be0e941a60b6b5bcac18cbc30d0e47fd87cadb29b35453399bc66303038a',
  'scan.schema.json': 'eef40df96e50e5e35f57589f8bd2f53e9fdddc56ce5e6d9ee8709ae3f3c32839',
  'span.schema.json': 'dc481b19fc9f2fd8d8cfc3b145e8c9616683df092585477963e1097aae92e471',
  'spend.schema.json': '82a7d8fed21f2e90312bc5e649f972417caade65995954fcd79103240af12112',
  'step.schema.json': 'cc50be24fdb7dcd0efd6e43f0f51915b8c066c15fb8fd6ab279b57b72bae8c92',
  'suggestion-card.schema.json': '57baf40bb7d63ac9f72a7ae396e8b33cd5d9007d09c0fbe773922b029c4e06b6',
  'work-order.schema.json': '3932e01a3915091cc5d3730c3b19cf30a2e3d75ded53d82cafb496941c0b9e89',
  'work-result.schema.json': '0a42bcc8a1e01786e3c035e9bf0e2b54db4a202d6919652d3af183766c24f3da',
};

const T0 = Date.parse('2026-10-27T10:00:00Z');
const seqClock = (stepMs = 1000) => {
  let n = 0;
  return { now: () => new Date(T0 + n++ * stepMs).toISOString() };
};
const seqId = (prefix) => {
  let n = 0;
  return () => `${prefix}-${++n}`;
};

function makeWorld() {
  const db = openAgenticDb(':memory:');
  migrate(db, join(root, 'scripts/agentic/db/migrations'));
  const clock = seqClock();
  return {
    db,
    clock,
    store: createArtifactStore({ db, clock, idGen: seqId('art') }),
    acceptance: createAcceptance({ db, clock, idGen: seqId('acc') }),
    needs: createNeedStore({ db, clock, idGen: seqId('need') }),
  };
}

test('FROZEN baseline is still v1 b9d9bdfa…6bb and no frozen schema changed during W9', () => {
  const frozen = readFileSync(join(contractDir, 'FROZEN'), 'utf8').trim();
  assert.equal(frozen, FROZEN_EXPECTED);
  for (const [name, expected] of Object.entries(SCHEMA_SHA256)) {
    const actual = createHash('sha256').update(readFileSync(join(contractDir, name))).digest('hex');
    assert.equal(actual, expected, `${name} drifted from the frozen baseline`);
  }
});

test('W0 fixtures for the W9 objects remain consumable', () => {
  for (const name of ['artifact', 'acceptance', 'evidence', 'need']) {
    const fixture = JSON.parse(readFileSync(join(contractDir, 'fixtures', `${name}.fixtures.json`), 'utf8'));
    const schema = loadSchema(`${name}.schema.json`, contractDir);
    for (const value of fixture.valid) {
      assert.equal(validate(value, schema, { schemaDir: contractDir }).valid, true, `${name} fixture must stay valid`);
    }
    for (const value of fixture.invalid) {
      assert.equal(validate(value, schema, { schemaDir: contractDir }).valid, false, `${name} invalid fixture must stay invalid`);
    }
  }
});

test('delivery-domain outputs pass the frozen artifact and acceptance schemas', async () => {
  const w = makeWorld();
  const artifactSchema = loadSchema('artifact.schema.json', contractDir);
  const acceptanceSchema = loadSchema('acceptance.schema.json', contractDir);
  const evidenceFixture = JSON.parse(readFileSync(join(contractDir, 'fixtures', 'evidence.fixtures.json'), 'utf8'));

  const art = await w.store.put('owner-a', {
    missionId: 'm1', type: 'report', title: '报告', location: '/a.md', status: 'ready',
    evidence: [evidenceFixture.valid[1]],
  });
  await w.store.put('owner-a', { missionId: 'm1', type: 'report', title: '报告v2', location: '/a.md', status: 'ready', artifactId: art.id });
  for (const value of [art, await w.store.get('owner-a', art.id), ...(await w.store.versions('owner-a', art.id)), ...(await w.store.list('owner-a'))]) {
    assert.equal(validate(value, artifactSchema, { schemaDir: contractDir }).valid, true);
  }
  // W0 evidence fixture 经 store 往返保持逐字相等（能吃下 W0 fixtures）
  const round = await w.store.get('owner-a', art.id, { version: 1 });
  assert.deepEqual(round.evidence, [evidenceFixture.valid[1]]);

  const record = await w.acceptance.record('owner-a', art.id, { actor: 'user:alice', decision: 'accept' });
  assert.equal(validate(record, acceptanceSchema, { schemaDir: contractDir }).valid, true);
});

test('an ArtifactRef pointing at a stored artifact passes the frozen artifact-ref schema', async () => {
  const w = makeWorld();
  const refSchema = loadSchema('artifact-ref.schema.json', contractDir);
  const art = await w.store.put('owner-a', { missionId: 'm1', type: 'report', title: 't', location: '/a', status: 'ready' });
  const ref = { artifactId: art.id, version: art.version, kind: art.type };
  assert.equal(validate(ref, refSchema).valid, true);
});

test('inbox-domain needs with a default materialize into the frozen need schema', async () => {
  const needSchema = loadSchema('need.schema.json', contractDir);
  const w = makeWorld();
  const need = await w.needs.createNeed('owner-a', {
    missionId: 'm1', type: 'decision', question: 'A 还是 B？', dueAt: '2026-10-27T12:00:00Z', defaultAction: 'continue',
  });
  const view = needView(need);
  assert.equal(validate(view, needSchema, { schemaDir: contractDir }).valid, true);
});

test('benefit gate: accepted + blocking verdict never yields benefit, non-blocking does (用户验收≠agent 自报)', async () => {
  const w = makeWorld();
  const art = await w.store.put('owner-a', {
    missionId: 'm1', type: 'report', title: 't', location: '/a', status: 'ready',
    evidence: [{ type: 'dod-check', title: 'd', detail: 'x', verified: true }],
  });

  // 先有一条带 UNKNOWN 的核验 → 阻断
  saveVerdict(w.db, 'owner-a', {
    artifactId: art.id, version: 1, overall: 'UNKNOWN', ranAt: '2026-10-27T10:05:00Z',
    checks: [{ kind: 'citation', ref: 'r', status: 'UNKNOWN', severity: 'MEDIUM', reason: '未核验' }],
  });
  const gate = dbVerdictGate(w.db, 'owner-a');
  const accepted = await w.acceptance.record('owner-a', art.id, { actor: 'user:alice', decision: 'accept' });

  const blockingSummary = await gate(art.id, 1);
  assert.equal(blockingSummary.blocking, true);
  assert.equal(acceptedBenefit(accepted, blockingSummary), null, 'accepted but unverified must not count');

  // 复核通过后 → 计入
  saveVerdict(w.db, 'owner-a', {
    artifactId: art.id, version: 1, overall: 'VERIFIED', ranAt: '2026-10-27T10:10:00Z',
    checks: [{ kind: 'citation', ref: 'r', status: 'PASS', severity: 'LOW', reason: 'ok' }],
  });
  const clearSummary = await gate(art.id, 1);
  assert.equal(clearSummary.blocking, false);
  const benefit = acceptedBenefit(accepted, clearSummary);
  assert.ok(benefit);
  assert.equal(benefit.artifactId, art.id);

  // 用户拒绝/要求修改 → 永不计入
  const art2 = await w.store.put('owner-a', { missionId: 'm2', type: 'report', title: 't2', location: '/a2', status: 'ready' });
  const rejected = await w.acceptance.record('owner-a', art2.id, { actor: 'user:alice', decision: 'reject' });
  assert.equal(acceptedBenefit(rejected, { blocking: false, unknownCount: 0, highFailCount: 0 }), null);
});

test('builtin-reachable UNKNOWN verdict (dod=[], all checks PASS) never enters benefit (no free VERIFIED, 裁决③④)', async () => {
  const w = makeWorld();
  const art = await w.store.put('owner-a', {
    missionId: 'm1', type: 'report', title: '干净报告', location: '/a', status: 'ready',
  });
  // 空机 DoD：engine 只产出 injection PASS，overall=UNKNOWN（没有 DoD 核验
  // 就没有免费 VERIFIED）。M2→M1 边界不得丢掉这个 overall（评审 HIGH）。
  const verdict = await verify(
    { id: art.id, version: 1, title: art.title, evidence: [] },
    [],
    { runCommand: async () => ({ rc: 0, stdout: '', timedOut: false }), clock: w.clock },
  );
  assert.equal(verdict.overall, 'UNKNOWN');
  assert.ok(verdict.checks.length > 0 && verdict.checks.every((check) => check.status === 'PASS'));

  saveVerdict(w.db, 'owner-a', verdict);
  const summary = await dbVerdictGate(w.db, 'owner-a')(art.id, 1);
  assert.equal(summary.blocking, true, 'overall=UNKNOWN must block even with all-PASS checks');

  const accepted = await w.acceptance.record('owner-a', art.id, { actor: 'user:alice', decision: 'accept' });
  assert.equal(acceptedBenefit(accepted, summary), null, 'accepted + UNKNOWN verdict must not count as benefit');
});

test('revision_requested never counts as benefit; only a fresh acceptance on the new version can (plan M4-3)', async () => {
  const w = makeWorld();
  const acceptanceSchema = loadSchema('acceptance.schema.json', contractDir);
  const art = await w.store.put('owner-a', { missionId: 'm1', type: 'report', title: 't', location: '/a', status: 'ready' });

  const revise = await w.acceptance.record('owner-a', art.id, { actor: 'user:alice', decision: 'revise', comment: '补充来源' });
  assert.equal(revise.decision, 'revision_requested');
  assert.equal(validate(revise, acceptanceSchema, { schemaDir: contractDir }).valid, true);
  // 即便核验全清，revision_requested 也绝不计入收益（用户验收≠agent 自报）
  const clear = { blocking: false, unknownCount: 0, highFailCount: 0 };
  assert.equal(acceptedBenefit(revise, clear), null);

  // revise 不关版本链：新版本可以继续，且需要一次全新的用户验收才可能进收益
  const v2 = await w.store.put('owner-a', { missionId: 'm1', type: 'report', title: 't2', location: '/a', status: 'ready', artifactId: art.id });
  assert.equal(v2.version, 2);
  assert.equal((await w.store.get('owner-a', art.id)).status, 'ready');
  const fresh = await w.acceptance.record('owner-a', art.id, { actor: 'user:alice', decision: 'accept' });
  // 对外对象按冻结 schema 保持纯净（无 version 字段，plan 张力#2），版本绑定查 DB 列
  assert.equal(fresh.version, undefined);
  assert.equal(
    w.db.prepare('SELECT artifact_version FROM w9_acceptances WHERE id = ?').get(fresh.id).artifact_version,
    2,
    'fresh acceptance must bind the new version',
  );
  const benefit = acceptedBenefit(fresh, clear);
  assert.ok(benefit, 'accepted + non-blocking on the new version counts');
  assert.equal(benefit.artifactId, art.id);
});

test('rejected artifact cannot sneak back into benefit via revision without a fresh acceptance', async () => {
  const w = makeWorld();
  const art = await w.store.put('owner-a', { missionId: 'm1', type: 'report', title: 't', location: '/a', status: 'ready' });
  const rejected = await w.acceptance.record('owner-a', art.id, { actor: 'user:alice', decision: 'reject' });
  assert.equal((await w.store.get('owner-a', art.id)).status, 'rejected');
  assert.equal(acceptedBenefit(rejected, { blocking: false, unknownCount: 0, highFailCount: 0 }), null);
  await assert.rejects(
    async () => w.store.put('owner-a', { missionId: 'm1', type: 'report', title: 't2', location: '/a', status: 'ready', artifactId: art.id }),
    (e) => e.code === 'CONFLICT',
  );
});

test('cross-owner chain: store → acceptance → inbox all refuse owner B', async () => {
  const w = makeWorld();
  const art = await w.store.put('owner-a', { missionId: 'm1', type: 'report', title: 't', location: '/a', status: 'ready' });
  const need = await w.needs.createNeed('owner-a', {
    missionId: 'm1', type: 'acceptance', question: '验收？', dueAt: '2026-10-27T12:00:00Z', defaultAction: 'deliver_best',
  });

  await assert.rejects(async () => w.store.get('owner-b', art.id), (e) => e.code === 'NOT_FOUND');
  await assert.rejects(
    async () => w.store.put('owner-b', { missionId: 'm1', type: 'report', title: 't', location: '/a', status: 'ready', artifactId: art.id }),
    (e) => e.code === 'NOT_FOUND',
  );
  await assert.rejects(
    async () => w.acceptance.record('owner-b', art.id, { actor: 'user:bob', decision: 'accept' }),
    (e) => e.code === 'NOT_FOUND',
  );
  await assert.rejects(
    async () => w.needs.answer('owner-b', need.id, { answer: '替你验收了', revision: 1 }),
    (e) => e.code === 'NOT_FOUND',
  );

  // owner A 的原对象未被 B 的尝试污染
  assert.equal((await w.store.get('owner-a', art.id)).status, 'ready');
  assert.equal((await w.needs.get('owner-a', need.id)).status, 'open');
});
