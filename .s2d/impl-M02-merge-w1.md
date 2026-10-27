# S2D-W13 · M02-merge-w1 实现记录（impl-M02-merge-w1.md）

- 模块：M02-merge-w1（组1/G1 合入链第 2 步，plan.md §G1）
- actor：w13·实现·M02-merge-w1（zai-api/GLM-5.3$max，工作流统一绑定）
- 会话日期：2026-10-28
- 工作树：`/Users/chillbit/Proj/Done & Go/s2d/w13-integrate` @ `feat/s2d-w13-integrate`
- 合入提交：`2f810d2`（merge: W1 blocksync (3033265) into W13 integrate；本记录核验时 HEAD=`c82f11e`，链上后续模块 M03-M12 已完成）

## 1. 状态

W1 合入已于合入会话·A 完成并提交（`2f810d2`，真双亲 merge commit）。本实现会话按「代码与新鲜命令为权威」对 M02 门禁包在当前 HEAD **全量重跑**，全部通过，无新增改动需求（合并零冲突、无遗留 TODO/未完成子任务）。明细证据：`argus-cto/projects/donego/evidence/s2d-w13-merge-w1.md`（合入时点）+ 本文件（重验时点）。

## 2. 新鲜门禁包（本会话实测，全部 rc=0）

| # | 检查 | 命令 | 结果 |
|---|---|---|---|
| 1 | tip 核对 | `git rev-parse feat/s2d-w1-blocksync` | `30332659f55a44d7881c2a36a8f69b1c50a35c15` = 派单值 3033265 ✓ 零漂移 |
| 2 | merge 结构 | `git log -1 --format=%P 2f810d2` | parents `42b754c` + `3033265`（真双亲，无 -X ours/theirs） |
| 3 | 祖先包含 | `git merge-base --is-ancestor 3033265 HEAD` | rc=0（W1 tip 在集成分支历史内） |
| 4 | FROZEN 门禁 | `bash /tmp/w13-gate-frozen.sh` | rc=0：committed+worktree 对 `contracts/agentic` vs 60fdc73 零 delta；树哈希 base=head=`cddcdf2e30dbace5288eb17cfaad7c23a06b2400`；`FROZEN` = `v1 b9d9bdfa0511905a95b729753b82e5734adab6bb` |
| 5 | migration 门禁 | `node /tmp/w13-gate-migrations.mjs` | rc=0：20 文件字典序、编号唯一、103 DDL 跨文件零重名、首跑 applied=20（=字典序）、双跑 applied=0（幂等） |
| 6 | targeted 套件（本模块测试全绿判据） | `node --test tests/unit/agentic/blocks/*.test.mjs` | **rc=0，50 tests / 50 pass / 0 fail**（含 contract-consistency 三件套，R-6 核销：60fdc73 对齐后 contracts 上无回归） |
| 7 | RED 套件联动（防污染观察） | `node --test tests/unit/agentic/integration/*.test.mjs` | 26 tests / 17 pass / 9 fail——与 M01/M02 记录终态一致；9 fail 全为缺 integration 实现（M13-M17 的 RED 先行预期），未被本模块污染 |

TAP 日志：`/tmp/m02-blocks-tap.log`（blocks 套件）、`/tmp/m02-red-tap.log`（RED 观察）。

## 3. W1 变更面（`git diff --name-only 2f810d2^1 2f810d2`，20 文件 = 19 W1 文件 + merge-log.md 本模块条目）

- 源：`scripts/agentic/block-store/{index,routes,store}.mjs`、`scripts/agentic/db/migrations/blocks-001-blocks.sql`
- 测试：`tests/unit/agentic/blocks/`（7 test + harness.mjs）、`tests/agentic/blocks/`（双设备同步 spec + harness-server + server + 两 playwright config，端口 17601-17609 与 W13 17701-17719 无碰撞）
- web：`web/agentic/sync.js`（新增）、`web/index.html`（W1 侧唯一改动方：动态 import /agentic/sync.js、登录守卫、删除上行接线——安全评审 HIGH 项；属 W13 允许域，M19/M20 统一处理发布清单与接缝）

全部文件当前在 HEAD 原样在位（`git ls-tree -r HEAD` 逐一核对）。

## 4. PROVISIONAL 保留（不抹平，进终报）

- W1 legacy DTO 与 W0 Agentic Block 形状分歧（snake/camelCase、prio int/enum、source 枚举、draft 无 start/end）——由 M15 w1-adapter 门控：完成时间/来源/owner/schemaVersion/服务端时间戳齐备才转，草稿或缺字段留同步层并返回 UNKNOWN+不可执行原因（draft 块在 W0 v1 block schema 必填 start 下不合法，缺口锚定于 contract-consistency.test.mjs，待 CTO 裁决）。

## 5. 提交

- 本记录 `.s2d/impl-M02-merge-w1.md` 以 flock（`/tmp/donego-s2d-w13-git.lock`）提交于 `feat/s2d-w13-integrate`；不 push（M27 收口统一处理）。
