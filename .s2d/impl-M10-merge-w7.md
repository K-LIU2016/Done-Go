# S2D-W13 · M10-merge-w7 实现记录（impl-M10-merge-w7.md）

- 模块：M10-merge-w7（组1/G1 合入链第 10 步，plan.md §G1）
- actor：w13·实现·M10-merge-w7（zai-api/GLM-5.3$max，工作流统一绑定）
- 会话日期：2026-10-28
- 工作树：`/Users/chillbit/Proj/Done & Go/s2d/w13-integrate` @ `feat/s2d-w13-integrate`
- 合入提交：`b271cc5`（merge: W7 runtime (1388636) into W13 integrate；本记录核验时 HEAD=`2c0786c`，链上 W9/W10 后续合入与 M01-M08 记录已完成）

## 1. 状态

W7 合入已于合入会话·C 完成并提交（`b271cc5`，真双亲 merge commit，1 冲突 `.s2d/plan.md` modify/modify 按 keep-ours+归档解决，W7 自有路径零冲突；共享目录新增 `contracts/w7-contract-consistency.test.mjs` 文件名无碰撞）。本实现会话按「代码与新鲜命令为权威」对 M10 门禁包在当前 HEAD **全量重跑**，全部通过，无新增改动需求（无遗留 TODO/未完成子任务；合并树 W7 文件零冲突标记）。明细证据：`argus-cto/projects/donego/evidence/s2d-w13-merge-w7.md`（§1-§5 合入时点 + §6 本重验时点）。

## 2. 新鲜门禁包（本会话实测，HEAD=`2c0786c`，工作树干净）

| # | 检查 | 命令 | 结果 |
|---|---|---|---|
| 1 | tip 核对 | `git rev-parse feat/s2d-w7-runtime` | `13886366308b109b05a5955e2b82425fad99b4b6` = 派单值 1388636 ✓ 零漂移 |
| 2 | merge 结构 | `git log -1 --format=%P b271cc5` | parents `2b23cef` + `1388636`（真双亲，无 -X ours/theirs） |
| 3 | 祖先包含 | `git merge-base --is-ancestor 1388636 HEAD` | rc=0（W7 tip 在集成分支历史内） |
| 4 | FROZEN 门禁 | `bash /tmp/w13-gate-frozen.sh` | rc=0：committed+worktree 对 `contracts/agentic` vs 60fdc73 零 delta；树哈希 base=head=`cddcdf2e…`；`FROZEN` = `v1 b9d9bdfa0511905a95b729753b82e5734adab6bb` |
| 5 | migration 门禁 | `node /tmp/w13-gate-migrations.mjs` | rc=0：20 文件字典序、103 DDL 跨文件零重名、首跑 applied=20（=字典序，w7-1..3 介于 preview-002 与 w9-1）、双跑 applied=0（幂等） |
| 6 | targeted 套件（本模块测试全绿判据，plan §G1 M10 行） | `node --test tests/unit/agentic/runtime/*.test.mjs tests/unit/agentic/model-router/*.test.mjs tests/unit/agentic/tool-registry/*.test.mjs tests/unit/agentic/contracts/w7-contract-consistency.test.mjs` | **rc=0，218 tests / 218 pass / 0 fail / 0 skipped**（与合入时点 218/218 一致；= W7 收口 206 targeted + 12 一致性） |
| 7 | 共享 contracts 目录（并存零回归） | `node --test tests/unit/agentic/contracts/*.test.mjs` | rc=0，46/46（W0 24 + w7 12 + w9 10；合入时点 36/36，W9 后 +10 无回归） |
| 8 | RED 套件联动（防污染观察） | `node --test tests/unit/agentic/integration/*.test.mjs` | 26 tests / 17 pass / 9 fail（rc=1）——与 M01-M08 记录及三批合入终态一致；9 fail 全为缺 integration 实现（M13-M17 RED 预期），未被本模块污染 |
| 9 | W7 路径完整性 | `git diff --name-only 1388636 HEAD -- <W7 自有路径>`（runtime/model-router/tool-registry 源码+测试+w7-contract-consistency+w7-*.sql） | **空**——W7 之后 W9/W10 合入与记录提交零改动 W7 文件 |
| 10 | 树内代表文件 | `git ls-tree HEAD …` | 10 源 + 8 test + 3 migration 全在位；`.s2d/import-w7-plan.md`=blob `fe7c106`（105 行，与 merge-log 逐字一致）；`.s2d/plan.md`=blob `f536ebf`（W13 keep-ours） |
| 11 | 空白门禁 | `git diff --check 60fdc73..HEAD` | rc=0 |

TAP 日志：`/tmp/m10-w7-targeted-tap.log`、`/tmp/m10-w7-contracts-tap.log`、`/tmp/m10-red-tap.log`、`/tmp/m10-gate-frozen.log`、`/tmp/m10-gate-migrations.log`。

## 3. W7 变更面（`git diff --name-only b271cc5^1 b271cc5`，30 文件实测，+7478/−0）

- 源码 10：`scripts/agentic/runtime/`（budget/engine/errors/ports/store）、`scripts/agentic/model-router/`（call/router/transport）、`scripts/agentic/tool-registry/`（mcp/registry）。
- migration 3：`w7-1-runtime-store.sql`、`w7-2-model-router.sql`、`w7-3-tool-registry.sql`（`w7_*` 表 DDL 名与 12 流零冲突）。
- 测试 8：runtime 3 + model-router 2 + tool-registry 2 + `contracts/w7-contract-consistency.test.mjs`。
- `.s2d` 9：W7 实现记录 8 + `import-w7-plan.md`（theirs blob `fe7c106` 归档溯源）。

完整性双验：① W7 自有路径 `git diff --name-only 1388636 HEAD -- …` 为**空**（见 §2 #9）；② 代表文件（10 源+8 test+3 sql）`git ls-tree HEAD` 逐一在位（§2 #10）。

## 4. 语义红线复核（合入不放宽，brief §4.5/红线 5/7）

- **红线⑦**：`w7-contract-consistency` 含锚点「无模型来源的 run 绝不产生 status=done 的 WorkResult」「transport 与选型均无模型来源 → 台账 UNKNOWN、绝不生成成功结果」——targeted 218 内实测通过。
- **UNKNOWN 不重试 / fail-closed**：engine/ports/store（`w7_unknown_outcomes` 只对账；缺 policyPort/缺 clock/check 抛错 → 构造失败）源码原样合入、断言零改动。
- **owner/幂等/检查点**：owner 过滤 NOT_FOUND、(owner,idempotency_key) 同载 replay/异载 CONFLICT、乐观锁、checkpoint 回放（contractHash 重验+policy 重查+新 now 重验窗口）原样；与 W2 checkpoint/outbox × W4 fence 组合、policyPort→W4 adapter、transport key 接线归 M13/M16，本模块不扩张。
- W7 无 HTTP 路由（plan §0.3）→ 无路由复用器挂载面。

## 5. PROVISIONAL/UNKNOWN 保留（不抹平，进终报）

- W7 终报行 3 FROZEN 笔误 `…57**4**adab6bb`（非有效对象名）——以磁盘 FROZEN=`…5734…` 为准（§2 #4 实测），报告侧笔误保留。
- W7 定位声明：未接主服务（归 M13+/M18）；零真实模型/MCP 调用（全注入 mock）；单测通过≠端到端（真实上游 429/MCP 实况/SQLite 并发迁移未端到端验证）。
- W7 评审 MED/LOW 未修留档（2 HIGH 已于 1388636 修复+回归测试）：correctness 4 MED/2 LOW、maintainability 3 MED/4 LOW、security 3 MED/3 LOW（纵深防御，接线前处置建议→M13+）。
- W7 文档↔代码 mismatch 4 条按现有代码/冻结契约保留（step unknown 枚举落 checkpoint/台账、Mission 状态归 W3、MCP 自写封装不引 sdk、旧签名已订正）。
- npm lock 缺 `sherpa-onnx-win-arm64@2.0.0`（`npm ci` rc=1）——W13 不修 lock（域外，终报保留）。

## 6. 提交

- 本记录 `.s2d/impl-M10-merge-w7.md` 以 flock（`/tmp/donego-s2d-w13-git.lock`）提交于 `feat/s2d-w13-integrate`；不 push（M27 收口统一处理）。
