// W1 收尾契约一致性测试（BUILD-PLAN §2.2 收尾条款、§2.4-6 门禁；TDD：本文件先行提交时
// contracts/agentic/** 与 scripts/agentic/contracts.mjs 尚未并入本分支 → RED（ERR_MODULE_NOT_FOUND），
// `git merge feat/s2d-w0-contracts` 后转 GREEN）。
//
// 形状分歧的如实说明（文档级分歧，按全局 AGENTS.md 在证据/报告中列出，最终对齐归 CTO/W13 裁决）：
// W1 的 block 存储格式按 BUILD-PLAN §3 W1-1 字段表实现（snake_case：deleted_at/updated_at；prio 为
// web 端 1–5 整数，index.html:824 旧三档迁移 {1:1,2:3,3:5}；source 取 'web'|'draft'）；W0 冻结契约
// contracts/agentic/block.schema.json 为 camelCase 且必填 ownerId/schemaVersion/createdAt，prio 为
// low|normal|high 枚举、source 为 voice|manual|agent|sync|import|system 枚举。本文件用显式适配层
// （仅存在于测试，不进运行时）证明两方向结构互通：
//   ① W1 产出对象（entryToBlock → store 往返）适配后经 scripts/agentic/contracts.mjs 校验通过；
//   ② W0 fixtures 的 valid block 全部可喂进 W1 store，规范字段往返一致；invalid 被校验器拒绝；
//   ③ 锚定已知缺口：draft 块（start=null，BUILD-PLAN W1-2 允许无时刻）在 W0 v1 schema 必填 start 下
//     不合法 → 待 CTO 裁决（裁决前该断言锁定现状，防止缺口被静默吞掉）。
// 适配语义（全部锚定现有代码，非凭空约定）：
//   prio 上行 1|2→high、3→normal、4|5→low（低数值=高优先，index.html:3059 prio-up 递减）；
//   prio 下行 high→1、normal→3、low→5（恰为 index.html:824 的旧三档→五档映射）。
//   source 上行 web|draft→manual（契约枚举无 web/draft，二者皆用户手工动作）；契约值 W1 store 原样收
//   （store.mjs normalizeContent 只要求字符串，不锁枚举）。createdAt：W1 表无该列 → 以 updated_at 兜底
//   （有损，报告已列）。schemaVersion：常量 1。
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { loadSchema, validate } from '../../../../scripts/agentic/contracts.mjs';
import { createBlocksStore } from '../../../../scripts/agentic/block-store/index.mjs';
import { entryToBlock } from '../../../../web/agentic/sync.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../../../../');
const contractDir = join(root, 'contracts/agentic');
const blockSchema = loadSchema('block.schema.json', contractDir);
const fixtures = JSON.parse(readFileSync(join(contractDir, 'fixtures/block.fixtures.json'), 'utf8'));

const MIGRATION = fileURLToPath(new URL('../../../../scripts/agentic/db/migrations/blocks-001-blocks.sql', import.meta.url));
function makeStore() {
  const db = new DatabaseSync(':memory:');
  db.exec(readFileSync(MIGRATION, 'utf8'));
  return createBlocksStore({ db, now: () => '2026-10-27T00:00:00.000Z' });
}

// ── 适配层（仅测试内；语义依据见文件头注）──────────────────────────────────────
const PRIO_TO_CONTRACT = { 1: 'high', 2: 'high', 3: 'normal', 4: 'low', 5: 'low' };
const PRIO_FROM_CONTRACT = { high: 1, normal: 3, low: 5 };
const toContractSource = value => (value === 'web' || value === 'draft' ? 'manual' : value);

// W1 store 块（store.mjs rowToBlock 形状，owner 由调用方给——store API 以参数持 owner）→ W0 契约形状
function w1BlockToContract(block, owner) {
  return {
    id: block.id, ownerId: owner, revision: block.revision, schemaVersion: 1,
    date: block.date, start: block.start, end: block.end, title: block.title, kind: block.kind,
    prio: PRIO_TO_CONTRACT[block.prio] || 'normal', note: block.note, done: block.done,
    source: toContractSource(block.source),
    deletedAt: block.deleted_at, createdAt: block.updated_at, updatedAt: block.updated_at,
  };
}
// W0 契约块 → W1 change（喂 store.upsert；revision 服务端递增，契约里的 revision 不随行）
function contractToChange(contractBlock) {
  return {
    id: contractBlock.id,
    baseRevision: 0,
    block: {
      date: contractBlock.date, start: contractBlock.start, end: contractBlock.end,
      title: contractBlock.title, kind: contractBlock.kind,
      prio: PRIO_FROM_CONTRACT[contractBlock.prio] || 3,
      note: contractBlock.note == null ? '' : contractBlock.note,
      done: contractBlock.done === true, source: contractBlock.source,
    },
  };
}

test('W1 产出对象经适配层通过 W0 契约校验：entryToBlock → store 往返 → contracts.mjs valid', () => {
  const store = makeStore();
  const entry = {
    id: 'e1', date: '2026-10-27', start: '09:00', end: '10:00', title: '写作', kind: 'create',
    prio: 2, note: '同步契约', done: false,
    state: 'kept', use: 'x', intent: 'y', freed: 'z', collaborationRef: 'c1', // 非规范字段：不得进契约
  };
  const block = entryToBlock(entry);
  assert.ok(block, 'entryToBlock 应产出块');
  const applied = store.upsert('u1', { id: block.id, baseRevision: 0, block });
  assert.equal(applied.applied, true);
  const stored = store.list('u1').find(item => item.id === 'e1');
  assert.ok(stored);
  const result = validate(w1BlockToContract(stored, 'u1'), blockSchema, { schemaDir: contractDir });
  assert.equal(result.valid, true, JSON.stringify(result.errors));
  // 非规范字段经适配层天然剥除（schema additionalProperties:false，若带入会 invalid——上面的
  // valid 即证明）；再显式钉住，防止适配层未来误带私货
  const contractBlock = w1BlockToContract(stored, 'u1');
  for (const stray of ['state', 'use', 'intent', 'freed', 'collaborationRef', 'owner_id', 'deleted_at', 'updated_at']) {
    assert.equal(stray in contractBlock, false, stray);
  }
});

test('W1 吃得下 W0 block fixtures：valid 全部入 store 且规范字段往返一致；invalid 被校验器拒绝', () => {
  const store = makeStore();
  for (const fixtureBlock of fixtures.valid) {
    const applied = store.upsert('u1', contractToChange(fixtureBlock));
    assert.equal(applied.applied, true, fixtureBlock.id);
    const stored = store.list('u1').find(item => item.id === fixtureBlock.id);
    assert.ok(stored, fixtureBlock.id);
    // 规范内容字段与 fixture 一致（date/start/end/title/kind/note/done；prio 经枚举映射往返）
    assert.equal(stored.date, fixtureBlock.date);
    assert.equal(stored.start, fixtureBlock.start);
    assert.equal(stored.end, fixtureBlock.end);
    assert.equal(stored.title, fixtureBlock.title);
    assert.equal(stored.kind, fixtureBlock.kind);
    assert.equal(stored.note, fixtureBlock.note == null ? '' : fixtureBlock.note);
    assert.equal(stored.done, fixtureBlock.done === true);
    // 回到契约形状再校验：仍 valid（往返闭合）
    const round = validate(w1BlockToContract(stored, fixtureBlock.ownerId), blockSchema, { schemaDir: contractDir });
    assert.equal(round.valid, true, fixtureBlock.id + ': ' + JSON.stringify(round.errors));
  }
  // invalid fixture 必须被 contracts.mjs 拒绝——证明校验器真的在咬（适配层不可能是恒真）
  for (const bad of fixtures.invalid) {
    assert.equal(validate(bad, blockSchema, { schemaDir: contractDir }).valid, false);
  }
});

test('已知缺口锚定：draft 块（start=null）在 W0 v1 block schema 必填 start 下不合法——待 CTO 裁决', () => {
  const store = makeStore();
  const draft = entryToBlock({ id: 'd9', date: '2026-10-27', title: '草稿', kind: 'create' }, { source: 'draft' });
  assert.ok(draft && draft.start === null && draft.source === 'draft', 'draft 无时刻映射 null（BUILD-PLAN W1-2）');
  assert.equal(store.upsert('u1', { id: 'd9', baseRevision: 0, block: draft }).applied, true);
  const stored = store.list('u1').find(item => item.id === 'd9');
  const result = validate(w1BlockToContract(stored, 'u1'), blockSchema, { schemaDir: contractDir });
  // W0 v1 schema：start 必填且须匹配 HH:MM 模式——draft 的 null 不可能合法。此断言锁定缺口现状，
  // 裁决（schema 放宽 nullable / W1 侧补时刻占位 / draft 不入契约对象）之前不得静默变绿。
  assert.equal(result.valid, false);
  assert.ok(result.errors.some(error => error.path.startsWith('$.start')), JSON.stringify(result.errors));
});
