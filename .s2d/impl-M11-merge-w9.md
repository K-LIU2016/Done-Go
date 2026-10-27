# S2D-W13 · M11-merge-w9 实现记录（impl-M11-merge-w9.md）

- 模块：M11-merge-w9（组1/G1 合入链第 11 步，plan.md §G1）
- actor：w13·实现·M11-merge-w9（zai-api/GLM-5.3$max，工作流统一绑定）
- 会话日期：2026-10-28
- 工作树：`/Users/chillbit/Proj/Done & Go/s2d/w13-integrate` @ `feat/s2d-w13-integrate`
- 合入提交：`07b0974`（merge: W9 delivery (472b6d4) into W13 integrate；本记录核验时 HEAD=`0513979`，链上 W10 合入与 M01-M10 记录已完成）

## 1. 状态

W9 合入已于合入会话·C 完成并提交（`07b0974`，真双亲 merge commit；1 文本冲突 `.s2d/plan.md` keep-ours+归档，W9 源码/测试零改动零冲突）。本实现会话按「代码与新鲜命令为权威」对 M11 门禁包在当前 HEAD **全量重跑**，全部通过，无新增改动需求（无遗留 TODO/未完成子任务）。明细证据：`argus-cto/projects/donego/evidence/s2d-w13-merge-w9.md`（§1-§5 合入时点 + §6 本重验时点）。

## 2. 新鲜门禁包（本会话实测，HEAD=0513979，工作树干净）

| # | 检查 | 命令 | 结果 |
|---|---|---|---|
| 1 | tip 核对 | `git rev-parse feat/s2d-w9-delivery` | `472b6d448df717cfd08b37c8cbf37cb3dae438de` = 派单值 472b6d4 ✓ 零漂移 |
| 2 | merge 结构 | `git log -1 --format=%P 07b0974` | parents `b271cc5` + `472b6d4`（真双亲，无 -X ours/theirs） |
| 3 | 祖先包含 | `git merge-base --is-ancestor 472b6d4 HEAD` | rc=0（W9 tip 在集成分支历史内）；merge-base(60fdc73,472b6d4)=60fdc73 |
| 4 | FROZEN 门禁 | `bash /tmp/w13-gate-frozen.sh` | rc=0：committed+worktree 对 `contracts/agentic` vs 60fdc73 零 delta；树哈希 base=head=`cddcdf2e…`；`FROZEN` = `v1 b9d9bdfa0511905a95b729753b82e5734adab6bb` |
| 5 | migration 门禁 | `node /tmp/w13-gate-migrations.mjs` | rc=0：20 文件字典序（w9-1→w9-3 居末段）、103 DDL 跨文件零重名、首跑 applied=20（=字典序）、双跑 applied=0（幂等，W0 单台账） |
| 6 | targeted 套件（本模块测试全绿判据，plan §G1 M11 行） | `node --test tests/unit/agentic/delivery/*.test.mjs tests/unit/agentic/verifier/*.test.mjs tests/unit/agentic/inbox/*.test.mjs tests/unit/agentic/contracts/w9-contract-consistency.test.mjs` | **rc=0，192 tests / 192 pass / 0 fail / 0 skipped**（20 文件；与合入时点 192/192 一致——R-6 W9 侧核销：W9 merge-base=60fdc73 即冻结态，集成树无回归） |
| 7 | 共享 contracts 目录（并存零回归） | `node --test tests/unit/agentic/contracts/*.test.mjs` | rc=0，46/46（W0 24 + w7 12 + w9 10） |
| 8 | RED 套件联动（防污染观察） | `node --test tests/unit/agentic/integration/*.test.mjs` | 26 tests / 17 pass / 9 fail（rc=1）——与 M01-M10 记录及三批合入终态一致；9 fail 全为缺 integration 实现（M13-M17 的 RED 先行预期），未被本模块污染 |
| 9 | W9 路径完整性 | `git diff --name-only 472b6d4 HEAD -- scripts/agentic/{delivery,verifier,inbox} tests/unit/agentic/{delivery,verifier,inbox} tests/unit/agentic/contracts/w9-contract-consistency.test.mjs scripts/agentic/db/migrations/w9-{1,2,3}-*.sql` | **空**——W9 之后 W10 合入与 M01-M10 记录提交零改动 W9 文件 |
| 10 | 树内代表文件 | `git ls-tree -r HEAD scripts/agentic/{delivery,verifier,inbox}` | 17 源文件全在位（5 delivery + 8 verifier + 4 inbox）；`.s2d/import-w9-plan.md`=blob `7d21cc2`（82 行，与 merge-log 记录一致）；合并树 W9 文件零冲突标记（grep `^<<<<<<<` 无命中） |
| 11 | 空白门禁 | `git diff --check 60fdc73..HEAD` | rc=0 |

TAP 日志：`/tmp/m11-w9-targeted-tap.log`（targeted 192）、`/tmp/m11-w9-contracts-tap.log`（contracts 46）、`/tmp/m11-red-tap.log`（RED 观察）、`/tmp/m11-gate-frozen.log`、`/tmp/m11-gate-migrations.log`、`/tmp/m11-fence-grep.txt`（§4 围栏证据）。

## 3. W9 变更面（`git diff --name-only 07b0974^1 07b0974`，46 文件实测，+5256/−0）

- 源码 17：`scripts/agentic/delivery/` 5（routes/artifact-store/acceptance/benefit/util）+ `scripts/agentic/verifier/` 8（engine/verdict/dod-checker/citation-checker/command-result/injection-marker/db-gate/shape）+ `scripts/agentic/inbox/` 4（need-store/expiry/attention-projection/routes）。
- migration 3：`w9-1-delivery.sql`、`w9-2-verifier.sql`、`w9-3-inbox.sql`（`w9_*` 9 表，DDL 名与 12 流零冲突）。
- 测试 20：delivery 6 + verifier 8 + inbox 5 + `contracts/w9-contract-consistency.test.mjs`（10 tests）。
- `.s2d` 6：W9 实现记录 4 + `import-w9-plan.md` 归档 + `tests-red-w9.md`。

完整性双验：① §2#9——W9 之后 W10 合入与 M01-M10 记录提交对 W9 源码/迁移/测试零改动；② §2#10 树内代表文件逐一在位、归档 blob 与 merge-log 逐字一致。

## 4. 语义红线复核（合入不放宽，brief §4.4/红线 5/7）

- **收益门（黄金场景 5）**：w9-contract-consistency 实测锚点全绿——accepted+blocking 不计收益（用户验收≠agent 自报，:149）、builtin 可达 UNKNOWN 不产免费 VERIFIED（裁决③④，:185）、revision_requested 不计收益仅新版本全新 acceptance 可（:208）、rejected 不能借 revision 洗回（:237）、跨 owner store→acceptance→inbox 全拒（:249）。db-gate overall+UNKNOWN/HIGH 双门禁（W9 H1 修复 472b6d4）原样合入，断言零改动。
- **projection 围栏（R-7）**：W9 只建/只写自身 `w9_*` 9 表；`grep -rn -E "obs_|mission_|w7_|preview_" scripts/agentic/{delivery,verifier,inbox}` 13 命中全部为 `w9_*` 表内 `mission_id` 列（值引用，不读写 W3 `missions` 表），obs_/w7_/preview_ 零命中；W10 obs_* 镜像经事件/显式查询接入归 M16。
- **确定性注入（R-8）**：`createDeliveryRoutes`/`createInboxRoutes` 缺 db/auth/clock/idGen 即抛（delivery/routes.mjs:19、inbox/routes.mjs:92），无缺省 wall clock；已返回 `handled:boolean` 与 M14 dispatcher 形状一致；verdictGate 可选=响应无 verdict 字段（文档化行为，收益门独立在 benefit+db-gate）。
- **红线⑦（resolved_model）**：W9 无模型调用面（checkers/runCommand 全注入；command-result rc≠0→FAIL(HIGH)、超时/解析失败→UNKNOWN fail-closed）；W9 全部 actor 工作流绑定 zai-api/GLM-5.3（max），无 resolved_model=NULL。

## 5. PROVISIONAL/UNKNOWN 保留（不抹平，进终报）

- W9 全量基线 rc=1（7 条全为已知环境基线，无新增 W9 失败）——集成阶段不据此升级，全量对账归 M25。
- W9 未验证边界原样：未挂载主服务（归 M13+/M18）、未真实用户验收、未外部通知、Playwright 未跑。
- 文档↔代码 mismatch 保留：need.schema.json defaultAction 枚举非空 vs 裁决⑤无默认→UNKNOWN；无默认 need 不物化冻结 Need 对象走 AttentionItem 投影（M15/M16 接缝关注，投影侧不得反向扩 schema）。
- W9 终报 FROZEN 笔误已自纠（31dbbe5）；以磁盘 FROZEN 为准（§2#4 实测）。
- npm lock 缺 sherpa-onnx-win-arm64（npm ci rc=1）——W13 不修 lock（域外）。全局保留项（W8/W10/W11/W12）见 merge-log 批次三收尾，不在本模块处置。

## 6. 提交

- 本记录 `.s2d/impl-M11-merge-w9.md` 以 flock（`/tmp/donego-s2d-w13-git.lock`）提交于 `feat/s2d-w13-integrate`；不 push（M27 收口统一处理）。
