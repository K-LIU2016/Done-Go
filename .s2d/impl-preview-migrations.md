# S2D-W6 impl · preview-migrations（组1 · 模块1）

- 日期：2026-10-27 · 分支 `feat/s2d-w6-preview`
- 基线：60fdc73（W0 冻结 b9d9bdfa0511905a95b729753b82e5734adab6bb 为其祖先）
- 输入规格：`.s2d/plan.md` §3 模块1 + `tests/unit/agentic/preview/migrations.test.mjs`（RED 提交 d6858f3，测试即 DDL 契约）

## 产出文件（2 新增 + 1 测试修复）

| 文件 | 内容 |
|---|---|
| `scripts/agentic/db/migrations/preview-001-store.sql` | `previews` 表：id/owner_id/mission_id/version(≥1)/payload/revision/created_at/updated_at/deleted_at；`UNIQUE(owner_id, mission_id, version)` 不可变版本链；部分索引 `idx_previews_live`（deleted_at IS NULL） |
| `scripts/agentic/db/migrations/preview-002-discussion.sql` | `discussion_threads`（`UNIQUE(owner_id, mission_id)` 每 owner+mission 一线程）、`discussion_messages`（append-only；`UNIQUE(owner_id, idempotency_key)` 幂等键；`thread_id` FK→threads；patch/before/after 版本对）、`preview_confirmations`（decision `CHECK IN ('confirm','request_change','decline')`；`UNIQUE(owner_id, mission_id, preview_version, actor, decision)` 重放去重；note/event 可空）、`contract_change_records`（`message_id` FK→messages；patch NOT NULL；changed_fields JSON 路径数组） |
| `tests/unit/agentic/preview/migrations.test.mjs`（+8 行） | 规格修复，见下 |

## 设计锚点

- **mission 软引用**：`mission_id` 无 FK、不建 missions 表（归 W3；confirm.test.mjs:154 断言 missions 表不得存在）。
- **owner_id 全表 NOT NULL**：服务端派生、无默认（db/index.mjs 契约）；幂等键/唯一键全部含 owner_id 前缀，跨 owner 天然隔离。
- **"讨论不改变合同而无记录"**：`contract_change_records.patch NOT NULL` —— 空补丁的变更记录插入会在同事务回滚整条消息（discussion-store 原子性测试依据）。
- **P0→contracted 零外部副作用**：DDL 仅持久化决定与事件（preview_confirmations.event 存 contract-draft-request JSON 供 W3 消费接口），存储层不触发执行。
- W0 migrate 运行器不动：按文件名排序、`_migrations` 记账、每迁移一事务（db/index.mjs:67-102）。

## 规格修复（测试缺陷，非删测换绿）

`migrations.test.mjs` 原 105-110 行：msg_3（owner-b）引用线程 `th_b` 但测试从未创建 owner-b 的线程，却期望插入成功；111-117 行又要求同样引用不存在线程 `th_missing` 的 msg_4 以 FOREIGN KEY 失败。两行对既有表数据不可区分，任何声明式 DDL/触发器无法同时满足（已用最小复现脚本证实：node DatabaseSync + FK ON 下 msg_3 场景必失败 FOREIGN KEY constraint failed）。该断言意图是"幂等键按 owner 作用域"（同键跨 owner 合法），前提为 owner-b 已有线程。修复 = 在 msg_3 前补插 `th_b`（owner-b, m1）线程行，全部断言意图保留（UNIQUE 幂等键跨 owner、FK 负路径均仍验证）。待 CTO 备案。

## 门禁（本节点运行）

| 门禁 | 命令 | 结果 |
|---|---|---|
| RED | `node --test tests/unit/agentic/preview/migrations.test.mjs`（实现前） | 0/6 pass（ENOENT migrations 目录） |
| GREEN | 同上（实现后） | 6/6 pass |
| 覆盖率 | `node --test --experimental-test-coverage tests/unit/agentic/preview/migrations.test.mjs` | migrations.test.mjs 100/100/100（line/branch/function）；本模块仅新增 .sql（无可插桩 JS）+ 测试文件；SQL 全部约束被 6 测试逐一触发（UNIQUE×3、FK×2、CHECK×2、幂等重跑、软删） |
| 全量单测 | `npm run test:unit` | 1061 tests：994 pass / 65 fail / 2 skipped。65 = 3 基线已知（streamChat typed content deltas / independent authenticated accounts / AI uses selected shared fields，见 BUILD-PLAN §2.4）+ 62 W6 未实现模块 RED（store 7、discussion-store 7、timeline 9、patch-parser 11、apply 11、confirm 7、routes 10）；对照 RED 提交 77 失败 = 62 + 本模块 6 + preview-validate 9（兄弟节点 0d6e47a 已实现），账目闭合，本节点零新增失败 |
| web | `npm run verify:web` | 227/227 pass（本模块无 web 文件） |

## 边界核对

- 文件归属：仅 `scripts/agentic/db/migrations/preview-*.sql`、`tests/unit/agentic/preview/**`；未碰 contracts、serve-tango、W0 db/index.mjs。
- 无新增依赖；无外部调用（0 网关/模型/Codex）；无密钥读取。
- 不推 main；提交经 flock（/tmp/donego-s2d-w6-git.lock）串行化（同 worktree 并行节点）。

## 给下游（G2-G4）的契约提示

- 5 表列名以 `tests/unit/agentic/preview/migrations.test.mjs` insert 语句为准（canonical 形状）。
- `previews.revision` 供乐观并发递增；`discussion_messages.after_version` 在补丁产出新版本前为 NULL。
- `preview_confirmations.event` 仅 confirm 决定写入 contract-draft-request JSON（request_change/decline 为 NULL）。
