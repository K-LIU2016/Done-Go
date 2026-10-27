# S2D-W13 · M09-merge-w6 实现记录（impl-M09-merge-w6.md）

- 模块：M09-merge-w6（组1/G1 合入链第 9 步，plan.md §G1）
- actor：w13·实现·M09-merge-w6（zai-api/GLM-5.3$max，工作流统一绑定）
- 会话日期：2026-10-28
- 工作树：`/Users/chillbit/Proj/Done & Go/s2d/w13-integrate` @ `feat/s2d-w13-integrate`
- 合入提交：`2b23cef`（merge: W6 preview (cbc79ed) into W13 integrate；本记录核验时 HEAD=`2c0786c`，链上 W7/W9/W10 后续合入与 M01-M08 记录已完成）

## 1. 状态

W6 合入已于合入会话·C 完成并提交（`2b23cef`，真双亲 merge commit；1 文本冲突 `.s2d/plan.md` keep-ours+归档，1 语义冲突 `confirm.test.mjs` missions 存在性断言按「静态 SQL 不匹配+动态行数不变」双证明重述，源码零改动）。本实现会话按「代码与新鲜命令为权威」对 M09 门禁包在当前 HEAD **全量重跑**，全部通过，无新增改动需求（无遗留 TODO/未完成子任务）。明细证据：`argus-cto/projects/donego/evidence/s2d-w13-merge-w6.md`（§1-§5 合入时点 + §6 本重验时点）。

## 2. 新鲜门禁包（本会话实测）

| # | 检查 | 命令 | 结果 |
|---|---|---|---|
| 1 | tip 核对 | `git rev-parse feat/s2d-w6-preview` | `cbc79ed1e43ad47d275c1827ae373762a6441b71` = 派单值 cbc79ed ✓ 零漂移（W6 终报 df106ae 过期，以代码为准） |
| 2 | merge 结构 | `git log -1 --format=%P 2b23cef` | parents `b2325eb` + `cbc79ed`（真双亲，无 -X ours/theirs） |
| 3 | 祖先包含 | `git merge-base --is-ancestor cbc79ed HEAD` | rc=0（W6 tip 在集成分支历史内） |
| 4 | FROZEN 门禁 | `bash /tmp/w13-gate-frozen.sh` | rc=0：committed+worktree 对 `contracts/agentic` vs 60fdc73 零 delta；树哈希 base=head；`FROZEN` = `v1 b9d9bdfa0511905a95b729753b82e5734adab6bb` |
| 5 | migration 门禁 | `node /tmp/w13-gate-migrations.mjs` | rc=0：20 文件字典序、103 DDL 跨文件零重名、首跑 applied=20（=字典序）、双跑 applied=0（幂等；W6 preview-001/002 裸 CREATE 依赖 W0 单台账——R-9 W6 侧核销） |
| 6 | targeted 套件（本模块测试全绿判据，plan §G1 M09 行） | `node --test tests/unit/agentic/preview/*.test.mjs` | **rc=0，109 tests / 109 pass / 0 fail / 0 skipped**（10 文件；与合入时点 109/109 一致——R-6 W6 侧核销：`_helpers.mjs` 用共享 W0 台账全量 20 migration 建库，测试跑在 60fdc73 对齐集成 schema 上无回归） |
| 7 | RED 套件联动（防污染观察） | `node --test tests/unit/agentic/integration/*.test.mjs` | 26 tests / 17 pass / 9 fail（rc=1）——与 M01-M08 记录及三批合入终态一致；9 fail 全为缺 integration 实现（M13-M17 的 RED 先行预期），未被本模块污染 |
| 8 | W6 路径完整性 | `git diff --name-only cbc79ed HEAD -- scripts/agentic/preview scripts/agentic/discussion tests/unit/agentic/preview preview-*.sql` | 仅 `tests/unit/agentic/preview/confirm.test.mjs`（=已记录的 M09 语义冲突解决，diff 全文重核对，强度不降）；**preview/discussion 源码 8 .mjs + 2 migration 自 cbc79ed 零改动** |
| 9 | 空白门禁 | `git diff --check 60fdc73..HEAD` | rc=0 |

TAP 日志：`/tmp/m09-preview-tap.log`（targeted）、`/tmp/m09-red-tap.log`（RED 观察）、`/tmp/m09-gate-frozen.log`、`/tmp/m09-gate-migrations.log`。

## 3. W6 变更面（`git diff --name-only 2b23cef^1 2b23cef`，31 文件实测，+5296/−0）

- 源码：`scripts/agentic/preview/` 4 文件（routes / store / timeline / validate）+ `scripts/agentic/discussion/` 4 文件（apply / confirm / patch-parser / store）。
- migration：`preview-001-store.sql`、`preview-002-discussion.sql`（preview_* 表，DDL 名与 12 流零冲突）。
- 测试：`tests/unit/agentic/preview/` 10 test 文件 + `_helpers.mjs`。
- `.s2d`：W6 自有 9 个 impl-*.md + `import-w6-plan.md`（对方 plan.md blob `56f4f86` 归档，66 行，保双方内容与溯源）。

完整性双验：① §2#8——其后 W7/W9/W10 三连合入与 M01-M08 记录提交对 W6 源码/迁移零改动（唯一 delta=本记录在案的 confirm.test.mjs 语义重述）；② 代表文件（4 preview 源 + 4 discussion 源 + 2 migration）`git ls-tree HEAD` 逐一在位。

## 4. 语义红线复核（合入不放宽，brief §4.4/红线 3-4）

- **projection 分离**：preview 持久化（store.mjs）与 Timeline projection（timeline.mjs）分离模块原样合入；W11 播放字段经 projection 消费、不扩 Preview schema 的接缝归 M16，本模块不扩张。
- **确定性接缝保留**：`createPreviewRoutes` 的 `now` 缺省 wall clock（R-8）——源码原样合入；组合根强制注入确定性 clock 归 M13，集成路径禁隐藏 wall clock 由 M13/M14 落地。
- **跨流表围栏**（R-7）：W6 不创建/不写 W3 `missions`——静态（preview-*.sql doesNotMatch CREATE TABLE missions）+动态（confirm 前后行数不变）双证明钉在测试内，W6_TABLES 断言原样。
- 模型绑定红线（红线 7）对 W6 无新接触面（W6 无 actor/模型调用；preview 路由无模型语义）。

## 5. PROVISIONAL/UNKNOWN 保留（不抹平，进终报）

- npm lock 缺 `sherpa-onnx-win-arm64@2.0.0`（`npm ci` rc=1）——W13 不修 lock（域外，终报保留）。
- W6 终报溯源过期（报告 HEAD=df106ae ≠ 代码 cbc79ed，3 个 remediation 提交 1e9740a/2fb0ab5/cbc79ed 未入报告）——以代码为准，终报保留差异行。
- 本合入无 W6 专属 PROVISIONAL 新增项；全局保留项（W8/W10/W11/W12/npm）见 merge-log 批次三收尾，不在本模块处置。

## 6. 提交

- 本记录 `.s2d/impl-M09-merge-w6.md` 以 flock（`/tmp/donego-s2d-w13-git.lock`）提交于 `feat/s2d-w13-integrate`；不 push（M27 收口统一处理）。
