# S2D-W13 · M08-merge-w4 实现记录（impl-M08-merge-w4.md）

- 模块：M08-merge-w4（组1/G1 合入链第 8 步，plan.md §G1）
- actor：w13·实现·M08-merge-w4（zai-api/GLM-5.3$max，工作流统一绑定）
- 会话日期：2026-10-28
- 工作树：`/Users/chillbit/Proj/Done & Go/s2d/w13-integrate` @ `feat/s2d-w13-integrate`
- 合入提交：`b2325eb`（merge: W4 autonomy (c9a865b) into W13 integrate；本记录核验时 HEAD=`ac6ea15`，链上 W6/W7/W9/W10 后续合入与 M01-M06 记录已完成）

## 1. 状态

W4 合入已于合入会话·C 完成并提交（`b2325eb`，真双亲 merge commit，1 冲突 `.s2d/plan.md` modify/delete 按 keep-W13 解决，`autonomy/*.mjs` 零冲突）。本实现会话按「代码与新鲜命令为权威」对 M08 门禁包在当前 HEAD **全量重跑**，全部通过，无新增改动需求（无遗留 TODO/未完成子任务）。明细证据：`argus-cto/projects/donego/evidence/s2d-w13-merge-w4.md`（§1-§5 合入时点 + §6 本重验时点）。

## 2. 新鲜门禁包（本会话实测）

| # | 检查 | 命令 | 结果 |
|---|---|---|---|
| 1 | tip 核对 | `git rev-parse feat/s2d-w4-autonomy` | `c9a865b75f42988fc6ea8a47c11f87a640624e8b` = 派单值 c9a865b ✓ 零漂移 |
| 2 | merge 结构 | `git log -1 --format=%P b2325eb` | parents `9d8fc06` + `c9a865b`（真双亲，无 -X ours/theirs） |
| 3 | 祖先包含 | `git merge-base --is-ancestor c9a865b HEAD` | rc=0（W4 tip 在集成分支历史内） |
| 4 | FROZEN 门禁 | `bash /tmp/w13-gate-frozen.sh` | rc=0：committed+worktree 对 `contracts/agentic` vs 60fdc73 零 delta；树哈希 base=head；`FROZEN` = `v1 b9d9bdfa0511905a95b729753b82e5734adab6bb` |
| 5 | migration 门禁 | `node /tmp/w13-gate-migrations.mjs` | rc=0：20 文件字典序（autonomy-001-audit → autonomy-002-idempotency-recovery 居首）、103 DDL 跨文件零重名、首跑 applied=20（=字典序）、双跑 applied=0（幂等） |
| 6 | targeted 套件（本模块测试全绿判据，plan §G1 M08 行） | `node --test tests/unit/agentic/autonomy/*.test.mjs` | **rc=0，85 tests / 85 pass / 0 fail / 0 skipped**（10 文件；与合入时点 85/85 一致——R-6 核销：60fdc73 对齐 schema 上无回归） |
| 7 | RED 套件联动（防污染观察） | `node --test tests/unit/agentic/integration/*.test.mjs` | 26 tests / 17 pass / 9 fail（rc=1）——与 M01-M06 记录及三批合入终态一致；9 fail 全为缺 integration 实现（M13-M17 的 RED 先行预期），未被本模块污染 |
| 8 | 空白门禁 | `git diff --check 60fdc73..HEAD` | rc=0 |

TAP 日志：`/tmp/m08-autonomy-tap.log`（targeted）、`/tmp/m08-red-tap.log`（RED 观察）、`/tmp/m08-gate-frozen.log`、`/tmp/m08-gate-migrations.log`。

## 3. W4 变更面（`git diff --name-only b2325eb^1 b2325eb`，23 文件实测，+2325/−25）

- 源码：`scripts/agentic/autonomy/` 9 文件（actor-model-boundary / audit / confirmation / idempotency-recovery / identity / policy / runtime / side-effect-fence / types）。
- migration：`autonomy-001-audit.sql`、`autonomy-002-idempotency-recovery.sql`（`autonomy_*` 表，DDL 名与 12 流零冲突）。
- 测试：`tests/unit/agentic/autonomy/` 10 文件（含 m10-negative-paths / policy-boundaries / side-effect-fence / actor-model-boundary / route-harness）。
- `.s2d`：仅 2 删除（`impl-contract-tests.md`/`impl-freeze-and-report.md`，W0 遗留按 W4 清空语义落删除，内容保留在 M00 历史）；`plan.md` keep-ours（blob `f536ebf` 实测）。

完整性双验：① W4 自有路径 `git diff --name-only c9a865b HEAD -- scripts/agentic/autonomy tests/unit/agentic/autonomy autonomy-*.sql` 为**空**——其后 W6/W7/W9/W10 四连合入与记录提交零改动 W4 文件；② 代表文件（9 源 + 10 test）`git ls-tree HEAD` 逐一在位。

## 4. 语义红线复核（合入不放宽，brief §4.5/红线 5/7）

- A4 每次显式确认、A5 永不自动执行、P0 fail-closed：源码原样合入、测试断言零改动，targeted 85/85 实证。
- actor 显式绑定模型：`actor-model-boundary.mjs` + 同名测试在位（85 内含）。
- W4 无 HTTP 路由（plan §0.3）→ 无路由复用器挂载面；policyPort→W4 runtime（fail-closed）与 checkpoint/outbox × fence 组合接缝归 M13/M16，本模块不扩张。

## 5. PROVISIONAL/UNKNOWN 保留（不抹平，进终报）

- npm lock 缺 `sherpa-onnx-win-arm64@2.0.0`（`npm ci` rc=1）——W13 不修 lock（域外，终报保留）。
- 本合入无 W4 专属 PROVISIONAL 新增项；全局保留项（W8/W10/W11/W12/npm）见 merge-log 批次三收尾，不在本模块处置。

## 6. 提交

- 本记录 `.s2d/impl-M08-merge-w4.md` 以 flock（`/tmp/donego-s2d-w13-git.lock`）提交于 `feat/s2d-w13-integrate`；不 push（M27 收口统一处理）。
