# S2D-W13 · M05-merge-w12 实现记录（impl-M05-merge-w12.md）

- 模块：M05-merge-w12（组1/G1 合入链第 5 步，plan.md §G1）
- actor：w13·实现·M05-merge-w12（zai-api/GLM-5.3$max，工作流统一绑定）
- 会话日期：2026-10-28
- 工作树：`/Users/chillbit/Proj/Done & Go/s2d/w13-integrate` @ `feat/s2d-w13-integrate`
- 合入提交：`3bb41e8`（merge: W12 perception (8cd9b4f) into W13 integrate；本记录核验时起点 HEAD=`d07c343`，链上后续模块 M06-M12 已完成）

## 1. 状态

W12 合入已于合入会话·B 完成并提交（`3bb41e8`，真双亲 merge commit，git 层零冲突，含 R-6 语义冲突解决）。本实现会话按「代码与新鲜命令为权威」对 M05 门禁包在当前 HEAD **全量重跑**，全部通过，无新增改动需求（无遗留 TODO/未完成子任务）。未重放 merge 本身（`3bb41e8` 已在 HEAD 历史，重复合并无操作且会制造空 merge）。明细证据：`argus-cto/projects/donego/evidence/s2d-w13-merge-w12.md`（合入时点）+ 本文件（重验时点）。

## 2. 新鲜门禁包（本会话实测 @ d07c343，工作树干净）

| # | 检查 | 命令 | 结果 |
|---|---|---|---|
| 1 | tip 核对 | `git rev-parse feat/s2d-w12-perception` | `8cd9b4f1190547f3e4fbbc5047d7ec894fb7db52` = 派单值 8cd9b4f ✓ 零漂移 |
| 2 | merge 结构 | `git log -1 --format=%P 3bb41e8` | parents `0198b05` + `8cd9b4f1190547f3e4fbbc5047d7ec894fb7db52`（真双亲，无 -X ours/theirs） |
| 3 | 祖先包含 | `git merge-base --is-ancestor 8cd9b4f HEAD` | rc=0（W12 tip 在集成分支历史内） |
| 4 | FROZEN 门禁 | `bash /tmp/w13-gate-frozen.sh` | rc=0：committed+worktree 对 `contracts/agentic` vs 60fdc73 零 delta；树哈希 base=head=`cddcdf2e30dbace5288eb17cfaad7c23a06b2400`；`FROZEN` = `v1 b9d9bdfa0511905a95b729753b82e5734adab6bb` |
| 5 | migration 门禁 | `node /tmp/w13-gate-migrations.mjs` | rc=0：20 文件字典序（autonomy-001/002 → blocks-001 → bridge-001 → engine-001..004 → mission-001 → obs-001/002 → **perception-0001** → preview-001/002 → w7-1..3 → w9-1..3）、编号唯一、103 DDL 跨文件零重名、首跑 applied=20（=字典序，W0 单 `_migrations` 台账）、双跑 applied=0（幂等）。perception-0001 四位编号经门禁归一化校验无冲突 |
| 6 | targeted 套件（本模块测试全绿判据，plan §G1 M05 行） | `node --test tests/unit/agentic/perception/*.test.mjs`（文件 glob，node v22.22.2 拒绝裸目录） | **rc=0，184 tests / 184 pass / 0 fail / 0 skipped**（15 文件：14 test + helpers；含 contracts-consistency——W12 感知套件首次绿于 43f12b3，R-6 修复后绿于 60fdc73；本次在十二流合入终态重验仍全绿，R-6 持续核销） |
| 7 | RED 套件联动（防污染观察） | `node --test tests/unit/agentic/integration/*.test.mjs` | 26 tests / 17 pass / 9 fail（rc=1）——与 M01-M04 记录及三批合入终态一致；9 fail 全为缺 integration 实现（M13-M17 的 RED 先行预期），未被本模块污染 |

TAP 日志：`/tmp/m05-perception-tap.log`（perception 套件）、`/tmp/m05-red-tap.log`（RED 观察）。

## 3. W12 变更面与 R-6 修复存续核验

- 变更面（`git diff --name-only 3bb41e8^1 3bb41e8`，35 文件）：`scripts/agentic/perception/`（19 源文件含 fixtures 4 + make-smoke-fixtures）、`scripts/agentic/db/migrations/perception-0001-init.sql`、`tests/unit/agentic/perception/`（14 test + helpers.mjs）。无 web 面（W12 纯后端）。
- **R-6 修复存续**（后续 W5/W3/W4/W6/W7/W9/W10 六连合入未覆盖）：`git diff --stat 8cd9b4f HEAD -- scripts/agentic/perception/ tests/unit/agentic/perception/ scripts/agentic/db/migrations/perception-0001-init.sql` → **仅 2 文件，+10/−8**，逐行核对与合入会话记录（merge-log §M05、evidence §3）完全一致，零额外漂移：
  1. `scripts/agentic/perception/contract-projection.mjs`：`evidence: [imageRef]` → `evidence: { imageRef }`（toContractContextDelta 输出对齐 b9d9bdf 冻结 schema 的 `{type:object, required:[imageRef]}`）+ 头注释（分叉清单三处→两处、FROZEN 引用 b2de664→b9d9bdf）。拒投影语义（missing-blockId/seen/change/evidence、unmappable-risk）与 mapRisk/mapActionKind 零改动。
  2. `tests/unit/agentic/perception/contracts-consistency.test.mjs`：期望字面量 `evidence:['cap_smoke_whiteboard_1']` → `evidence:{ imageRef:'cap_smoke_whiteboard_1' }`；**对 W0 schema 的 validate 断言原样保留**（非删测试/非放宽）。
- 完整性双验：① 代表文件（pipeline/routes/store/vision/contract-projection.mjs、fixtures/fridge.png、perception-0001-init.sql、contracts-consistency.test.mjs）`git ls-tree HEAD` 逐一在位；perception 源 19 + 测试 15 文件计数与变更面一致。② targeted 184/184（本会话）= 合入时点复跑值（evidence §3），六连合入后无回归。

## 4. PROVISIONAL/UNKNOWN 保留（不抹平，进终报）

- W12 TD2 契约分叉清单**仅消除 evidence 一项**：risk 枚举 vs 自由文本、全字段必填 vs 流水线 null 语义仍「待 CTO 裁决」（拒投影路径原样保留，终报照列）。
- 真实 vision 上游不自动启用；黄金场景（§5 场景 2）用 fixture/假 vision，需真实调用的单项标 UNKNOWN+次数+限制。
- npm lock 缺 sherpa-onnx-win-arm64（npm ci rc=1）与 W12 无关但同期存在，照列终报。

## 5. 提交

- 本记录 `.s2d/impl-M05-merge-w12.md` 以 flock（`/tmp/donego-s2d-w13-git.lock`）提交于 `feat/s2d-w13-integrate`；不 push（M27 收口统一处理）。
