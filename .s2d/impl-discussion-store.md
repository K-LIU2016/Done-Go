# S2D-W6 模块 4 实现记录：discussion-store

- 节点：G2 discussion-store（plan.md:53）
- 文件（2）：
  - `scripts/agentic/discussion/store.mjs`（新增，纯存储层）
  - `tests/unit/agentic/preview/discussion-store.test.mjs`（RED 批次已有 7 测，本节点按 plan §2 负面路径补 2 测：输入校验 CONTRACT_INVALID、重放先于校验）
- 提交：见 `git log` "feat: discussion-store — …"

## API（与 RED 测试及 G3 apply / G4 routes 的期望对齐）

`createDiscussionStore(db, { now })` → `{ appendMessage, getThread, listChangeRecords }`

- `appendMessage({ownerId, missionId, actor, utterance, baseVersion, beforeVersion, afterVersion, idempotencyKey, patch, contractChange})`（**async**）
  - 隐式建线程（`INSERT … ON CONFLICT(owner_id, mission_id) DO NOTHING`）
  - 幂等：先按 `(owner_id, idempotency_key)` 查重返回 `replayed:true`（重放判定在输入校验之前，漂移重放仍归并到原消息）；事务内二次查重防跨进程竞态
  - `contractChange: {patch, changedFields}` → `contract_change_records` 行与消息**同事务**写入；`patch` 为 null 时映射 SQL NULL，由 NOT NULL 约束中止整个事务（无消息、无线程残留）
  - 返回消息含 `replayed/threadId/createdAt` 等
- `getThread({ownerId, missionId})` → 线程 + 按追加序消息（`ORDER BY created_at, rowid`），无则 `null`；patch 列读出时 JSON 反解，损坏文本 fail-closed `CONTRACT_INVALID`
- `listChangeRecords({ownerId, missionId})` → 记录数组（messageId/before/after/patch/changedFields），owner 隔离

## 关键决策

1. **async appendMessage**：node v22.22.2 实测 `assert.rejects` 对同步 throw 不走 matcher 直接外抛（本会话 `node -e` 复现）；异步化后失败以 rejection 呈现，G4 路由层才能映射 api-error 信封。
2. **DB 约束兜底原子性**：contractChange.patch=null 不在应用层拦截，故意落到 NOT NULL 约束中止事务——"未落记录的合同变更在存储层不可达"由 schema 硬保证（测试 atomicity 用例即此路径）。
3. **校验职责分层**：store 层做最后防线（ownerId/missionId/actor/idempotencyKey 非空、utterance≤2000、版本字段正整数或 null、patch 为对象或 null、changedFields 非空字符串数组 → CONTRACT_INVALID）；utterance 语义校验/CONFLICT/NOT_FOUND 归 G3 apply 与 G4 routes（其 RED 测试已覆盖）。
4. `MAX_UTTERANCE_LENGTH=2000` 导出，与 apply.test.mjs 的 `'长'.repeat(2001)` 边界一致。
5. 时钟注入 `now`（默认 ISO now，请求路径不隐式读钟）。

## 测试证据（本会话实跑）

- RED：`node --test tests/unit/agentic/preview/discussion-store.test.mjs` → 7/7 fail（补测后 9/9 fail，ERR_MODULE_NOT_FOUND）
- GREEN：同命令 → **9/9 pass**
- 覆盖率：`node --test --experimental-test-coverage tests/unit/agentic/preview/discussion-store.test.mjs` → `discussion/store.mjs` **line 96.46 / branch 89.83 / funcs 93.75**（≥80 门禁过；未覆盖分支为默认 now、损坏 JSON fail-closed、跨进程竞态重查、ROLLBACK 失败守卫）
- 全量：`npm run test:unit` → 1066 tests, fail 42 = apply 11 + confirm 7 + patch-parser 11 + routes 10（G3/G4 未实现的 RED）+ 基线 3（tango-ai-stream 1、tango-collaboration-http 2，与 plan §1 记录一致）；discussion-store 零失败。对照法：stash 前后失败名单 comm 差为空（无新失败）。注：worktree 为多节点共享，全量数字随并行节点提交浮动，本模块口径以文件级归因为准。
- 真实外部调用：0；新增依赖：0。
