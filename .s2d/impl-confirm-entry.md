# S2D-W6 模块 8 实现记录：confirm-entry

- 日期：2026-10-27 · 分支 `feat/s2d-w6-preview`（基 60fdc73，W0 冻结 b9d9bdf 为祖先）
- 输入规格：`.s2d/plan.md:57`（模块8）+ `tests/unit/agentic/preview/confirm.test.mjs`（RED 提交 d6858f3 的 7 测即规格）
- 前置：G1 preview-migrations（9ee19d9，`preview_confirmations` 表 + UNIQUE 幂等键）、G2 preview-store（a57a88c，软删语义）
- 语义依据：PRD §5.3（边界卡签约意图）、CTO-BATCH2-BRIEF §3（confirm→contract-draft-request 事件是 W3 接口，不直接动 mission）

## 产出文件（1 实现 + 1 测试追加）

| 文件 | 内容 |
|---|---|
| `scripts/agentic/discussion/confirm.mjs` | 新增。`createConfirmEntry(db, { now })` → `{ record, list }`；导出 `CONFIRM_DECISIONS` / `CONTRACT_DRAFT_REQUEST_EVENT` / `MAX_NOTE_LENGTH`（2000） |
| `tests/unit/agentic/preview/confirm.test.mjs`（+4 测试） | plan §2 负面路径追加（只增不改，原 7 断言零改动） |

## API

- `record({ ownerId, missionId, previewVersion, actor, decision, note? })`（**async**）
  - `decision ∈ {confirm, request_change, decline}`；confirm 存 `contract-draft-request` 事件 JSON（`{type, missionId, previewVersion, actor, emittedAt}`，canonicalJson 落库），另两档 event=null
  - 幂等键 = 表 UNIQUE `(owner_id, mission_id, preview_version, actor, decision)`：重放返回原记录 `replayed:true`；漂移 note 不覆盖原值；版本事后软删仍重放（决定是历史，不是 preview 现态）
  - 校验顺序：身份键形状（CONTRACT_INVALID）→ 重放查库 → note 校验 → live 版本存在性（未知/跨 owner/已软删一律 NOT_FOUND，零存在性泄露）→ `BEGIN IMMEDIATE` 事务内二次重放查库 + live 检查 + INSERT
  - UNIQUE 撞行（多进程竞态）→ 重查按 replayed 返回，非 CONFLICT（幂等键即意图键）
- `list({ ownerId, missionId })`（async）→ 追加序（`created_at, rowid`）全量决定记录；event 列读出 JSON 反解，损坏 fail-closed `CONTRACT_INVALID`

## 关键决策

1. **只记决定与事件，零外部副作用**（P0→contracted）：无网络/模型/时钟（now 注入）；事件是存储记录不是 dispatch——RED 测试 side-effect 边界用例证明 confirm 后 5 张 W6 表仅 `preview_confirmations` +1，且 W6 全程无 missions 表。
2. **重放先于 live 检查**：confirm v1 → softDelete v1 → 重放 confirm v1 仍返回原 id（追加测试锁定）。与 discussion-store"重放先于校验"同构，但 confirm 的身份键先做形状校验防 undefined 绑定（note 是唯一非键字段，即唯一漂移维度，存储值胜出）。
3. **async 契约**：失败以 rejection 呈现（node v22 `assert.rejects` 对同步 throw 不走 matcher，discussion-store 决策 #1 先例），G4 路由直接映射 api-error 信封。
4. **存在性探测用直查而非复用 preview-store.get()**：确认绑定的是版本号而非内容，无需触发 payload 往返校验；owner 谓词齐全。

## 未覆盖分支（防御性，单进程不可达）

覆盖率未覆盖行 174–176 / 201–202 / 206–210 = 两处 ROLLBACK 失败守卫 `catch {}` + UNIQUE 竞态重查包装——多进程/连接已回滚场景兜底，同兄弟模块类别，未剔除以保崩溃安全语义。

## 门禁（本会话实跑）

| 门禁 | 命令 | 结果 |
|---|---|---|
| RED | `node --test tests/unit/agentic/preview/confirm.test.mjs`（实现前） | 7/7 fail → 追加负面测试后 11/11 fail（ERR_MODULE_NOT_FOUND confirm.mjs） |
| GREEN | 同上（实现后） | **11/11 pass**，rc=0 |
| 覆盖率 | `node --test --experimental-test-coverage tests/unit/agentic/preview/confirm.test.mjs` | `confirm.mjs` **line 95.83 / branch 89.36 / funcs 91.67**（≥80 过） |
| 全量单测 | `npm run test:unit` | 1070 tests：1033 pass / 35 fail / 2 skipped。35 = apply 11 + patch-parser 11 + routes 10（G3/G4 兄弟模块未实现 RED）+ 基线 3（tango-ai-stream/collaboration-http，与 plan §1 记录一致）。**confirm.test.mjs 独立 0 失败**（逐文件归因实跑核对） |
| web | `npm run verify:web` | fail 0，rc=0（本模块无 web 文件） |

- 真实外部调用：0；新增依赖：0；未碰 contracts/W0 db/index.mjs/兄弟节点文件。
