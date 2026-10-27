# S2D-W13 · M03-merge-w8 实现记录（impl-M03-merge-w8.md）

- 模块：M03-merge-w8（组1/G1 合入链第 3 步，plan.md §G1）
- actor：w13·实现·M03-merge-w8（zai-api/GLM-5.3$max，工作流统一绑定）
- 会话日期：2026-10-28
- 工作树：`/Users/chillbit/Proj/Done & Go/s2d/w13-integrate` @ `feat/s2d-w13-integrate`
- 合入提交：`10584f7`（merge: W8 codex-bridge (9a6dfdf) into W13 integrate；本记录核验时 HEAD=`e13ada9`，链上后续模块 M04-M12 已完成）

## 1. 状态

W8 合入已于合入会话·A 完成并提交（`10584f7`，真双亲 merge commit）。本实现会话按「代码与新鲜命令为权威」对 M03 门禁包在当前 HEAD（十二流合入后的集成树）**全量新鲜重跑**，全部通过，无新增改动需求（合并零冲突、无遗留 TODO/未完成子任务）。明细证据：`argus-cto/projects/donego/evidence/s2d-w13-merge-w8.md`（合入时点）+ 本文件（重验时点）。

## 2. 新鲜门禁包（本会话实测，工作树起点干净 @ e13ada9，全部 rc=0 除 RED 观察）

| # | 检查 | 命令 | 结果 |
|---|---|---|---|
| 1 | tip 核对 | `git rev-parse feat/s2d-w8-codex-bridge` | `9a6dfdff5a7a06ebf223bb9d69b4661495a846f3` = 派单值 9a6dfdf ✓ 零漂移 |
| 2 | merge 结构 | `git show --no-patch --format='%H %P' 10584f7` | parents `2f810d2`（W13 侧，W1 合入后）+ `9a6dfdf`（真双亲，无 -X ours/theirs） |
| 3 | 祖先包含 | `git merge-base --is-ancestor 9a6dfdf HEAD` | rc=0（W8 tip 在集成分支历史内） |
| 4 | 原 merge-base | `git merge-base 9a6dfdf 2f810d2` | `60fdc73` ✓（=W0 冻结基线，与盘点 §0.1 一致） |
| 5 | FROZEN 门禁 | `bash /tmp/w13-gate-frozen.sh` | rc=0：committed+worktree 对 `contracts/agentic` vs 60fdc73 零 delta；树哈希 base=head=`cddcdf2e30dbace5288eb17cfaad7c23a06b2400`；`FROZEN` = `v1 b9d9bdfa0511905a95b729753b82e5734adab6bb` |
| 6 | migration 门禁 | `node /tmp/w13-gate-migrations.mjs` | rc=0：20 文件字典序（autonomy-001/002 → blocks-001 → **bridge-001** → engine-001..004 → mission-001 → obs-001/002 → perception-0001 → preview-001/002 → w7-1..3 → w9-1..3）、编号唯一、103 DDL 跨文件零重名、首跑 applied=20（=字典序）、双跑 applied=0（幂等） |
| 7 | targeted 套件（本模块测试全绿判据） | `node --test tests/unit/agentic/bridge/*.test.mjs` | **rc=0，143 tests / 143 pass / 0 fail / 0 cancelled**（W8 门禁原跑于 b561a7b，本次在十二流集成树重验通过——R-6 核销，含 contract-consistency/security-gates） |
| 8 | RED 套件联动（防污染观察） | `node --test tests/unit/agentic/integration/*.test.mjs` | rc=1，26 tests / 17 pass / 9 fail——与合入链各批次终态完全一致；9 fail 全为缺 integration 实现（context/dispatcher/health/projection/w1-adapter/release-*），未被本模块污染 |
| 9 | 变更面完整性 | 逐文件 `git cat-file -e HEAD:<f>`（53 文件） | 全部 53 文件在 HEAD 原样在位 |

TAP 日志：`/tmp/m03-bridge-tap.log`（bridge 套件 143/143）、`/tmp/m03-red-tap.log`（RED 观察 26/17/9）。

## 3. 变更面与记录勘误（docs vs code，以代码为准）

- 本会话实测 `git diff --name-only 10584f7^1 10584f7 | wc -l` = **53 文件**，构成：
  - 源 20：`scripts/agentic/bridge-hub/{hub,devices,pairing,routes}.mjs`（4）+ `scripts/agentic/db/migrations/bridge-001-devices.sql`（1）+ `packages/donego-bridge/**`（15：入口/package.json/generate-codex-ts、cli/wss、codex adapter/jsonrpc/threads/GENERATED.md、config、git/worktree、model/choose+rate-limits、policy/approvals、runtime/session）
  - 测试 21：`tests/unit/agentic/bridge/` 18 文件（17 test + `_fake-codex.mjs`，HEAD `git ls-tree` 实测 18）+ `tests/agentic/bridge/` 3（loopback.e2e、codex-smoke、SMOKE-LOG.md）
  - `.s2d` 12：11 个 W8 impl-* 记录 + `merge-log.md`（合入会话在**同一 merge commit** 内写入的 M03 条目）
- **勘误**：merge-log/evidence §2 记「51 文件」与实测不符——其自身枚举（20+18+3+11）已=52，再加 merge-log.md 编辑=53；即记录值为漏计 merge-log.md 后的 off-by-one。无功能影响（53 文件逐一在位、门禁全绿），merge-log 原文保留不改（合入会话产物，溯源以本条勘误为准）。

## 4. PROVISIONAL 保留（不抹平，进终报）

- W8 报告：19/21 actor `resolved_model=NULL`、真实 Codex smoke 0 完成回合、branch 覆盖率 78.27%<80%——代码原样合入，状态原样保留，不因集成升级。
- 真实 Codex/gateway 在 W13 集成路径不自动启用；需要真实调用的项单独标 UNKNOWN+次数+限制。

## 5. 覆盖率口径

- M03 为合入模块：W13 侧零新增源码（唯一产出 = 门禁/记录文档），无模块专属 coverage 分母；R-6 硬门禁以 targeted 套件全绿（143/143，bridge）代替，aggregate targeted 2045/2045 见 merge-log 批次三收尾。逐模块 line/branch/function ≥80% 的强制度量落在 M24。

## 6. 提交

- 本记录 `.s2d/impl-M03-merge-w8.md` 以 flock（`/tmp/donego-s2d-w13-git.lock`）提交于 `feat/s2d-w13-integrate`；不 push（M27 收口统一处理）。
